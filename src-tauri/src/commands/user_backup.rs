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
        // 文件名带随机后缀防多开实例互踩。守卫兜底：下面任何一步 `return Err`
        // 都会把它删掉（里面有明文私钥，见 `TempFile` 的注释）。
        let tmp = TempFile::new(
            s.db_path
                .with_extension(format!("backup-{}.tmp", crate::db::now_ms())),
        );
        // ① 一致性快照：VACUUM INTO 在主连接上执行（读写都停一瞬，秒级）。
        {
            let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
            dbc.execute(
                "VACUUM INTO ?1",
                rusqlite::params![tmp.path().to_string_lossy().as_ref()],
            )
            .map_err(|e| {
                let msg = format!("生成快照失败（数据目录所在磁盘可写？空间够？）: {e}");
                s.logger.error("backup", format!("code={} {msg}", error_codes::USER_BACKUP_SNAPSHOT_FAILED));
                error_codes::coded(error_codes::USER_BACKUP_SNAPSHOT_FAILED, msg)
            })?;
        }
        // ② 副本上的信封明文化（主库不动 —— 用户拍板「私钥进备份」，明文只活在
        //    密文层内；恢复端启动时按既有逻辑重新封）。
        let (binding_rows, bindings_kept_sealed) = {
            let snap = rusqlite::Connection::open(tmp.path()).map_err(|e| {
                let msg = format!("打开快照失败: {e}");
                s.logger.error("backup", format!("code={} {msg}", error_codes::USER_BACKUP_SNAPSHOT_FAILED));
                error_codes::coded(error_codes::USER_BACKUP_SNAPSHOT_FAILED, msg)
            })?;
            unseal_bindings_in_snapshot(&snap).map_err(|e| {
                let msg = format!("信封明文化失败: {e}");
                s.logger.error("backup", format!("code={} {msg}", error_codes::USER_BACKUP_SNAPSHOT_FAILED));
                error_codes::coded(error_codes::USER_BACKUP_SNAPSHOT_FAILED, msg)
            })?
        };
        // ③ 读快照字节 → 加密外壳 → 写目的地。临时文件由守卫在离开作用域时删除
        //    （原来那行显式 `remove_file` 只覆盖成功路径）。
        let db_bytes = std::fs::read(tmp.path()).map_err(|e| {
            let msg = format!("读快照失败: {e}");
            s.logger.error("backup", format!("code={} {msg}", error_codes::USER_BACKUP_SNAPSHOT_FAILED));
            error_codes::coded(error_codes::USER_BACKUP_SNAPSHOT_FAILED, msg)
        })?;
        drop(tmp);
        let sealed = user_backup::seal_snapshot(
            &db_bytes,
            &password,
            KdfParams::default(),
            rand_salt(),
            rand_nonce(),
        )
        .map_err(|e| {
            // seal_snapshot 自带 RP_KEY_BACKUP_IO 码（"加密失败"）；这里换成备份专属码，
            // 让界面给「重试/换口令」而不是「查磁盘」。
            let msg = format!("加密失败: {e}");
            s.logger.error("backup", format!("code={} {msg}", error_codes::USER_BACKUP_SEAL_FAILED));
            error_codes::coded(error_codes::USER_BACKUP_SEAL_FAILED, msg)
        })?;
        std::fs::write(&dest, &sealed).map_err(|e| {
            let msg = format!("写备份文件失败（导出目标可写？空间够？）: {e}");
            s.logger.error("backup", format!("code={} {msg}", error_codes::USER_BACKUP_WRITE_FAILED));
            error_codes::coded(error_codes::USER_BACKUP_WRITE_FAILED, msg)
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

/// 「除非显式放行，否则离开作用域就删」的临时文件守卫。
///
/// 为什么必须有（2026-11-21 review）：导出快照里装着**已明文**的私钥（见
/// `unseal_bindings_in_snapshot`），而中途每一步都可能 `return Err` —— 只写在成功路径上的
/// `remove_file` 意味着任何一步失败都把明文文件留在 app_data 里。Drop 是唯一不依赖
/// "以后记得加"的写法：新加的错误分支自动被覆盖。
struct TempFile {
    path: PathBuf,
    keep: bool,
}

impl TempFile {
    fn new(path: PathBuf) -> Self {
        Self { path, keep: false }
    }
    fn path(&self) -> &std::path::Path {
        &self.path
    }
    /// 放行：不再删除，把路径交回去（后续 rename 由调用方负责）。
    fn keep(mut self) -> PathBuf {
        self.keep = true;
        self.path.clone()
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        if !self.keep {
            let _ = std::fs::remove_file(&self.path);
        }
    }
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
        // ⚠️ `meta.len()` 本来就是 `u64`，**不要**转 `usize`：32 位目标上那是截断
        // （>4 GiB 的文件会绕回小值），而且 `MAX_DB_BYTES * 2` 在 32 位 usize 上是
        // 编译期溢出（2026-11-21 armv7 打包整条红在这里）。上限按"档案文件 ≈ 快照
        // + 头 + 密文"给两倍余量，全程 u64 比较。
        if meta.len() > user_backup::MAX_DB_BYTES * 2 {
            return Err(error_codes::coded(
                error_codes::RP_KEY_BACKUP_TOO_LARGE,
                "文件超过备份大小上限",
            ));
        }
        let bytes = std::fs::read(&archive)
            .map_err(|e| error_codes::coded(error_codes::RP_KEY_BACKUP_UNREADABLE, format!("读备份失败: {e}")))?;
        let db_bytes = user_backup::open_snapshot(&bytes, &password)?;
        // ⚠️ 先落**临时文件**，校验全过之后才改名成 `restore-pending`（2026-11-21 review）。
        // 启动段的口径是"只要 pending 在就换库"（见 state.rs 恢复段），而这里是"先落
        // pending 再校验" —— 完整性/版本校验失败虽然返回了错误、界面上也算"解析失败"，
        // pending 却已经躺在盘上了：下次启动照样把好库挪成 `.bak`、顶上这个库。
        // 于是"恢复了但失败"静默变成"重启后丢数据"。
        let pending = pending_restore_path(&s.db_path);
        let tmp = TempFile::new(s.db_path.with_extension("restore-tmp"));
        std::fs::write(tmp.path(), &db_bytes).map_err(|e| {
            error_codes::coded(error_codes::RP_KEY_BACKUP_IO, format!("写恢复临时文件失败: {e}"))
        })?;
        // 打开临时库做健康检查 + 概要统计
        let snap = rusqlite::Connection::open(tmp.path())
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
        let friends = count("SELECT COUNT(*) FROM friends");
        let messages = count("SELECT COUNT(*) FROM messages");
        let convs = count("SELECT COUNT(*) FROM conversations");
        // ⚠️ Windows 上"文件还被连接占着"时 `rename` 直接失败（sharing violation）。
        // 校验用的连接必须先关，再转正。
        drop(snap);
        // 校验全过 ⇒ 临时文件转正成 pending：从这一刻起"存在"与"可信"才是同一件事
        //（启动段只按存在性判断，见上一段注释）。
        // ⚠️ **先 rename，再放行守卫**（2026-11-21 review）：顺序反过来的话，
        // rename 失败（Windows 共享冲突 / 权限 / 进程被杀）会留下一个含**明文私钥**的
        // `*.restore-tmp` 永久躺在 app_data 里 —— 守卫的用处恰恰是覆盖这种路径。
        std::fs::rename(tmp.path(), &pending).map_err(|e| {
            error_codes::coded(error_codes::RP_KEY_BACKUP_IO, format!("落 pending 失败: {e}"))
        })?;
        tmp.keep();
        s.logger.info(
            "backup",
            format!(
                "备份解析通过 pending={} uv={user_version} friends={friends} messages={messages} convs={convs}",
                pending.display(),
            ),
        );
        Ok(ImportPreview {
            snapshot_bytes: db_bytes.len() as u64,
            db_user_version: user_version as u32,
            friend_count: friends,
            message_count: messages,
            conversation_count: convs,
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
