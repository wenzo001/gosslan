// 职责边界：
// - 单聊文件传输（Offer/Chunk/Done/取消）
// - 离线投递队列（flush_pending_files）
// ---------------- 文件传输 ----------------

/// 图片 MIME → 扩展名（仅接受常见格式）。
fn image_extension(mime: &str) -> Option<&'static str> {
    match mime.to_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

/// 纯函数：验证并解码 data URL 图片，返回 (扩展名, 解码后字节)。
/// 用于单元测试覆盖 MIME/大小/base64 等校验逻辑，不涉及文件系统。
fn decode_outgoing_image(data_url: &str) -> Result<(&'static str, Vec<u8>), String> {
    const PREFIX: &str = "data:";
    if !data_url.starts_with(PREFIX) {
        return Err("非法的 data URL".to_string());
    }
    let rest = &data_url[PREFIX.len()..];
    let Some((meta, encoded)) = rest.split_once(',') else {
        return Err("非法的 data URL".to_string());
    };
    let meta = meta.to_lowercase();
    if !meta.ends_with(";base64") {
        return Err("只接受 base64 编码的 data URL".to_string());
    }
    let mime = meta.trim_end_matches(";base64").trim();
    if !mime.starts_with("image/") {
        return Err("只接受图片文件".to_string());
    }
    let Some(ext) = image_extension(mime) else {
        return Err("不支持的图片格式".to_string());
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.as_bytes())
        .map_err(|e| format!("图片解码失败：{e}"))?;
    if bytes.len() as u64 > MAX_OUTGOING_IMAGE_BYTES {
        return Err(format!(
            "图片过大（{} > {}），请压缩后重试",
            bytes.len(),
            MAX_OUTGOING_IMAGE_BYTES
        ));
    }
    if bytes.is_empty() {
        return Err("图片内容为空".to_string());
    }
    Ok((ext, bytes))
}

/// 把前端 paste 产生的 data URL 解码保存为本地文件。
/// 仅接受 image/* 常见格式，按解码后字节数限制，返回本地路径/文件名/大小。
#[tauri::command(async)]
pub fn save_outgoing_image(
    state: State<'_, Arc<AppState>>,
    data_url: String,
) -> Result<serde_json::Value, String> {
    let (ext, bytes) = decode_outgoing_image(&data_url)?;
    let name = format!("image-{}.{ext}", Uuid::new_v4());
    let dl = state
        .inner()
        .downloads_dir
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let path = dl.join(&name);
    std::fs::create_dir_all(&dl).map_err(|e| e.to_string())?;
    std::fs::write(&path, &bytes).map_err(|e| format!("图片保存失败：{e}"))?;
    // 落进**托管目录**的图片含聊天图片本体：只许属主读（审计 P1 #8）。
    // 用户显式选的导出目的地不在此列（他可能就是要放到共享目录）。
    crate::private_fs::restrict_to_owner(&path);
    Ok(serde_json::json!({
        "path": path.to_string_lossy().to_string(),
        "name": name,
        "size": bytes.len() as u64,
    }))
}

/// 删除本地文件（用于图片发送初始化失败后清理孤儿文件）。
///
/// ⚠️ **只允许删除下载目录内的文件**。读取侧早有这条边界（见 `resolve_media_path`：
/// canonicalize 后必须落在 downloads 内，或该消息确由本机发出），删除侧原先却接受任意路径。
/// 当前唯一调用方只清理 `save_outgoing_image` 刚写进 downloads 的孤儿图片，
/// 所以这条限制不影响任何既有功能；但若哪天有 UI 把它接到消息里的 `path`
/// （该字段由对端控制），没有它就会变成「对端点一下按钮删掉本机任意文件」。
///
/// 用 canonicalize 比对，避免 `../` 或符号链接绕过前缀匹配。
#[tauri::command(async)]
pub async fn delete_file(state: State<'_, Arc<AppState>>, path: String) -> Result<(), String> {
    let s = state.inner().clone();
    // 两次 canonicalize + remove：全是文件系统调用（审计 R-18）。安全闸（只能删下载目录内）
    // 与判据顺序一字不动，只是整段换个线程跑。
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let file = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
        let dl = s
            .downloads_dir
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let under_downloads = std::fs::canonicalize(&dl)
            .map(|dir| path_under_any(&file, &[dir]))
            .unwrap_or(false);
        if !under_downloads {
            return Err("只能删除下载目录内的文件".to_string());
        }
        std::fs::remove_file(&file).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("文件删除被线程池中断: {e}"))?
}

/// 纯函数：`file` 是否落在 `roots` 里任意一个之下（**按路径分量**比，不是字符串前缀）。
///
/// 抽出来只为它能被单测判住 —— "对端给的 `path` 直接交给系统默认应用打开"这一格
/// 本机看不见也摸不着，只能靠机器。分量比对是刻意的：`/app/downloads_evil/x`
/// 不许被 `/app/downloads` 放行（字符串前缀会放过去）。
fn path_under_any(file: &std::path::Path, roots: &[std::path::PathBuf]) -> bool {
    roots.iter().any(|dir| file.starts_with(dir))
}

/// 从消息 id 取传输 id（`file-{id}` / `gfile-{id}`），其它形状返回 `None`。
///
/// 同一映射在 `helpers.rs::resolve_media_path` 里也有一份（读取预览那条链），
/// 口径必须一致；这里是**打开**那条链的唯一入口。
fn transfer_id_of_owner(owner: &str) -> Option<&str> {
    owner
        .strip_prefix("file-")
        .or_else(|| owner.strip_prefix("gfile-"))
}

/// 台账绑定判据（纯函数）：请求路径必须与台账路径（两者都已 canonicalize）一致。
///
/// 抽成纯函数是为了能被单测判住 —— “消息里的 path 不等于这条消息的传输台账 path”
/// 这一格在本机点不出来，只能靠机器。返回值是日志/前端共用的 `code`。
fn ledger_path_owns(
    requested: &std::path::Path,
    ledger: Option<&std::path::Path>,
) -> Result<(), &'static str> {
    match ledger {
        None => Err("OPEN_PATH_UNBOUND"),
        Some(path) if path != requested => Err("OPEN_PATH_NOT_OWNED"),
        Some(_) => Ok(()),
    }
}

/// 用系统默认应用打开本地文件。
/// macOS 走 NSWorkspace（沙盒下 /usr/bin/open 被拦）；Android 走 FileProvider + ACTION_VIEW
/// （私有目录的文件不能以 file:// 交给别的应用，见 android_open.rs）；Windows/Linux 走 opener。
///
/// ⚠️ 信任边界到**对象**，不是到目录（审计 2026-10-24 SEC-01 / SOL-01）。
/// 消息内容里的 `path` 由**对端**写，只校验"落在托管目录内"挡不住
/// "本应用托管目录内的任意文件"（对端先前投递的 `.command` / `.app` 也算）。
///
/// 判据：调用方传 `owner = msg_id`，后端按 `file-{tid}` / `gfile-{tid}` 回绑
/// `file_transfers.path`（**沿用现有约定，不新增表列**），请求路径必须与该台账路径
/// （canonicalize 后）一致；台账行尚未建立时，只允许**本机发出**的消息
/// （那条路径是本机用户在文件对话框里选的，对端写不了 `sender_id`）。
/// 无 `owner` 的只剩收藏入口，只允许 `favorites_dir`。
///
#[tauri::command(async)]
pub fn open_file_native(
    state: State<'_, Arc<AppState>>,
    path: String,
    owner: Option<String>,
) -> Result<(), String> {
    let s = state.inner();
    let requested = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;

    let allowed = match owner.as_deref() {
        // 判据唯一份在 `owned_payload_rejection`（另存为 / 转发共用同一份，
        // 否则三条链必然漂移 —— 这正是 SEC-01 修好「打开」、另两条仍然裸奔的原因）。
        Some(msg_id) => match owned_payload_rejection(s, msg_id, &requested) {
            None => Ok(()),
            Some(code) => Err(code),
        },
        None => {
            let fav = std::fs::canonicalize(&s.favorites_dir).ok();
            if fav
                .as_deref()
                .map(|dir| requested.starts_with(dir))
                .unwrap_or(false)
            {
                Ok(())
            } else {
                Err("OPEN_PATH_UNBOUND")
            }
        }
    };

    if let Err(code) = allowed {
        s.logger.warn(
            "file",
            format!(
                "code={code} 拒绝用系统默认应用打开 file={path} owner={}",
                owner.as_deref().unwrap_or("-")
            ),
        );
        return Err(match code {
            "OPEN_PATH_NOT_OWNED" => "这个文件不属于这条消息，已拒绝打开".to_string(),
            _ => "无法确认这个文件属于本应用，已拒绝打开".to_string(),
        });
    }

    // ⚠️ 交给系统的是**原始路径**，不是上面那份 canonical 结果：Windows 的 `canonicalize` 返回
    // `\\?\C:\…` 这种 verbatim 形式，而这条链在 Windows/Linux 上走 `tauri_plugin_opener` → `ShellExecuteW`，
    // **ShellExecute 不支持 `\\?\` 前缀**（macOS 走 NSWorkspace、Android 走 FileProvider，才与它无关）。
    // 边界判定照旧用 canonical（能解掉 `..` 与符号链接），打开用原路径 —— 顺序不能反，
    // 反了就是"安全了，但你最常按的那个按钮在 Windows 上死了"。
    crate::open_path::open_path_native(std::path::Path::new(&path))
}

