// 安卓应用内升级：检查 → 下载 → 校验 → 发起安装，以及可查询的安装状态。
//
// ## 为什么 Rust 侧还要做一遍下载/校验
// - `tauri-plugin-updater` 只支持桌面（Windows/macOS/Linux），Android 没有等价实现；
// - APK 动辄几十 MB，不能整包塞进内存：这里用 `reqwest::Response::chunk()` 流式落盘，
//   边下边算 sha256，并可随时取消；
// - 系统安装器只认本地文件。把“网络/校验/取消”放在 Rust，Kotlin 只负责
//   `PackageInstaller` 与系统确认 UI，职责边界清楚。
//
// ## 状态口径
// 后端状态是**可查询的**（`android_updater_status`），事件是 `android-update-status`。
// 安装阶段：`preparing`（Kotlin 写安装会话）→ `launching`（会话已提交）→
// `waiting-user`（系统确认框已出现）→ `installed` / `failed`。
// 成功替换自身时进程会被系统杀掉，所以 `installed` 事件不保证送达；重开应用后
// 版本已经更新，属于终态。
//
// ## 失败必须具名
// `code=ANDROID_UPDATE_<原因>：<中文说明>`，前端按 code 映射到具体话术，
// 不允许退化成“安装失败”四个字。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use sha2::Digest;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
// 流式落盘要用 `AsyncWriteExt` 提供的 `write_all` / `flush`（`tokio::fs::File`
// 只是实现了 `AsyncWrite`，方法本身挂在扩展 trait 上，不 import 就找不到）。
use tokio::io::AsyncWriteExt;

#[cfg(target_os = "android")]
use crate::android_update_core as core;

const GITEE_MANIFEST: &str =
    "https://gitee.com/fwdq/gosslan-releases/raw/master/updates/latest.json";
const RELEASE_API: &str = "https://api.github.com/repos/wenzo001/gosslan/releases/latest";
const CHECK_TIMEOUT: Duration = Duration::from_secs(15);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const PROGRESS_EMIT_MS: i64 = 200;

const E_BUSY: &str = "ANDROID_UPDATE_BUSY";
const E_NETWORK: &str = "ANDROID_UPDATE_NETWORK";
const E_TIMEOUT: &str = "ANDROID_UPDATE_TIMEOUT";
// 清单解析失败的错误码由 `android_update_core::parse_release_json` 自己拼（那里是纯逻辑、
// 可在主机单测），这里不再留同名字面量常量 —— 留着只会被 dead_code 报“从未使用”。
const E_NO_RELEASE: &str = "ANDROID_UPDATE_NO_RELEASE";
const E_RATE_LIMIT: &str = "ANDROID_UPDATE_RATE_LIMIT";
const E_HTTP: &str = "ANDROID_UPDATE_HTTP";
const E_NO_ASSET: &str = "ANDROID_UPDATE_NO_ASSET";
const E_NO_DIGEST: &str = "ANDROID_UPDATE_NO_DIGEST";
const E_CHECKSUM: &str = "ANDROID_UPDATE_CHECKSUM";
const E_SIZE: &str = "ANDROID_UPDATE_SIZE_MISMATCH";
const E_CANCELLED: &str = "ANDROID_UPDATE_CANCELLED";
const E_NO_APK: &str = "ANDROID_UPDATE_NO_APK";
const E_FILE_MISSING: &str = "ANDROID_UPDATE_FILE_MISSING";
const E_PARSE: &str = "ANDROID_UPDATE_PARSE";
const E_WRONG_PACKAGE: &str = "ANDROID_UPDATE_WRONG_PACKAGE";
const E_SIGNATURE: &str = "ANDROID_UPDATE_SIGNATURE";
const E_IO: &str = "ANDROID_UPDATE_IO";
const E_PERMISSION: &str = "ANDROID_UPDATE_PERMISSION";
const E_INSTALL_CANCELLED: &str = "ANDROID_UPDATE_INSTALL_CANCELLED";
const E_INSTALL_FAILED: &str = "ANDROID_UPDATE_INSTALL_FAILED";

fn coded(code: &str, detail: impl AsRef<str>) -> String {
    format!("code={code}：{}", detail.as_ref())
}

fn extract_code(message: &str) -> Option<String> {
    let head = message.split('：').next().unwrap_or(message);
    head.strip_prefix("code=").map(|c| c.to_string())
}

/// 前端拿到的更新信息。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidUpdateInfo {
    pub current_version: String,
    pub version: String,
    pub notes: Option<String>,
    pub size: u64,
    pub sha256: String,
}

/// 可查询的后端状态（事件与 `android_updater_status` 共用同一形状）。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidUpdateStatus {
    /// `idle | checking | available | downloading | verifying | ready | installing | installed | failed | cancelled`
    pub phase: String,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub version: Option<String>,
    pub size: Option<u64>,
    pub sha256: Option<String>,
    pub error: Option<String>,
    pub error_code: Option<String>,
    /// `preparing | launching | waiting-user | installing`
    pub install_step: Option<String>,
}

