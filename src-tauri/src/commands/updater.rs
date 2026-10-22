// 应用内更新（桌面端）。
//
// 为什么没有直接用 `@tauri-apps/plugin-updater` 的 JS API：官方 JS 的 `download()` 没有
// 取消入口（`Update.close()` 只释放资源，不会中止已经在飞的下载）。本需求要求“取消下载”
// 必须真的停下任务，所以这里用官方 crate 的 `UpdaterExt` / `Update::download` /
// `Update::install`，只额外包一层 `tokio::select!`：
//   · 清单解析、平台选择、签名校验、安装全部仍由官方插件完成；
//   · 取消时直接 drop download future（请求中断、内存里的半包一起释放），
//     没有落盘临时文件、没有启动安装器，因此不需要额外的清理协议。
// 下载的字节由官方 `Update::download` 校验签名后整块返回（官方实现就是内存缓冲），
// 我们只把发布产物限制在较小的默认安装包（Windows 基础 NSIS / macOS .app.tar.gz）；
// WebView2 内置包（近 200MB）不进入更新清单，避免这一次内存峰值。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub version: String,
    pub notes: Option<String>,
    pub published_at: Option<i64>,
}

// 移动端只用它做命令参数类型，不会构造任何变体；桌面端由下载闭包构造。
#[cfg_attr(not(desktop), allow(dead_code))]
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum DownloadEvent {
    #[serde(rename = "Started")]
    Started {
        #[serde(rename = "contentLength")]
        content_length: Option<u64>,
    },
    #[serde(rename = "Progress")]
    Progress {
        #[serde(rename = "chunkLength")]
        chunk_length: usize,
    },
    #[serde(rename = "Finished")]
    Finished,
}

#[cfg(desktop)]
mod desktop {
    use super::{DownloadEvent, UpdateInfo};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tauri::ipc::Channel;
    use tauri::{AppHandle, State};
    use tauri_plugin_updater::{Update, UpdaterExt};
    use tokio::sync::Notify;

    pub const CANCELLED: &str = "UPDATER_CANCELLED";
    /// 清单请求的硬上限：离线/DNS 失败必须在十几秒内结束，不能把启动拖住。
    const CHECK_TIMEOUT: Duration = Duration::from_secs(12);
    /// 下载请求的总超时。
    ///
    /// ⚠️ 这是 reqwest 的**整请求**超时，不是"多久没数据"。120s 在手机热点 / 跨网段下
    /// 传不完一个几十 MB 的安装包 ⇒ 必然在 99% 报"更新失败"，而且重试多少次都一样。
    /// 给 30 分钟：仍然有界（挂死的连接不会永远占着下载锁），但不会误杀慢速链路。
    const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(1800);

    #[derive(Default)]
    pub struct UpdaterSession {
        update: Mutex<Option<Update>>,
        bytes: Mutex<Option<Vec<u8>>>,
        cancel: Mutex<Option<Arc<Notify>>>,
        checking: AtomicBool,
        downloading: AtomicBool,
    }

    impl UpdaterSession {
        fn clear(&self) {
            *self.update.lock().unwrap_or_else(|e| e.into_inner()) = None;
            *self.bytes.lock().unwrap_or_else(|e| e.into_inner()) = None;
        }
    }