/// 「这条消息能否认领这个路径」的**唯一判据**（打开 / 另存为 / 转发三处共用）。
///
/// `Some(code)` = 拒绝（可直接进日志与前端错误码），`None` = 放行。
/// 请求路径（调用方已 canonicalize）必须与 `msg_id` 的台账路径一致；台账行尚未建立时，
/// 只放行**本机发出**的消息 —— 那条路径是本机用户在文件对话框里选的，对端写不了
/// `sender_id`（入站校验拒绝 `sender_id == 本机`）。
///
/// 为什么不退化成"落在 downloads 内即可"：那挡不住"对端诱导你去读**另一个**接收文件"
/// （同目录内越权）；台账回绑能挡住，而 `file_transfers` 早就有这一列。
pub(crate) fn owned_payload_rejection(
    s: &AppState,
    msg_id: &str,
    requested: &std::path::Path,
) -> Option<&'static str> {
    let (ledger, mine) = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        let ledger = transfer_id_of_owner(msg_id).and_then(|tid| db::get_transfer_path(&dbc, tid));
        // 群文件气泡在第一条进度上报之前还没有台账行；本机发出的那条路径是用户自己选的。
        let mine = ledger.is_none()
            && db::get_message_record(&dbc, msg_id)
                .map(|m| m.sender_id == s.device_id)
                .unwrap_or(false);
        (ledger, mine)
    };
    if mine {
        return None;
    }
    let ledger_canon = ledger
        .as_deref()
        .and_then(|p| std::fs::canonicalize(p).ok());
    ledger_path_owns(requested, ledger_canon.as_deref()).err()
}

/// macOS 窗口圆角：WebView 加载完成后（前端 onMounted 触发）设背景色跟随主题 +
/// contentView 圆角（setup 阶段设会被 wry 替换 contentView 丢失）。非 macOS 无操作。
#[tauri::command]
pub fn apply_macos_window_shape(window: tauri::WebviewWindow, dark: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return crate::macos_window::apply_rounded_corners(&window, dark);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, dark);
        Ok(())
    }
}

/// 群文件投递摘要（气泡成员状态文案用）：总数/completed/failed/待投递。
#[tauri::command(async)]
pub async fn get_group_file_delivery_summary(
    state: State<'_, Arc<AppState>>,
    transfer_id: String,
) -> Result<Option<db::GroupFileDeliverySummary>, String> {
    let s = state.inner().clone();
    tokio::task::spawn_blocking(move || -> Result<Option<db::GroupFileDeliverySummary>, String> {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        Ok(db::get_group_file_delivery_summary(&dbc, &transfer_id))
    })
    .await
    .map_err(|e| format!("投递统计读取被线程池中断: {e}"))?
}

/// 群文件列表里的一项（前端「群文件」面板）。
#[derive(serde::Serialize)]
pub struct GroupFileEntry {
    pub transfer_id: String,
    pub name: String,
    pub size: u64,
    pub sender_id: String,
    pub created_at: i64,
    /// 本机视角的持有状态：`local`（在本机可打开）/ `receiving`（传输中）/
    /// `remote`（未取到）/ `failed`（取失败，可重试）。
    /// **不由群投递状态推导**：我发出去的文件对别人是否送达，与我本机能不能打开无关。
    pub local_state: String,
    /// 本机完整文件的真实路径（仅 `local_state == "local"` 时给出）。
    pub local_path: Option<String>,
    /// 该文件对全群的投递进度（已完成成员数 / 成员总数）。
    pub delivered: i64,
    pub total: i64,
}

/// 列出某群的全部群文件，附带「本机是否持有」与「对全群投递进度」。
///
/// 本机持有状态的判定必须**看磁盘**：路径在 DB 里存在不代表文件还在
/// （缓存清理会删掉媒体文件，见 `clean_cache_now`）。只信 DB 会让面板列出
/// 一堆点了打不开的条目。
/// 群文件面板一次最多取多少条（只增表 + 每行点查/stat ⇒ 必须有界）。
pub const GROUP_FILES_PANEL_LIMIT: i64 = 500;

#[tauri::command(async)]
pub async fn list_group_files(
    state: State<'_, Arc<AppState>>,
    group_id: String,
) -> Result<Vec<GroupFileEntry>, String> {
    let s = state.inner().clone();
    // 整段进阻塞池（审计 R-18）：前半是每行 3~4 次持 db 锁的点查，后半是**每个文件一次磁盘
    // stat** —— 群文件面板一打开就打这条，留在 worker 上等于让"打开面板"占住一个工作线程。
    tokio::task::spawn_blocking(move || -> Result<Vec<GroupFileEntry>, String> {
        let me = s.device_id.clone();
        // 先把 DB 该给的都取出来，**随即释放 db 锁** —— 下面的磁盘 stat 是阻塞 I/O，
        // 持着全局 db 锁做 N 次 stat 会把整条消息链路的落库一起堵住。
        type Row = (crate::state::GroupFile, i64, i64, String, Option<String>);
        let rows: Vec<Row> = {
            let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
            // 面板只取最近 500 条（见 `list_group_files_page`）；历史同步仍走全量那条。
            let files = db::list_group_files_page(&dbc, &group_id, GROUP_FILES_PANEL_LIMIT)
                .map_err(|e| e.to_string())?;
            files
                .into_iter()
                .map(|f| {
                    let summary = db::get_group_file_delivery_summary(&dbc, &f.transfer_id);
                    let (delivered, total) = match summary {
                        Some(x) => (x.completed, x.total),
                        None => (0, 0),
                    };
                    let my_status = db::get_group_file_recipient_status(&dbc, &f.transfer_id, &me)
                        .unwrap_or_default();
                    let path = db::get_transfer_path(&dbc, &f.transfer_id);
                    (f, delivered, total, my_status, path)
                })
                .collect()
        };
        Ok(rows
            .into_iter()
            .map(|(f, delivered, total, my_status, path)| {
                let (local_state, local_path) = if f.sender_id == me {
                    // 发送者不参与 recipients（见 send_group_file 的成员过滤），其 recipient 行
                    // 恒为空 —— 按 my_status 判定会让自己发的文件永远显示"未取到"。
                    // 本机是否还留着原件，只能看磁盘。
                    local_path_state(path)
                } else {
                    match my_status.as_str() {
                        "completed" => local_path_state(path),
                        "sending" | "pending" => ("receiving".to_string(), None),
                        "failed" => ("failed".to_string(), None),
                        // 没有 recipient 行：该文件早于本机入群，尚未登记接收
                        _ => ("remote".to_string(), None),
                    }
                };
                GroupFileEntry {
                    transfer_id: f.transfer_id,
                    name: f.name,
                    size: f.size,
                    sender_id: f.sender_id,
                    created_at: f.created_at,
                    local_state,
                    local_path,
                    delivered,
                    total,
                }
            })
            .collect())
    })
    .await
    .map_err(|e| format!("群文件列表读取被线程池中断: {e}"))?
}

/// 路径 → 持有状态：路径存在且**文件仍在磁盘上**才算 `local`，否则回落到 `remote`。
fn local_path_state(path: Option<String>) -> (String, Option<String>) {
    match path {
        Some(p) if std::path::Path::new(&p).is_file() => ("local".to_string(), Some(p)),
        _ => ("remote".to_string(), None),
    }
}

/// 构造一条本地文件/图片消息记录（发送方）。
/// kind 由调用方根据 subtype 决定：image 子类型保持 kind="image"，其余为 "file"。
#[allow(clippy::too_many_arguments)]
fn build_file_message(
    state: &AppState,
    transfer_id: &str,
    friend_id: &str,
    path: &str,
    name: &str,
    size: u64,
    kind: &str,
    subtype: &str,
) -> MessageRecord {
    // cid = 明文 sha256，接收方据此按 cid 拉取（ADR-0019 Phase 3）。
    // ⚠️ **这里不计算**：整文件哈希是 O(体积) 的，放在建记录这一步就等于把气泡挡在哈希之后
    // （真机 Mac 发 600MB：点完要"卡一会儿"才出现发送中气泡）。真正用于校验的那份由投递
    // 任务算（`network/file/send.rs::send_file_from_path_at` → FileOffer.file_sha256），
    // 算完再回填本行的 sha256 字段（`db::fill_message_sha256`），所以最终值同源、不丢。
    let mut content = serde_json::json!({
        "name": name,
        "path": path,
        "size": size,
        "sha256": "",
        "subtype": subtype,
    });
    if kind == "image" {
        file::attach_image_size(&mut content, std::path::Path::new(path));
    }
    let content = content.to_string();
    let seq = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::next_clock(&dbc, friend_id).unwrap_or(1)
    };
    MessageRecord {
        fail_code: None,
        id: 0,
        msg_id: format!("file-{transfer_id}"),
        conv_id: friend_id.to_string(),
        sender_id: state.device_id.clone(),
        receiver_id: friend_id.to_string(),
        kind: kind.to_string(),
        content,
        ts: db::now_ms(),
        seq,
        status: "sent".to_string(),
        mention_targets: None,
        local_id: None,
    }
}

