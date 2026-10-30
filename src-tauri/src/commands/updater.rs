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

/// 更新这件事的**可查询状态**（B5）。
///
/// 为什么要有它：进度以前只走 `Channel<DownloadEvent>` —— 那个通道绑在**发起下载的那个窗口**上。
/// 设置窗口一关，进度就再也收不到（下载还在后台跑），重新打开设置只能看到"检查更新"按钮，
/// 用户不知道刚才那几十 MB 到底还在不在下。任务中心也没法列它（没有可查询的事实）。
///
/// 所以状态收进 `UpdaterSession`（全局 managed state，两个窗口共用），每次跃迁 emit 一条
/// `updater-status`，并把同一份快照留在命令里给"刚打开窗口"的补拉用。
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterStatus {
    /// `idle | checking | downloading | ready | installing | failed | cancelled`（桌面）；
    /// 移动端恒为 `unsupported`。
    pub phase: String,
    /// 已收到的字节（与 `total` 同口径：`total` 缺失时它是唯一读数）。
    pub downloaded: u64,
    /// 安装包总字节（服务端没给时为 None）。
    pub total: Option<u64>,
    /// 这一轮的目标版本（检查到更新之后才有）。
    pub version: Option<String>,
    /// `failed` 时的人话原因。
    pub error: Option<String>,
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
    use super::{DownloadEvent, UpdateInfo, UpdaterStatus};
    use semver::Version;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tauri::ipc::Channel;
    use tauri::{AppHandle, Emitter, State};
    use tauri_plugin_updater::{Update, UpdaterExt};
    use tokio::sync::Notify;

    pub const CANCELLED: &str = "UPDATER_CANCELLED";
    /// 安装相位的**名字**（`UpdaterStatus.phase` 的取值）。
    ///
    /// 它是一个**跨层契约**：Rust 写这一格、TS（`src/updater/service.ts`）按它判"能不能取消"。
    /// 以前两个 Rust 调用点各手抄一份字面量 —— 任一侧打错都不会编译失败，只会让
    /// 「安装中不可取消」静默失效（审计 B1-F3）。现在只许引用这个常量。
    pub const PHASE_INSTALLING: &str = "installing";
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
        /// 可查询状态（见 [`UpdaterStatus`] 的理由）。每次跃迁都写这里并 emit。
        ///
        /// `Arc<Mutex<…>>` 而不是裸 `Mutex<…>`：下载进度的回调是 `'static` 闭包，
        /// 它拿不到 `State` 的借用，只能 clone 一份句柄进去（节流时间戳同理）。
        status: Arc<Mutex<UpdaterStatus>>,
        /// 上一次 emit 的时刻（毫秒）：进度帧很密，全局事件按 250ms 节流，
        /// 否则一条 40MB 的下载会给整棵前端树打上万次事件。
        last_emit_ms: Arc<std::sync::atomic::AtomicI64>,
    }

    impl UpdaterSession {
        fn clear(&self) {
            *self.update.lock().unwrap_or_else(|e| e.into_inner()) = None;
            *self.bytes.lock().unwrap_or_else(|e| e.into_inner()) = None;
        }

        /// 改状态并广播（跃迁用，不节流）。广播本身只走 [`emit_now`] 那一处。
        fn set_status(&self, app: &AppHandle, f: impl FnOnce(&mut UpdaterStatus)) {
            {
                let mut st = self.status.lock().unwrap_or_else(|e| e.into_inner());
                f(&mut st);
            }
            emit_now(app, &self.status);
        }

        fn snapshot(&self) -> UpdaterStatus {
            self.status
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
        }
    }

    /// 立即广播一份快照（跃迁用）。
    fn emit_now(app: &AppHandle, status: &Mutex<UpdaterStatus>) {
        let snapshot = status.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let _ = app.emit("updater-status", &snapshot);
    }

    /// 进度帧的广播：250ms 节流（状态本身照写，查询读得到最新值）。
    fn emit_throttled(
        app: &AppHandle,
        status: &Mutex<UpdaterStatus>,
        last: &std::sync::atomic::AtomicI64,
    ) {
        let now = crate::db::now_ms();
        let prev = last.load(Ordering::Relaxed);
        if now.saturating_sub(prev) < 250 {
            return;
        }
        last.store(now, Ordering::Relaxed);
        emit_now(app, status);
    }

    /// 当前更新状态（B5）。两个窗口都能读；刚打开的窗口用它在首帧就把进度/完成态画对，
    /// 不必等下一次事件。
    #[tauri::command]
    pub fn updater_status(state: State<'_, UpdaterSession>) -> UpdaterStatus {
        state.snapshot()
    }

    /// 清单版本必须**严格高于**当前版本（禁止降级，2026-10-24 产品裁决）。
    ///
    /// 为什么要在自己的代码里再判一次：更新包是签名的，但「签名有效」只证明它出自发布者，
    /// 不证明它比现在新 —— 清单端点被换、或发布事故把旧包推上 `latest` 时，用户会被安静地
    /// 回滚到已知漏洞版本。官方插件内部也做版本比较，但那条判据住在上游、本仓钉不住；
    /// 这一道让结论能留下 `code=UPDATER_DOWNGRADE_BLOCKED` 的痕迹并明确告诉用户。
    ///
    /// 版本号解析失败按「不升级」处理（失败关闭）：清单形状不对时宁可拒绝并留痕，也不赌。
    pub(super) fn is_not_an_upgrade(current: &str, candidate: &str) -> bool {
        match (Version::parse(current), Version::parse(candidate)) {
            (Ok(current), Ok(candidate)) => candidate <= current,
            _ => true,
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
        state.set_status(&app, |st| {
            st.phase = "checking".to_string();
            st.downloaded = 0;
            st.total = None;
            st.version = None;
            st.error = None;
        });
        // 显式标注错误类型：下面 `match &result` 里要把 `e` clone 成 String 交给状态，
        // 不标的话推断会在这里断（`async` 块的 Err 类型只有一个 `?` 来源时才能自动定）。
        let result: Result<Option<UpdateInfo>, String> = async {
            let updater = app
                .updater_builder()
                .timeout(CHECK_TIMEOUT)
                .build()
                .map_err(|e| e.to_string())?;
            match updater.check().await.map_err(|e| e.to_string())? {
                Some(update) => {
                    // 禁止降级：清单版本必须严格高于当前版本（见 `is_not_an_upgrade`）。
                    if is_not_an_upgrade(&update.current_version, &update.version) {
                        let msg = format!(
                            "code=UPDATER_DOWNGRADE_BLOCKED：清单版本 {} 不高于当前 {}，已拒绝（禁止降级）",
                            update.version, update.current_version
                        );
                        log_updater_error(&app, &msg);
                        return Err(msg);
                    }
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
        match &result {
            Ok(Some(info)) => {
                let v = info.version.clone();
                state.set_status(&app, move |st| {
                    st.phase = "idle".to_string();
                    st.version = Some(v);
                });
            }
            Ok(None) => state.set_status(&app, |st| {
                st.phase = "idle".to_string();
            }),
            Err(e) => {
                let msg = e.clone();
                state.set_status(&app, move |st| {
                    st.phase = "failed".to_string();
                    st.error = Some(msg);
                });
            }
        }
        result
    }

    #[tauri::command]
    pub async fn updater_download(
        app: AppHandle,
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
            state.set_status(&app, |st| {
                st.phase = "downloading".to_string();
                st.downloaded = 0;
                st.total = None;
                st.error = None;
            });
            let progress = on_event.clone();
            let finished = on_event.clone();
            let sink = app.clone();
            let status = state.status.clone();
            let last_emit = state.last_emit_ms.clone();
            let mut first_chunk = true;
            let download = update.download(
                move |chunk_length, content_length| {
                    {
                        let mut st = status.lock().unwrap_or_else(|e| e.into_inner());
                        if first_chunk {
                            st.total = content_length;
                            st.downloaded = 0;
                        }
                        st.downloaded = st.downloaded.saturating_add(chunk_length as u64);
                    }
                    if first_chunk {
                        first_chunk = false;
                        // 第一帧把 total 立刻广播出去（否则界面要等 250ms 才有分母）
                        emit_now(&sink, &status);
                        let _ = progress.send(DownloadEvent::Started { content_length });
                    } else {
                        emit_throttled(&sink, &status, &last_emit);
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
                    let bytes_len = bytes.len() as u64;
                    // 整包是**常驻内存**的一份（`Mutex<Option<Vec<u8>>>`）⇒ 它多大就得记多大。
                    crate::mem_diag::note_big_alloc("update_package_held", bytes_len);
                    *state.bytes.lock().unwrap_or_else(|e| e.into_inner()) = Some(bytes);
                    state.set_status(&app, move |st| {
                        st.phase = "ready".to_string();
                        st.downloaded = bytes_len;
                        st.error = None;
                    });
                    Ok(())
                }
                Some(Err(e)) => {
                    let msg = e.to_string();
                    let shown = msg.clone();
                    state.set_status(&app, move |st| {
                        st.phase = "failed".to_string();
                        st.error = Some(shown);
                    });
                    Err(msg)
                }
                // 取消时 future 被 drop：HTTP 读取停止、半包 Vec 释放；没有文件/安装器状态。
                None => {
                    state.set_status(&app, |st| {
                        st.phase = "cancelled".to_string();
                        st.downloaded = 0;
                    });
                    Err(CANCELLED.to_string())
                }
            }
        }
        .await;
        state.downloading.store(false, Ordering::SeqCst);
        result
    }

    /// 取消下载。`Downloading`/`Ready` 都成立；**安装阶段不可取消**（那时字节已经交给安装器，
    /// 这一条由前端不显示取消按钮 + 这里直接返回错误两道保证）。
    #[tauri::command]
    pub fn updater_cancel(app: AppHandle, state: State<'_, UpdaterSession>) -> Result<(), String> {
        if state.status.lock().unwrap_or_else(|e| e.into_inner()).phase == PHASE_INSTALLING {
            // 被拒也要留痕（审计 B1-F1）：这个模块原先只有失败码，取消的两种结局都没有码。
            log_updater_info(&app, "code=UPDATER_CANCEL outcome=refused_installing");
            return Err("安装已经开始，无法取消".to_string());
        }
        let signalled = if let Some(cancel) = state
            .cancel
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            cancel.notify_one();
            true
        } else {
            false
        };
        *state.bytes.lock().unwrap_or_else(|e| e.into_inner()) = None;
        state.set_status(&app, |st| {
            st.phase = "cancelled".to_string();
            st.downloaded = 0;
        });
        // `signalled=false` 表示当时没有在飞的下载（点了取消但没东西可停）—— 这一格
        // 与"真的打断了"在排障时是两件事。
        log_updater_info(
            &app,
            &format!("code=UPDATER_CANCEL outcome=cancelled signalled={signalled}"),
        );
        Ok(())
    }

    /// `installing` 相位的清道夫（复审）：命令 future 被丢弃时（窗口关闭 / 调用方取消
    /// await），相位不能永久停在 `installing` —— 那会让 `updater_cancel` 永远拒绝、
    /// 界面永远转圈，用户只能重启应用。正常路径在返回前把 `armed` 置 false。
    struct InstallingPhase<'a> {
        app: &'a AppHandle,
        state: &'a UpdaterSession,
        armed: bool,
    }

    impl Drop for InstallingPhase<'_> {
        fn drop(&mut self) {
            if self.armed {
                self.state.set_status(self.app, |st| {
                    st.phase = "failed".to_string();
                    st.error = Some(
                        "code=UPDATER_INSTALL_ABORTED：安装任务被中断（窗口关闭或进程退出）"
                            .to_string(),
                    );
                });
            }
        }
    }

    /// 安装**之前**的复查：手里这份下载可能花了几十分钟，期间可能已经发布了更新的版本。
    ///
    /// 返回 `Some(info)` = 清单上出现了**严格更高**的版本 ⇒ 手里这份已经过期，字节已丢弃，
    /// 调用方应改为显示"有新版本，需要重新下载"；返回 `None` = 手里这份仍是最新（或清单读不到）。
    ///
    /// 为什么不复用 `updater_check`：那条命令会 `clear()` 掉已下载的字节 —— 在 ready 态调用
    /// 它等于"点一下检查就把几十 MB 扔了"。这里只在**确实更高**时才丢。
    #[cfg(desktop)]
    #[tauri::command]
    pub async fn updater_recheck_ready(
        app: AppHandle,
        state: State<'_, UpdaterSession>,
    ) -> Result<Option<UpdateInfo>, String> {
        let held = state.snapshot();
        if held.phase != "ready" {
            return Ok(None);
        }
        let Some(held_version) = held.version.clone() else {
            return Ok(None);
        };
        let updater = app
            .updater_builder()
            .timeout(CHECK_TIMEOUT)
            .build()
            .map_err(|e| e.to_string())?;
        let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
            return Ok(None);
        };
        // 清单版本不高于手里这份 ⇒ 仍是最新，**保留**已下载的字节。
        if is_not_an_upgrade(&held_version, &update.version) {
            return Ok(None);
        }
        let info = UpdateInfo {
            current_version: update.current_version.clone(),
            version: update.version.clone(),
            notes: update.body.clone(),
            published_at: update.date.map(|d| d.unix_timestamp()),
        };
        // 过期了：丢掉旧字节，并把清单换成新的那份，用户点"下载"就能直接开始。
        state.clear();
        *state.update.lock().unwrap_or_else(|e| e.into_inner()) = Some(update);
        let v = info.version.clone();
        state.set_status(&app, move |st| {
            st.phase = "idle".to_string();
            st.version = Some(v);
            st.downloaded = 0;
            st.total = None;
            st.error = None;
        });
        log_updater_error(
            &app,
            &format!(
                "code=UPDATER_SUPERSEDED：已下载的 {held_version} 已被更高版本超越，字节已丢弃"
            ),
        );
        Ok(Some(info))
    }

    #[tauri::command]
    pub async fn updater_install(
        // Windows 由官方 install 内部退出进程，不经过下面的 restart 分支。
        app: AppHandle,
        state: State<'_, UpdaterSession>,
    ) -> Result<(), String> {
        if state.downloading.load(Ordering::SeqCst) {
            return Err("更新仍在下载".to_string());
        }
        // PERF-01：整包**移动**而不是 clone —— 峰值从 2× 包体降到 1×。
        //
        // 上一版用 clone 的理由是真的（`install` 会在验签/解包/复制任一环节失败，
        // take 掉之后用户再点"安装"只会得到"没有可安装的更新"，几十 MB 白下），
        // 但那个理由要的是**失败可重试**，不是"必须留一份副本"。所以这里 take，
        // 失败时把两样原样退回去（见下面的 `Some(` 回填）。
        let taken_update = state
            .update
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        let taken_bytes = state.bytes.lock().unwrap_or_else(|e| e.into_inner()).take();
        let missing = if taken_update.is_none() {
            "没有可安装的更新"
        } else {
            "更新尚未下载完成"
        };
        let (update, bytes) = match (taken_update, taken_bytes) {
            (Some(update), Some(bytes)) => (update, bytes),
            (update, bytes) => {
                // 缺一样也要把已取出的那份放回去：只 take 一半会让下一次重试同样失败。
                if let Some(update) = update {
                    *state.update.lock().unwrap_or_else(|e| e.into_inner()) = Some(update);
                }
                if let Some(bytes) = bytes {
                    *state.bytes.lock().unwrap_or_else(|e| e.into_inner()) = Some(bytes);
                }
                return Err(missing.to_string());
            }
        };
        state.set_status(&app, |st| {
            st.phase = PHASE_INSTALLING.to_string();
            st.error = None;
        });
        // **更新装完那次"没有关停标记的运行结尾"不是崩溃**（2026-10-27 现场里 01:39 那一趟
        // 就是这样被读成一次不明死法）。Windows 的 NSIS 安装器成功后直接接管并结束本进程，
        // 走不到任何 shutdown 钩子 ⇒ 必须在交棒**之前**把它写进不轮转的现场文件。
        // 版本号只在 BEGIN 里给：`update` 马上要被 `move` 进阻塞任务，为了 DONE 那一行
        // 再 clone 一份会直接撞上本函数那条 PERF-01 判据（安装路径里除错误文案外不许 clone）。
        crate::logging::crash_note(&format!(
            ">>> code=UPDATER_INSTALL_BEGIN version={} pid={}（这一步之后进程被安装器结束属正常）",
            update.version,
            std::process::id()
        ));
        // 从这里起到返回前，future 若被丢弃就由守卫把相位改回 `failed`。
        let mut installing = InstallingPhase {
            app: &app,
            state: state.inner(),
            armed: true,
        };
        // 解包/验签/复制是同步重活：放到阻塞池，别占 tokio worker（单 runtime 会被饿死）。
        // 闭包**带回** update/bytes，失败时由调用处放回会话；成功时随闭包一起 drop。
        let outcome = tokio::task::spawn_blocking(move || {
            let result = update.install(&bytes);
            (result, update, bytes)
        })
        .await;
        let (installed, update, bytes) = match outcome {
            Ok(v) => v,
            Err(join) => {
                // 阻塞任务被中断/panic：整包已随闭包 drop，只能让用户重下。
                // 这是"失败可重试"唯一覆盖不到的一格，必须留痕，不许假装成普通失败。
                installing.armed = false;
                let msg = format!("code=UPDATER_INSTALL_FAILED：安装任务中断：{join}");
                log_updater_error(&app, &msg);
                state.set_status(&app, |st| {
                    st.phase = "failed".to_string();
                    st.error = Some(msg.clone());
                });
                return Err(msg);
            }
        };
        if let Err(e) = installed {
            // 现场放回去：验签不符/磁盘满/目录被占都是"可以再试一次"的失败。
            installing.armed = false;
            *state.update.lock().unwrap_or_else(|e| e.into_inner()) = Some(update);
            *state.bytes.lock().unwrap_or_else(|e| e.into_inner()) = Some(bytes);
            let msg = format!("code=UPDATER_INSTALL_FAILED：{e}");
            log_updater_error(&app, &msg);
            state.set_status(&app, |st| {
                st.phase = "failed".to_string();
                st.error = Some(msg.clone());
            });
            return Err(msg);
        }
        // 成功：两样都已随安装一起用掉（`take` 之后会话里本来就是空的，不必再 clear）。
        installing.armed = false;
        crate::logging::crash_note(
            ">>> code=UPDATER_INSTALL_DONE（本进程接下来会被结束：Windows 由安装器、其它平台由 restart）",
        );
        state.set_status(&app, |st| {
            st.phase = "idle".to_string();
        });
        #[cfg(windows)]
        {
            // NSIS 安装器默认会在成功后重启应用；走到这里说明安装器已交棒。
            Ok(())
        }
        #[cfg(not(windows))]
        {
            // macOS/Linux：安装完成后由本进程重启到新版本。
            crate::logging::crash_note(">>> code=UPDATER_RESTART");
            app.restart()
        }
    }

    /// 更新器错误留痕（`code=UPDATER_INSTALL_FAILED` / `code=UPDATER_DOWNGRADE_BLOCKED`）。
    ///
    /// 一条日志写不出去不该连累返回值：`logger` 拿不到时退回 stderr，
    /// 反正这条错误的**可定位性**由返回给前端的同一个字符串兜底。
    /// 与 [`log_updater_error`] 同一口径，只是级别是 info（取消的结局不是失败）。
    fn log_updater_info(app: &AppHandle, msg: &str) {
        use tauri::Manager;
        match app.try_state::<std::sync::Arc<crate::state::AppState>>() {
            Some(s) => s.inner().logger.info("updater", msg.to_string()),
            None => eprintln!("[gosslan-updater] {msg}"),
        }
    }

    fn log_updater_error(app: &AppHandle, msg: &str) {
        use tauri::Manager;
        match app.try_state::<std::sync::Arc<crate::state::AppState>>() {
            Some(s) => s.inner().logger.error("updater", msg.to_string()),
            None => eprintln!("[gosslan-updater] {msg}"),
        }
    }

    #[tauri::command]
    pub fn updater_close(app: AppHandle, state: State<'_, UpdaterSession>) -> Result<(), String> {
        if let Some(cancel) = state
            .cancel
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            cancel.notify_one();
        }
        state.clear();
        state.set_status(&app, |st| {
            st.phase = "idle".to_string();
            st.downloaded = 0;
            st.total = None;
            st.version = None;
            st.error = None;
        });
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

