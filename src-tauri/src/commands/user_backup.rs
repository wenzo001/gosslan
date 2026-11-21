// 用户数据全量备份的**命令层**（J1-4b）：文件系统、tauri、数据库都在这一层。
//
// 纯逻辑（格式/加解密/校验）在 `crate::user_backup`，这里的职责只有三件事：
//
// ## 导出（`export_user_backup`）
//
// `VACUUM INTO` 生成一致性快照（官方备份 API：不阻塞主连接、落盘即完整）→
// **信封列解成明文**（备份外壳自己加密，明文只活在密文层内；恢复端按既有的
// 「旧格式行第一次被读到时升级信封」逻辑重新封）→ 整库字节 `seal_snapshot` →
// 写目的地 → 删临时文件。
//
// ⚠️ **异机信封解不开的行原样保留**（部分恢复好过全失败）：从旧备份恢复来的
// RP 绑定行带着旧机器的信封，本机密钥库解不开 —— 这类行数在返回值里报给界面。
//
// ## 导入（`import_user_backup` + `apply_user_backup_restore`，两步）
//
// 解密 → SQLite 魔数 + `integrity_check` + `user_version` ≤ 本机版本（**更figh 一律
// 拒绝**：程序比数据旧，恢复只会更坏）→ 写 `restore-pending` 文件。**替换主库发生在
// 下一次启动**（启动早期检查 pending 文件，见 `state.rs` 的恢复段）—— 运行中的
// 连接绝不能被背后换文件。第二步 `apply_user_backup_restore` 只做「确认 + 重启」。

use tokio::task::spawn_blocking;

use crate::user_backup::{self, KdfParams};

/// 导出结果（界面展示用）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    /// 写入的文件字节数。
    pub file_bytes: u64,
    /// 快照里 RP 绑定行的总数。
    pub binding_rows: usize,
    /// 其中**信封解不开**（异机封的）被原样保留的行数 —— 恢复端这些行不可用。
    pub bindings_kept_sealed: usize,
}

/// 导入预览（确认框展示用）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub snapshot_bytes: u64,
    pub db_user_version: u32,
    pub friend_count: i64,
    pub message_count: i64,
    pub conversation_count: i64,
    /// 快照生成的本机应用版本（导出端写进 settings，仅人工识别）。
    pub app_version: Option<String>,
}

/// 把 VACUUM INTO 产物里的 RP 绑定信封**解成明文**（就地 UPDATE）。
///
/// 返回 (总行数, 解不开被保留的行数)。解不开 = `open_secret` Err（密钥库打不开 /
/// 异机信封）：那一行原样保留信封字节 —— 恢复端同样解不开，但其它行不受影响。
/// **不是静默**：行数在导出报告里报给界面（`bindingsKeptSealed`）。
fn unseal_bindings_in_snapshot(conn: &rusqlite::Connection) -> Result<(usize, usize), rusqlite::Error> {
    let rows: Vec<(String, String, String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT rp_origin, client_id, device_id, secret_key FROM rp_device_bindings",
        )?;
        let it = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?;
        it.collect::<Result<_, _>>()?
    };
    let total = rows.len();
    let mut kept = 0usize;
    for (rp_origin, client_id, device_id, sealed) in rows {
        match crate::rp_key_store::open_secret(&sealed) {
            Ok(plain) => {
                conn.execute(
                    "UPDATE rp_device_bindings SET secret_key = ?4
                     WHERE rp_origin = ?1 AND client_id = ?2 AND device_id = ?3",
                    rusqlite::params![rp_origin, client_id, device_id, plain],
                )?;
            }
            Err(_) => {
                // 留痕但不失败：这一行的命运在导出报告里说清（bindingsKeptSealed）。
                kept += 1;
            }
        }
    }
    Ok((total, kept))
}