/// 走唯一终态出口，并把 `Err` **留痕**（FUNC-02 复审）。
///
/// `finalize_file_failure` 现在是一个事务：失败即整体回滚。把它折成 `false` 本身是对的
/// （界面不该收到一条假"已失败"），但旧写法连**失败原因**一起丢了 —— 现场只剩
/// "这一单没动"，既不知道是磁盘满、锁中毒还是触发器拦的。三处收尾共用这一个入口。
fn finalize_with_note(
    state: &AppState,
    transfer_id: &str,
    end: db::FileJobEnd,
    ctx: &str,
) -> bool {
    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
    match db::finalize_file_failure(&dbc, transfer_id, end) {
        Ok(changed) => changed,
        Err(e) => {
            state.logger.error(
                "file",
                format!(
                    "code=FILE_FINALIZE_FAILED transfer={transfer_id} ctx={ctx} err={e} —— \
                     事务已整体回滚，界面不谎报终态"
                ),
            );
            false
        }
    }
}

/// 永久失败收尾：把一单放弃重发的文件落终态，并通知前端。
///
/// ⚠️ 两件事按顺序做，不许颠倒：
/// 1. **已经 `done` 的传输不是失败。** 传输行落到 `done` 意味着磁盘证据已经成立
///    （长度对 + sha256 对 + `sync_all()` 之后才 rename），这时再把气泡与台账改成 failed，
///    用户看到的就是"一个打开就在那儿的文件显示失败"⇒ 面向用户的两笔写与 emit 全部跳过。
/// 2. **把队列行踢出重试集合的那一步排最后**（下面唯一那处 `mark_file_outbox_failed` 调用）。
///    `list_expired_file_outbox` 只选 pending/sending ⇒ 它一跑，前面任何一步失败都永久无人补，
///    症状是"气泡停在发送中、而这行再也扫不到"。同一条规矩在
///    `transport.rs::finalize_expired_file` 上有逐函数注释；判据已升级成自动扫全部收尾路径
///    （`lib.rs::every_finalize_path_defers_the_destructive_write`）。
///    已 done 那一支同样要走到这一步：队列行必须关掉，否则每 tick 被重扫一遍又什么都不做。
///
/// 终态契约整体见 `db::file_transfer::upsert_transfer` 上面那段（INV-P26）。
fn fail_file_job(state: &AppState, transfer_id: &str, reason: &str) {
    // 全部落库都在唯一出口 `db::finalize_file_failure` 里（P7：三份收尾合成一份）：
    // 气泡 → 台账 → 最后才关队列行，`done` 闸门也在那一处。
    let announce = finalize_with_note(state, transfer_id, db::FileJobEnd::GiveUp, "fail_job");
    if announce {
        let _ = state.app.emit(
            "file-failed",
            &crate::state::FileFailedInfo {
                transfer_id: transfer_id.to_string(),
                reason: reason.to_string(),
            },
        );
    }
}

/// 尝试投递某 peer 的全部 pending 文件（同一 peer 串行，不同 peer 并行）。
/// 触发点与 `flush_outbox` / `flush_group_outbox` 一致：建链 / Hello / 心跳。
pub async fn flush_pending_files(state: &Arc<AppState>, peer_id: &str) {
    if !mark_peer_sending(&state.file_sending, peer_id) {
        return;
    }
    // 没有链路时不做无谓尝试，保持 pending，等下一次连接事件再触发。
    if !state.has_link(peer_id).await {
        release_peer_send(&state.file_sending, peer_id);
        return;
    }
    let pending = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::list_pending_file_outbox(&dbc, peer_id).unwrap_or_default()
    };
    if pending.is_empty() {
        release_peer_send(&state.file_sending, peer_id);
        return;
    }
    let st = state.clone();
    let peer = peer_id.to_string();
    tauri::async_runtime::spawn(async move {
        // 槽位交给守卫：任务体里一次 panic（或 future 被 drop）也必须归还。
        // 旧写法把 remove 手写在下面那个循环之后，panic 会跳过它 ⇒ 这个 peer
        // 之后的所有文件永远抢不到槽位，界面只停在「发送中 0%」且不报任何错。
        let _gate = PeerSendGuard::new(&st.file_sending, &peer);
        for (transfer_id, local_path) in pending {
            if !st.has_link(&peer).await {
                break;
            }
            // 只剩蓝牙链路时，超过 `BLE_FILE_SIZE_LIMIT` 的文件**不启动**（2026-09-23 真机 600MB）：
            // 保持 pending、不消耗 attempts、不落 failed —— LAN 一回来，下一次 flush 就会发。
            // 判据是纯函数（`file::refuse_reason_for_best_link`），这里只负责取链路种类与体积。
            // 必须排在 `mark_file_outbox_sending` 之前：那一步会把 attempts +1，
            // 5 次上限一到就永久 failed，"等 LAN 回来自动重试"就成了空话。
            let best_kind = {
                let links = st.links.lock().await;
                links.get(peer.as_str()).and_then(|ls| {
                    let kinds: Vec<crate::mesh::PathKind> =
                        ls.iter().map(|l| l.path_kind).collect();
                    crate::state::best_link_kind(&kinds)
                })
            };
            let size = std::fs::metadata(&local_path).map(|m| m.len()).unwrap_or(0);
            if let Some(reason) = file::refuse_reason_for_best_link(best_kind, size) {
                st.logger.warn(
                    "file",
                    format!(
                        "只有蓝牙链路，{size} 字节超过 BLE_FILE_SIZE_LIMIT ⇒ 暂不发送，保持 pending 等 LAN transfer={transfer_id}"
                    ),
                );
                // 让用户看见原因：不发的话界面只会停在"发送中 0%"，与"卡死"无法区分。
                let _ = st.app.emit(
                    "file-stalled",
                    &crate::state::FileStalledInfo {
                        transfer_id: transfer_id.clone(),
                        stalled: true,
                        idle_ms: 0,
                        reason: Some(reason.to_string()),
                    },
                );
                continue;
            }
            {
                let dbc = st.db.lock().unwrap_or_else(|e| e.into_inner());
                // 取消可能发生在 list_pending_file_outbox 之后、这里之前：只有真的
                // 从 pending 迁移成功才允许发；否则跳过，别再发完整份。
                if !db::mark_file_outbox_sending(&dbc, &transfer_id, 0).unwrap_or(false) {
                    continue;
                }
            }
            match file::send_file_from_path(
                &st,
                &peer,
                &transfer_id,
                std::path::PathBuf::from(local_path),
            )
            .await
            {
                Ok(()) => {
                    // 队列行删不掉必须留痕：那一行还在 = 清扫器会把同一单再投一次，
                    // 而界面上已经显示"已送达"。留痕在出锁之后写（helper 返回时就放了锁）。
                    if let Some(note) = file::drop_sent_outbox_row(&st.db, &transfer_id) {
                        st.logger.error("file", note);
                    }
                }
                Err(e) => {
                    // 判据只有一份（`file::send_retry_verdict`，纯函数 + 单测）：
                    // 这里只负责"照裁决写库"，不在此处再比一次 attempts。
                    let attempts = {
                        let dbc = st.db.lock().unwrap_or_else(|e| e.into_inner());
                        db::get_file_outbox_attempts(&dbc, &transfer_id)
                    };
                    match file::send_retry_verdict(&e, attempts) {
                        file::RetryVerdict::GiveUp(reason) => {
                            st.logger.warn(
                                "file",
                                format!(
                                    "[FAILED] transfer={transfer_id} reason={reason} (retryable={}, attempts={attempts:?})",
                                    e.retryable
                                ),
                            );
                            fail_file_job(&st, &transfer_id, &reason);
                        }
                        file::RetryVerdict::Retry { backoff_ms } => {
                            let dbc = st.db.lock().unwrap_or_else(|e| e.into_inner());
                            db::mark_file_outbox_pending(&dbc, &transfer_id, backoff_ms).ok();
                        }
                        // 用户取消：退出投递任务时**必须**继续按 cancelled 收尾，不能顺着
                        // `GiveUp` 那一格落 `failed`。取消信号是异步的 —— `cancel_file_transfer`
                        // 先写好墓碑，本任务在下一个观测点（分片之间 / Offer 等待 / ACK 等待）
                        // 才退回来；回来时若按 GiveUp 收尾，就把用户刚按下的"已取消"改成了
                        // "失败"并把进度打回 0%（墓碑只挡住台账那一笔，气泡与 emit 不在其内）。
                        file::RetryVerdict::Cancelled => {
                            st.logger.info(
                                "file",
                                format!("[CANCELLED] transfer={transfer_id} 用户取消，本次投递退出且不再重发"),
                            );
                            let announce = finalize_with_note(
                                &st,
                                &transfer_id,
                                db::FileJobEnd::Cancelled,
                                "send_cancelled",
                            );
                            if announce {
                                let _ = st.app.emit("file-cancelled", &transfer_id);
                            }
                        }
                    }
                }
            }
        }
    });
}

