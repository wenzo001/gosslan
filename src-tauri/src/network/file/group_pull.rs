// 群维度内容的补拉回程：**只用群文件帧**（`GroupFileOffer(scope=todo)` → Chunk → Done）。
//
// 为什么必须这样：`ContentRequest` 帧本身不带会话/群维度，如果沿用 1:1 的
// `send_file_from_path_at`，请求端会在 `handle_file.rs` 的单聊 FileDone 分支写一条
// `conv_id = 服务成员` 的消息 —— 群任务图片就是这样"从别人的私聊再发我一份"，
// 也就是群里发的图冒到单聊。走群文件帧后，接收端按 `group_id` 落 content store，
// `scope=todo` 不建气泡、不写单聊（见 `group_file.rs::create_group_file_receive_bubble`）。
//
// 这条路径不写 `group_files` 行、不发进度、不发 `file-done`：它只是把请求方缺的字节
// 从某个已持有的群成员那里补齐，界面上由缩略图轮询（`TodoImageThumb`）自行发现。
// `transfer_id` 由调用方强制给新值（`pull-<uuid>`），保证对端从 0 字节起收，
// 不会把上一轮残留的 `.part` 当成续传前缀。

/// Offer 是小控制帧；等满 10s 说明链路已不可用（与群发同一档期限）。
const GROUP_PULL_OFFER_TIMEOUT: Duration = Duration::from_secs(10);

/// 把 `src` 以群文件通道发给 `recipient`；`cid` 必须等于源的 sha256（接收端按它做最终校验）。
pub(crate) async fn send_group_file_pull_at(
    state: &Arc<AppState>,
    recipient: &str,
    group_id: &str,
    transfer_id: &str,
    src: PathBuf,
    cid: &str,
) -> Result<(), String> {
    // 与群发共用同一个并发闸：补拉也是"一份读缓冲 + 一条链路队列"。
    let _slot = state
        .group_file_permits
        .acquire()
        .await
        .map_err(|_| "群文件并发闸已关闭".to_string())?;
    let meta = std::fs::metadata(&src).map_err(|e| format!("源文件不可读：{e}"))?;
    if !meta.is_file() {
        return Err("源文件已不存在".to_string());
    }
    let size = meta.len();
    // 用真实摘要而不是直接信任 job.cid：接收端最终会按 sha256 校验，发错了只会更晚失败。
    // 整文件哈希是同步慢活（≈1 GB/s），必须挪进阻塞池 —— 这段代码跑在 tokio worker 上，
    // 就地算会把同一个 runtime 上排队的所有 async 开窗命令一起拖住（INV-P34）。
    let hash_src = src.clone();
    let sha256 = tokio::task::spawn_blocking(move || crate::network::file::sha256_file_hex(&hash_src))
        .await
        .map_err(|e| format!("摘要计算任务失败：{e}"))??;
    if sha256 != cid {
        return Err("源文件摘要与请求的 cid 不一致".to_string());
    }
    let group_key = crate::network::transport::get_group_key(state, group_id)
        .await
        .ok_or_else(|| "群密钥缺失".to_string())?;
    let file_key = crypto::random_key();
    let sealed_file_key = STANDARD.encode(
        crypto::seal_symmetric(&group_key, &file_key)
            .ok_or_else(|| "封装文件密钥失败".to_string())?,
    );
    // 整条流钉在同一条链路上（Offer=Normal、Chunk=Low，不钉会分落到不同连接）。
    let link = crate::network::transport::resolve_stream_link(state, recipient)
        .await
        .ok_or_else(|| "未建立连接".to_string())?;
    let name = src
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("content.bin")
        .to_string();
    let offer = Message::GroupFileOffer {
        transfer_id: transfer_id.to_string(),
        group_id: group_id.to_string(),
        sender_id: state.device_id.clone(),
        name,
        size,
        sha256: sha256.clone(),
        sealed_file_key,
        // 群任务图片：接收端按 cid 取本地路径，不建群气泡、更不建单聊消息。
        scope: "todo".to_string(),
        todo_id: String::new(),
        // 全新 transfer_id ⇒ 不需要续传握手，一律从 0 开始。
        attempt: None,
    };
    match tokio::time::timeout(
        GROUP_PULL_OFFER_TIMEOUT,
        send_on_link(&link, &offer),
    )
    .await
    {
        Err(_) => {
            return Err(format!(
                "Offer 发送等待超过 {}s（对端链路拥塞）",
                GROUP_PULL_OFFER_TIMEOUT.as_secs()
            ))
        }
        Ok(Err(e)) => return Err(format!("Offer 发送失败：{e}")),
        Ok(Ok(())) => {}
    }
    // 期限按体积自适应，与单聊/群发同一口径。
    let deadline = crate::network::file::send_deadline_for(size);
    let chunk_size = crate::network::file::chunk_size_for_path(link.path_kind.as_str());
    let result = tokio::time::timeout(deadline, async {
        use tokio::io::AsyncReadExt;
        let mut f = tokio::fs::File::open(&src)
            .await
            .map_err(|e| format!("打开源文件失败：{e}"))?;
        let mut buf = vec![0u8; chunk_size];
        let mut seq: u32 = 0;
        loop {
            let n = f
                .read(&mut buf)
                .await
                .map_err(|e| format!("读源文件失败：{e}"))?;
            if n == 0 {
                break;
            }
            let sealed = crypto::seal_symmetric(&file_key, &buf[..n])
                .ok_or_else(|| "分片加密失败".to_string())?;
            let chunk = Message::GroupFileChunk {
                transfer_id: transfer_id.to_string(),
                group_id: group_id.to_string(),
                sender_id: state.device_id.clone(),
                seq,
                data: STANDARD.encode(&sealed),
                attempt: None,
            };
            send_on_link(&link, &chunk)
                .await
                .map_err(|e| format!("分片发送失败：{e}"))?;
            seq += 1;
        }
        let done = Message::GroupFileDone {
            transfer_id: transfer_id.to_string(),
            group_id: group_id.to_string(),
            sender_id: state.device_id.clone(),
            attempt: None,
        };
        send_on_link(&link, &done)
            .await
            .map_err(|e| format!("Done 发送失败：{e}"))?;
        Ok::<(), String>(())
    })
    .await;
    match result {
        Ok(inner) => inner,
        Err(_) => Err(format!(
            "群文件补拉发送超时（超过 {}s）",
            deadline.as_secs()
        )),
    }
}
