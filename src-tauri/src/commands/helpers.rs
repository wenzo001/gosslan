// 职责边界：
// - 辅助工具：clipboard、媒体 present、文件预览路径解析
// ---------------- 辅助 ----------------

/// 将文件从 source 复制到 destination（用于"另存为"下载功能）。
///
/// `msg_id`：这条文件消息的 id。给了就必须满足「路径归这条消息」（SEC-01 的同一份判据，
/// 见 `commands/files.rs::owned_payload_rejection`）—— 消息内容里的 `path` 由**对端**写，
/// 不判就会变成"对端指定、本机复制任意文件"。不给只出现在用户自己挑文件的入口
/// （文件对话框里的选择是用户本人的授权）。
#[tauri::command(async)]
pub async fn copy_file(
    state: State<'_, Arc<AppState>>,
    source: String,
    destination: String,
    msg_id: Option<String>,
) -> Result<(), String> {
    let s = state.inner();
    if let Some(msg_id) = msg_id.as_deref() {
        let requested = std::fs::canonicalize(&source).map_err(|e| e.to_string())?;
        if let Some(code) = owned_payload_rejection(s, msg_id, &requested) {
            s.logger.warn(
                "file",
                format!("code={code} 拒绝另存为 source={source} msg={msg_id}"),
            );
            return Err("这个文件不属于这条消息，已拒绝保存".to_string());
        }
    }
    // Android 的「另存为」对话框返回的是 content:// URI，std::fs::copy 写不了，
    // 必须经 ContentResolver（见 android_open::save_path / OpenWith.saveWith）。
    #[cfg(target_os = "android")]
    {
        if destination.starts_with("content://") {
            return crate::android_open::save_path(&source, &destination);
        }
    }
    // ⚠️ INV-P34：`#[tauri::command(async)]` 挂在**同步 fn** 上不是豁免 —— 宏把整个函数体
    // 放进 `async_runtime::spawn` 的 future 里（tauri-macros 2.6.3 `command/wrapper.rs:249` +
    // tauri 2.11.5 `ipc/mod.rs:375`），跑的是 tokio **worker**，和所有 async 开窗命令、网络任务同池；
    // 本仓 `lib_window_tests.rs:225` 那条守卫的自述也是这句。"另存为"拷的是任意大小的接收文件
    // ⇒ 600 MB 就把一个 worker 按在磁盘复制上数秒。这里只换执行线程，签名与错误出口一字未改。
    let copied = {
        let s = source.clone();
        let d = destination.clone();
        tokio::task::spawn_blocking(move || std::fs::copy(&s, &d).map_err(|e| e.to_string()))
            .await
            .unwrap_or_else(|e| Err(format!("另存复制任务被线程池中断: {e}")))
    };
    copied?;
    Ok(())
}

/// 把文件本体写入系统剪贴板（Windows CF_HDROP）。
/// 之后既可在资源管理器 / 桌面 Ctrl+V 粘贴出文件，也可粘贴回聊天框直接发送（微信式）。
#[tauri::command(async)]
pub async fn copy_file_to_clipboard(path: String) -> Result<(), String> {
    // 剪贴板是**系统级独占资源**：别的程序正开着它时这里会等（Windows 还带 10 次重试）⇒ 必须在阻塞池。
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        #[cfg(target_os = "windows")]
        {
            use clipboard_win::Setter;
            if !std::path::Path::new(&path).is_file() {
                return Err(format!("文件不存在或不可访问：{path}"));
            }
            let _clip = clipboard_win::Clipboard::new_attempts(10)
                .map_err(|e| format!("无法访问系统剪贴板：{e}"))?;
            clipboard_win::formats::FileList
                .write_clipboard(&[path.as_str()])
                .map_err(|e| format!("复制文件到剪贴板失败：{e}"))
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = path;
            Err("当前平台暂不支持复制文件到剪贴板".into())
        }
    })
    .await
    .map_err(|e| format!("剪贴板写入被线程池中断: {e}"))?
}