/// 删除会话/好友之前，取消该 peer 所有仍在排队/传输中的**发送** transfer。
///
/// 只改台账不够：`upsert_transfer` 允许 cancelled 被在途 attempt 写回 active ⇒
/// 先按取消槽位的前缀点亮信号（[`file::signal_cancel_slots`]），再逐条走唯一终态出口。
/// 注意：`file_sending`（spawn loop 里按 peer_id 存的 HashSet）不需要这里清 ——
/// 那些循环读到取消信号后自己会走到下一条或退出。
///
/// 与用户点取消的差别只有一处：**不给对端发 `FileCancel` 帧**。删好友/删会话这件事
/// 对方是从"关系没了"那一侧知道的（friend 撤销帧），这里再补一帧只会打进一条已经不存在的链路。
pub(crate) fn cancel_send_transfers_for_peer(s: &AppState, peer_id: &str) {
    let ids = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        match db::list_open_send_transfer_ids_for_peer(&dbc, peer_id) {
            Ok(ids) => ids,
            Err(e) => {
                // 读失败 = 这一轮一条都没取消。不记就只剩"删了好友，文件还在队列里发"。
                s.logger.error(
                    "file",
                    format!("code=FILE_CANCEL_LIST_FAILED peer={peer_id} err={e}"),
                );
                return;
            }
        }
    };
    if ids.is_empty() {
        return;
    }
    for id in &ids {
        file::signal_cancel_slots(s, id);
    }
    let cancelled = ids
        .iter()
        .filter(|id| finalize_with_note(s, id, db::FileJobEnd::Cancelled, "peer_cancel"))
        .cloned()
        .collect::<Vec<_>>();
    for id in cancelled {
        let _ = s.app.emit("file-cancelled", &id);
    }
}

/// 取消一条文件传输的结果 —— 界面按这两个数说话，不再自己猜。
///
/// 为什么不再返回 `signalled`（"有没有命中在途投递任务"）：那个数描述的是**本机内存**，
/// 不是用户关心的事。用户点了取消要知道的是"这一单现在算不算被取消了"，而唯一权威是台账：
///  · 排队中（`pending`）根本没有在途任务 ⇒ `signalled=false`，但取消**成立**；
///  · 已经收完（`done`）时墓碑与终态闸门都不允许改成 cancelled ⇒ 取消**不成立**。
/// 旧返回值把这两种情况都说成"传输可能已结束"，而它们是完全相反的两件事。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCancelResult {
    /// 这一单现在面向用户的状态是"已取消"（本次推进，或本来就是）。
    pub cancelled: bool,
    /// 这一单已经完整收下（台账 `done`）⇒ 取消不成立，界面要说"已送达"。
    pub already_done: bool,
    /// 是否**真的把取消通知发出去了**（对端声明过能力位且帧进了链路）。
    ///
    /// 为什么这条要说给界面：本机停手 ≠ 对面停手。老端没有这条能力位 ⇒ 我们一条都不发
    /// （INV-P24 第 4 条），它会继续传/收到自己的 deadline。此时界面若只说"已取消"，
    /// 用户会以为对面也停了 —— 这一格就是让文案能说「对方版本较旧时可能仍在继续」。
    pub notified_peer: bool,
    /// 台帐那一笔写**成功落地**了吗（FUNC-02）。
    ///
    /// 取消的五笔写合并进同一个事务之后，`Err` 会把它们整体回滚（见
    /// `db::finalize_file_failure`）。本机确实已经停了手（在途槽位已点亮、接收器已摘），
    /// 但台账与气泡会留在原状态 —— 界面这时说"已取消"就是**比事实更满**：
    /// 刷新之后那条消息还会显示发送中。所以这一格单独回传，让界面改说
    /// 「本机已停止，状态待重试」，并已在后端留下 `code=CANCEL_COMMIT_FAILED`。
    pub ledger_committed: bool,
}

/// 群文件的**接收**侧取消（B3b 的第 0 步）：认出"这一单是不是别人发给我的群文件"，
/// 是就本机停手并落终态，返回 `Some(结果)`；不是（1:1 或本机是发送方）返回 `None`，
/// 让调用方继续走 1:1 / 整单那两条老路。
///
/// 写序与 `every_finalize_path_defers_the_destructive_write` 那条判据一致：
/// **面向用户的写（气泡 `gfile-` 状态）在前，把这一单踢出补发集合的写（整单行 cancelled）在后** ——
/// 反过来的话，进程在两步之间死掉会留下"补发再也不会碰它、但气泡还停在发送中"的孤儿。
async fn cancel_group_receive_side(
    s: &Arc<AppState>,
    transfer_id: &str,
    by: &str,
) -> Option<FileCancelResult> {
    let completed = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        if db::get_transfer_route(&dbc, transfer_id).is_some() {
            return None;
        }
        let gf = db::get_group_file(&dbc, transfer_id)?;
        if gf.sender_id == s.device_id {
            return None;
        }
        gf.status == "completed"
    };
    // 已经收完 = 没有可取消的字节（与 1:1 的 `already_done` 同一格口径）。
    if completed {
        return Some(FileCancelResult {
            cancelled: false,
            already_done: true,
            notified_peer: false,
            ledger_committed: true,
        });
    }
    let s2 = s.clone();
    let tid = transfer_id.to_string();
    let stopped = match tokio::task::spawn_blocking(move || file::cancel_group_receive(&s2, &tid))
        .await
    {
        Ok(v) => v,
        Err(e) => {
            s.logger.error(
                "group_file",
                format!("取消群文件接收的收尾任务被线程池中断 transfer={transfer_id}：{e}（.part 可能还在）"),
            );
            false
        }
    };
    let ledger_committed = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        // 面向用户的写先做（气泡）；随后那一笔才是"踢出补发集合"的。
        // FUNC-02：两笔写都要留痕。旧写法 `let _ =` 把失败吞掉 ⇒ 界面照样弹"已取消"，
        // 而刷新后气泡还停在发送中，且没有任何日志能说明原因。
        let bubble = match db::set_message_status(&dbc, &format!("gfile-{transfer_id}"), "cancelled") {
            Ok(_) => true,
            Err(e) => {
                s.logger.error(
                    "group_file",
                    format!("code=GROUP_CANCEL_BUBBLE_FAILED transfer={transfer_id} by={by}：{e}"),
                );
                false
            }
        };
        let ledger = match db::mark_group_file_cancelled(&dbc, transfer_id) {
            Ok(_) => true,
            Err(e) => {
                s.logger.error(
                    "group_file",
                    format!("code=GROUP_CANCEL_COMMIT_FAILED transfer={transfer_id} by={by}：{e}"),
                );
                false
            }
        };
        bubble && ledger
    };
    let _ = s.app.emit("file-cancelled", transfer_id);
    let _ = s
        .app
        .emit("message-status-changed", &format!("gfile-{transfer_id}"));
    s.logger.info(
        "group_file",
        format!("群文件接收已按取消收尾 transfer={transfer_id} by={by} stopped={stopped} ledger_committed={ledger_committed}"),
    );
    Some(FileCancelResult {
        // 本机确实停了手，但台账没落地时不能说"已取消"（界面按 ledger_committed 改口径）。
        cancelled: ledger_committed,
        already_done: false,
        // 群接收侧的取消由调用方在收尾之后按 `send_cancel_notice` 的回报补上。
        notified_peer: false,
        ledger_committed,
    })
}

