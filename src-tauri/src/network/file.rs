//! 文件传输与共享目录服务。
//!
//! 传输流程（E2EE）：
//! - 发送方：`send_file_from_path` 为本 transfer 生成随机文件会话密钥，用接收方
//!   X25519 公钥 ECDH + AEAD 封装后随 `FileOffer` 发出；等待 `FileAccept`
//!   （oneshot 握手）后，以 256KB 分片**逐片加密**为 `FileChunk` 流式发送，最后 `FileDone`。
//! - 接收方：收到 `FileOffer` 后解封会话密钥（只有我能解开），自动接受，
//!   逐片解密写入 `.part` 临时文件，`FileDone` 时改名落盘。密文绝不落盘。
//! - 中继路径：中继节点只透传密文切片，不持有会话密钥、无法解密。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use tauri::Emitter;
use tokio::time::Duration;

use crate::crypto;
use crate::db;
use crate::network::transport::{resolve_member_x25519, try_send};
use crate::protocol::{Message, ShareEntry, FILE_CHUNK};
use crate::state::{AppState, FileDoneInfo, FileFailedInfo, FileReceiver};

fn emit_failed(state: &AppState, transfer_id: &str, reason: impl Into<String>) {
    let _ = state.app.emit(
        "file-failed",
        &FileFailedInfo {
            transfer_id: transfer_id.to_string(),
            reason: reason.into(),
        },
    );
}

/// 流式计算文件 SHA-256（256KB 分块增量更新，不整读内存），返回小写 hex。
pub fn sha256_file_hex(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; FILE_CHUNK];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// SHA-256 hex 表示校验（64 位 hex，大小写均可；比较时统一小写）。
pub fn valid_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// 主动向 `peer_id` 发送本地文件。
pub async fn send_file_from_path(
    state: &Arc<AppState>,
    peer_id: &str,
    transfer_id: &str,
    path: PathBuf,
) -> Result<(), String> {
    let meta = match std::fs::metadata(&path) {
        Ok(meta) => meta,
        Err(e) => {
            let reason = e.to_string();
            emit_failed(state, transfer_id, &reason);
            return Err(reason);
        }
    };
    if !meta.is_file() {
        let reason = "只能发送普通文件";
        emit_failed(state, transfer_id, reason);
        return Err(reason.to_string());
    }
    let size = meta.len();
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "unnamed".to_string());

    // ---- E2EE：本 transfer 独立的随机文件会话密钥（CSPRNG），仅存内存 ----
    let file_key = crypto::random_key();
    // 文件级完整性：流式计算原文件 SHA-256（256KB 分块，不整读内存）
    let file_sha256 = sha256_file_hex(&path)?;
    // 接收方公钥：peers 优先、friends 回落（与 GroupKey 分发同一来源策略）
    let receiver_pubkey = resolve_member_x25519(state, peer_id);
    let sealed_key_b64 = (|| {
        let pubkey = receiver_pubkey.as_deref()?;
        let shared = crypto::shared_secret(&state.identity.x25519_secret, pubkey)?;
        Some(STANDARD.encode(crypto::seal(&shared, &file_key)?))
    })();
    let Some(sealed_key_b64) = sealed_key_b64 else {
        let reason = "无法获取对方公钥，无法加密文件";
        emit_failed(state, transfer_id, reason);
        return Err(reason.to_string());
    };

    {
        let dbc = state.db.lock().unwrap();
        db::upsert_transfer(
            &dbc,
            transfer_id,
            peer_id,
            &name,
            size,
            "send",
            "pending",
            Some(path.to_string_lossy().as_ref()),
            0.0,
        )
        .ok();
    }

    let (tx, rx) = tokio::sync::oneshot::channel();
    state
        .pending_file_accept
        .lock()
        .unwrap()
        .insert(transfer_id.to_string(), tx);

    let offer = Message::FileOffer {
        transfer_id: transfer_id.to_string(),
        from: state.device_id.clone(),
        name: name.clone(),
        size,
        sealed_file_key: sealed_key_b64,
        file_sha256,
    };
    if let Err(e) = try_send(state, peer_id, &offer).await {
        state
            .pending_file_accept
            .lock()
            .unwrap()
            .remove(transfer_id);
        let dbc = state.db.lock().unwrap();
        db::upsert_transfer(
            &dbc,
            transfer_id,
            peer_id,
            &name,
            size,
            "send",
            "failed",
            None,
            0.0,
        )
        .ok();
        emit_failed(state, transfer_id, &e);
        return Err(e);
    }

    // 等待对方接受（超时 15 秒）
    match tokio::time::timeout(Duration::from_secs(15), rx).await {
        Ok(Ok(())) => {}
        _ => {
            state
                .pending_file_accept
                .lock()
                .unwrap()
                .remove(transfer_id);
            {
                let dbc = state.db.lock().unwrap();
                db::upsert_transfer(
                    &dbc,
                    transfer_id,
                    peer_id,
                    &name,
                    size,
                    "send",
                    "failed",
                    None,
                    0.0,
                )
                .ok();
            }
            let reason = "对方未接受文件";
            emit_failed(state, transfer_id, reason);
            return Err(reason.to_string());
        }
    }

    // 传输中断（链路断开等）也要把记录标记为 failed，避免永远停在 active
    match stream_file(state, peer_id, transfer_id, path, name, size, file_key).await {
        Ok(()) => Ok(()),
        Err(e) => {
            let dbc = state.db.lock().unwrap();
            db::upsert_transfer(
                &dbc,
                transfer_id,
                peer_id,
                "",
                size,
                "send",
                "failed",
                None,
                0.0,
            )
            .ok();
            emit_failed(state, transfer_id, &e);
            Err(e)
        }
    }
}

