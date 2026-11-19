// RP 绑定密钥的导出/恢复命令层：读库 → 交给纯逻辑加密 → 写盘；或读盘 → 解密 → 按计划写库。
//
// 设计稿：`docs/notes/rp-key-export-recovery-design-2026-11-15.md`。
//
// 边界（都刻意写死）：
// - **不碰 P2P 身份密钥**：只读 `rp_device_bindings`，导出包里只有 RP 专属 seed。
// - **不新增表/列**：SQLite schema 属 Frozen Core，导入复用 `insert_binding` 的既有列。
// - **冲突不覆盖**：判定全在 `crate::rp_key_backup::plan_import`（预览与写入共用一份），
//   命令层只负责"按 plan 执行"。
// - **原子性**：整包单事务；部分冲突时其余照常导入，但报告逐条列明。
// - 口令与派生（Argon2id）都是 CPU/内存重活，整段在阻塞池里跑（R-18 要求）。
//
// ⚠️ 本文件是 `include!` 拼进 `commands.rs` 的：`Arc` / `State` / `error_codes` 等名字由父模块
// 与相邻分册提供，**不要**再 `use` 一遍（会 E0252）。

use rand_core::{OsRng, RngCore};
// 跨域依赖走 `use` 而不是 `crate::db::…` 内联：领域依赖守门只看得见 use 形式，
// 内联全路径会变成判据看不见的耦合（该守门有棘轮，本轮已撞到上限）。
use crate::db::{
    insert_binding, list_bindings, list_bindings_with_secrets, now_ms, ReadSecretsError, RpBindingRow,
};

/// 导出结果（只回条数与落点，不回任何密钥材料）。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RpKeyExportSummary {
    pub count: usize,
    pub path: String,
}

/// 导入预览/结果里的一条。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RpKeyImportReport {
    pub items: Vec<crate::rp_key_backup::PlannedItem>,
    pub added: usize,
    pub skipped: usize,
    pub conflicts: usize,
    pub refused: usize,
    pub rejected: usize,
}

fn count_by(items: &[crate::rp_key_backup::PlannedItem], action: crate::rp_key_backup::ImportAction) -> usize {
    items.iter().filter(|i| i.action == action).count()
}

/// 读盘并解密（预览与写入共用的前半段）。
fn open_package(path: &str, passphrase: &str) -> Result<crate::rp_key_backup::BackupDoc, String> {
    let meta = std::fs::metadata(path).map_err(|e| {
        error_codes::coded(error_codes::RP_KEY_BACKUP_IO, format!("读取密钥包失败：{e}"))
    })?;
    if meta.len() as usize > crate::rp_key_backup::MAX_FILE_BYTES {
        return Err(error_codes::coded(
            error_codes::RP_KEY_BACKUP_TOO_LARGE,
            "密钥包过大，已拒绝解析",
        ));
    }
    let bytes = std::fs::read(path).map_err(|e| {
        error_codes::coded(error_codes::RP_KEY_BACKUP_IO, format!("读取密钥包失败：{e}"))
    })?;
    crate::rp_key_backup::open_doc(&bytes, passphrase)
}

/// 本地绑定 → 冲突判定输入。
fn local_bindings(rows: &[RpBindingRow]) -> Vec<crate::rp_key_backup::LocalBinding> {
    rows.iter()
        .map(|r| crate::rp_key_backup::LocalBinding {
            rp_origin: r.rp_origin.clone(),
            client_id: r.client_id.clone(),
            public_key: r.public_key.clone(),
            status: r.status.clone(),
        })
        .collect()
}