/// 读取剪贴板里的文件路径列表（CF_HDROP）。空列表表示剪贴板里没有真实文件
/// （截图 / 网页图片是位图数据，不是文件）。供输入框粘贴时区分「粘贴文件」与「粘贴图片」。
#[tauri::command(async)]
pub async fn read_clipboard_file_paths() -> Result<Vec<String>, String> {
    // 同 `copy_file_to_clipboard`：读剪贴板也可能被别的程序占住（这条在粘贴路径上，每按一次 Ctrl+V 打一次）。
    tokio::task::spawn_blocking(read_clipboard_file_paths_blocking)
        .await
        .map_err(|e| format!("剪贴板读取被线程池中断: {e}"))
}

fn read_clipboard_file_paths_blocking() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        // 读不到（格式不符 / 被占用）一律按"无文件"处理，前端回退到图片粘贴分支。
        let paths: Vec<String> =
            clipboard_win::get_clipboard(clipboard_win::formats::FileList).unwrap_or_default();
        paths
    }
    #[cfg(not(target_os = "windows"))]
    {
        Vec::new()
    }
}

/// 将 base64 数据写入目标路径（用于图片消息"另存为"：前端把 dataURL 解出 base64 传回）。
///
/// 解码 + 整文件写盘都不许留在 tokio worker 上（10-22 审计 R-18 同族；`copy_file` 已按这条改过，
/// 推导见上面那段 INV-P34）。这条的体积**没有上限**：前端解多大我们就写多大。
#[tauri::command(async)]
pub async fn save_data_file(base64_data: String, destination: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || save_data_file_blocking(base64_data, destination))
        .await
        .unwrap_or_else(|e| Err(format!("另存写入被线程池中断: {e}")))
}

fn save_data_file_blocking(base64_data: String, destination: String) -> Result<(), String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data.as_bytes())
        .map_err(|e| e.to_string())?;
    // 体积闸（审计 P1 #10）：这条是**图像另存**的字节通道（base64 经 IPC，1.33× 放大，
    // 解码后又是一份）⇒ 不设上限时单次 IPC 可申请数百 MB，`panic = "abort"` 下 OOM 直接杀进程。
    // 与粘贴图片同一上限、同一常量（它本来就只服务图片另存）。
    if bytes.len() as u64 > MAX_OUTGOING_IMAGE_BYTES {
        return Err(format!(
            "图片过大（{} 字节，上限 {} 字节），未保存",
            bytes.len(),
            MAX_OUTGOING_IMAGE_BYTES
        ));
    }
    // Android：目标可能是 content:// URI，std::fs::write 写不了，走 ContentResolver。
    #[cfg(target_os = "android")]
    {
        if destination.starts_with("content://") {
            return crate::android_open::save_bytes(&bytes, &destination);
        }
    }
    std::fs::write(&destination, bytes).map_err(|e| e.to_string())?;
    Ok(())
}

/// 按 `msg_id` / `cid` 把本机媒体另存到用户选择的目的地。
///
/// 与 `save_data_file` 的区别：这条**不经过 base64 IPC** —— 源文件本来就在后端
/// （接收落盘 / 自选发送 / content store），前端只需要给出"哪一条"和"存到哪"。
/// 大图另存时省掉 JS 堆里的 base64 与 JSON 载荷；Android 的 `content://` 目的地
/// 复用 `copy_file` 已经验证过的 ContentResolver 分支。
#[tauri::command(async)]
pub async fn save_media_as(
    state: State<'_, Arc<AppState>>,
    msg_id: Option<String>,
    cid: Option<String>,
    destination: String,
) -> Result<(), String> {
    let s = state.inner();
    let source = if let Some(id) = msg_id.as_deref() {
        match resolve_media_path(s, id) {
            MediaPath::Present(p) => *p,
            MediaPath::Unknown(e) => return Err(e),
            MediaPath::Gone => return Err("文件不存在".to_string()),
        }
    } else if let Some(cid) = cid.as_deref() {
        let path = {
            let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
            crate::content::store::find_local_path(&dbc, cid)
        }
        .ok_or_else(|| "文件不存在".to_string())?;
        let file = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
        if !file.is_file() {
            return Err("文件不存在".to_string());
        }
        file
    } else {
        return Err("缺少图片来源".to_string());
    };

    #[cfg(target_os = "android")]
    {
        if destination.starts_with("content://") {
            return crate::android_open::save_path(&source.to_string_lossy(), &destination);
        }
    }
    let (src, dst) = (source, destination);
    tokio::task::spawn_blocking(move || std::fs::copy(&src, &dst).map_err(|e| e.to_string()))
        .await
        .unwrap_or_else(|e| Err(format!("另存任务被线程池中断: {e}")))?;
    Ok(())
}