async fn stream_file(
    state: &Arc<AppState>,
    peer_id: &str,
    transfer_id: &str,
    path: PathBuf,
    name: String,
    size: u64,
    file_key: [u8; 32],
) -> Result<(), String> {
    use tokio::io::AsyncReadExt;

    let mut f = tokio::fs::File::open(&path)
        .await
        .map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; FILE_CHUNK];
    let mut seq = 0u32;
    let mut sent = 0u64;
    // 进度节流：避免每片一次 SQLite 写 + IPC 事件（大文件会形成事件风暴卡死界面）
    let mut last_report = std::time::Instant::now() - Duration::from_secs(1);

    {
        let dbc = state.db.lock().unwrap();
        db::upsert_transfer(
            &dbc,
            transfer_id,
            peer_id,
            &name,
            size,
            "send",
            "active",
            None,
            0.0,
        )
        .ok();
    }

    loop {
        let n = f.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        // E2EE：每片独立随机 nonce 的 AEAD 密文（crypto::seal = nonce || ct），
        // 同一密钥不同片 nonce 必不相同，无 nonce 重用。
        let sealed = crypto::seal_symmetric(&file_key, &buf[..n])
            .ok_or_else(|| "文件分片加密失败".to_string())?;
        let data = STANDARD.encode(&sealed);
        let chunk = Message::FileChunk {
            transfer_id: transfer_id.to_string(),
            seq,
            data,
        };
        try_send(state, peer_id, &chunk).await?;
        seq += 1;
        sent += n as u64;

        if last_report.elapsed() >= Duration::from_millis(250) {
            last_report = std::time::Instant::now();
            let progress = if size == 0 {
                1.0
            } else {
                sent as f64 / size as f64
            };
            {
                let dbc = state.db.lock().unwrap();
                db::upsert_transfer(
                    &dbc,
                    transfer_id,
                    peer_id,
                    &name,
                    size,
                    "send",
                    "active",
                    None,
                    progress,
                )
                .ok();
            }
            let _ = state.app.emit(
                "file-progress",
                &crate::state::FileProgress {
                    transfer_id: transfer_id.to_string(),
                    received: sent,
                    total: size,
                },
            );
        }
    }

    try_send(
        state,
        peer_id,
        &Message::FileDone {
            transfer_id: transfer_id.to_string(),
        },
    )
    .await?;
    {
        let dbc = state.db.lock().unwrap();
        db::upsert_transfer(
            &dbc,
            transfer_id,
            peer_id,
            &name,
            size,
            "send",
            "done",
            None,
            1.0,
        )
        .ok();
        // 发送方消息状态也要推进到 delivered：否则气泡永远停在「发送中」spinner，
        // 因为后端不会给自己的消息回 Ack/FileDone 事件。
        db::set_message_status(&dbc, &format!("file-{transfer_id}"), "delivered").ok();
    }
    // 通知前端发送方文件消息已完成（前端 onMessageAcked 会把 spinner 切为空圆框）
    let _ = state
        .app
        .emit("message-acked", &format!("file-{transfer_id}"));
    // 发送方也需要 file-done 事件来更新 transfer 状态（进度条消失 + transfer.status → done）
    let _ = state.app.emit(
        "file-done",
        &FileDoneInfo {
            transfer_id: transfer_id.to_string(),
            name: name.clone(),
            size,
            path: path.to_string_lossy().to_string(),
        },
    );
    let _ = state.app.emit(
        "file-progress",
        &crate::state::FileProgress {
            transfer_id: transfer_id.to_string(),
            received: size,
            total: size,
        },
    );
    Ok(())
}