/// 导出当前绑定到一个口令加密的 `.gosslankey` 文件。
///
/// 落点由界面的保存对话框给（`dialog:allow-save`）—— 后端不替用户决定写到哪。
#[tauri::command(async)]
pub async fn device_auth_export_bindings(
    state: State<'_, Arc<crate::state::AppState>>,
    destination: String,
    passphrase: String,
) -> Result<RpKeyExportSummary, String> {
    let s = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        if let Some(e) = crate::rp_key_backup::passphrase_error(&passphrase) {
            return Err(e);
        }
        let rows = {
            let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
            // ⚠️ 用 `list_bindings_with_secrets`（**解封后**的明文）而不是 `list_bindings`
            // （库里原样值 = 平台密钥库信封）：导出包的卖点是「换机/重装能迁移」，
            // 而 DPAPI 绑机器、Keystore 绑设备 ⇒ 把信封搬走等于搬了个解不开的东西。
            //
            // ⚠️ 两类失败必须**分开报**（2026-11-19 真机事故）：
            // 「读库失败」与「密钥库打不开」以前都被塞进 `RP_KEY_BACKUP_IO` ⇒
            // 界面一律显示「请检查文件与磁盘空间」，用户去清磁盘，而磁盘是满的。
            match list_bindings_with_secrets(&dbc) {
                Ok(rows) => rows,
                Err(ReadSecretsError::Db(e)) => {
                    return Err(error_codes::coded(
                        error_codes::RP_KEY_BACKUP_STORE_READ_FAILED,
                        format!("读取绑定清单失败：{e}"),
                    ));
                }
                Err(ReadSecretsError::KeyStore(e)) => {
                    return Err(error_codes::coded(
                        error_codes::RP_KEY_BACKUP_KEYSTORE_UNAVAILABLE,
                        format!("打开系统密钥库失败：{e}"),
                    ));
                }
            }
        };
        // 只导出 active / revoked：`pending_registration` 与 `registration_failed` 是 RP 还没确认的
        // 中间态，导出它们等于把一条"对方不知道的凭证"搬走 —— 恢复后仍然不成立。
        let bindings: Vec<_> = rows
            .iter()
            .filter(|r| is_exportable_status(&r.status))
            .map(|r| crate::rp_key_backup::BackupBinding {
                rp_origin: r.rp_origin.clone(),
                client_id: r.client_id.clone(),
                display_name: r.display_name.clone(),
                kid: r.kid.clone(),
                public_key: r.public_key.clone(),
                secret_key: r.secret_key.clone(),
                pairwise_subject: r.pairwise_subject.clone(),
                scopes: r.scopes.clone(),
                created_at: r.created_at,
                status: r.status.clone(),
            })
            .collect();
        if bindings.is_empty() {
            // ⚠️ 这一格**不是** IO 失败：文件一个字节都还没写。
            // 以前这里报 `RP_KEY_BACKUP_IO` ⇒ 界面说「检查文件与磁盘空间」⇒
            // 用户去清磁盘（真机 2026-11-19：磁盘是满的，库里本来一条绑定都没有）。
            return Err(error_codes::coded(
                error_codes::RP_KEY_BACKUP_NOTHING_TO_EXPORT,
                "没有可导出的已授权应用（先在「第三方接入」里绑定一个应用）",
            ));
        }
        let doc = crate::rp_key_backup::BackupDoc {
            v: crate::rp_key_backup::FORMAT_VERSION,
            exported_at: now_ms() / 1000,
            app_name: s.display_name().to_string(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            bindings,
        };
        let mut salt = [0u8; crate::rp_key_backup::SALT_LEN];
        let mut nonce = [0u8; crate::rp_key_backup::NONCE_LEN];
        OsRng.fill_bytes(&mut salt);
        OsRng.fill_bytes(&mut nonce);
        let bytes = crate::rp_key_backup::seal_doc(
            &doc,
            &passphrase,
            crate::rp_key_backup::KdfParams::default(),
            salt,
            nonce,
        )?;

        // 先写同目录临时文件再改名：中途失败不会留下半截凭证文件（改名同卷内是原子的）。
        // 平台差异（Windows 的占用重试、跨卷回退、Unix 的 0600）都收在 `write_atomic_file` 里。
        let dest = std::path::Path::new(&destination);
        write_atomic_file(dest, &bytes).map_err(|e| {
            error_codes::coded(error_codes::RP_KEY_BACKUP_IO, format!("保存文件失败：{e}"))
        })?;
        Ok(RpKeyExportSummary {
            count: doc.bindings.len(),
            path: destination,
        })
    })
    .await
    .map_err(|e| {
        error_codes::coded(error_codes::RP_KEY_BACKUP_IO, format!("导出任务被中断：{e}"))
    })?
}

/// 这一条状态**可以**进导出包。
///
/// ⚠️ 口径只有这一份：前端「导出」按钮的空态判定必须与它一致
/// （前端那份在 `RpKeyBackupSection.vue`，由 `rpKeyBackupWiring.test.ts` 交叉核对）。
/// 理由：中间态（`pending_registration` / `registration_failed`）导出去，恢复后仍然不成立 ——
/// 对方从没确认过这把公钥。
fn is_exportable_status(status: &str) -> bool {
    status == "active" || status == "revoked"
}