/// 解析 `msg_id` 指向的本地媒体文件的结果。
///
/// 由 `read_file_preview` 与 `media_present` 共用，避免出现第二份路径解析实现
/// （安全边界必须只有一处）。
enum MediaPath {
    /// 文件存在且通过安全校验。
    Present(Box<PathBuf>),
    /// 查不到这条消息 / 元数据缺路径 / 路径未通过安全校验 —— **无法判断**媒体是否还在。
    /// 尚未落库的乐观消息会落到这里，因此调用方不能据此断言"已被清理"。
    /// 附带面向用户的错误文案。
    Unknown(String),
    /// 消息记录里的路径已解析不到文件 —— 已被「存储清理」删除。
    Gone,
}

/// 校验并解析 `msg_id` 的媒体路径。
///
/// 安全边界：路径必须落在 downloads 目录内（接收方文件），或该消息由本机发出
/// （发送方自选的文件）——两者都不允许对端通过消息内容诱导读取本机任意路径。
fn resolve_media_path(s: &AppState, msg_id: &str) -> MediaPath {
    let Some((sender_id, content)) =
        db::get_message_preview_source(&s.db.lock().unwrap_or_else(|e| e.into_inner()), msg_id)
    else {
        return MediaPath::Unknown("消息不存在".to_string());
    };
    let Some(path) = serde_json::from_str::<serde_json::Value>(&content)
        .ok()
        .and_then(|v| {
            v.get("path")
                .and_then(|p| p.as_str())
                .map(|p| p.to_string())
        })
    else {
        return MediaPath::Unknown("元数据缺少路径".to_string());
    };

    // msg_id → transfer_id：接收侧单聊是 file-{id}，群文件是 gfile-{id}。
    let transfer_id = msg_id
        .strip_prefix("file-")
        .or_else(|| msg_id.strip_prefix("gfile-"));
    let in_flight = transfer_id
        .map(|tid| {
            s.file_receivers
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .contains_key(tid)
                || s.group_file_receivers
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .contains_key(tid)
        })
        .unwrap_or(false);
    let Ok(file) = std::fs::canonicalize(&path) else {
        // **文件还没落盘 ≠ 已被清理**：接收方在 FileDone 之前写的是 <transfer_id>.part，
        // final 路径尚不存在。若这里报 Gone，前端会把"正在接收的图片"标成「已被清理」并
        // 缓存下来，从此再也不会重读（真机：图片时好时坏、要重发才出来）。
        // 在途 ⇒ 报 Unknown，让前端保持"加载中"，等 FileDone 落盘后再读。
        return if in_flight {
            MediaPath::Unknown("仍在接收".to_string())
        } else {
            MediaPath::Gone
        };
    };
    let under_downloads = std::fs::canonicalize(
        s.downloads_dir
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_path(),
    )
    .map(|dir| file.starts_with(dir))
    .unwrap_or(false);
    if !under_downloads && sender_id != s.device_id {
        return MediaPath::Unknown("路径越权".to_string());
    }
    match std::fs::metadata(&file) {
        Ok(meta) if meta.is_file() => MediaPath::Present(Box::new(file)),
        Ok(_) => MediaPath::Unknown("非普通文件".to_string()),
        Err(_) => MediaPath::Gone,
    }
}

/// 媒体是否**仍在本机**（未被存储清理删除）。
///
/// 前端据此把"已被清理"的消息渲染成明确提示，而不是一个空白/裂开的图片框——后者
/// 会让人误以为是对端发来的文件本身有问题。只有能确定「文件已被删除」时才返回 `false`；
/// 查不到消息（例如尚未落库的乐观消息）一律按"存在"处理，绝不能把在途消息误标成已清理。
#[tauri::command(async)]
pub async fn media_present(state: State<'_, Arc<AppState>>, msg_id: String) -> Result<bool, String> {
    let s = state.inner().clone();
    // 每一条媒体气泡渲染都可能问到它 ⇒ 这次 stat 不该留在 worker 上（审计 R-18）。
    tokio::task::spawn_blocking(move || -> Result<bool, String> {
        Ok(!matches!(resolve_media_path(&s, &msg_id), MediaPath::Gone))
    })
    .await
    .map_err(|e| format!("媒体副本检查被线程池中断: {e}"))?
}