/// 「本机把这一单按已取消收尾」的**唯一**入口（B3）。
///
/// 两个调用方，语义是同一件事——"这一单不再继续了"：
///  · [`cancel_file_transfer`] —— 用户点了取消（`by = "user"`）；
///  · `transport::handle_file` 的 `FileCancel` 臂 —— **对端**取消了并通知我（`by = "peer"`）。
/// 共用这一条是刻意的：两条路径落的是同一格终态（INV-P26 里"取消"这一档的第二种来源），
/// 谁都不许自己再抄一份收尾；`by` 只进日志，不新增状态、不新增列。
///
/// 做五件事（顺序是文档化的，别重排）：
///
/// 1. 点亮 `file_send_cancels` 里这一单的所有在途槽位 —— send_file_from_path /
///    dispatch_group_file_to_peer 的 chunk loop 会 select! 到它，走 Cancelled 那条出口。
/// 2. 接收侧先停手（摘接收器 + 删 `.part`，见 B3a）。
/// 3. DB 层：**面向用户的写先做、把行踢出重试集合的写最后做**（同 `fail_file_job` 的顺序纪律，
///    判据自动扫全部收尾路径）；取消记 `cancelled`，不记 `failed`（INV-P26）。
///    已经 `done` 的行不会被降级（`done` 闸门），盖了墓碑的行不会被写回 active/done。
/// 4. 群文件：本机是发送方时按成员落 `cancelled`（B2）。
/// 5. 通知前端 emit `file-cancelled` + `message-status-changed`。
///
/// 如果这一单没有匹配的在途投递任务（排队中、或任务已经退出），取消**照样成立**：
/// 落库与 emit 都照做 —— 用户按了取消，界面必须立刻响应。返回值说的是台账，不是内存。
pub(crate) async fn apply_local_cancel(
    s: &Arc<AppState>,
    transfer_id: &str,
    by: &str,
) -> FileCancelResult {
    // 0. 群文件的**接收**侧（B3b）：这一单在 `file_transfers` 里根本没有行（群文件是另一本账），
    //    所以必须先认出来，否则下面的每一步都"成立但什么也没动"，而 emit 会让界面显示已取消 ——
    //    那正是这条分支要消灭的谎话（接收器还在写 `.part`、下一次 Offer 还会把它拉起来）。
    if let Some(res) = cancel_group_receive_side(s, transfer_id, by).await {
        return res;
    }

    // 1. 发 cancel 信号 —— 一个 transfer_id 可能对应**多条**在途流（群文件是每个成员一条，
    //    登记键见 `file::file_cancel_key`），必须按前缀全部命中，不能只拿一条。
    let signalled = file::signal_cancel_slots(s, transfer_id) > 0;

    // 2. DB 层：单聊 outbox + 消息状态 + transfer
    //    群文件不走 file_outbox（走 group_files 表），但我们仍然 mark cancelled ——
    //    语义：用户主动停止用 "cancelled"，自动失败用 "failed"。
    //    ⚠️ 这句注释此前是**谎话**：紧接着调的是 `mark_file_outbox_failed`，
    //    `file_outbox` 里落下的是 'failed' ⇒ 排查"这单为什么失败"的人会读到一个用户自己
    //    按下的取消。三条队列查询只认 pending/sending，所以功能等价、台账不等价。
    //    终态守卫保证幂等：已 delivered/read 的不会被覆盖；已 done 的传输行也不会被降级
    //    （INV-P26）。
    //
    // 1b. 方向分派（B3a）：接收中的那一单没有"在途发送任务"可通知 —— 取消的含义是
    // **本机停手**：摘掉接收器、删掉 `.part`（不留下会被下一次投递当成续传前缀的半截文件）、
    // 内容状态记成 Rejected（不自动重取）。台账那一笔仍然只走下面那一个出口。
    // 群文件的接收侧在**上面第 0 步**就分流走了（它不在这张表里）。
    let is_receive = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::get_transfer_route(&dbc, transfer_id).is_some_and(|(d, _)| d == "receive")
    };
    let receive_stopped = if is_receive {
        // 删文件 + 落内容状态都是阻塞活 ⇒ 挪出 tokio worker（INV-P34，与 `get_transfers` 同形）
        let s2 = s.clone();
        let tid = transfer_id.to_string();
        match tokio::task::spawn_blocking(move || file::cancel_receive(&s2, &tid)).await {
            Ok(stopped) => stopped,
            Err(e) => {
                s.logger.error(
                    "file",
                    format!("取消接收的收尾任务被线程池中断 transfer={transfer_id}：{e}（.part 可能还在）"),
                );
                false
            }
        }
    } else {
        false
    };

    // 「已送达」要在动手写之前问一次：`finalize_file_failure` 里的 `done` 闸门会拒绝降级，
    // 所以这一读的用途只有"给界面说实话"，不参与任何写序（写在后面，破坏性写仍在最后）。
    let already_done = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::is_transfer_done(&dbc, transfer_id).unwrap_or(false)
    };
    // 台账这一笔是否全部落地（FUNC-02：任何一处 `Err` 都会把事务整体回滚）。
    let mut ledger_committed = true;
    {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        // 落库并入唯一出口（同一份顺序与 `done` 闸门）。取消与失败的区别在这里说得通：
        // 用户取消的是**整条消息**（1:1 与群文件共用这个入口）⇒ `gfile-` 该写；
        // 而超时/放弃只代表"某一个收件人没收到"，不该改写群气泡（见
        // `db::finalize_file_failure` 与 `expired_file_does_not_touch_the_group_bubble`）。
        // 取消一律照实响应：emit 不被门控（本机已经停手，界面必须立刻回话）。
        //
        // FUNC-02：**`Err` 不再被吞掉**。四笔写共处一个事务，失败即整体回滚；此时界面
        // 说"已取消"就是假话（刷新后还是发送中）。记 `CANCEL_COMMIT_FAILED` 并把
        // `ledger_committed=false` 回传给界面，让文案改说"本机已停止、状态待重试"。
        match db::finalize_file_failure(&dbc, transfer_id, db::FileJobEnd::Cancelled) {
            Ok(_) => {}
            Err(e) => {
                s.logger.error(
                    "file",
                    format!("code=CANCEL_COMMIT_FAILED transfer={transfer_id} by={by}：{e}"),
                );
                ledger_committed = false;
            }
        }
    }

    // 2b. 群文件（B2）：用户取消的是**整条消息** ⇒ 每个还没到终态的成员都要落 cancelled。
    // 少这一步的真实后果不是"界面上少一行"，而是**文件会被再发一遍**：
    //  · 离线补发那条路在成员重新上线时捞 `pending` 的收件人行（`list_pending_group_files_for_recipient`）；
    //  · 投递失败/续传的复位入口 `db::upsert_group_file_receive`（接收端与续传都走它，
    //    由 `transport::group_file::ensure_group_file_row` 调用）以前把非 completed 的行
    //    一律复位成 `sending` ⇒ 已取消的成员会在"同一单再来一次"时被点亮。
    // 两处都改过之后（见 db/group_files.rs 那两条 NOT IN ('completed','cancelled')），
    // 已取消的成员既不被补发、也不被点亮。
    // 只在本机是**发送方**时动这两张表：收件端那条 `group_files` 行是"别人发给我的"，
    // 取消它属于接收侧协议（B3 的 Cancel 帧），不在这一批。
    let cancelled_recipients = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        let mine = db::get_group_file(&dbc, transfer_id)
            .map(|f| f.sender_id == s.device_id)
            .unwrap_or(false);
        if mine {
            // 成员行与聚合行在同一个事务里（FUNC-02 复审）：分开写的半落地态是
            // "成员行已 cancelled、聚合行还在 sending"，界面与补发判据互相矛盾。
            match db::cancel_group_file_atomically(&dbc, transfer_id) {
                Ok(n) => n,
                Err(e) => {
                    s.logger.error(
                        "group_file",
                        format!("code=GROUP_CANCEL_COMMIT_FAILED transfer={transfer_id} by={by}：{e}"),
                    );
                    ledger_committed = false;
                    0
                }
            }
        } else {
            0
        }
    };

    // 3. 通知前端
    let _ = s.app.emit("file-cancelled", &transfer_id);
    let _ = s
        .app
        .emit("message-status-changed", &format!("file-{transfer_id}"));
    let _ = s
        .app
        .emit("message-status-changed", &format!("gfile-{transfer_id}"));

    s.logger.info(
        "file",
        format!(
            "文件传输按已取消收尾 transfer={transfer_id} by={by} (cancel_signal={signalled} already_done={already_done} group_recipients_cancelled={cancelled_recipients} receive_stopped={receive_stopped} ledger_committed={ledger_committed})"
        ),
    );

    FileCancelResult {
        // 台账没落地时不能说"已取消"：本机停了手，但刷新后消息还会显示发送中。
        cancelled: !already_done && ledger_committed,
        already_done,
        // 通知那一半在调用方（命令）之后补上；这里先给"没通知"。
        notified_peer: false,
        ledger_committed,
    }
}

/// 取消一单**按 cid 拉取内容**（任务中心「取消」；2026-10-25 Stage 4）。
///
/// 为什么按 cid 而不是 transfer_id：任务中心那一行只有 cid（内容台账的语义主键）。
/// 同一份内容可能同时从多个源接收 ⇒ 取消 = 把所有**仍在途的接收方向行**都收口。
///
/// 顺序即语义：
/// 1. 先停本机仍在跑的接收器（`cancel_receive`：摘登记、删 `.part`、记 Cancelled）；
/// 2. 再对每一条 live 行落 `FailReason::Cancelled` ⇒ `Rejected`（终态）。
///    记成 `Incomplete` 会被下次建链的 `retry_incomplete_content` **自动再拉一遍** ——
///    那正是用户说"取消了它又自己开始"的形状。
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContentCancelResult {
    /// 这一下真的停了还在途的拉取。
    pub cancelled: bool,
    /// 这一单已经收完/早就判死（那一下什么都没改）。
    pub already_done: bool,
    /// 被停下的接收器个数（>0 说明本机确实有一路在收）。
    pub stopped: usize,
    /// 台账那一笔是否全部落地；false = 界面该说「本机已停止、状态待刷新」。
    pub ledger_committed: bool,
}