/// 下载进度（走 `Channel`，与桌面 updater 的进度口径一致）。
#[derive(Debug, Clone, Serialize)]
pub enum AndroidDownloadEvent {
    Started {
        #[serde(rename = "contentLength")]
        content_length: Option<u64>,
    },
    Progress {
        #[serde(rename = "chunkLength")]
        chunk_length: u64,
    },
    Finished,
}

#[derive(Debug, Clone)]
struct CachedUpdate {
    info: AndroidUpdateInfo,
    url: String,
}

#[derive(Debug, Clone)]
struct DownloadedApk {
    path: PathBuf,
    version: String,
    /// 清单里的期望 sha256（小写 hex）。
    expected_sha256: String,
}

/// 后端持有的一小块状态。managed state（跨窗口共用一份）。
#[cfg(target_os = "android")]
#[derive(Default)]
pub struct AndroidUpdaterSession {
    info: Mutex<Option<CachedUpdate>>,
    apk: Mutex<Option<DownloadedApk>>,
    cancel: Mutex<Option<Arc<tokio::sync::Notify>>>,
    checking: AtomicBool,
    downloading: AtomicBool,
    installing: AtomicBool,
    status: Arc<Mutex<AndroidUpdateStatus>>,
    last_progress_emit_ms: Arc<AtomicI64>,
}

/// 非 Android 目标只要一个同名的空状态，供 `Builder::manage` 与命令桩使用。
#[cfg(not(target_os = "android"))]
#[derive(Default)]
pub struct AndroidUpdaterSession;

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

fn init_handle(app: &AppHandle) {
    let _ = APP_HANDLE.set(app.clone());
}

#[cfg(target_os = "android")]
fn publish(
    app: &AppHandle,
    state: &AndroidUpdaterSession,
    change: impl FnOnce(&mut AndroidUpdateStatus),
) {
    let snapshot = {
        let mut status = match state.status.lock() {
            Ok(s) => s,
            Err(p) => p.into_inner(),
        };
        change(&mut status);
        status.clone()
    };
    let _ = app.emit("android-update-status", snapshot);
}

#[cfg(target_os = "android")]
fn publish_progress(
    app: &AppHandle,
    state: &AndroidUpdaterSession,
    downloaded: u64,
    total: Option<u64>,
    force: bool,
) {
    {
        let mut status = match state.status.lock() {
            Ok(s) => s,
            Err(p) => p.into_inner(),
        };
        status.phase = "downloading".into();
        status.downloaded = downloaded;
        status.total = total;
    }
    // 墙上时钟只有 `logging.rs` 与 `db/read_receipts.rs` 两处实现（守卫会数名字），
    // 这里直接转调日志域那一份，不自造第三份。
    let now = crate::logging::now_ms();
    let last = state.last_progress_emit_ms.load(Ordering::Relaxed);
    if force || now - last >= PROGRESS_EMIT_MS {
        state.last_progress_emit_ms.store(now, Ordering::Relaxed);
        let snapshot = match state.status.lock() {
            Ok(s) => s.clone(),
            Err(p) => p.into_inner().clone(),
        };
        let _ = app.emit("android-update-status", snapshot);
    }
}

#[cfg(target_os = "android")]
fn fail(
    app: &AppHandle,
    state: &AndroidUpdaterSession,
    code: &str,
    detail: impl AsRef<str>,
    install_step: Option<&str>,
) -> String {
    let message = coded(code, detail);
    publish(app, state, |s| {
        s.phase = "failed".into();
        s.error = Some(message.clone());
        s.error_code = Some(code.to_string());
        s.install_step = install_step.map(|v| v.to_string());
    });
    message
}

#[cfg(target_os = "android")]
fn updates_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| coded(E_IO, format!("拿不到应用缓存目录（{e}）")))?
        .join("updates");
    std::fs::create_dir_all(&dir)
        .map_err(|e| coded(E_IO, format!("创建更新缓存目录失败（{e}）")))?;
    Ok(dir)
}

#[cfg(target_os = "android")]
fn apk_path(dir: &Path, version: &str, abi: &str) -> PathBuf {
    dir.join(format!("gosslan-{version}-{abi}.apk"))
}

#[cfg(target_os = "android")]
fn remove_file_if_exists(path: &Path) {
    let _ = std::fs::remove_file(path);
}

#[cfg(target_os = "android")]
fn cleanup_other_apks(dir: &Path, keep_name: &str) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if (name.ends_with(".apk") || name.ends_with(".part")) && name != keep_name {
            remove_file_if_exists(&entry.path());
        }
    }
}

#[cfg(target_os = "android")]
fn clear_apk(state: &AndroidUpdaterSession) {
    if let Ok(mut apk) = state.apk.lock() {
        if let Some(old) = apk.take() {
            remove_file_if_exists(&old.path);
        }
    }
}