/// 读取附件预览内容（原始字节，不走 base64 IPC）。
///
/// 按 `msg_id` 反查记录里的本地 `path` 再读，前端据此渲染图片（→Blob/objectURL）
/// 或代码（→TextDecoder）。安全边界见 [`resolve_media_path`]。
/// 超过 `max_bytes` 返回 "TOO_LARGE"，由前端回退文件卡片；文件已被清理返回
/// "文件不存在"，由前端渲染成「已清理」占位。
#[tauri::command]
pub async fn read_file_preview(
    state: State<'_, Arc<AppState>>,
    msg_id: String,
    max_bytes: u64,
) -> Result<tauri::ipc::Response, String> {
    let s = state.inner().clone();
    // 预览最大 15MiB：`canonicalize` 与 `read` 可能落在慢盘/网络盘上，
    // 必须离开 async worker（与导出、整份哈希同一条规矩）。
    tauri::async_runtime::spawn_blocking(move || -> Result<tauri::ipc::Response, String> {
        let max_bytes = max_bytes.min(15 * 1024 * 1024);
        let file = match resolve_media_path(&s, &msg_id) {
            MediaPath::Present(p) => *p,
            MediaPath::Unknown(e) => return Err(e),
            MediaPath::Gone => return Err("文件不存在".to_string()),
        };
        let meta = std::fs::metadata(&file).map_err(|e| e.to_string())?;
        if meta.len() > max_bytes {
            return Err("TOO_LARGE".to_string());
        }
        let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|e| format!("预览读取任务失败：{e}"))?
}

// ---------------- peer 投递槽位闸门 ----------------

/// 「该 peer 正在跑投递任务」的登记表
/// （`AppState::file_sending` 与 `AppState::group_file_sending` 都是它）。
pub(crate) type PeerSendSet = std::sync::Mutex<std::collections::HashSet<String>>;

/// 抢占一个 peer 的投递槽位。
/// `true` = 抢到，调用方要么把 [`PeerSendGuard`] 送进任务、要么自己走
/// [`release_peer_send`] 归还；`false` = 已有任务在跑，直接返回并保持 pending。
pub(crate) fn mark_peer_sending(set: &PeerSendSet, peer: &str) -> bool {
    set.lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(peer.to_string())
}

/// 归还槽位（早退路径用；任务体的归还交给 [`PeerSendGuard`] 的 Drop）。
pub(crate) fn release_peer_send(set: &PeerSendSet, peer: &str) {
    set.lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(peer);
}

/// 槽位的 RAII 持有者。
///
/// 为什么必须有它：1:1 与群文件两条投递循环原先都把 `remove` 手写在 spawn 体的**末尾**，
/// 而体里任何一次 panic（含被 drop）都会跳过它 ⇒ 这个 peer 之后所有文件永远抢不到槽位，
/// 界面只停在「发送中 0%」且不报任何错。守卫在正常结束 / panic 展开 / future 被 drop
/// 三种出口都会归还（同层里 `DialGuard`、`WireLedger` 是同一族先例）。
pub(crate) struct PeerSendGuard<'a> {
    set: &'a PeerSendSet,
    peer: String,
}

impl<'a> PeerSendGuard<'a> {
    /// 接管一个**已抢占**的槽位（不与 `mark_peer_sending` 重复 insert）。
    pub(crate) fn new(set: &'a PeerSendSet, peer: &str) -> Self {
        Self {
            set,
            peer: peer.to_string(),
        }
    }
}

impl Drop for PeerSendGuard<'_> {
    fn drop(&mut self) {
        release_peer_send(self.set, &self.peer);
    }
}

// ---------------- 测试 ----------------
include!("helpers_tests.rs");