/// 接收方：准备接收文件，返回最终落盘路径。
pub fn begin_receive(
    state: &AppState,
    transfer_id: &str,
    peer_id: &str,
    name: &str,
    size: u64,
    file_key: [u8; 32],
    expected_sha256: String,
) -> Result<PathBuf, String> {
    let safe_name = safe_file_name(name).ok_or("文件名非法")?;
    if size > i64::MAX as u64 {
        return Err("文件过大，无法安全保存".to_string());
    }
    if state
        .file_receivers
        .lock()
        .unwrap()
        .contains_key(transfer_id)
    {
        return Err("重复的文件传输".to_string());
    }
    std::fs::create_dir_all(&state.downloads_dir).ok();
    let final_path = unique_path(&state.downloads_dir, &safe_name);
    let tmp_path = PathBuf::from(format!("{}.part", final_path.display()));
    let f = std::fs::File::create(&tmp_path).map_err(|e| e.to_string())?;

    state.file_receivers.lock().unwrap().insert(
        transfer_id.to_string(),
        FileReceiver {
            file: f,
            name: safe_name,
            size,
            received: 0,
            next_seq: 0,
            tmp_path: tmp_path.clone(),
            final_path: final_path.clone(),
            peer_id: peer_id.to_string(),
            last_report_ms: 0,
            file_key,
            expected_sha256,
            hasher: {
                use sha2::Digest as _;
                sha2::Sha256::new()
            },
        },
    );

    {
        let dbc = state.db.lock().unwrap();
        db::upsert_transfer(
            &dbc,
            transfer_id,
            peer_id,
            name,
            size,
            "receive",
            "active",
            Some(final_path.to_string_lossy().as_ref()),
            0.0,
        )
        .ok();
    }
    Ok(final_path)
}

/// 接收方：写入一个分片，返回累计字节数。
/// 入参 `data` 为 AEAD 密文（nonce || ciphertext）：先解密再写盘，
/// 解密失败直接报错——密文绝不落盘。
pub fn write_chunk(
    state: &AppState,
    transfer_id: &str,
    peer_id: &str,
    seq: u32,
    data: &[u8],
) -> Result<u64, String> {
    use std::io::Write;
    let mut recv = state.file_receivers.lock().unwrap();
    let r = recv.get_mut(transfer_id).ok_or("未知传输")?;
    if r.peer_id != peer_id {
        return Err("文件传输来源不匹配".to_string());
    }
    if seq != r.next_seq {
        return Err("文件分片顺序错误".to_string());
    }
    let plaintext = crypto::open_symmetric(&r.file_key, data)
        .ok_or_else(|| "文件分片解密失败".to_string())?;
    if plaintext.len() as u64 > r.size.saturating_sub(r.received) {
        return Err("文件分片超出声明大小".to_string());
    }
    // 文件级完整性：明文增量哈希（与写盘同一份数据，无二次磁盘读取）
    use sha2::Digest;
    r.hasher.update(&plaintext);
    r.file.write_all(&plaintext).map_err(|e| e.to_string())?;
    r.received += plaintext.len() as u64;
    r.next_seq = r.next_seq.checked_add(1).ok_or("文件分片序号溢出")?;
    Ok(r.received)
}

/// 终止损坏或超时的接收，删除临时文件，避免留下永远占空间的 `.part` 文件。
pub fn fail_receive(state: &AppState, transfer_id: &str, peer_id: &str, reason: &str) -> bool {
    let mut recv = state.file_receivers.lock().unwrap();
    let Some(r) = recv.remove(transfer_id) else {
        return false;
    };
    if r.peer_id != peer_id {
        recv.insert(transfer_id.to_string(), r);
        return false;
    }
    let _ = std::fs::remove_file(&r.tmp_path);
    let dbc = state.db.lock().unwrap();
    db::upsert_transfer(
        &dbc,
        transfer_id,
        &r.peer_id,
        &r.name,
        r.size,
        "receive",
        "failed",
        None,
        0.0,
    )
    .ok();
    emit_failed(state, transfer_id, reason);
    true
}

/// 对端断链时终止其所有未完成接收，避免下载目录长期堆积临时文件。
pub fn fail_receives_for_peer(state: &AppState, peer_id: &str) {
    let ids: Vec<String> = state
        .file_receivers
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, r)| r.peer_id == peer_id)
        .map(|(id, _)| id.clone())
        .collect();
    for id in ids {
        let _ = fail_receive(state, &id, peer_id, "对端连接已断开");
    }
}