/// 移动端：更新入口本身不展示，但命令面要与桌面同形（`generate_handler!` 不按平台拆）。
/// 返回 `unsupported` 而不是空相位：前端据此永远不把"更新下载"当成一个任务列出来。
#[cfg(not(desktop))]
#[tauri::command]
pub fn updater_status() -> UpdaterStatus {
    UpdaterStatus {
        phase: "unsupported".to_string(),
        ..Default::default()
    }
}

#[cfg(not(desktop))]
#[tauri::command]
pub async fn updater_check() -> Result<Option<UpdateInfo>, String> {
    Err("应用内更新仅支持桌面端".to_string())
}

#[cfg(not(desktop))]
#[tauri::command]
pub async fn updater_download(_on_event: tauri::ipc::Channel<DownloadEvent>) -> Result<(), String> {
    Err("应用内更新仅支持桌面端".to_string())
}

#[cfg(not(desktop))]
#[tauri::command]
pub fn updater_cancel() -> Result<(), String> {
    Err("应用内更新仅支持桌面端".to_string())
}

#[cfg(not(desktop))]
#[tauri::command]
pub async fn updater_recheck_ready() -> Result<Option<UpdateInfo>, String> {
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

// ---------------- 形状判据（B5：状态可查询、广播一个家、安装不可取消） ----------------
#[cfg(all(test, desktop))]
mod status_tests {
    use super::desktop::{is_not_an_upgrade, PHASE_INSTALLING};

    /// 取一个顶层函数的函数体（到下一个顶层 `}` 为止，足够覆盖这几条断言）。
    fn body_of<'a>(src: &'a str, needle: &str) -> &'a str {
        let at = src
            .find(needle)
            .unwrap_or_else(|| panic!("找不到 {needle} —— 改名/搬家时这里必须同步"));
        let rest = &src[at..];
        let end = rest.find("\n    }\n").map(|i| i + 6).unwrap_or(rest.len());
        &rest[..end]
    }

    /// 广播只有一个家。
    ///
    /// 两个地方各 emit 一次，迟早会有一处忘了节流（进度帧一秒几十条）或忘了写快照
    /// （于是查询读到的比界面旧）。`emit_now` / `emit_throttled` 都只走这一个 emit 点。
    #[test]
    fn updater_status_has_exactly_one_emit_home() {
        // ⚠️ 先切掉本测试模块：`include_str!` 读的是整份文件，下面那条断言的**字面量**
        // 就在测试里 ⇒ 不切的话它自己会被数成第二个 emit 点（第一版实测 2 vs 1）。
        let src = include_str!("updater.rs");
        let prod = &src[..src.find("#[cfg(all(test, desktop))]").unwrap_or(src.len())];
        assert_eq!(
            prod.matches("emit(\"updater-status\"").count(),
            1,
            "广播只能有一个家（`emit_now`）；第二处就会漏节流或漏写快照"
        );
    }

    /// 三处关键跃迁都必须写状态，否则"可查询"是假的（窗口刚打开时读到 idle）。
    #[test]
    fn every_major_transition_writes_the_status() {
        let src = include_str!("updater.rs");
        let download = body_of(src, "pub async fn updater_download(");
        assert!(
            download.contains("\"downloading\"") && download.contains("\"ready\""),
            "下载必须同时写「开始」与「下完」两个相位"
        );
        let install = body_of(src, "pub async fn updater_install(");
        assert!(
            install.contains("st.phase = PHASE_INSTALLING.to_string()"),
            "安装阶段必须写 installing（常量）：否则取消按钮判断不出「已经不能取消了」"
        );
        let status_cmd = body_of(src, "pub fn updater_status(");
        assert!(
            status_cmd.contains("snapshot()"),
            "查询命令必须读同一份快照（不许自己再拼一个状态）"
        );
    }

    /// 安装阶段不可取消：**字节已经交给安装器**，取消只会留下半装现场。
    ///
    /// 这一条原来只 grep「两处都有 `"installing"`」—— 写与判各手抄一份，**任一侧打错都不会
    /// 编译失败**，只会让「安装中不可取消」静默失效（审计 B1-F3）。现在把形状改强：
    ///  ① 相位名在代码里只许出现**一次**（常量定义；注释行里的说明不算）；
    ///  ② 写相位与判相位都必须引用常量（手抄的字面量会同时打破 ① 与 ②）；
    ///  ③ 值必须原样出现在 `src/updater/service.ts`（TS 状态机是另一个家，跨层不许漂）。
    #[test]
    fn install_phase_is_not_cancellable() {
        let src = include_str!("updater.rs");
        let prod = &src[..src.find("#[cfg(all(test, desktop))]").unwrap_or(src.len())];
        let literals = prod
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .filter(|l| l.contains("\"installing\""))
            .count();
        assert_eq!(
            literals, 1,
            "相位名在代码里只许出现一次（常量定义）—— 两处手抄正是这条缺陷的形状"
        );
        assert!(
            prod.contains("pub const PHASE_INSTALLING: &str = \"installing\";"),
            "常量的名字与值都要逐字钉住（TS 侧按这个值判）"
        );

        let cancel = body_of(src, "pub fn updater_cancel(");
        assert!(
            cancel.contains("== PHASE_INSTALLING") && cancel.contains("无法取消"),
            "取消必须在 installing 相位直接拒绝（前端不显示按钮是第二道，不是唯一一道）"
        );
        let install = body_of(src, "pub async fn updater_install(");
        assert!(
            install.contains("st.phase = PHASE_INSTALLING.to_string()"),
            "写相位也必须用同一个常量 ⇒ 写与判不可能再各漂一份"
        );

        // 跨层：前端那一侧没有共享常量，值只能靠对账。这里读的是 TS 状态机的唯一家，
        // 且比对的是**常量当前的值**（不是手抄的 "installing"）—— 后端改名而前端没跟上，
        // 这条就红。
        let ts = include_str!("../../../src/updater/service.ts");
        let literal = format!("\"{PHASE_INSTALLING}\"");
        assert!(
            ts.contains(&literal),
            "src/updater/service.ts 里没有 {literal} ⇒ 前端判不出安装相位，取消按钮会在安装中又冒出来"
        );
    }

    /// PERF-01：安装时整包必须**移动**（峰值 2× 包体 → 1×），而失败必须把现场放回去。
    ///
    /// 这两条是一起的：只 take 不回填会把"失败可重试"退化成"失败要重下几十 MB"，
    /// 而只回填不 take 就是原来的 2× 峰值。判据只看这一处函数体，
    /// `clone` 允许出现的唯一位置是错误文案（它没有整包那么大）。
    #[test]
    fn install_moves_the_package_and_restores_it_on_failure() {
        let src = include_str!("updater.rs");
        let install = body_of(src, "pub async fn updater_install(");
        assert_eq!(
            install.matches(".take()").count(),
            2,
            "update 与 bytes 都必须 take 出来（整包移动，不 clone）"
        );
        assert_eq!(
            install.matches(".clone()").count(),
            install.matches("msg.clone()").count(),
            "安装路径里除错误文案外不许出现 clone —— 那正是 PERF-01 的 2× 峰值"
        );
        // 回填必须发生在**两处**：缺一样的分支 + 安装失败的分支。
        // 只断言 contains 会被"缺一样"那一处满足（复审指出过这个假绿）。
        assert_eq!(
            install.matches("= Some(update)").count(),
            2,
            "缺一样分支与安装失败分支都必须把 update 放回会话"
        );
        assert_eq!(
            install.matches("= Some(bytes)").count(),
            2,
            "缺一样分支与安装失败分支都必须把整包放回会话，否则用户要重新下载几十 MB"
        );
        assert_eq!(
            install.matches("log_updater_error(").count(),
            2,
            "两格失败（install 报错、阻塞任务中断）都要留痕"
        );
        assert_eq!(
            install.matches("code=UPDATER_INSTALL_FAILED").count(),
            2,
            "两格失败（install 报错、阻塞任务中断）都要留同一个可检索码"
        );
        // `installing` 相位的 Drop 守卫（复审）：future 被丢弃时不能永久停在 installing。
        assert!(
            src.contains("struct InstallingPhase") && src.contains("UPDATER_INSTALL_ABORTED"),
            "安装阶段必须有 Drop 守卫，否则窗口一关相位就永久卡在 installing"
        );
    }

    /// 禁止降级（审计 §13，2026-10-24 产品裁决）：清单版本必须**严格高于**当前版本。
    ///
    /// 三个对照方向都要有，否则「全都拒绝」也能让降级那条通过：
    /// 更低/相同 ⇒ 拒绝；更高 ⇒ 放行。预发布按 semver 比（`5.8.0-beta.1 < 5.8.0`），
    /// 解析失败按失败关闭处理 —— 清单形状不对时不许赌。
    #[test]
    fn a_manifest_at_or_below_the_current_version_is_refused() {
        assert!(is_not_an_upgrade("5.7.28", "5.7.27"), "更低版本必须拒绝");
        assert!(is_not_an_upgrade("5.7.28", "5.7.28"), "相同版本不算更新");
        assert!(!is_not_an_upgrade("5.7.28", "5.7.29"), "更高补丁版必须放行");
        assert!(!is_not_an_upgrade("5.7.28", "5.8.0"), "更高次版本必须放行");
        assert!(
            is_not_an_upgrade("5.8.0", "5.8.0-beta.1"),
            "5.8.0-beta.1 低于 5.8.0（预发布按 semver 比较）"
        );
        assert!(
            !is_not_an_upgrade("5.8.0-beta.1", "5.8.0"),
            "正式版高于同号预发布"
        );
        assert!(
            is_not_an_upgrade("5.7.28", "banana"),
            "非法候选版本必须拒绝"
        );
        assert!(
            is_not_an_upgrade("banana", "5.8.0"),
            "非法当前版本也必须失败关闭"
        );
    }

    /// 判据必须**接在检查路径上**：只写一个纯函数、`updater_check` 不调用它，等于没做。
    /// 同时钉住拒绝时的可检索码与日志出口（用户要能在运行日志里找到它）。
    #[test]
    fn check_refuses_a_manifest_that_is_not_newer() {
        let src = include_str!("updater.rs");
        let check = body_of(src, "pub async fn updater_check(");
        assert!(
            check.contains("is_not_an_upgrade("),
            "检查路径必须调用降级判据"
        );
        assert!(
            check.contains("UPDATER_DOWNGRADE_BLOCKED") && check.contains("log_updater_error("),
            "拒绝降级必须留 `code=UPDATER_DOWNGRADE_BLOCKED` 的日志痕迹"
        );
        // 被拒的那份 `Update` 不许留在会话里（否则用户还能点「下载」把它装回去）。
        let gate = check.find("is_not_an_upgrade(").unwrap();
        let insert = check.find("= Some(update)").unwrap();
        assert!(gate < insert, "降级判定必须发生在把 update 放进会话之前");
    }
}