    #[tauri::command]
    pub async fn updater_check(
        app: AppHandle,
        state: State<'_, UpdaterSession>,
    ) -> Result<Option<UpdateInfo>, String> {
        if state.downloading.load(Ordering::SeqCst) {
            return Err("更新正在下载，稍后再检查".to_string());
        }
        if state
            .checking
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("更新检查正在进行".to_string());
        }
        state.clear();
        let result = async {
            let updater = app
                .updater_builder()
                .timeout(CHECK_TIMEOUT)
                .build()
                .map_err(|e| e.to_string())?;
            match updater.check().await.map_err(|e| e.to_string())? {
                Some(update) => {
                    let info = UpdateInfo {
                        current_version: update.current_version.clone(),
                        version: update.version.clone(),
                        notes: update.body.clone(),
                        published_at: update.date.map(|d| d.unix_timestamp()),
                    };
                    *state.update.lock().unwrap_or_else(|e| e.into_inner()) = Some(update);
                    Ok(Some(info))
                }
                None => Ok(None),
            }
        }
        .await;
        state.checking.store(false, Ordering::SeqCst);
        result
    }

    #[tauri::command]
    pub async fn updater_download(
        state: State<'_, UpdaterSession>,
        on_event: Channel<DownloadEvent>,
    ) -> Result<(), String> {
        if state
            .downloading
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("更新已在下载".to_string());
        }
        let result = async {
            let update = state
                .update
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
                .ok_or_else(|| "没有可下载的更新".to_string())?;
            let mut update = update;
            update.timeout = Some(DOWNLOAD_TIMEOUT);
            *state.bytes.lock().unwrap_or_else(|e| e.into_inner()) = None;

            let cancel = Arc::new(Notify::new());
            *state.cancel.lock().unwrap_or_else(|e| e.into_inner()) = Some(cancel.clone());
            let progress = on_event.clone();
            let finished = on_event.clone();
            let mut first_chunk = true;
            let download = update.download(
                move |chunk_length, content_length| {
                    if first_chunk {
                        first_chunk = false;
                        let _ = progress.send(DownloadEvent::Started { content_length });
                    }
                    let _ = progress.send(DownloadEvent::Progress { chunk_length });
                },
                move || {
                    let _ = finished.send(DownloadEvent::Finished);
                },
            );
            let outcome = tokio::select! {
                result = download => Some(result),
                _ = cancel.notified() => None,
            };
            *state.cancel.lock().unwrap_or_else(|e| e.into_inner()) = None;
            match outcome {
                Some(Ok(bytes)) => {
                    *state.bytes.lock().unwrap_or_else(|e| e.into_inner()) = Some(bytes);
                    Ok(())
                }
                Some(Err(e)) => Err(e.to_string()),
                // 取消时 future 被 drop：HTTP 读取停止、半包 Vec 释放；没有文件/安装器状态。
                None => Err(CANCELLED.to_string()),
            }
        }
        .await;
        state.downloading.store(false, Ordering::SeqCst);
        result
    }

    #[tauri::command]
    pub fn updater_cancel(state: State<'_, UpdaterSession>) -> Result<(), String> {
        if let Some(cancel) = state
            .cancel
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            cancel.notify_one();
        }
        *state.bytes.lock().unwrap_or_else(|e| e.into_inner()) = None;
        Ok(())
    }

    #[tauri::command]
    pub async fn updater_install(
        // Windows 由官方 install 内部退出进程，不经过下面的 restart 分支。
        #[allow(unused_variables)] app: AppHandle,
        state: State<'_, UpdaterSession>,
    ) -> Result<(), String> {
        if state
            .downloading
            .load(Ordering::SeqCst)
        {
            return Err("更新仍在下载".to_string());
        }
        // ⚠️ 这里必须 clone 而不是 take：`install` 会在**验签/解包/复制**任一环节失败
        // （签名不符、磁盘满、目标目录被占）。take 掉之后这两个字段就空了，
        // 用户再点"安装"只会得到"没有可安装的更新"—— 几十 MB 已经下完，
        // 却被迫重新检查 + 重新下载。失败时保留现场，成功后再 clear。
        let update = state
            .update
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or_else(|| "没有可安装的更新".to_string())?;
        let bytes = state
            .bytes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or_else(|| "更新尚未下载完成".to_string())?;
        // 解包/验签/复制是同步重活：放到阻塞池，别占 tokio worker（单 runtime 会被饿死）。
        tokio::task::spawn_blocking(move || update.install(&bytes))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        state.clear();
        #[cfg(windows)]
        {
            // NSIS 安装器默认会在成功后重启应用；走到这里说明安装器已交棒。
            Ok(())
        }
        #[cfg(not(windows))]
        {
            // macOS/Linux：安装完成后由本进程重启到新版本。
            app.restart()
        }
    }

    #[tauri::command]
    pub fn updater_close(state: State<'_, UpdaterSession>) -> Result<(), String> {
        if let Some(cancel) = state
            .cancel
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            cancel.notify_one();
        }
        state.clear();
        Ok(())
    }
}

#[cfg(desktop)]
pub use desktop::*;

// 移动端不注册 updater 插件（官方插件只支持桌面）。命令仍注册，统一返回“不支持”，
// 这样 `generate_handler!` 不需要按平台拆成两份；前端在移动端也不会展示更新入口。
#[cfg(not(desktop))]
#[derive(Default)]
pub struct UpdaterSession;

#[cfg(not(desktop))]
#[tauri::command]
pub async fn updater_check() -> Result<Option<UpdateInfo>, String> {
    Err("应用内更新仅支持桌面端".to_string())
}

#[cfg(not(desktop))]
#[tauri::command]
pub async fn updater_download(
    _on_event: tauri::ipc::Channel<DownloadEvent>,
) -> Result<(), String> {
    Err("应用内更新仅支持桌面端".to_string())
}

#[cfg(not(desktop))]
#[tauri::command]
pub fn updater_cancel() -> Result<(), String> {
    Err("应用内更新仅支持桌面端".to_string())
}

#[cfg(not(desktop))]
#[tauri::command]
pub async fn updater_install() -> Result<(), String> {
    Err("应用内更新仅支持桌面端".to_string())
}

#[cfg(not(desktop))]
#[tauri::command]
pub fn updater_close() -> Result<(), String> {
    Err("应用内更新仅支持桌面端".to_string())
}