#[cfg(target_os = "android")]
async fn fetch_manifest_body(
    client: &reqwest::Client,
    url: &str,
    accept: &str,
    current: &str,
) -> Result<String, String> {
    let resp = client
        .get(url)
        .header("User-Agent", format!("Gosslan/{current}"))
        .header("Accept", accept)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                coded(E_TIMEOUT, "检查更新超时，请稍后重试")
            } else {
                coded(E_NETWORK, format!("检查更新失败（{e}）"))
            }
        })?;

    let status = resp.status();
    if !status.is_success() {
        let code = match status.as_u16() {
            404 => E_NO_RELEASE,
            403 | 429 => E_RATE_LIMIT,
            _ => E_HTTP,
        };
        let detail = match status.as_u16() {
            404 => "还没有可用的发布版本".to_string(),
            403 | 429 => "请求过于频繁，请稍后再试".to_string(),
            n => format!("发布服务器返回 HTTP {n}"),
        };
        return Err(coded(code, detail));
    }

    resp.text()
        .await
        .map_err(|e| coded(E_NETWORK, format!("读取发布信息失败（{e}）")))
}

/// 把清单转成缓存 + 下载信息。两种来源（Gitee 固定清单 / GitHub API）共用这一段，
/// 保证版本比较、ABI 选包、sha256 必填、旧 APK 清理的口径完全一致。
#[cfg(target_os = "android")]
fn prepare_update(
    app: &AppHandle,
    state: &AndroidUpdaterSession,
    current: &str,
    release: core::ReleaseInfo,
) -> Result<Option<AndroidUpdateInfo>, String> {
    if !core::version_is_newer(current, &release.version) {
        return Ok(None);
    }

    let abi = core::abi_name();
    let asset = core::select_asset(&release.assets, abi)
        .ok_or_else(|| coded(E_NO_ASSET, format!("当前设备架构（{abi}）没有对应安装包")))?;
    let sha256 = asset
        .sha256
        .clone()
        .ok_or_else(|| coded(E_NO_DIGEST, "发布信息缺少 sha256，无法校验安装包"))?;

    let info = AndroidUpdateInfo {
        current_version: current.to_string(),
        version: release.version.clone(),
        notes: release.notes,
        size: asset.size,
        sha256,
    };
    if let Ok(mut cached) = state.info.lock() {
        *cached = Some(CachedUpdate {
            info: info.clone(),
            url: asset.url.clone(),
        });
    }
    let dir = updates_dir(app)?;
    let keep = format!("gosslan-{}-{abi}.apk", release.version);
    cleanup_other_apks(&dir, &keep);
    Ok(Some(info))
}

/// Gitee 固定清单优先。清单 200 但版本低于当前版本时判为“清单过期”并返回错误，
/// 让外层退 GitHub —— 桌面的 Gitee 旧清单不会回退，Android 这里多一层兜底。
#[cfg(target_os = "android")]
async fn fetch_from_gitee(
    client: &reqwest::Client,
    current: &str,
    app: &AppHandle,
    state: &AndroidUpdaterSession,
) -> Result<Option<AndroidUpdateInfo>, String> {
    let body = fetch_manifest_body(client, GITEE_MANIFEST, "application/json", current).await?;
    let release = core::parse_fixed_manifest(&body)?;
    if !core::version_is_newer(current, &release.version) {
        let same = core::normalize_version(&release.version) == core::normalize_version(current);
        if same {
            return Ok(None);
        }
        return Err(coded(
            E_PARSE,
            format!(
                "Gitee 清单版本 {} 低于当前版本 {current}，判定为过期",
                release.version
            ),
        ));
    }
    prepare_update(app, state, current, release)
}

#[cfg(target_os = "android")]
async fn fetch_from_github(
    client: &reqwest::Client,
    current: &str,
    app: &AppHandle,
    state: &AndroidUpdaterSession,
) -> Result<Option<AndroidUpdateInfo>, String> {
    let body = fetch_manifest_body(
        client,
        RELEASE_API,
        "application/vnd.github+json",
        current,
    )
    .await?;
    let release = core::parse_release_json(&body)?;
    prepare_update(app, state, current, release)
}

#[cfg(target_os = "android")]
async fn fetch_update(
    app: &AppHandle,
    state: &AndroidUpdaterSession,
) -> Result<Option<AndroidUpdateInfo>, String> {
    let current = app.package_info().version.to_string();
    let client = reqwest::Client::builder()
        .timeout(CHECK_TIMEOUT)
        .build()
        .map_err(|e| coded(E_NETWORK, format!("网络客户端初始化失败（{e}）")))?;

    match fetch_from_gitee(&client, &current, app, state).await {
        Ok(result) => Ok(result),
        Err(gitee_err) => {
            if crate::logging::log_throttled("android_update_gitee_fallback", 300_000) {
                eprintln!(
                    "[gosslan-updater] Gitee 清单不可用，回退 GitHub（code={}）",
                    extract_code(&gitee_err).unwrap_or_else(|| "UNKNOWN".into())
                );
            }
            // 最终错误保持 GitHub 的口径，前端已有的 code 映射不变。
            fetch_from_github(&client, &current, app, state).await
        }
    }
}