#[tauri::command(async)]
pub async fn export_user_backup(
    state: State<'_, Arc<AppState>>,
    password: String,
    destination: String,
) -> Result<ExportReport, String> {
    let s = state.inner().clone();
    let dest = PathBuf::from(&destination);
    spawn_blocking(move || -> Result<ExportReport, String> {
        if let Some(e) = user_backup::passphrase_error(&password) {
            return Err(e);
        }
        // 快照写进 app_data 同目录（同一文件系统 ⇒ rename/删除都是原子便宜操作），
        // 文件名带随机后缀防多开实例互踩。
        let tmp_path = s
            .db_path
            .with_extension(format!("backup-{}.tmp", crate::db::now_ms()));
        // ① 一致性快照：VACUUM INTO 在主连接上执行（读写都停一瞬，秒级）。
        {
            let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
            dbc.execute(
                "VACUUM INTO ?1",
                rusqlite::params![tmp_path.to_string_lossy().as_ref()],
            )
            .map_err(|e| {
                error_codes::coded(
                    error_codes::RP_KEY_BACKUP_IO,
                    format!("生成快照失败（目标目录可写？）: {e}"),
                )
            })?;
        }
        // ② 副本上的信封明文化（主库不动 —— 用户拍板「私钥进备份」，明文只活在
        //    密文层内；恢复端启动时按既有逻辑重新封）。
        let (binding_rows, bindings_kept_sealed) = {
            let snap = rusqlite::Connection::open(&tmp_path)
                .map_err(|e| error_codes::coded(error_codes::RP_KEY_BACKUP_IO, format!("打开快照失败: {e}")))?;
            unseal_bindings_in_snapshot(&snap).map_err(|e| {
                error_codes::coded(error_codes::RP_KEY_BACKUP_IO, format!("信封明文化失败: {e}"))
            })?
        };
        // ③ 读快照字节 → 加密外壳 → 写目的地 → 清理临时文件。
        let db_bytes = std::fs::read(&tmp_path).map_err(|e| {
            error_codes::coded(error_codes::RP_KEY_BACKUP_IO, format!("读快照失败: {e}"))
        })?;
        let _ = std::fs::remove_file(&tmp_path);
        let sealed = user_backup::seal_snapshot(
            &db_bytes,
            &password,
            KdfParams::default(),
            rand_salt(),
            rand_nonce(),
        )?;
        std::fs::write(&dest, &sealed).map_err(|e| {
            error_codes::coded(
                error_codes::RP_KEY_BACKUP_IO,
                format!("写备份文件失败（目标可写？空间够？）: {e}"),
            )
        })?;
        s.logger.info(
            "backup",
            format!(
                "已导出全量备份 dest={} bytes={} bindings={binding_rows} kept_sealed={bindings_kept_sealed}",
                dest.display(),
                sealed.len()
            ),
        );
        Ok(ExportReport {
            file_bytes: sealed.len() as u64,
            binding_rows,
            bindings_kept_sealed,
        })
    })
    .await
    .map_err(|e| format!("备份操作被线程池中断: {e}"))?
}

fn rand_salt() -> [u8; user_backup::SALT_LEN] {
    let mut s = [0u8; user_backup::SALT_LEN];
    use rand_core::RngCore;
    rand_core::OsRng.fill_bytes(&mut s);
    s
}

fn rand_nonce() -> [u8; user_backup::NONCE_LEN] {
    let mut n = [0u8; user_backup::NONCE_LEN];
    use rand_core::RngCore;
    rand_core::OsRng.fill_bytes(&mut n);
    n
}

/// pending 恢复文件的标准命名（导出与启动检查共用同一个名字，别处别再拼）。
pub fn pending_restore_path(db_path: &std::path::Path) -> PathBuf {
    db_path.with_extension("restore-pending")
}