#[tauri::command(async)]
pub async fn cancel_content_fetch(
    state: State<'_, Arc<AppState>>,
    cid: String,
) -> Result<ContentCancelResult, String> {
    let s = state.inner().clone();
    if cid.is_empty() {
        return Err("这条内容没有内容指纹，无法取消".to_string());
    }
    // SQLite 读写与 `.part` 删除都在阻塞池（INV-P34）：持锁做几笔写，占住 tokio worker
    // 会把整屏 IPC 一起拖慢（同 `cancel_message` 的理由）。
    let s_db = s.clone();
    tokio::task::spawn_blocking(move || -> Result<ContentCancelResult, String> {
        use crate::content::model::{Direction, FailReason, TransferStatus};
        let rows = {
            let dbc = s_db.db.lock().unwrap_or_else(|e| e.into_inner());
            crate::content::store::list_by_cid(&dbc, &cid)
                .map_err(|e| format!("读取内容台账失败：{e}"))?
                .into_iter()
                .filter(|r| r.direction == Direction::Receive)
                .collect::<Vec<_>>()
        };
        let live: Vec<_> = rows
            .into_iter()
            .filter(|r| {
                matches!(
                    r.status,
                    TransferStatus::Queued
                        | TransferStatus::Active
                        | TransferStatus::Verifying
                        | TransferStatus::Incomplete
                )
            })
            .collect();
        if live.is_empty() {
            return Ok(ContentCancelResult {
                cancelled: false,
                already_done: true,
                stopped: 0,
                ledger_committed: true,
            });
        }

        // ① 停接收器（它自己会记一次 Cancelled；这里不持着 db 锁去调它，否则自己等自己）。
        let mut stopped = 0usize;
        let mut stopped_ids: Vec<String> = Vec::new();
        for r in &live {
            if let Some(tid) = r.transfer_id.as_deref().filter(|t| !t.is_empty()) {
                if crate::network::file::cancel_receive(&s_db, tid) {
                    stopped += 1;
                    stopped_ids.push(tid.to_string());
                }
            }
        }

        // ② 台账收口（对没有接收器的行也必须落，否则任务中心那一行会一直挂着）。
        let now = db::now_ms();
        let ledger_committed = {
            let dbc = s_db.db.lock().unwrap_or_else(|e| e.into_inner());
            live.iter().all(|r| {
                crate::content::store::record_failure(
                    &dbc,
                    &r.cid,
                    &r.peer_id,
                    Direction::Receive,
                    FailReason::Cancelled,
                    now,
                )
                .is_ok()
            })
        };

        // ③ 通知界面：被停下的那些接收器与文件取消是同一件事（气泡/传输列表据此收尾）。
        for tid in &stopped_ids {
            let _ = s_db.app.emit("file-cancelled", tid);
        }
        s_db.logger.info(
            "file",
            format!(
                "用户取消内容拉取 cid={cid} rows={} stopped={stopped} ledger_committed={ledger_committed}",
                live.len()
            ),
        );
        Ok(ContentCancelResult {
            cancelled: true,
            already_done: false,
            stopped,
            ledger_committed,
        })
    })
    .await
    .map_err(|e| format!("取消内容拉取被线程池中断: {e}"))?
}

/// 用户手动取消一条**没传完**的文件（1:1 与群文件共用这个入口；发送中与接收中都算）。
///
/// 本机收尾走 [`apply_local_cancel`]，然后把"取消"这件事**告诉对端**（B3）：
/// 只在对端声明了 `CONTENT_FEATURE_FILE_CANCEL` 时才发（INV-P24 第 4 条），
/// 老端不发这条帧 ⇒ 它那边的行为与今天完全一致（会继续发/收，直到自己的 deadline）。
#[tauri::command(async)]
pub async fn cancel_file_transfer(
    state: State<'_, Arc<AppState>>,
    transfer_id: String,
) -> Result<FileCancelResult, String> {
    let s = state.inner();
    // 通知名单必须在收尾**之前**读：`apply_local_cancel` 会把成员行落成 cancelled，
    // 之后再看就只剩"已经取消的"，谁都收不到通知（顺序即语义）。
    let notice = plan_cancel_notice(s, &transfer_id);
    let mut res = apply_local_cancel(s, &transfer_id, "user").await;
    // 通知那半的结论回填到结果里（界面据此决定要不要说"对方可能仍在继续"）。
    res.notified_peer = send_cancel_notice(s, &transfer_id, notice).await;
    // 结局也要有码（审计 B1-F1）：失败那半早有 `FILE_CANCEL_LIST_FAILED`，成功/竞态没有行。
    // 用户报「点了取消、对方还在收」时，`already_done` / `notified_peer=false` 就是答案。
    //
    // ⚠️ 日志是**同步文件 append**（见 `worker_bound_heavy_commands_do_not_grow` 的重活标记表）
    // ⇒ 进阻塞池，别占 tokio worker：worker 数 = CPU 核数，而开设置窗这类命令也排同一个池。
    let s_log = s.clone();
    let tid = transfer_id.clone();
    let (cancelled, already_done, notified, committed) =
        (res.cancelled, res.already_done, res.notified_peer, res.ledger_committed);
    let _ = tokio::task::spawn_blocking(move || {
        s_log.logger.info(
            "file",
            format!(
                "code=FILE_CANCEL transfer={tid} by=user cancelled={cancelled} \
                 already_done={already_done} notified_peer={notified} ledger_committed={committed}"
            ),
        );
    })
    .await;
    Ok(res)
}

/// 撤回停传输时的**通知范围**。
///
/// 群主撤回别人的消息那一档必须是 `LocalOnly`：那条 `recall` 帧本来就全群广播，收到它的
/// 每台设备各自停本机那一笔就够；若每台都再发一份 `FileCancel`，一个撤回会变成 N 份取消
/// 通知（回声），而真正的发送方自己也会收到那条帧、由它停自己的发。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CancelNotify {
    /// 发起撤回那一侧：停本机 + 通知对端（今天的行为）。
    Peers,
    /// 收到撤回帧那一侧：只停本机，不再对外广播。
    LocalOnly,
}

/// 撤回一条**附件**消息时先把它的传输停掉（2026-10-28：附件也支持撤回）。
///
/// 为什么必须一起做：撤回只改**消息行**，不 cancel 的话对端还在收字节 —— 这正是 5.6.0
/// 把附件排除在撤回之外的全部理由。这里复用「取消发送」那整套（本地收尾 + `FileCancel`
/// 帧），于是「气泡已撤回、字节照样在发」不再可能。
///
/// 非附件消息（`msg_id` 没有 `file-` / `gfile-` 前缀）是空操作；已传完的单也是空操作
/// （取消是幂等的），都**不挡撤回本身**。
pub(crate) async fn cancel_transfer_for_recalled_message(
    s: &Arc<AppState>,
    msg_id: &str,
    notify: CancelNotify,
) {
    let Some(tid) = transfer_id_of_owner(msg_id) else {
        return;
    };
    // 已经传完的不碰：撤回只改消息行。对一条 done 的单再发 FileCancel / 落取消
    // 既无意义，还可能把「已完成」的成员行顶掉（INV-P26 的 `done` 闸门在两端都有，
    // 但"不发这条通知"比"指望两端闸门都兜住"更干净）。
    let finished = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::is_transfer_done(&dbc, tid).unwrap_or(false)
            || db::list_group_file_recipients(&dbc, tid)
                .map(|rows| {
                    !rows.is_empty()
                        && rows
                            .iter()
                            .all(|r| !matches!(r.status.as_str(), "pending" | "sending"))
                })
                .unwrap_or(false)
    };
    if finished {
        s.logger.info(
            "chat",
            format!("code=RECALL_TRANSFER_ALREADY_DONE msg={msg_id} tid={tid}（只撤消息行）"),
        );
        return;
    }
    // 通知名单在收尾**之前**读：落成 cancelled 之后就没人可通知了（与上面同一条顺序语义）。
    let notice = plan_cancel_notice(s, tid);
    let res = apply_local_cancel(s, tid, "user").await;
    let notified = match notify {
        CancelNotify::Peers => send_cancel_notice(s, tid, notice).await,
        // 收到撤回帧的那一侧：只停自己。名单照读但不发 —— 广播交给发起方。
        CancelNotify::LocalOnly => false,
    };
    s.logger.info(
        "chat",
        format!(
            "code=RECALL_CANCEL_TRANSFER msg={msg_id} tid={tid} cancelled={} notify={notify:?} \
             notified={notified}",
            res.cancelled
        ),
    );
}

/// 取消该通知谁 —— 三种形状，读一次台账就能分清。
///
/// 为什么要有这一层而不是在 `apply_local_cancel` 里顺手发：那条入口是**本机收尾**的家，
/// 它也被"对端已经取消了"那条路复用；在它里面发通知会造成"收到取消 → 又回一条取消"的回声。
enum CancelNotice {
    /// 1:1（发送或接收）。
    Dm { peer_id: String, direction: String },
    /// 群文件、本机是发送方：每个还在传的成员各一条。
    GroupMembers { group_id: String, members: Vec<String> },
    /// 群文件、本机是接收方：告诉发送方"这一格我不收了"。
    GroupSender { group_id: String, sender: String },
}

