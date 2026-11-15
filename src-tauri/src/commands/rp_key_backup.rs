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
use crate::db::{insert_binding, list_bindings, now_ms, RpBindingRow};

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
            list_bindings(&dbc).map_err(|e| {
                error_codes::coded(error_codes::RP_KEY_BACKUP_IO, format!("读取绑定清单失败：{e}"))
            })?
        };
        // 只导出 active / revoked：`pending_registration` 与 `registration_failed` 是 RP 还没确认的
        // 中间态，导出它们等于把一条"对方不知道的凭证"搬走 —— 恢复后仍然不成立。
        let bindings: Vec<_> = rows
            .iter()
            .filter(|r| r.status == "active" || r.status == "revoked")
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
            return Err(error_codes::coded(
                error_codes::RP_KEY_BACKUP_IO,
                "没有可导出的已授权应用",
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

        // 先写 .tmp 再 rename：中途失败不会留下半截凭证文件（rename 同目录内是原子的）。
        let tmp = format!("{destination}.tmp");
        {
            use std::io::Write;
            let mut f = std::fs::File::create(&tmp).map_err(|e| {
                error_codes::coded(error_codes::RP_KEY_BACKUP_IO, format!("创建文件失败：{e}"))
            })?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                // 文件即凭证：导出就收紧到 0600（与日志目录同一条纪律）。
                let _ = f.set_permissions(std::fs::Permissions::from_mode(0o600));
            }
            f.write_all(&bytes).map_err(|e| {
                let _ = std::fs::remove_file(&tmp);
                error_codes::coded(error_codes::RP_KEY_BACKUP_IO, format!("写入文件失败：{e}"))
            })?;
        }
        std::fs::rename(&tmp, &destination).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
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
                error_codes::coded(error_codes::RP_KEY_BACKUP_IO, format!("读取绑定清单失败：{e}"))
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
            error_codes::coded(error_codes::RP_KEY_BACKUP_IO, format!("读取绑定清单失败：{e}"))
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
}