/// 接收方：收尾，返回 (name, size, final_path, peer_id)。
pub fn finish_receive(
    state: &AppState,
    transfer_id: &str,
    peer_id: &str,
) -> Result<Option<(String, u64, PathBuf, String)>, String> {
    let mut recv = state.file_receivers.lock().unwrap();
    let r = match recv.remove(transfer_id) {
        Some(r) => r,
        None => return Ok(None),
    };
    if r.peer_id != peer_id {
        recv.insert(transfer_id.to_string(), r);
        return Err("文件传输来源不匹配".to_string());
    }
    if r.received != r.size {
        let _ = std::fs::remove_file(&r.tmp_path);
        let dbc = state.db.lock().unwrap();
        db::upsert_transfer(
            &dbc,
            transfer_id,
            &r.peer_id,
            &r.name,
            r.size,
            "receive",
            "failed",
            None,
            0.0,
        )
        .ok();
        return Err("文件传输未完成".to_string());
    }
    // 文件级完整性校验：实际 SHA-256 必须与发送方声明一致，否则不落盘
    {
        use sha2::Digest;
        let actual = r.hasher.clone().finalize();
        let actual_hex: String = actual.iter().map(|b| format!("{b:02x}")).collect();
        if !actual_hex.eq_ignore_ascii_case(&r.expected_sha256) {
            let _ = std::fs::remove_file(&r.tmp_path);
            let dbc = state.db.lock().unwrap();
            db::upsert_transfer(
                &dbc,
                transfer_id,
                &r.peer_id,
                &r.name,
                r.size,
                "receive",
                "failed",
                None,
                0.0,
            )
            .ok();
            return Err("文件完整性校验失败".to_string());
        }
    }
    if let Err(e) = r.file.sync_all() {
        let reason = e.to_string();
        let _ = std::fs::remove_file(&r.tmp_path);
        let dbc = state.db.lock().unwrap();
        db::upsert_transfer(
            &dbc,
            transfer_id,
            &r.peer_id,
            &r.name,
            r.size,
            "receive",
            "failed",
            None,
            0.0,
        )
        .ok();
        return Err(reason);
    }
    drop(r.file);
    if let Err(e) = std::fs::rename(&r.tmp_path, &r.final_path) {
        let reason = e.to_string();
        let dbc = state.db.lock().unwrap();
        db::upsert_transfer(
            &dbc,
            transfer_id,
            &r.peer_id,
            &r.name,
            r.size,
            "receive",
            "failed",
            None,
            0.0,
        )
        .ok();
        return Err(reason);
    }
    {
        let dbc = state.db.lock().unwrap();
        db::upsert_transfer(
            &dbc,
            transfer_id,
            &r.peer_id,
            &r.name,
            r.size,
            "receive",
            "done",
            Some(r.final_path.to_string_lossy().as_ref()),
            1.0,
        )
        .ok();
    }
    Ok(Some((
        r.name.clone(),
        r.size,
        r.final_path.clone(),
        r.peer_id.clone(),
    )))
}

/// 递归枚举共享目录树（限制深度 8，跳过隐藏文件）。
pub fn walk_share_dir(root: &Path) -> Vec<ShareEntry> {
    let mut out = Vec::new();
    walk(root, "", &mut out, 0);
    out
}

fn walk(dir: &Path, rel: &str, out: &mut Vec<ShareEntry>, depth: usize) {
    if depth > 8 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let path = e.path();
        let Ok(file_type) = e.file_type() else {
            continue;
        };
        // 不跟随符号链接，避免共享目录枚举泄露共享根目录之外的路径。
        if file_type.is_symlink() {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let rel_path = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        let is_dir = file_type.is_dir();
        let size = if is_dir {
            0
        } else {
            std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0)
        };
        out.push(ShareEntry {
            name,
            path: rel_path.clone(),
            is_dir,
            size,
        });
        if is_dir {
            walk(&path, &rel_path, out, depth + 1);
        }
    }
}

/// 按文件扩展名（大小写不敏感）保守分类附件类型：`image` / `code` / `file`。
///
/// 这是纯函数，**仅依赖 basename**：FileOffer 已把 `name` 带到接收端，两端各自调用
/// 同一实现 → 分类结果天然一致，无需给文件传输协议增加字段。
///
/// 未用 MIME 魔数嗅探的原因：那要么需要给 FileOffer/RelayFileOffer 加 kind 字段
/// （违反「不修改文件传输协议」），要么两端各自读字节嗅探（引入 sender/receiver 分歧）。
/// 任务给出的图片/代码清单本身即扩展名，扩展名判定已足够保守且确定。
pub fn classify_file_subtype(name: &str) -> &'static str {
    let ext = Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" => "image",
        "rs" | "ts" | "tsx" | "js" | "jsx" | "vue" | "py" | "go" | "java" | "c" | "cpp" | "h"
        | "hpp" | "json" | "yaml" | "yml" | "md" | "html" | "css" | "sql" | "sh" => "code",
        _ => "file",
    }
}