fn plan_cancel_notice(s: &AppState, transfer_id: &str) -> Option<CancelNotice> {
    let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((direction, peer_id)) = db::get_transfer_route(&dbc, transfer_id) {
        return Some(CancelNotice::Dm { peer_id, direction });
    }
    let gf = db::get_group_file(&dbc, transfer_id)?;
    if gf.sender_id == s.device_id {
        let members = db::list_group_file_recipients(&dbc, transfer_id)
            .unwrap_or_default()
            .into_iter()
            .filter(|r| r.status == "pending" || r.status == "sending")
            .map(|r| r.recipient_id)
            .collect();
        Some(CancelNotice::GroupMembers {
            group_id: gf.group_id,
            members,
        })
    } else {
        Some(CancelNotice::GroupSender {
            group_id: gf.group_id,
            sender: gf.sender_id,
        })
    }
}

/// 对端是否声明过"能处理取消帧"。门控只有这一处口径（INV-P24 第 4 条）。
fn peer_declares_file_cancel(s: &AppState, peer_id: &str) -> bool {
    s.peer_content_features
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(peer_id)
        .is_some_and(|f| f & crate::protocol::CONTENT_FEATURE_FILE_CANCEL != 0)
}

/// 取消的**通知**那一半：只发给声明过 `CONTENT_FEATURE_FILE_CANCEL` 的对端。
///
/// 发送失败（离线/队列满）**不回滚取消**：本机已经停了手，通知只是让对方也早点知道；
/// 对方自己有 deadline 与队列判死兜着，不会因此永远传下去。
/// 返回"至少有一条取消帧真的进了链路"（界面据此决定要不要说"对方可能仍在继续"）。
async fn send_cancel_notice(
    s: &Arc<AppState>,
    transfer_id: &str,
    notice: Option<CancelNotice>,
) -> bool {
    let Some(notice) = notice else {
        // 没记过账的单不通知：宁可不发，也不要发给一个猜出来的对端。
        return false;
    };
    match notice {
        CancelNotice::Dm { peer_id, direction } => {
            if !peer_declares_file_cancel(s, &peer_id) {
                s.logger.info(
                    "file",
                    format!(
                        "取消不通知对端 transfer={transfer_id} dir={direction} peer={peer_id}（对端未声明 FILE_CANCEL ⇒ 它自己会走到 deadline）"
                    ),
                );
                return false;
            }
            let msg = Message::FileCancel {
                transfer_id: transfer_id.to_string(),
                from: s.device_id.clone(),
            };
            match try_send(s, &peer_id, &msg).await {
                Ok(()) => {
                    s.logger.info(
                        "file",
                        format!("已通知对端取消 transfer={transfer_id} dir={direction} peer={peer_id}"),
                    );
                    true
                }
                Err(e) => {
                    s.logger.warn(
                        "file",
                        format!(
                            "通知对端取消没送出去 transfer={transfer_id} dir={direction} peer={peer_id}：{e}（本机取消已成立）"
                        ),
                    );
                    false
                }
            }
        }
        CancelNotice::GroupMembers { group_id, members } => {
            let mut any = false;
            for member in members {
                if !peer_declares_file_cancel(s, &member) {
                    continue;
                }
                let msg = Message::GroupFileCancel {
                    transfer_id: transfer_id.to_string(),
                    group_id: group_id.clone(),
                    recipient: member.clone(),
                    from: s.device_id.clone(),
                };
                match try_send(s, &member, &msg).await {
                    Ok(()) => any = true,
                    Err(e) => s.logger.warn(
                        "group_file",
                        format!("群文件取消通知没送到 recipient={member} transfer={transfer_id}：{e}（本机取消已成立）"),
                    ),
                }
            }
            any
        }
        CancelNotice::GroupSender { group_id, sender } => {
            if !peer_declares_file_cancel(s, &sender) {
                s.logger.info(
                    "group_file",
                    format!("群文件接收取消不通知发送方 transfer={transfer_id} sender={sender}（未声明 FILE_CANCEL）"),
                );
                return false;
            }
            let msg = Message::GroupFileCancel {
                transfer_id: transfer_id.to_string(),
                group_id,
                recipient: s.device_id.clone(),
                from: s.device_id.clone(),
            };
            match try_send(s, &sender, &msg).await {
                Ok(()) => {
                    s.logger.info(
                        "group_file",
                        format!("已通知发送方取消这一格 transfer={transfer_id} sender={sender}"),
                    );
                    true
                }
                Err(e) => {
                    s.logger.warn(
                        "group_file",
                        format!("群文件取消通知没送到 sender={sender} transfer={transfer_id}：{e}（本机取消已成立）"),
                    );
                    false
                }
            }
        }
    }
}

/// 请对端**按 cid 再发一份**内容（ADR-0019 Phase 3「点击重取」）。
///
/// 用户点一下未完成/校验失败的图片或文件时调用。对方**无需确认**：它按 cid 找到本地
/// 完整字节就直接回发一份 FileOffer（拥有即授权）。只发给 Hello 里声明了
/// CONTENT_FEATURE_PULL 的对端；旧端返回 Ok(false)（不打扰、不报错）。
#[tauri::command(async)]
pub async fn request_content(
    state: State<'_, Arc<AppState>>,
    peer_id: String,
    msg_id: String,
) -> Result<bool, String> {
    let s = state.inner();
    let (cid, name, size) = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        let content = db::get_message_preview_source(&dbc, &msg_id)
            .map(|(_sender, c)| c)
            .ok_or_else(|| "消息不存在".to_string())?;
        let v: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
        (
            v.get("sha256")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            v.get("name")
                .and_then(|x| x.as_str())
                .unwrap_or("file")
                .to_string(),
            v.get("size").and_then(|x| x.as_u64()).unwrap_or(0),
        )
    };
    if cid.is_empty() {
        return Err("这条内容没有内容指纹（对方版本较旧），无法重新获取".to_string());
    }
    // 能力协商：对方没声明拉取能力就不发新帧（向后兼容）。
    let supports = s
        .peer_content_features
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&peer_id)
        .copied()
        .unwrap_or(0)
        & crate::protocol::CONTENT_FEATURE_PULL
        != 0;
    if !supports {
        return Ok(false);
    }
    // 手动重取也尽量续传：读该内容在统一状态里的 transfer_id / 已收字节。
    let (transfer_id, from_bytes) = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        crate::content::store::get(
            &dbc,
            &cid,
            &peer_id,
            crate::content::model::Direction::Receive,
        )
        .ok()
        .flatten()
        .map(|r| (r.transfer_id.unwrap_or_default(), r.received))
        .unwrap_or_default()
    };
    let msg = Message::ContentRequest {
        from: s.device_id.clone(),
        cid,
        transfer_id,
        from_seq: 0,
        from_bytes,
        name,
        size,
    };
    match try_send(s, &peer_id, &msg).await {
        Ok(()) => Ok(true),
        Err(e) => Err(format!("无法联系对方：{e}")),
    }
}

/// 按**裸 cid** 请求内容 —— 合并转发卡片的读侧配套（ADR-0019 Phase 3）。
///
/// [`request_content`] 从**本机消息行**反查 cid；而卡片是快照（sender/kind/content/ts），
/// 对端机器上没有原始消息行，cid 与元信息只能来自卡片载荷本身。
/// 网络行为与 [`request_content`] 完全一致：服务端（`handle_message` 的
/// ContentRequest 分支）本来就只认 cid（`find_source`），授权规则也不变 ——
/// 好友、或该内容所属群的成员，拥有即授权。
/// 对端不具备拉取能力（旧版本）返回 Ok(false)，不打扰、不报错。
#[tauri::command(async)]
pub async fn request_content_by_cid(
    state: State<'_, Arc<AppState>>,
    peer_id: String,
    cid: String,
    name: String,
    size: u64,
) -> Result<bool, String> {
    let s = state.inner();
    if cid.is_empty() {
        return Err("这条内容没有内容指纹，无法重新获取".to_string());
    }
    // 能力协商：与 request_content 同一条规则 —— 对端没声明拉取能力就不发新帧。
    let supports = s
        .peer_content_features
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&peer_id)
        .copied()
        .unwrap_or(0)
        & crate::protocol::CONTENT_FEATURE_PULL
        != 0;
    if !supports {
        return Ok(false);
    }
    // 续传：已有 receive 记录就沿用 transfer_id / 已收字节（与 request_content 同口径）。
    let (transfer_id, from_bytes) = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        crate::content::store::get(
            &dbc,
            &cid,
            &peer_id,
            crate::content::model::Direction::Receive,
        )
        .ok()
        .flatten()
        .map(|r| (r.transfer_id.unwrap_or_default(), r.received))
        .unwrap_or_default()
    };
    let msg = Message::ContentRequest {
        from: s.device_id.clone(),
        cid,
        transfer_id,
        from_seq: 0,
        from_bytes,
        name,
        size,
    };
    match try_send(s, &peer_id, &msg).await {
        Ok(()) => Ok(true),
        Err(e) => Err(format!("无法联系对方：{e}")),
    }
}