/// 解密 + 校验 + 落 pending 文件。**不替换主库** —— 那一步在下一次启动。
#[tauri::command(async)]
pub async fn import_user_backup(
    state: State<'_, Arc<AppState>>,
    archive_path: String,
    password: String,
) -> Result<ImportPreview, String> {
    let s = state.inner().clone();
    let archive = PathBuf::from(&archive_path);
    spawn_blocking(move || -> Result<ImportPreview, String> {
        let meta = std::fs::metadata(&archive)
            .map_err(|_| error_codes::coded(error_codes::RP_KEY_BACKUP_UNREADABLE, "备份文件读不到"))?;
        if meta.len() as usize > user_backup::MAX_DB_BYTES * 2 {
            return Err(error_codes::coded(
                error_codes::RP_KEY_BACKUP_TOO_LARGE,
                "文件超过备份大小上限",
            ));
        }
        let bytes = std::fs::read(&archive)
            .map_err(|e| error_codes::coded(error_codes::RP_KEY_BACKUP_UNREADABLE, format!("读备份失败: {e}")))?;
        let db_bytes = user_backup::open_snapshot(&bytes, &password)?;
        // 落 pending 文件（启动时替换主库）
        let pending = pending_restore_path(&s.db_path);
        std::fs::write(&pending, &db_bytes).map_err(|e| {
            error_codes::coded(error_codes::RP_KEY_BACKUP_IO, format!("写 pending 失败: {e}"))
        })?;
        // 打开 pending 库做健康检查 + 概要统计
        let snap = rusqlite::Connection::open(&pending)
            .map_err(|e| error_codes::coded(error_codes::RP_KEY_BACKUP_UNREADABLE, format!("打开恢复库失败: {e}")))?;
        let integrity: String = snap
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .map_err(|e| error_codes::coded(error_codes::RP_KEY_BACKUP_UNREADABLE, format!("完整性检查失败: {e}")))?;
        if integrity != "ok" {
            return Err(error_codes::coded(
                error_codes::RP_KEY_BACKUP_UNREADABLE,
                format!("快照库完整性检查未通过: {integrity}"),
            ));
        }
        let user_version: i64 = snap
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| error_codes::coded(error_codes::RP_KEY_BACKUP_UNREADABLE, format!("读 schema 版本失败: {e}")))?;
        if user_version as u32 > crate::db::DB_VERSION {
            return Err(error_codes::coded(
                error_codes::RP_KEY_BACKUP_UNSUPPORTED,
                format!(
                    "备份的 schema 版本（{user_version}）比本机程序（{}）新 —— 先升级应用再恢复",
                    crate::db::DB_VERSION
                ),
            ));
        }
        let count = |sql: &str| -> i64 {
            snap.query_row(sql, [], |r| r.get(0)).unwrap_or(0)
        };
        // app_version 只是给人看的（导出端的版本号）。读不到（老备份没有这一行）
        // 合法，但要留痕——棘轮不许 `.ok()` 把失败变成「没有过这次检查」。
        let app_version: Option<String> = match snap.query_row(
            "SELECT value FROM settings WHERE key = 'app_version'",
            [],
            |r| r.get(0),
        ) {
            Ok(v) => Some(v),
            Err(e) => {
                s.logger
                    .warn("backup", format!("备份里没有 app_version（老格式？）: {e}"));
                None
            }
        };
        s.logger.info(
            "backup",
            format!(
                "备份解析通过 pending={} uv={user_version} friends={} messages={} convs={}",
                pending.display(),
                count("SELECT COUNT(*) FROM friends"),
                count("SELECT COUNT(*) FROM messages"),
                count("SELECT COUNT(*) FROM conversations"),
            ),
        );
        Ok(ImportPreview {
            snapshot_bytes: db_bytes.len() as u64,
            db_user_version: user_version as u32,
            friend_count: count("SELECT COUNT(*) FROM friends"),
            message_count: count("SELECT COUNT(*) FROM messages"),
            conversation_count: count("SELECT COUNT(*) FROM conversations"),
            app_version,
        })
    })
    .await
    .map_err(|e| format!("备份操作被线程池中断: {e}"))?
}

/// 第二步：用户确认后，把 pending 标记为「重启即替换」并重启。
/// 替换动作本身在启动早期（`state.rs` 恢复段）—— 运行中的连接动不得。
#[tauri::command(async)]
pub async fn apply_user_backup_restore(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let s = state.inner().clone();
    let s_check = s.clone();
    let exists = spawn_blocking(move || pending_restore_path(&s_check.db_path).exists())
        .await
        .unwrap_or(false);
    if !exists {
        return Err(error_codes::coded(
            error_codes::RP_KEY_BACKUP_UNREADABLE,
            "没有待恢复的备份（先执行解析）",
        ));
    }
    s.logger
        .info("backup", "用户确认恢复，即将重启替换主库".to_string());
    crate::restart::request_restart(&s.app);
    Ok(())
}

/// 取消待恢复（用户在确认框点了放弃）：删掉 pending 文件。
#[tauri::command(async)]
pub async fn cancel_user_backup_restore(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let s = state.inner().clone();
    spawn_blocking(move || {
        let pending = pending_restore_path(&s.db_path);
        if pending.exists() {
            let _ = std::fs::remove_file(&pending);
            s.logger.info("backup", "用户取消了待恢复的备份".to_string());
        }
        Ok::<(), String>(())
    })
    .await
    .unwrap_or(Ok(()))
}