/// 避免重名：`a.txt` -> `a (1).txt`
fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let base = dir.join(name);
    if !base.exists() {
        return base;
    }
    let stem = base
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = base
        .extension()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    for i in 1..1000 {
        let cand = if ext.is_empty() {
            dir.join(format!("{stem} ({i})"))
        } else {
            dir.join(format!("{stem} ({i}).{ext}"))
        };
        if !cand.exists() {
            return cand;
        }
    }
    base
}

/// 文件名来自远端协议，必须只允许 basename，避免 `../` / Windows `\\` 穿越下载目录。
pub(crate) fn safe_file_name(name: &str) -> Option<String> {
    if name.is_empty() || name == "." || name == ".." || name.contains('\0') {
        return None;
    }
    if name.contains('/') || name.contains('\\') {
        return None;
    }
    Some(name.to_string())
}

/// 人类可读的文件大小。
#[allow(dead_code)]
pub fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = bytes as f64;
    let mut i = 0;
    while v >= 1024.0 && i < 4 {
        v /= 1024.0;
        i += 1;
    }
    format!("{v:.1} {}", UNITS[i])
}

#[cfg(test)]
mod tests {
    use super::{classify_file_subtype, safe_file_name};

    #[test]
    fn image_extensions() {
        for n in ["a.png", "a.jpg", "a.jpeg", "a.gif", "a.webp"] {
            assert_eq!(classify_file_subtype(n), "image", "{n}");
        }
    }

    #[test]
    fn code_extensions() {
        for n in [
            "a.rs", "a.ts", "a.tsx", "a.js", "a.jsx", "a.vue", "a.py", "a.go", "a.java", "a.c",
            "a.cpp", "a.h", "a.hpp", "a.json", "a.yaml", "a.yml", "a.md", "a.html", "a.css",
            "a.sql", "a.sh",
        ] {
            assert_eq!(classify_file_subtype(n), "code", "{n}");
        }
    }

    #[test]
    fn other_files() {
        for n in [
            "a.exe", "a.zip", "a.pdf", "a.docx", "a.txt", "Makefile", "LICENSE",
        ] {
            assert_eq!(classify_file_subtype(n), "file", "{n}");
        }
    }

    #[test]
    fn case_insensitive_and_multidot_and_chinese() {
        assert_eq!(classify_file_subtype("PHOTO.PNG"), "image");
        assert_eq!(classify_file_subtype("App.Vue"), "code");
        assert_eq!(classify_file_subtype("archive.tar.gz"), "file"); // 末段 gz 不在清单
        assert_eq!(classify_file_subtype("min.bundle.js"), "code"); // 末段 js
        assert_eq!(classify_file_subtype("报告 截图.JPG"), "image"); // 中文名 + 空格
        assert_eq!(classify_file_subtype("代码.rs"), "code");
        assert_eq!(classify_file_subtype(".gitignore"), "file"); // 隐藏文件无有效扩展
        assert_eq!(classify_file_subtype(""), "file");
    }

    #[test]
    fn rejects_path_traversal_file_names() {
        for name in ["../secret.txt", "..\\secret.txt", "/tmp/secret", "..", ""] {
            assert!(safe_file_name(name).is_none(), "{name} must be rejected");
        }
        assert_eq!(safe_file_name("report.txt").as_deref(), Some("report.txt"));
    }

    // ---------- 文件传输 E2EE（协议层模拟，不依赖 AppState） ----------

    use super::super::super::crypto;
    use super::{sha256_file_hex, valid_sha256_hex};
    use crate::protocol::FILE_CHUNK;
    use base64::Engine as _;

    /// 在系统临时目录创建唯一的 .part 文件（测试接收端用），返回句柄与路径。
    fn temp_part(tag: &str) -> (std::fs::File, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "gosslan-test-{tag}-{}.part",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let f = std::fs::File::create(&path).unwrap();
        (f, path)
    }

    /// 模拟接收端 write_chunk 的核心序列：AEAD 解密 → 增量哈希 → 写 .part。
    /// （write_chunk 本体需要 AppState，此处按相同操作序列驱动 FileReceiver。）
    fn receive_one_chunk(r: &mut crate::state::FileReceiver, seq: u32, sealed: &[u8]) {
        assert_eq!(seq, r.next_seq, "write_chunk 语义：seq 必须严格递增");
        use sha2::Digest;
        let plaintext = crypto::open_symmetric(&r.file_key, sealed).expect("解密失败");
        r.hasher.update(&plaintext);
        std::io::Write::write_all(&mut r.file, &plaintext).unwrap();
        r.received += plaintext.len() as u64;
        r.next_seq += 1;
    }