/// 改名盖住目标时最多试几次（只对「别的进程正占着这个文件」那类瞬时失败重试）。
const RENAME_ATTEMPTS: u32 = 6;
/// 第一次重试前等多久（之后指数退避，封顶 400ms）。
const RENAME_BACKOFF_MS: u64 = 40;

/// 这类失败是**别的进程正占着这个文件**（杀软扫描 / 记事本打开着 / 资源管理器预览），
/// 稍等一下就能过去 ⇒ 值得重试。
///
/// ⚠️ 只在 Windows 上真：Unix 的 `PermissionDenied` 是真的没权限，重试只是白等
/// （而且 Unix 上 `rename` 覆盖既有文件是原子的，不需要这层）。
#[cfg(target_os = "windows")]
fn is_transient_rename_failure(e: &std::io::Error) -> bool {
    // 5 = ERROR_ACCESS_DENIED、32 = ERROR_SHARING_VIOLATION、33 = ERROR_LOCK_VIOLATION
    matches!(e.raw_os_error(), Some(5) | Some(32) | Some(33))
        || e.kind() == std::io::ErrorKind::PermissionDenied
}

#[cfg(not(target_os = "windows"))]
fn is_transient_rename_failure(_e: &std::io::Error) -> bool {
    false
}

/// 「跨设备」错误码：Unix 的 `EXDEV` = 18；Windows 的 `ERROR_NOT_SAME_DEVICE` = 17。
///
/// ⚠️ 不用 `std::io::ErrorKind::CrossesDevices`（那个变体 1.85 才稳定，而本仓
/// `rust-version = 1.77` ⇒ clippy 的 `incompatible_msrv` 会直接判 error）。
#[cfg(unix)]
const CROSS_DEVICE_ERRNO: i32 = 18;
#[cfg(windows)]
const CROSS_DEVICE_ERRNO: i32 = 17;
#[cfg(not(any(unix, windows)))]
const CROSS_DEVICE_ERRNO: i32 = 18;

/// 删除临时凭据副本，带有限退避重试（杀软扫描/句柄占用时 `remove_file` 会短暂失败）。
/// 与 `rename_replacing` 的占用重试同一口径：有限次、指数退避、封顶。
fn remove_temp_with_retry(path: &std::path::Path) -> std::io::Result<()> {
    let mut delay = std::time::Duration::from_millis(RENAME_BACKOFF_MS);
    for attempt in 1..=RENAME_ATTEMPTS {
        match std::fs::remove_file(path) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) if attempt == RENAME_ATTEMPTS || !is_transient_rename_failure(&e) => return Err(e),
            Err(_) => {
                std::thread::sleep(delay);
                delay = (delay * 2).min(std::time::Duration::from_millis(400));
            }
        }
    }
    unreachable!("循环必然以 Ok 或 Err 收尾")
}

/// 改名盖住目标（`fs::rename`），把平台差异收在这里：
/// - **跨卷（EXDEV）**：`rename` 不能跨设备 ⇒ 退回复制 + 删除。
/// - **Windows 瞬时占用**：有限次退避重试（杀软/记事本占着目标文件时不该让用户重导一次）。
fn rename_replacing(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    let mut delay = std::time::Duration::from_millis(RENAME_BACKOFF_MS);
    for attempt in 1..=RENAME_ATTEMPTS {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => {
                // 跨卷：改名永远不可能成功（目标目录可能是指向别的卷的联接/符号链接）⇒ 复制。
                if e.raw_os_error() == Some(CROSS_DEVICE_ERRNO) {
                    // 跨卷：复制成功但删除临时副本失败会留下**完整的明文密钥包副本**（
                    // 文件即凭证）。重试删除；仍失败则带上路径返回 Err —— 宁可让用户知道
                    // "目标已写入但有临时副本没清掉、请手动删除"，也绝不静默成功。
                    std::fs::copy(from, to)?;
                    if let Err(del) = remove_temp_with_retry(from) {
                        eprintln!(
                            "[rp-key-backup] 跨卷导出后临时凭据副本删除失败，请手动删除：{}（{del}）",
                            from.display()
                        );
                        return Err(del);
                    }
                    return Ok(());
                }
                if attempt == RENAME_ATTEMPTS || !is_transient_rename_failure(&e) {
                    return Err(e);
                }
                std::thread::sleep(delay);
                delay = (delay * 2).min(std::time::Duration::from_millis(400));
            }
        }
    }
    unreachable!("循环必然以 Ok 或 Err 收尾")
}