#[cfg(target_os = "android")]
fn map_reqwest_err(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        coded(E_TIMEOUT, "下载超时，请检查网络后重试")
    } else {
        coded(E_NETWORK, format!("下载失败（{e}）"))
    }
}

#[cfg(target_os = "android")]
fn map_apk_code(code: &str) -> (String, String) {
    match code {
        "PARSE_FAILED" => (
            E_PARSE.to_string(),
            "安装包无法解析，可能已损坏".to_string(),
        ),
        "WRONG_PACKAGE" => (
            E_WRONG_PACKAGE.to_string(),
            "安装包不是本应用的升级包".to_string(),
        ),
        "SIGNATURE_MISMATCH" => (
            E_SIGNATURE.to_string(),
            "安装包签名与本应用不一致，系统会拒绝覆盖安装".to_string(),
        ),
        "SIGNATURE_CHECK_UNAVAILABLE" => (
            E_SIGNATURE.to_string(),
            "无法读取签名信息，不能确认安装包来源".to_string(),
        ),
        "DOWNGRADE" => (
            E_PARSE.to_string(),
            "安装包版本低于当前版本，系统不允许降级覆盖".to_string(),
        ),
        "FILE_MISSING" => (
            E_FILE_MISSING.to_string(),
            "安装包已不存在，请重新下载".to_string(),
        ),
        "PERMISSION_REQUIRED" => (
            E_PERMISSION.to_string(),
            "需要允许本应用安装未知来源的应用".to_string(),
        ),
        "APP_NOT_READY" => (
            E_INSTALL_FAILED.to_string(),
            "安装能力尚未就绪，请重开应用".to_string(),
        ),
        "INSTALLER_UNAVAILABLE" => (
            E_INSTALL_FAILED.to_string(),
            "系统没有可用的安装器".to_string(),
        ),
        "IO_ERROR" => (E_IO.to_string(), "读取或写入安装包失败".to_string()),
        "SESSION_ERROR" => (
            E_INSTALL_FAILED.to_string(),
            "系统安装会话创建失败".to_string(),
        ),
        other => (E_INSTALL_FAILED.to_string(), other.to_string()),
    }
}