    /// 模拟 finish_receive 的最终裁决：size 一致 + SHA-256 一致才算完成。
    fn finish_verdict(r: &mut crate::state::FileReceiver) -> Result<(), String> {
        use sha2::Digest;
        if r.received != r.size {
            return Err("文件传输未完成".to_string());
        }
        let actual_hex: String = r
            .hasher
            .clone()
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        if !actual_hex.eq_ignore_ascii_case(&r.expected_sha256) {
            return Err("文件完整性校验失败".to_string());
        }
        Ok(())
    }

    fn hex_of(bytes: &[u8]) -> String {
        use sha2::Digest;
        let mut h = sha2::Sha256::new();
        h.update(bytes);
        h.finalize().iter().map(|b| format!("{b:02x}")).collect()
    }

    /// 1. FileOffer.sealed_file_key：发送方以接收方公钥封装、接收方解封，
    ///    必须还原出同一个文件会话密钥（ECDH 对称性）。
    #[test]
    fn file_offer_sealed_key_roundtrip() {
        let sender = crypto::Identity::generate();
        let receiver = crypto::Identity::generate();
        let file_key = crypto::random_key();

        // 发送端（send_file_from_path 同逻辑）：receiver 公钥封装
        let shared = crypto::shared_secret(&sender.x25519_secret, &receiver.x25519_public_b64())
            .expect("ECDH 失败");
        let sealed_key_b64 = base64::engine::general_purpose::STANDARD
            .encode(crypto::seal(&shared, &file_key).expect("封装失败"));

        // 接收端（handle_message FileOffer 同逻辑）：sender 公钥解封
        let shared_rx = crypto::shared_secret(&receiver.x25519_secret, &sender.x25519_public_b64())
            .expect("ECDH 失败");
        let sealed = base64::engine::general_purpose::STANDARD
            .decode(&sealed_key_b64)
            .expect("base64 非法");
        let opened = crypto::open(&shared_rx, &sealed).expect("解封失败");
        assert_eq!(opened.len(), 32);
        assert_eq!(opened, file_key, "解封出的文件会话密钥必须与原密钥一致");
    }

    /// 2. FileChunk 加密→解密 roundtrip：原始 bytes 完整还原。
    #[test]
    fn file_chunk_encrypt_roundtrip() {
        let file_key = crypto::random_key();
        let plaintext: Vec<u8> = (0u8..=255).cycle().take(FILE_CHUNK).collect();
        let sealed = crypto::seal_symmetric(&file_key, &plaintext).expect("加密失败");
        let opened = crypto::open_symmetric(&file_key, &sealed).expect("解密失败");
        assert_eq!(opened, plaintext);
    }

    /// 3. 密文被篡改后解密必须失败（AEAD 完整性），不能产出可用明文。
    #[test]
    fn tampered_chunk_fails_to_decrypt() {
        let file_key = crypto::random_key();
        let plaintext = b"gosslan file chunk";
        let mut sealed = crypto::seal_symmetric(&file_key, plaintext).expect("加密失败");
        let last = sealed.len() - 1;
        sealed[last] ^= 0xFF; // 翻转密文最后一比特
        assert!(
            crypto::open_symmetric(&file_key, &sealed).is_none(),
            "篡改后的密文必须解密失败"
        );
    }

    /// 4. 每个 transfer 生成独立的随机文件会话密钥，不得共用。
    #[test]
    fn distinct_transfers_have_distinct_keys() {
        let a = crypto::random_key();
        let b = crypto::random_key();
        assert_ne!(a, b, "两次 random_key() 必须产生不同密钥（CSPRNG）");
        // 密文互换后必须解不开：证明密钥确实互不通用
        let msg = b"content of transfer";
        let sealed_with_a = crypto::seal_symmetric(&a, msg).unwrap();
        assert!(crypto::open_symmetric(&b, &sealed_with_a).is_none());
    }

    /// 5. 中继节点原样转发密文（RelayChunk 只透传 data），
    ///    接收端用自己解封的会话密钥仍可解密——中继无需也无法解密。
    #[test]
    fn relay_forwarded_ciphertext_still_decryptable() {
        let sender = crypto::Identity::generate();
        let receiver = crypto::Identity::generate();
        let file_key = crypto::random_key();

        // 发送端：封装会话密钥 + 加密 chunk
        let shared = crypto::shared_secret(&sender.x25519_secret, &receiver.x25519_public_b64())
            .unwrap();
        let sealed_key_b64 = base64::engine::general_purpose::STANDARD
            .encode(crypto::seal(&shared, &file_key).unwrap());
        let plaintext = b"chunk travels through relay nodes";
        let ciphertext_b64 = base64::engine::general_purpose::STANDARD
            .encode(crypto::seal_symmetric(&file_key, plaintext).unwrap());

        // 模拟中继：data 原样透传（无密钥、无修改）——中继不可见明文
        let forwarded = ciphertext_b64.clone();

        // 接收端：解封密钥 → 解密转发的密文
        let shared_rx = crypto::shared_secret(&receiver.x25519_secret, &sender.x25519_public_b64())
            .unwrap();
        let opened_key: [u8; 32] = crypto::open(
            &shared_rx,
            &base64::engine::general_purpose::STANDARD
                .decode(&sealed_key_b64)
                .unwrap(),
        )
        .unwrap()
        .try_into()
        .unwrap();
        let decrypted = crypto::open_symmetric(
            &opened_key,
            &base64::engine::general_purpose::STANDARD.decode(&forwarded).unwrap(),
        )
        .expect("中继转发后的密文必须仍可解密");
        assert_eq!(decrypted, plaintext);
    }