/// 同目录的临时文件名：`.<目标名>.gosslan-tmp-<随机>`。
///
/// 为什么要随机后缀而不是固定 `.tmp`：两次导出并发时，固定名会让后一份抢走前一份的
/// 临时文件（内容错乱）。放**同目录**是刻意的 —— 改名必须同卷才原子。
fn temp_sibling_path(dest: &std::path::Path) -> PathBuf {
    let dir = dest
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "gosslan-keys.gosslankey".to_string());
    let mut rnd = [0u8; 6];
    OsRng.fill_bytes(&mut rnd);
    // hex 的形状只有 `crypto::hex_lower` 一处（判据 `crypto::tests::hex_encoding_has_exactly_one_home` 守着）。
    let suffix = crate::crypto::hex_lower(&rnd);
    dir.join(format!(".{name}.gosslan-tmp-{suffix}"))
}

/// 把一段字节**原子地**写到目标路径：先写同目录临时文件，落盘后再改名盖上去。
///
/// 为什么不能直接写目标文件：写到一半崩了/被杀 ⇒ 留下一份**半截凭证**，
/// 而用户会以为导出成功了（文件在、体积对、但解不开）。
///
/// 平台差异都在这里收口（用户不该看见）：
/// - **Windows**：目标文件正被别的进程占着时改名会失败 —— 那是**瞬时占用**，不是磁盘满
///   ⇒ 退避重试（见 [`is_transient_rename_failure`]）。
/// - **跨卷**：退回复制 + 删除（见 [`rename_replacing`]）。
/// - **Unix**：临时文件权限收紧到 0600（文件即凭证）。
fn write_atomic_file(dest: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = temp_sibling_path(dest);
    let written = (|| -> std::io::Result<()> {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // 文件即凭证：导出就收紧到 0600（与日志目录同一条纪律）。
            // chmod 失败必须上抛：静默吞掉会让临时文件以 umask 默认权限（常见 0644）
            // 留在盘上，同机其他用户可读 —— 这是凭据文件的 fail-open。
            f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        f.write_all(bytes)?;
        // 落盘再改名：改名成功 ⇒ 内容真的在盘上（掉电也不留半截）。
        f.sync_all()?;
        Ok(())
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = rename_replacing(&tmp, dest) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// 预览：解密 + 逐条判定，**不写库**。
#[tauri::command(async)]
pub async fn device_auth_preview_import(
    state: State<'_, Arc<crate::state::AppState>>,
    source: String,
    passphrase: String,
) -> Result<RpKeyImportReport, String> {
    let s = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let doc = open_package(&source, &passphrase)?;
        let rows = {
            let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
            list_bindings(&dbc).map_err(|e| {
                error_codes::coded(error_codes::RP_KEY_BACKUP_STORE_READ_FAILED, format!("读取绑定清单失败：{e}"))
            })?
        };
        let items = crate::rp_key_backup::plan_import(&local_bindings(&rows), &doc);
        Ok(RpKeyImportReport {
            added: count_by(&items, crate::rp_key_backup::ImportAction::Add),
            skipped: count_by(&items, crate::rp_key_backup::ImportAction::Skip),
            conflicts: count_by(&items, crate::rp_key_backup::ImportAction::Conflict),
            refused: count_by(&items, crate::rp_key_backup::ImportAction::RefuseRevived),
            rejected: count_by(&items, crate::rp_key_backup::ImportAction::Rejected),
            items,
        })
    })
    .await
    .map_err(|e| {
        error_codes::coded(error_codes::RP_KEY_BACKUP_IO, format!("预览任务被中断：{e}"))
    })?
}

/// 真正写入：重新解密、重新判定（**不复用预览结果**，避免两次之间本地状态变了），单事务提交。
#[tauri::command(async)]
pub async fn device_auth_apply_import(
    state: State<'_, Arc<crate::state::AppState>>,
    source: String,
    passphrase: String,
) -> Result<RpKeyImportReport, String> {
    let s = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let doc = open_package(&source, &passphrase)?;
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        let rows = list_bindings(&dbc).map_err(|e| {
            error_codes::coded(error_codes::RP_KEY_BACKUP_STORE_READ_FAILED, format!("读取绑定清单失败：{e}"))
        })?;
        let plan = crate::rp_key_backup::plan_import(&local_bindings(&rows), &doc);
        // 计划按 (rp_origin, client_id) 与文件顺序一一对应 ⇒ 用下标取回原始条目。
        let tx = dbc.unchecked_transaction().map_err(|e| {
            error_codes::coded(error_codes::RP_KEY_BACKUP_IO, format!("开启事务失败：{e}"))
        })?;
        let mut added = 0usize;
        for (i, item) in plan.iter().enumerate() {
            if item.action != crate::rp_key_backup::ImportAction::Add {
                continue;
            }
            let b = &doc.bindings[i];
            let row = RpBindingRow {
                rp_origin: b.rp_origin.clone(),
                client_id: b.client_id.clone(),
                display_name: b.display_name.clone(),
                kid: b.kid.clone(),
                public_key: b.public_key.clone(),
                secret_key: b.secret_key.clone(),
                pairwise_subject: b.pairwise_subject.clone(),
                scopes: b.scopes.clone(),
                status: b.status.clone(),
                created_at: b.created_at,
                // 不伪造"刚刚用过"：文件里没有这个字段，这里就不写。
                last_used_at: None,
                // 撤销时间也不编：recovery 只负责把凭证搬回来。
                revoked_at: None,
            };
            insert_binding(&tx, &row).map_err(|e| {
                error_codes::coded(error_codes::RP_KEY_BACKUP_IO, format!("写入绑定失败：{e}"))
            })?;
            added += 1;
        }
        tx.commit().map_err(|e| {
            error_codes::coded(error_codes::RP_KEY_BACKUP_IO, format!("提交事务失败：{e}"))
        })?;
        Ok(RpKeyImportReport {
            added,
            skipped: count_by(&plan, crate::rp_key_backup::ImportAction::Skip),
            conflicts: count_by(&plan, crate::rp_key_backup::ImportAction::Conflict),
            refused: count_by(&plan, crate::rp_key_backup::ImportAction::RefuseRevived),
            rejected: count_by(&plan, crate::rp_key_backup::ImportAction::Rejected),
            items: plan,
        })
    })
    .await
    .map_err(|e| {
        error_codes::coded(error_codes::RP_KEY_BACKUP_IO, format!("导入任务被中断：{e}"))
    })?
}