#[cfg(target_os = "android")]
fn fatal_apk_code(code: &str) -> bool {
    matches!(
        code,
        "PARSE_FAILED"
            | "WRONG_PACKAGE"
            | "SIGNATURE_MISMATCH"
            | "SIGNATURE_CHECK_UNAVAILABLE"
            | "DOWNGRADE"
            | "FILE_MISSING"
    )
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn android_updater_check(
    app: AppHandle,
    state: State<'_, AndroidUpdaterSession>,
) -> Result<Option<AndroidUpdateInfo>, String> {
    let state = state.inner();
    if state.downloading.load(Ordering::SeqCst) || state.installing.load(Ordering::SeqCst) {
        return Err(coded(E_BUSY, "正在下载或安装，请稍候"));
    }
    if state.checking.swap(true, Ordering::SeqCst) {
        return Err(coded(E_BUSY, "正在检查更新"));
    }
    init_handle(&app);
    publish(&app, state, |s| {
        *s = AndroidUpdateStatus {
            phase: "checking".into(),
            ..Default::default()
        };
    });

    let result = fetch_update(&app, state).await;
    state.checking.store(false, Ordering::SeqCst);
    match &result {
        Ok(Some(info)) => {
            publish(&app, state, |s| {
                *s = AndroidUpdateStatus {
                    phase: "available".into(),
                    total: Some(info.size),
                    downloaded: 0,
                    version: Some(info.version.clone()),
                    size: Some(info.size),
                    sha256: Some(info.sha256.clone()),
                    ..Default::default()
                };
            });
        }
        Ok(None) => {
            publish(&app, state, |s| {
                *s = AndroidUpdateStatus {
                    phase: "idle".into(),
                    ..Default::default()
                };
            });
            if let Ok(mut cached) = state.info.lock() {
                *cached = None;
            }
        }
        Err(e) => {
            let code = extract_code(e).unwrap_or_else(|| E_NETWORK.to_string());
            publish(&app, state, |s| {
                *s = AndroidUpdateStatus {
                    phase: "failed".into(),
                    error: Some(e.clone()),
                    error_code: Some(code),
                    ..Default::default()
                };
            });
        }
    }
    result
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn android_updater_download(
    app: AppHandle,
    state: State<'_, AndroidUpdaterSession>,
    on_event: Channel<AndroidDownloadEvent>,
) -> Result<(), String> {
    let state = state.inner();
    if state.installing.load(Ordering::SeqCst) {
        return Err(coded(E_BUSY, "正在安装，无法下载"));
    }
    if state.downloading.swap(true, Ordering::SeqCst) {
        return Err(coded(E_BUSY, "已有下载任务在进行"));
    }
    init_handle(&app);
    let result = download_inner(&app, state, &on_event).await;
    state.downloading.store(false, Ordering::SeqCst);
    if let Ok(mut slot) = state.cancel.lock() {
        *slot = None;
    }
    if let Err(e) = &result {
        // 早期失败（建客户端/发请求/建文件）不会走到 download_inner 里的状态更新，
        // 这里统一兜底，保证前端拿到的状态不会停在 "downloading"。
        publish(&app, state, |s| {
            if s.phase == "downloading" || s.phase.is_empty() {
                s.phase = "failed".into();
                s.error = Some(e.clone());
                s.error_code = extract_code(e);
                s.downloaded = 0;
            }
        });
    }
    result
}

#[cfg(target_os = "android")]
async fn download_inner(
    app: &AppHandle,
    state: &AndroidUpdaterSession,
    on_event: &Channel<AndroidDownloadEvent>,
) -> Result<(), String> {
    let cached = state
        .info
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .ok_or_else(|| coded(E_NO_APK, "还没有可下载的更新"))?;
    let info = cached.info.clone();
    let dir = updates_dir(app)?;
    let final_path = apk_path(&dir, &info.version, core::abi_name());
    let part_path = final_path.with_extension("apk.part");
    remove_file_if_exists(&final_path);
    remove_file_if_exists(&part_path);

    let cancel = Arc::new(tokio::sync::Notify::new());
    if let Ok(mut slot) = state.cancel.lock() {
        *slot = Some(cancel.clone());
    }

    publish(app, state, |s| {
        *s = AndroidUpdateStatus {
            phase: "downloading".into(),
            downloaded: 0,
            total: Some(info.size),
            version: Some(info.version.clone()),
            size: Some(info.size),
            sha256: Some(info.sha256.clone()),
            ..Default::default()
        };
    });
    let _ = on_event.send(AndroidDownloadEvent::Started {
        content_length: Some(info.size),
    });

    let client = reqwest::Client::builder()
        .timeout(DOWNLOAD_TIMEOUT)
        .build()
        .map_err(|e| coded(E_NETWORK, format!("网络客户端初始化失败（{e}）")))?;
    let mut resp = client
        .get(&cached.url)
        .header("User-Agent", format!("Gosslan/{}", info.current_version))
        .send()
        .await
        .map_err(|e| map_reqwest_err(&e))?;
    if !resp.status().is_success() {
        let _ = on_event.send(AndroidDownloadEvent::Finished);
        return Err(coded(
            E_HTTP,
            format!("下载地址返回 HTTP {}", resp.status().as_u16()),
        ));
    }
    let total = resp.content_length().or(Some(info.size));

    let mut file = match tokio::fs::File::create(&part_path).await {
        Ok(f) => f,
        Err(e) => {
            return Err(coded(E_IO, format!("创建安装包临时文件失败（{e}）")));
        }
    };
    let mut hasher = sha2::Sha256::new();
    let mut downloaded = 0u64;
    let notify = cancel.notified();
    tokio::pin!(notify);
    let mut cancelled = false;

    loop {
        let chunk = tokio::select! {
            _ = &mut notify => {
                cancelled = true;
                None
            }
            chunk = resp.chunk() => {
                match chunk {
                    Ok(v) => v,
                    Err(e) => {
                        drop(file);
                        remove_file_if_exists(&part_path);
                        let _ = on_event.send(AndroidDownloadEvent::Finished);
                        return Err(map_reqwest_err(&e));
                    }
                }
            }
        };
        let Some(bytes) = chunk else {
            break;
        };
        if let Err(e) = file.write_all(&bytes).await {
            drop(file);
            remove_file_if_exists(&part_path);
            let _ = on_event.send(AndroidDownloadEvent::Finished);
            return Err(coded(E_IO, format!("写入安装包失败（{e}）")));
        }
        hasher.update(&bytes);
        downloaded += bytes.len() as u64;
        let _ = on_event.send(AndroidDownloadEvent::Progress {
            chunk_length: bytes.len() as u64,
        });
        publish_progress(app, state, downloaded, total, false);
    }

    if cancelled {
        drop(file);
        remove_file_if_exists(&part_path);
        let _ = on_event.send(AndroidDownloadEvent::Finished);
        publish(app, state, |s| {
            s.phase = "cancelled".into();
            s.downloaded = 0;
            s.error = None;
            s.error_code = Some(E_CANCELLED.to_string());
        });
        return Err(coded(E_CANCELLED, "下载已取消"));
    }

    if let Err(e) = file.flush().await {
        drop(file);
        remove_file_if_exists(&part_path);
        let _ = on_event.send(AndroidDownloadEvent::Finished);
        return Err(coded(E_IO, format!("刷新安装包失败（{e}）")));
    }
    drop(file);

    if info.size > 0 && downloaded != info.size {
        remove_file_if_exists(&part_path);
        let _ = on_event.send(AndroidDownloadEvent::Finished);
        return Err(coded(
            E_SIZE,
            format!("安装包大小不符（期望 {}，实际 {downloaded}）", info.size),
        ));
    }

    let actual = format!("{:x}", hasher.finalize());
    if !core::checksum_matches(&info.sha256, &actual) {
        remove_file_if_exists(&part_path);
        let _ = on_event.send(AndroidDownloadEvent::Finished);
        return Err(coded(E_CHECKSUM, "安装包校验失败，可能下载不完整"));
    }

    if let Err(e) = tokio::fs::rename(&part_path, &final_path).await {
        remove_file_if_exists(&part_path);
        let _ = on_event.send(AndroidDownloadEvent::Finished);
        return Err(coded(E_IO, format!("保存安装包失败（{e}）")));
    }
    if let Ok(mut slot) = state.apk.lock() {
        *slot = Some(DownloadedApk {
            path: final_path,
            version: info.version.clone(),
            expected_sha256: info.sha256.clone(),
        });
    }
    publish_progress(app, state, downloaded, total, true);
    publish(app, state, |s| {
        s.phase = "verifying".into();
        s.install_step = None;
        s.error = None;
        s.error_code = None;
    });
    let _ = on_event.send(AndroidDownloadEvent::Finished);
    Ok(())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn android_updater_verify(
    app: AppHandle,
    state: State<'_, AndroidUpdaterSession>,
) -> Result<(), String> {
    let state = state.inner();
    if state.installing.load(Ordering::SeqCst) {
        return Err(coded(E_BUSY, "正在安装，无法校验"));
    }
    let apk = state
        .apk
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .ok_or_else(|| coded(E_NO_APK, "还没有下载完成的安装包"))?;
    publish(&app, state, |s| {
        s.phase = "verifying".into();
        s.error = None;
        s.error_code = None;
    });

    let path = apk.path.clone();
    let expected = apk.expected_sha256.clone();
    let actual = tokio::task::spawn_blocking(move || core::sha256_file(&path))
        .await
        .map_err(|e| coded(E_IO, format!("校验任务失败（{e}）")))?
        .map_err(|e| coded(E_IO, format!("读取安装包失败（{e}）")))?;
    if !core::checksum_matches(&expected, &actual) {
        clear_apk(state);
        return Err(fail(
            &app,
            state,
            E_CHECKSUM,
            "安装包 sha256 校验失败，请重新下载",
            None,
        ));
    }

    // JNI 桥收的是 `&str`（Kotlin 侧形参是 `String`）⇒ 先把路径转成本地字符串。
    let path = apk.path.to_string_lossy().to_string();
    let inspected = tokio::task::spawn_blocking(move || crate::android_apk_install::inspect(&path))
        .await
        .map_err(|e| coded(E_IO, format!("安装包检查任务失败（{e}）")))?;
    match inspected {
        Ok(()) => {
            publish(&app, state, |s| {
                s.phase = "ready".into();
                s.install_step = None;
                s.error = None;
                s.error_code = None;
            });
            Ok(())
        }
        Err(kotlin_code) => {
            let (code, detail) = map_apk_code(&kotlin_code);
            if fatal_apk_code(&kotlin_code) {
                clear_apk(state);
            }
            Err(fail(&app, state, &code, detail, None))
        }
    }
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn android_updater_install(
    app: AppHandle,
    state: State<'_, AndroidUpdaterSession>,
) -> Result<(), String> {
    let state = state.inner();
    if state
        .installing
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(coded(E_BUSY, "安装已在进行中，请勿重复点击"));
    }
    let Some(apk) = state.apk.lock().ok().and_then(|g| g.clone()) else {
        state.installing.store(false, Ordering::SeqCst);
        return Err(coded(E_NO_APK, "安装包不存在，请重新下载"));
    };
    init_handle(&app);
    publish(&app, state, |s| {
        s.phase = "installing".into();
        s.install_step = Some("preparing".into());
        s.error = None;
        s.error_code = None;
    });

    let can_install = tokio::task::spawn_blocking(crate::android_apk_install::can_install)
        .await
        .map_err(|e| coded(E_INSTALL_FAILED, format!("权限检查任务失败（{e}）")))?;
    let can_install = match can_install {
        Ok(v) => v,
        Err(e) => {
            state.installing.store(false, Ordering::SeqCst);
            return Err(fail(&app, state, E_INSTALL_FAILED, e, None));
        }
    };
    if !can_install {
        let _ = crate::android_apk_install::open_settings();
        state.installing.store(false, Ordering::SeqCst);
        return Err(fail(
            &app,
            state,
            E_PERMISSION,
            "需要允许本应用安装未知来源的应用；已打开系统设置，授权后可重试",
            None,
        ));
    }

    // 同上：`install` 的 JNI 形参是 Kotlin `String`，必须先转成 `&str`。
    let path = apk.path.to_string_lossy().to_string();
    let outcome = tokio::task::spawn_blocking(move || crate::android_apk_install::install(&path))
        .await
        .map_err(|e| coded(E_INSTALL_FAILED, format!("安装任务失败（{e}）")))?;
    match outcome {
        Ok(()) => {
            // 回调可能已经先到（极快成功/失败）；只在仍在安装时推进到 launching。
            if state.installing.load(Ordering::SeqCst) {
                publish(&app, state, |s| {
                    s.phase = "installing".into();
                    s.install_step = Some("launching".into());
                });
            }
            Ok(())
        }
        Err(kotlin_code) => {
            state.installing.store(false, Ordering::SeqCst);
            let (code, detail) = map_apk_code(&kotlin_code);
            if fatal_apk_code(&kotlin_code) {
                clear_apk(state);
            }
            Err(fail(&app, state, &code, detail, None))
        }
    }
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn android_updater_cancel(
    app: AppHandle,
    state: State<'_, AndroidUpdaterSession>,
) -> Result<(), String> {
    let state = state.inner();
    if state.installing.load(Ordering::SeqCst) {
        return Err(coded(E_BUSY, "正在安装，无法取消"));
    }
    if let Ok(slot) = state.cancel.lock() {
        if let Some(n) = slot.as_ref() {
            n.notify_one();
        }
    }
    // `.part` 文件清理是磁盘 IO：交给阻塞线程池，别占 tokio worker
    //（否则会被「重活命令棘轮」记一条，也会在低端机上卡住其它通道）。
    // 缓存目录取不到时**跳过清理**而不是让取消失败：取消本身必须总能成功；
    // 这里用显式 match 判断结果（不用 `.ok()`：静默丢弃棘轮硬零）。
    let dir = match updates_dir(&app) {
        Ok(dir) => dir,
        Err(_) => PathBuf::new(),
    };
    tauri::async_runtime::spawn_blocking(move || {
        if dir.as_os_str().is_empty() {
            return;
        }
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy().ends_with(".part") {
                    remove_file_if_exists(&entry.path());
                }
            }
        }
    })
    .await
    .map_err(|e| coded(E_IO, &format!("清理下载残留失败：{e}")))?;
    publish(&app, state, |s| {
        s.phase = "cancelled".into();
        s.downloaded = 0;
        s.error = None;
        s.error_code = Some(E_CANCELLED.to_string());
    });
    Ok(())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn android_updater_status(state: State<'_, AndroidUpdaterSession>) -> AndroidUpdateStatus {
    let state = state.inner();
    match state.status.lock() {
        Ok(s) => s.clone(),
        Err(p) => p.into_inner().clone(),
    }
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn android_updater_close(
    app: AppHandle,
    state: State<'_, AndroidUpdaterSession>,
) -> Result<(), String> {
    let state = state.inner();
    if state.installing.load(Ordering::SeqCst) {
        return Err(coded(E_BUSY, "正在安装，无法关闭更新"));
    }
    if let Ok(slot) = state.cancel.lock() {
        if let Some(n) = slot.as_ref() {
            n.notify_one();
        }
    }
    // 整目录删除同样是磁盘 IO，走阻塞线程池。
    // 同上：目录取不到就跳过清理（关闭面板不该因缓存目录异常而失败），但结果必须显式判断。
    let dir = match updates_dir(&app) {
        Ok(dir) => dir,
        Err(_) => PathBuf::new(),
    };
    tauri::async_runtime::spawn_blocking(move || {
        if dir.as_os_str().is_empty() {
            return;
        }
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                remove_file_if_exists(&entry.path());
            }
        }
    })
    .await
    .map_err(|e| coded(E_IO, &format!("清理安装包失败：{e}")))?;
    clear_apk(state);
    if let Ok(mut info) = state.info.lock() {
        *info = None;
    }
    publish(&app, state, |s| {
        *s = AndroidUpdateStatus {
            phase: "idle".into(),
            ..Default::default()
        };
    });
    Ok(())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn android_updater_open_permission_settings() -> Result<(), String> {
    crate::android_apk_install::open_settings()
}

/// Kotlin `InstallResultReceiver` 的回调。
/// `0` = 安装成功；`1` = 用户取消；其它 = 失败（`message` 是系统给的具体原因）。
#[cfg(target_os = "android")]
pub fn on_native_install_result(result_code: i32, message: Option<String>) {
    let Some(app) = APP_HANDLE.get() else {
        return;
    };
    let Some(state) = app.try_state::<AndroidUpdaterSession>() else {
        return;
    };
    let state = state.inner();
    if !state.installing.swap(false, Ordering::SeqCst) {
        // 重复回调（广播 + onActivityResult 都会到）或过期回调：只认第一次。
        return;
    }
    match result_code {
        0 => {
            let version = state
                .apk
                .lock()
                .ok()
                .and_then(|g| g.as_ref().map(|a| a.version.clone()))
                .or_else(|| {
                    state
                        .info
                        .lock()
                        .ok()
                        .and_then(|g| g.as_ref().map(|c| c.info.version.clone()))
                });
            clear_apk(state);
            if let Ok(mut info) = state.info.lock() {
                *info = None;
            }
            publish(&app, state, |s| {
                s.phase = "installed".into();
                s.version = version;
                s.install_step = None;
                s.error = None;
                s.error_code = None;
            });
        }
        1 => {
            publish(&app, state, |s| {
                s.phase = "failed".into();
                s.error = Some(coded(E_INSTALL_CANCELLED, "安装已取消"));
                s.error_code = Some(E_INSTALL_CANCELLED.to_string());
                s.install_step = None;
            });
        }
        _ => {
            let detail = message.unwrap_or_else(|| "系统安装器返回失败".to_string());
            let msg = coded(E_INSTALL_FAILED, detail);
            publish(&app, state, |s| {
                s.phase = "failed".into();
                s.error = Some(msg);
                s.error_code = Some(E_INSTALL_FAILED.to_string());
                s.install_step = None;
            });
        }
    }
}

/// Kotlin 侧 `STATUS_PENDING_USER_ACTION`：系统确认框已经出现。
#[cfg(target_os = "android")]
pub fn on_native_install_stage(stage: i32) {
    let Some(app) = APP_HANDLE.get() else {
        return;
    };
    let Some(state) = app.try_state::<AndroidUpdaterSession>() else {
        return;
    };
    let state = state.inner();
    if !state.installing.load(Ordering::SeqCst) {
        return;
    }
    if stage == 1 {
        publish(&app, state, |s| {
            s.phase = "installing".into();
            s.install_step = Some("waiting-user".into());
        });
    }
}

/// `onActivityResult`：用户从「安装未知来源应用」设置页返回。
#[cfg(target_os = "android")]
pub fn on_native_permission_result(granted: bool) {
    let Some(app) = APP_HANDLE.get() else {
        return;
    };
    let Some(state) = app.try_state::<AndroidUpdaterSession>() else {
        return;
    };
    let state = state.inner();
    if granted {
        state.installing.store(false, Ordering::SeqCst);
        let has_apk = state.apk.lock().map(|g| g.is_some()).unwrap_or(false);
        if has_apk {
            publish(&app, state, |s| {
                s.phase = "ready".into();
                s.error = None;
                s.error_code = None;
                s.install_step = None;
            });
        }
    } else {
        state.installing.store(false, Ordering::SeqCst);
        publish(&app, state, |s| {
            s.phase = "failed".into();
            s.error = Some(coded(E_PERMISSION, "未获得安装未知来源应用的权限"));
            s.error_code = Some(E_PERMISSION.to_string());
            s.install_step = None;
        });
    }
}

// ---- 非 Android 目标的桩：命令必须存在（generate_handler 不做平台裁剪），但一律拒绝 ----

#[cfg(not(target_os = "android"))]
fn unsupported(command: &str) -> String {
    coded(
        "ANDROID_UPDATE_UNSUPPORTED",
        format!("{command} 仅支持 Android"),
    )
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn android_updater_check(
    _app: AppHandle,
    _state: State<'_, AndroidUpdaterSession>,
) -> Result<Option<AndroidUpdateInfo>, String> {
    Err(unsupported("检查更新"))
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn android_updater_download(
    _app: AppHandle,
    _state: State<'_, AndroidUpdaterSession>,
    _on_event: Channel<AndroidDownloadEvent>,
) -> Result<(), String> {
    Err(unsupported("下载更新"))
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn android_updater_verify(
    _app: AppHandle,
    _state: State<'_, AndroidUpdaterSession>,
) -> Result<(), String> {
    Err(unsupported("校验更新"))
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn android_updater_install(
    _app: AppHandle,
    _state: State<'_, AndroidUpdaterSession>,
) -> Result<(), String> {
    Err(unsupported("安装更新"))
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn android_updater_cancel(
    _app: AppHandle,
    _state: State<'_, AndroidUpdaterSession>,
) -> Result<(), String> {
    Err(unsupported("取消下载"))
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn android_updater_status(_state: State<'_, AndroidUpdaterSession>) -> AndroidUpdateStatus {
    AndroidUpdateStatus::default()
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn android_updater_close(
    _app: AppHandle,
    _state: State<'_, AndroidUpdaterSession>,
) -> Result<(), String> {
    Err(unsupported("关闭更新"))
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn android_updater_open_permission_settings() -> Result<(), String> {
    Err(unsupported("打开安装权限设置"))
}