    /// 6. 完整传输生命周期（协议层）：解封密钥 → 多分片逐片加解密 →
    ///    拼接还原 + 大小校验通过——与 finish_receive 的裁决一致。
    #[test]
    fn full_transfer_lifecycle_still_completes() {
        let sender = crypto::Identity::generate();
        let receiver = crypto::Identity::generate();

        // 原始文件：3 片（末片不满 256KB，覆盖边界）
        let mut original: Vec<u8> = Vec::new();
        for i in 0..(FILE_CHUNK * 3 - 1234) {
            original.push((i % 251) as u8);
        }
        let chunks: Vec<&[u8]> = original.chunks(FILE_CHUNK).collect();

        // 发送端生命周期：random_key → 封装 → 逐片加密
        let file_key = crypto::random_key();
        let shared = crypto::shared_secret(&sender.x25519_secret, &receiver.x25519_public_b64())
            .unwrap();
        let sealed_key_b64 = base64::engine::general_purpose::STANDARD
            .encode(crypto::seal(&shared, &file_key).unwrap());
        let wire_chunks: Vec<Vec<u8>> = chunks
            .iter()
            .map(|c| crypto::seal_symmetric(&file_key, c).unwrap())
            .collect();

        // 接收端生命周期：解封密钥 → 逐片解密重组 → 大小校验
        let shared_rx = crypto::shared_secret(&receiver.x25519_secret, &sender.x25519_public_b64())
            .unwrap();
        let restored_key: [u8; 32] = crypto::open(
            &shared_rx,
            &base64::engine::general_purpose::STANDARD
                .decode(&sealed_key_b64)
                .unwrap(),
        )
        .unwrap()
        .try_into()
        .unwrap();
        let mut assembled: Vec<u8> = Vec::new();
        for (seq, wire) in wire_chunks.iter().enumerate() {
            // seq 严格递增校验（write_chunk 语义）：乱序片在这里被拒绝
            assert_eq!(seq as usize, assembled.chunks(FILE_CHUNK).count());
            let plain = crypto::open_symmetric(&restored_key, wire)
                .unwrap_or_else(|| panic!("分片 {seq} 解密失败"));
            assembled.extend_from_slice(&plain);
        }
        assert_eq!(assembled.len(), original.len(), "重组大小必须一致");
        assert_eq!(assembled, original, "重组内容必须与原文件一致");
    }

    // ---------- 文件级 SHA-256 完整性校验 ----------

    /// sha256_file_hex：流式分块结果必须与一次性内存计算一致（发送端正确性）。
    #[test]
    fn sha256_file_hex_matches_in_memory_hash() {
        let path = std::env::temp_dir().join(format!("gosslan-test-sha-{}.bin", std::process::id()));
        std::fs::write(&path, b"gosslan sha-256 streaming test body").unwrap();
        let got = sha256_file_hex(&path).unwrap();
        let want = hex_of(b"gosslan sha-256 streaming test body");
        let _ = std::fs::remove_file(&path);
        assert_eq!(got, want);
        assert_eq!(got.len(), 64, "hex 表示必须为 64 字符");
    }

    /// SHA-256 hex 字段格式校验（FileOffer 元数据），非法即拒绝。
    #[test]
    fn invalid_sha256_format_is_rejected() {
        assert!(valid_sha256_hex(&hex_of(b"ok")));
        assert!(valid_sha256_hex(&hex_of(b"ok").to_uppercase()), "大写 hex 也合法");
        assert!(!valid_sha256_hex(""), "空串");
        assert!(!valid_sha256_hex("abc"), "长度不足");
        assert!(!valid_sha256_hex(&"a".repeat(63)), "63 位");
        assert!(!valid_sha256_hex(&"a".repeat(65)), "65 位");
        assert!(!valid_sha256_hex(&format!("{}g", "a".repeat(63))), "非 hex 字符");
    }