#[cfg(test)]
mod rp_key_backup_cmd_tests {
    use super::*;

    /// 导入的写入语义（不依赖 tauri）：Add 条进库、Skip/Conflict 不动库。
    #[test]
    fn apply_only_inserts_added_items() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE rp_device_bindings (
                rp_origin TEXT NOT NULL, client_id TEXT NOT NULL, display_name TEXT NOT NULL,
                kid TEXT NOT NULL, public_key TEXT NOT NULL, secret_key TEXT NOT NULL,
                pairwise_subject TEXT NOT NULL, scopes TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL,
                last_used_at INTEGER, revoked_at INTEGER, PRIMARY KEY (rp_origin, client_id));",
        )
        .unwrap();

        // 造两条：一条全新、一条与本地同键不同公钥（冲突）
        let mk = |seed: u8, origin: &str, client: &str| {
            let key = crate::crypto::RpKey::from_secret_b64(&STANDARD.encode([seed; 32])).unwrap();
            crate::rp_key_backup::BackupBinding {
                rp_origin: origin.into(),
                client_id: client.into(),
                display_name: String::new(),
                kid: crate::device_auth::kid_from_public(&key.public_key_bytes()),
                public_key: base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .encode(key.public_key_bytes()),
                secret_key: STANDARD.encode([seed; 32]),
                pairwise_subject: "s".into(),
                scopes: String::new(),
                created_at: 1,
                status: "active".into(),
            }
        };
        let doc = crate::rp_key_backup::BackupDoc {
            v: 1,
            exported_at: 0,
            app_name: String::new(),
            app_version: String::new(),
            bindings: vec![mk(7, "https://a.example.com", "a"), mk(8, "https://b.example.com", "b")],
        };
        // 本地已有一条 b，但公钥不同 ⇒ 冲突，不许覆盖
        let local = vec![crate::rp_key_backup::LocalBinding {
            rp_origin: "https://b.example.com".into(),
            client_id: "b".into(),
            public_key: "not-the-same".into(),
            status: "active".into(),
        }];
        let plan = crate::rp_key_backup::plan_import(&local, &doc);

        let tx = conn.unchecked_transaction().unwrap();
        for (i, item) in plan.iter().enumerate() {
            if item.action != crate::rp_key_backup::ImportAction::Add {
                continue;
            }
            let b = &doc.bindings[i];
            let row = RpBindingRow {
                rp_origin: b.rp_origin.clone(),
                client_id: b.client_id.clone(),
                display_name: b.display_name.clone(),
                kid: b.kid.clone(),
                public_key: b.public_key.clone(),
                secret_key: b.secret_key.clone(),
                pairwise_subject: b.pairwise_subject.clone(),
                scopes: b.scopes.clone(),
                status: b.status.clone(),
                created_at: b.created_at,
                last_used_at: None,
                revoked_at: None,
            };
            insert_binding(&tx, &row).unwrap();
        }
        tx.commit().unwrap();

        let rows = list_bindings(&conn).unwrap();
        assert_eq!(rows.len(), 1, "只该写入 Add 的那一条");
        assert_eq!(rows[0].client_id, "a");
        assert_eq!(rows[0].last_used_at, None, "恢复不该伪造 last_used_at");
    }

    // ---------------- 导出这一侧的平台差异与口径 ----------------

    /// 建一张只有 `rp_device_bindings` 的内存库（不经过迁移，省掉无关依赖）。
    fn bindings_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE rp_device_bindings (
                rp_origin TEXT NOT NULL, client_id TEXT NOT NULL, display_name TEXT NOT NULL,
                kid TEXT NOT NULL, public_key TEXT NOT NULL, secret_key TEXT NOT NULL,
                pairwise_subject TEXT NOT NULL, scopes TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL,
                last_used_at INTEGER, revoked_at INTEGER, PRIMARY KEY (rp_origin, client_id));",
        )
        .unwrap();
        conn
    }

    /// 往库里塞一条指定 `secret_key` 的绑定（**绕过 `insert_binding`**：
    /// 它在写入前会封密钥，测「库里有信封」必须原样塞进去）。
    fn put_binding(conn: &rusqlite::Connection, client: &str, secret: &str, status: &str) {
        conn.execute(
            "INSERT INTO rp_device_bindings
                (rp_origin, client_id, display_name, kid, public_key, secret_key,
                 pairwise_subject, scopes, status, created_at, last_used_at, revoked_at)
             VALUES (?1, ?2, '', 'k', 'p', ?3, 's', '', ?4, 1, NULL, NULL)",
            rusqlite::params![format!("https://{client}.example.com"), client, secret, status],
        )
        .unwrap();
    }

    /// **空态不报 IO**：没有可导出的应用时，后端必须给「空态」那一格。
    ///
    /// ⚠️ 这条是 2026-11-19 真机事故的回归锁：那条空态曾经报 `RP_KEY_BACKUP_IO`
    /// ⇒ 界面显示「请检查文件与磁盘空间」，用户去清磁盘（磁盘是满的，库里本来一条都没有）。
    /// 判据**不是**看文案，而是看**码**：码错了界面就会说错话。
    #[test]
    fn empty_export_reports_nothing_to_export_not_io() {
        let src = include_str!("rp_key_backup.rs");
        // 定位「空态」那一段（`bindings.is_empty()` 分支），**只取这一段**：
        // 取太宽会把后面「真·文件 IO」那一格一起扫进来 ⇒ 判据会误红。
        let at = src
            .find("if bindings.is_empty()")
            .expect("找不到空态分支：导出命令里必须有这一格");
        let end = src[at..]
            .find("\n        }")
            .map(|i| at + i)
            .expect("空态分支的收尾大括号不见了");
        // 注释里会提到别的码（说明「以前错在哪」），判据只看**代码** ⇒ 先剥掉注释行。
        let branch: String = src[at..end]
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            branch.contains("RP_KEY_BACKUP_NOTHING_TO_EXPORT"),
            "空态必须报 RP_KEY_BACKUP_NOTHING_TO_EXPORT（否则界面会说「检查磁盘空间」）"
        );
        assert!(
            !branch.contains("RP_KEY_BACKUP_IO"),
            "空态不许再报 RP_KEY_BACKUP_IO —— 那一格是「真·文件读写失败」"
        );
    }

    /// **可导出口径只有 active / revoked**（中间态导出去恢复后仍然不成立）。
    #[test]
    fn exportable_status_is_active_or_revoked_only() {
        assert!(is_exportable_status("active"));
        assert!(is_exportable_status("revoked"));
        for mid in ["pending_registration", "registration_failed", "", "unknown"] {
            assert!(!is_exportable_status(mid), "{mid} 不该进导出包");
        }
    }

    /// **密钥库打不开 ≠ 读库失败**：两类必须可分（界面给的「下一步」完全不同）。
    ///
    /// ⚠️ 跨平台成立的原因：`gsk1.dpapi.…` 这个信封在**每个**平台都解不开 ——
    /// macOS/Linux 根本没这个后端（ForeignBackend），Windows 有后端但这份密文不是本机封的
    /// （解不开）。所以断言的是「**属于密钥库这一类**」，而不是某一支的具体变体。
    #[test]
    fn foreign_envelope_is_reported_as_keystore_failure_not_db_failure() {
        let conn = bindings_db();
        put_binding(&conn, "a", "gsk1.dpapi.AAAA", "active");
        match list_bindings_with_secrets(&conn) {
            Err(ReadSecretsError::KeyStore(_)) => {}
            Err(ReadSecretsError::Db(e)) => {
                panic!("密钥库解不开不许报成读库失败：{e}")
            }
            Ok(rows) => panic!(
                "不许回落明文：解不开的密钥包必须报错（这里回了 {} 行）",
                rows.len()
            ),
        }
    }

    /// **旧格式明文照常能读**（没有密钥库的机器上就是明文列）—— 别把这条一起改坏。
    #[test]
    fn plaintext_secret_still_reads_on_every_platform() {
        let conn = bindings_db();
        put_binding(&conn, "a", "c2VjcmV0", "active");
        let rows = list_bindings_with_secrets(&conn).expect("旧格式明文不该报错");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].secret_key, "c2VjcmV0");
    }

    /// **原子写：盖掉既有文件**（Windows 与 Unix 的行为必须一致）。
    ///
    /// ⚠️ 这条是平台差异的回归锁：Windows 的 `rename` 目标已存在时要能替换
    /// （`MOVEFILE_REPLACE_EXISTING`），Unix 天然可以。导出同一个路径两次是真实用法。
    #[test]
    fn atomic_write_replaces_existing_target() {
        let dir = std::env::temp_dir().join(format!("gosslan-atomic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("keys.gosslankey");

        write_atomic_file(&dest, b"first").unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"first");

        write_atomic_file(&dest, b"second").unwrap();
        assert_eq!(
            std::fs::read(&dest).unwrap(),
            b"second",
            "导出到同一个路径两次，第二次必须盖掉第一次（不是报「文件已存在」）"
        );

        // 临时文件不许留在目录里（用户会看到一堆 .gosslan-tmp-… 的垃圾文件）。
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n != "keys.gosslankey")
            .collect();
        assert!(leftovers.is_empty(), "留下临时文件了：{leftovers:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **原子写失败时清理临时文件**（不留半截凭证给用户）。
    #[test]
    fn atomic_write_cleans_temp_file_on_failure() {
        let dir = std::env::temp_dir().join(format!("gosslan-atomic-fail-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // 目标是一个**目录** ⇒ 写临时文件能成，改名盖不上去 ⇒ 必然失败。
        let dest = dir.join("occupied");
        std::fs::create_dir_all(&dest).unwrap();

        assert!(write_atomic_file(&dest, b"payload").is_err(), "盖目录必须失败");

        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n != "occupied")
            .collect();
        assert!(leftovers.is_empty(), "失败后留下临时文件了：{leftovers:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **临时文件与目标同目录**（改名必须同卷才原子；跨目录会 EXDEV）。
    #[test]
    fn temp_file_is_a_sibling_of_the_target() {
        let dir = std::env::temp_dir().join(format!("gosslan-atomic-sib-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("keys.gosslankey");
        let tmp = temp_sibling_path(&dest);
        assert_eq!(tmp.parent(), dest.parent(), "临时文件必须与目标同目录");
        assert_ne!(tmp, dest);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