/// 统一的内容传输状态（ADR-0019 Phase 1）：前端据此在气泡上显示
/// 发送中 / 等待对方在线 / 网络不佳 / 未完成·点击重试 / 完成。
///
/// 同 `get_transfers`：查询本身已有 `LIMIT 200`（不是一句"没界"的抱怨），
/// 但它是持 db 锁的读，挂在同步 `fn` 上就占住 tokio worker（R-18 同族）⇒ 进阻塞池。
#[tauri::command(async)]
pub async fn get_content_transfers(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<crate::content::TransferRecord>, String> {
    let s = state.inner().clone();
    tokio::task::spawn_blocking(move || -> Result<Vec<crate::content::TransferRecord>, String> {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        Ok(crate::content::store::list(&dbc, 200).unwrap_or_default())
    })
    .await
    .map_err(|e| format!("内容传输表读取被线程池中断: {e}"))?
}

/// 单聊文件的真实实现。**不再是 IPC 入口**：界面上只有 `send_file_auto` 这一条门。
/// 两条入口并存的后果是「没人调的那条不会跟着主路径一起改」—— 0-A3 收了门面，
/// 但这条实现当时仍是注册着的命令，这次才真正降级成模块内私有：
/// 删掉注册后编译器立刻指出 `send_file_auto` 是它唯一的调用者，
/// 那份「第二条入口」的账也因此第一次被算清。
async fn send_file(
    state: State<'_, Arc<AppState>>,
    friend_id: String,
    path: String,
) -> Result<String, String> {
    let s = state.inner();
    // 「和自己聊天」暂不支持附件（用户 2026-09-16：先只支持文本）。这里给明确原因，
    // 而不是让用户看到下面那句"对方不是好友"——那与自聊场景完全对不上。
    if friend_id == s.device_id {
        return Err("和自己聊天暂不支持图片或文件".to_string());
    }
    // 好友关系检查
    {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        if db::get_friend(&dbc, &friend_id).is_none() {
            return Err("对方不是好友，请先扫描添加好友之后再继续聊天。".to_string());
        }
    }
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("只能发送普通文件".to_string());
    }
    let size = meta.len();
    let name = file::derive_file_name(&path);
    let transfer_id = Uuid::new_v4().to_string();
    let subtype = file::classify_file_subtype(&name);
    // kind 只区分 image / file；subtype 通过 content JSON 保留细分
    let kind = if subtype == "image" { "image" } else { "file" };
    let rec = build_file_message(
        s,
        &transfer_id,
        &friend_id,
        &path,
        &name,
        size,
        kind,
        subtype,
    );
    // 注意：不能在持有 db 锁时调用 resolve_nickname（其内部会再次锁 db）。
    let nm = resolve_nickname(s, &friend_id);
    let preview = if kind == "image" {
        "[图片]".to_string()
    } else {
        format!("[文件] {name}")
    };
    {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        let tx = dbc.unchecked_transaction().map_err(|e| e.to_string())?;
        db::insert_message(&tx, &rec).map_err(|e| e.to_string())?;
        db::touch_conversation(&tx, &friend_id, "single", &nm, None, &preview, 0)
            .map_err(|e| e.to_string())?;
        // 先建立 file_transfers 记录，前端刷新传输列表后能立刻拿到进度条载体。
        db::upsert_transfer(
            &tx,
            &transfer_id,
            &friend_id,
            &name,
            size,
            "send",
            "pending",
            Some(path.as_str()),
            0.0,
        )
        .map_err(|e| e.to_string())?;
        db::insert_file_outbox(&tx, &transfer_id, &friend_id, None, &path, &name, size)
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    let _ = s.app.emit("message-received", &rec);

    let arc = state.inner().clone();
    let fid = friend_id.clone();
    tokio::spawn(async move {
        flush_pending_files(&arc, &fid).await;
    });
    Ok(transfer_id)
}
/// 拖进来的路径先看一眼：给"确认后再发送"的弹窗用（名字、大小、是不是目录）。
///
/// 只读元数据，**不碰发送链路**：发送时后端仍会自己再校验一次（目录/不存在/不可读）。
/// 有界：一次最多 200 条、单条路径 4096 字节 —— 这条命令由前端按拖拽事件的载荷调用。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DropPathInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub is_dir: bool,
}

/// `(async)` + `spawn_blocking`：函数体里是 `std::fs::metadata`（文件系统 IO）。
/// 同步命令会在 wry 的 IPC 回调里内联跑 ⇒ 读盘期间所有窗口一起卡死；
/// 而直接写成 `async fn` 又会把重活留在 tokio worker 上（两条判据各自钉着一半）。
#[tauri::command(async)]
pub async fn inspect_drop_paths(paths: Vec<String>) -> Vec<DropPathInfo> {
    tokio::task::spawn_blocking(move || inspect_drop_paths_blocking(paths))
        .await
        .unwrap_or_default()
}

fn inspect_drop_paths_blocking(paths: Vec<String>) -> Vec<DropPathInfo> {
    const MAX_PATHS: usize = 200;
    const MAX_PATH_LEN: usize = 4096;
    paths
        .into_iter()
        .take(MAX_PATHS)
        .filter(|p| !p.is_empty() && p.len() <= MAX_PATH_LEN)
        .map(|path| {
            let meta = std::fs::metadata(&path);
            let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
            DropPathInfo {
                name: file::derive_file_name(&path),
                // 目录的 `len()` 是文件系统自己的记账（macOS 上实测 96），不是"这个文件夹多大"
                // ⇒ 明确给 0，别让界面把一个无意义的数显示成体积。
                size: if is_dir {
                    0
                } else {
                    meta.as_ref().map(|m| m.len()).unwrap_or(0)
                },
                is_dir,
                path,
            }
        })
        .collect()
}

/// 统一文件发送入口：当前稳定版统一走「直连 + 离线队列」。
/// 只要好友最终上线，文件就会在连接事件触发时自动补发，不再依赖不可达的中继路径。
#[tauri::command]
pub async fn send_file_auto(
    state: State<'_, Arc<AppState>>,
    friend_id: String,
    path: String,
    msg_id: Option<String>,
) -> Result<String, String> {
    let s = state.inner();
    // `msg_id` 给了 ⇒ 这是"转发一条已有消息"：路径必须归那条消息（SEC-01 同一判据）。
    // 不给 ⇒ 用户自己挑的文件（对话框里的选择就是授权），不拦。
    //
    // ⚠️ INV-P34：canonicalize 与 `owned_payload_rejection`（要拿 DB 锁）都是重活，
    // 整段进阻塞池 —— 留在 async 命令体里会占住 tokio worker（worker 棘轮实测 31→32）。
    if let Some(msg_id) = msg_id {
        let s2 = s.clone();
        let path2 = path.clone();
        let peer2 = friend_id.clone();
        let rejected = tokio::task::spawn_blocking(move || -> Result<Option<&'static str>, String> {
            let requested = std::fs::canonicalize(&path2).map_err(|e| e.to_string())?;
            let code = owned_payload_rejection(&s2, &msg_id, &requested);
            if let Some(code) = code {
                s2.logger.warn(
                    "file",
                    format!("code={code} 拒绝转发 file={path2} msg={msg_id} peer={peer2}"),
                );
            }
            Ok(code)
        })
        .await
        .map_err(|e| format!("转发路径校验被线程池中断: {e}"))??;
        if rejected.is_some() {
            return Err("这个文件不属于这条消息，已拒绝转发".to_string());
        }
    }
    send_file(state, friend_id, path).await
}

/// 传输表快照（10-22 审计 R-18 的一处）：整读进阻塞池。
///
/// 前端每次文件活动后都会拉一回这条（`refreshTransfers`），且持着那唯一一条 db 连接的锁。
/// 挂在同步 `fn` 上的 `#[tauri::command(async)]` 不是豁免 —— 宏把函数体投进
/// `async_runtime::spawn`，跑的是 tokio worker（INV-P34 那段推导在 `helpers.rs`）。
///
/// DB-03 之后 `list_transfers` 本身是**有界**的（未完成 + 最近 N 条终态），
/// 所以这里不再随历史行数线性变慢；线程挪对这件事仍然保留。
#[tauri::command(async)]
pub async fn get_transfers(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<TransferInfo>, String> {
    let s = state.inner().clone();
    let s_db = s.clone();
    let mut list = tokio::task::spawn_blocking(move || -> Result<Vec<TransferInfo>, String> {
        let dbc = s_db.db.lock().unwrap_or_else(|e| e.into_inner());
        Ok(db::list_transfers(&dbc).unwrap_or_default())
    })
    .await
    .map_err(|e| format!("传输表读取被线程池中断: {e}"))??;
    // 链路判据复用 `has_link`（就是 `flush_pending_files` 用的那一条），不另写一份：
    // “对方离线”和“队列记录丢失/重试耗尽”是两件事，前者只有内存链路知道。
    for row in &mut list {
        if row.direction == "send"
            && row.status == "pending"
            && row.blocked_reason.is_none()
            && !s.has_link(&row.peer_id).await
        {
            row.blocked_reason = Some("peer_offline".to_string());
        }
    }
    Ok(list)
}

// ---------------- 测试 ----------------
include!("files_tests.rs");