    /// 空文件边界：SHA-256 已知值 + sha256_file_hex 对 0 字节文件正确。
    #[test]
    fn empty_file_sha256_matches_known_value() {
        let path = std::env::temp_dir().join(format!("gosslan-test-empty-{}.bin", std::process::id()));
        std::fs::write(&path, b"").unwrap();
        let got = sha256_file_hex(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(
            got,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            "空文件 SHA-256 必须是标准已知值"
        );
    }

    /// 正常文件：多分片经「解密 → 增量哈希 → 写盘」后，最终 SHA-256 一致 → 完成。
    #[test]
    fn receiver_hash_lifecycle_success() {
        let original: Vec<u8> = (0..FILE_CHUNK * 2 + 777u32 as usize)
            .map(|i| (i % 251) as u8)
            .collect();
        let expected = hex_of(&original);
        let file_key = crypto::random_key();

        let (f, part_path) = temp_part("ok");
        let mut r = crate::state::FileReceiver {
            file: f,
            name: "ok.bin".into(),
            size: original.len() as u64,
            received: 0,
            next_seq: 0,
            tmp_path: part_path.clone(),
            final_path: part_path.clone(),
            peer_id: "a".into(),
            last_report_ms: 0,
            file_key,
            expected_sha256: expected.clone(),
            hasher: {
                use sha2::Digest as _;
                sha2::Sha256::new()
            },
        };

        for (seq, chunk) in original.chunks(FILE_CHUNK).enumerate() {
            let sealed = crypto::seal_symmetric(&file_key, chunk).unwrap();
            receive_one_chunk(&mut r, seq as u32, &sealed);
        }
        assert!(finish_verdict(&mut r).is_ok(), "内容一致时校验必须通过");
        let _ = std::fs::remove_file(&part_path);
    }

    /// 篡改某个明文分片：最终 SHA-256 不一致 → failed（不得视为完成）。
    #[test]
    fn receiver_hash_mismatch_fails() {
        let original: Vec<u8> = (0..FILE_CHUNK + 100u32 as usize)
            .map(|i| (i % 199) as u8)
            .collect();
        let expected = hex_of(&original);
        let file_key = crypto::random_key();

        let (f, part_path) = temp_part("bad");
        let mut r = crate::state::FileReceiver {
            file: f,
            name: "bad.bin".into(),
            size: original.len() as u64,
            received: 0,
            next_seq: 0,
            tmp_path: part_path.clone(),
            final_path: part_path.clone(),
            peer_id: "a".into(),
            last_report_ms: 0,
            file_key,
            expected_sha256: expected,
            hasher: {
                use sha2::Digest as _;
                sha2::Sha256::new()
            },
        };

        for (seq, chunk) in original.chunks(FILE_CHUNK).enumerate() {
            let mut plain = chunk.to_vec();
            if seq == 0 {
                plain[0] ^= 0x01; // 篡改首片一个比特
            }
            let sealed = crypto::seal_symmetric(&file_key, &plain).unwrap();
            receive_one_chunk(&mut r, seq as u32, &sealed);
        }
        let verdict = finish_verdict(&mut r);
        assert_eq!(verdict.unwrap_err(), "文件完整性校验失败");
        let _ = std::fs::remove_file(&part_path);
    }

    /// relay 场景：最终接收方逐片解密 + 增量哈希（RelayFileReceive 生命周期），
    /// 重组完成后 SHA-256 校验通过；中继只透传密文，不参与哈希。
    #[test]
    fn relay_receiver_hash_lifecycle_success() {
        use crate::state::RelayFileReceive;
        let original: Vec<u8> = (0..FILE_CHUNK + 500u32 as usize)
            .map(|i| (i % 241) as u8)
            .collect();
        let expected = hex_of(&original);
        let file_key = crypto::random_key();

        let mut rs = RelayFileReceive {
            file_key,
            expected_sha256: expected,
            hasher: {
                use sha2::Digest as _;
                sha2::Sha256::new()
            },
        };

        let mut assembled: Vec<u8> = Vec::new();
        for (seq, chunk) in original.chunks(FILE_CHUNK).enumerate() {
            let sealed = crypto::seal_symmetric(&file_key, chunk).unwrap(); // 发送端
            let _forwarded = sealed.clone(); // 中继：原样透传
            let plain = crypto::open_symmetric(&rs.file_key, &_forwarded).unwrap(); // 接收端
            use sha2::Digest;
            rs.hasher.update(&plain); // handle_relay_chunk 的增量哈希
            assembled.extend_from_slice(&plain);
        }
        assert_eq!(assembled.len() as u64, original.len() as u64);
        use sha2::Digest;
        let actual_hex: String = rs
            .hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert!(
            actual_hex.eq_ignore_ascii_case(&rs.expected_sha256),
            "中继场景最终校验必须通过"
        );
    }
}
