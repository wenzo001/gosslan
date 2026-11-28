// 用户数据全量备份的**命令层**（J1-4b）：文件系统、tauri、数据库都在这一层。
//
// 纯逻辑（格式/加解密/校验）在 `crate::user_backup`，这里的职责只有三件事：
//
// ## 导出（`export_user_backup`）
//
// `VACUUM INTO` 生成一致性快照（官方备份 API：不阻塞主连接、落盘即完整）→
// **信封列解成明文**（备份外壳自己加密，明文只活在密文层内；恢复端按既有的
// 「旧格式行第一次被读到时升级信封」逻辑重新封）→ v2 tar（database.enc + 表情原件/缩略图）
// → 写目的地 → 删临时文件。
//
// ⚠️ **异机信封解不开的行原样保留**（部分恢复好过全失败）：从旧备份恢复来的
// RP 绑定行带着旧机器的信封，本机密钥库解不开 —— 这类行数在返回值里报给界面。
//
// ## 导入（`import_user_backup` + `apply_user_backup_restore`，两步）
//
// 解密 → SQLite 魔数 + `integrity_check` + `user_version` ≤ 本机版本（**更高版本一律
// 拒绝**）→ 写 `restore-pending` 文件。v2 另将表情写入 `stickers-restore-<uuid>`，
// 启动换库前先原子提交到 `stickers`，换库失败则回滚。**替换主库发生在下一次启动**
// （见 `state.rs` 的恢复段）——运行中的连接绝不能被背后换文件。
// 第二步 `apply_user_backup_restore` 只做「确认 + 重启」。

use std::io::Read as _;
use std::path::Path;

use rusqlite::OptionalExtension;
use tokio::task::spawn_blocking;

use crate::user_backup::{self, KdfParams};

/// 导入与取消共享同一个临界区；启动恢复发生在单线程启动段，不需要 Tokio 锁。
static RESTORE_IO_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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
fn unseal_bindings_in_snapshot(
    conn: &rusqlite::Connection,
) -> Result<(usize, usize), rusqlite::Error> {
    let rows: Vec<(String, String, String)> = {
        let mut stmt = conn.prepare(
            // ⚠️ 主键是 (rp_origin, client_id)——**没有 device_id 列**。2026-11-21 的 J1-4b
            // 曾经在这里写了 device_id：SELECT 一编译就报
            // "no such column: device_id" ⇒ 从那天的版本起整库导出**在任何机器上都必然失败**，
            // 而当时共用 RP_KEY_BACKUP_IO ⇒ 界面显示"请检查磁盘空间"，把所有人引去查磁盘
            // （2026-11-23 Windows 用户 + 2026-11-24 macOS dev 两次真机）。列名以
            // `db.rs` 的 CREATE TABLE 为准，别再凭记忆写。
            "SELECT rp_origin, client_id, secret_key FROM rp_device_bindings",
        )?;
        let it = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        it.collect::<Result<_, _>>()?
    };
    let total = rows.len();
    let mut kept = 0usize;
    for (rp_origin, client_id, sealed) in rows {
        match crate::rp_key_store::open_secret(&sealed) {
            Ok(plain) => {
                conn.execute(
                    "UPDATE rp_device_bindings SET secret_key = ?3
                     WHERE rp_origin = ?1 AND client_id = ?2",
                    rusqlite::params![rp_origin, client_id, plain],
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
        // ③ v2：一张 tar 同时装数据库密文、表情原件与缩略图。口令只派生一次。
        let app_data = s.db_path.parent().ok_or_else(|| {
            error_codes::coded(error_codes::USER_BACKUP_SNAPSHOT_FAILED, "无法定位应用数据目录")
        })?;
        // 台账只占少量元数据；每张图片都在 write_v2_archive 回调里现读、现加密、现写。
        let rows = read_snapshot_sticker_rows(tmp.path())?;
        let count = rows.len();
        let db_bytes = read_snapshot_for_archive(tmp.path())?;
        drop(tmp);
        write_backup_atomically(&dest, |out| {
            user_backup::write_v2_archive(
                db_bytes,
                out,
                &password,
                KdfParams::default(),
                rand_salt(),
                count,
                |index| {
                    let (cid, sha256, path, thumb_path) = &rows[index];
                    Ok(user_backup::StickerInput {
                        cid: cid.clone(),
                        data: read_sticker_file(&app_data.join("stickers"), path, cid)?,
                        thumbnail: Some(read_sticker_file(
                            &app_data.join("stickers/thumbs"),
                            thumb_path,
                            cid,
                        )?),
                        sha256: sha256.clone(),
                    })
                },
            )
            .map(|_| ())
        })
        .map_err(|e| {
            let msg = format!("加密失败: {e}");
            s.logger.error("backup", format!("code={} {msg}", error_codes::USER_BACKUP_SEAL_FAILED));
            error_codes::coded(error_codes::USER_BACKUP_SEAL_FAILED, msg)
        })?;
        let file_bytes = std::fs::metadata(&dest)
            .map_err(|e| error_codes::coded(error_codes::USER_BACKUP_WRITE_FAILED, format!("读取备份大小失败: {e}")))?
            .len();
        s.logger.info(
            "backup",
            format!(
                "已导出全量备份 dest={} bytes={file_bytes} bindings={binding_rows} kept_sealed={bindings_kept_sealed}",
                dest.display(),
            ),
        );
        Ok(ExportReport {
            file_bytes,
            binding_rows,
            bindings_kept_sealed,
        })
    })
    .await
    .map_err(|e| format!("备份操作被线程池中断: {e}"))?
}

fn read_snapshot_for_archive(path: &Path) -> Result<Vec<u8>, String> {
    let file = std::fs::File::open(path).map_err(|e| {
        error_codes::coded(error_codes::USER_BACKUP_SNAPSHOT_FAILED, format!("读快照失败: {e}"))
    })?;
    let len = file
        .metadata()
        .map_err(|e| error_codes::coded(error_codes::USER_BACKUP_SNAPSHOT_FAILED, format!("读快照失败: {e}")))?
        .len();
    if len > user_backup::MAX_DB_BYTES {
        return Err(error_codes::coded(
            error_codes::RP_KEY_BACKUP_TOO_LARGE,
            "快照超过大小上限",
        ));
    }
    let capacity = usize::try_from(len + user_backup::HEADER_LEN as u64 + 16)
        .map_err(|_| error_codes::coded(error_codes::RP_KEY_BACKUP_IO, "快照超出本机地址空间"))?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(capacity)
        .map_err(|_| error_codes::coded(error_codes::RP_KEY_BACKUP_IO, "快照内存分配失败"))?;
    std::io::Read::take(file, user_backup::MAX_DB_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| error_codes::coded(error_codes::USER_BACKUP_SNAPSHOT_FAILED, format!("读快照失败: {e}")))?;
    if bytes.len() as u64 > user_backup::MAX_DB_BYTES {
        return Err(error_codes::coded(
            error_codes::RP_KEY_BACKUP_TOO_LARGE,
            "快照超过大小上限",
        ));
    }
    Ok(bytes)
}

/// 导出端只读快照中的表情台账；图片内容不在这里读取，更不整包驻留内存。
fn read_snapshot_sticker_rows(
    db_path: &Path,
) -> Result<Vec<(String, String, String, String)>, String> {
    let conn = rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| error_codes::coded(error_codes::USER_BACKUP_SNAPSHOT_FAILED, e))?;
    let mut stmt = conn
        .prepare("SELECT id, sha256, path, thumb_path FROM custom_stickers")
        .map_err(|e| {
            error_codes::coded(
                error_codes::USER_BACKUP_SNAPSHOT_FAILED,
                format!("读取 custom_stickers 失败: {e}"),
            )
        })?;
    let it = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| {
            error_codes::coded(
                error_codes::USER_BACKUP_SNAPSHOT_FAILED,
                format!("读取 custom_stickers 失败: {e}"),
            )
        })?;
    let rows = it.collect::<Result<Vec<_>, _>>().map_err(|e| {
        error_codes::coded(
            error_codes::USER_BACKUP_SNAPSHOT_FAILED,
            format!("读取 custom_stickers 失败: {e}"),
        )
    })?;
    if rows.len() > user_backup::MAX_STICKER_COUNT {
        return Err(error_codes::coded(
            error_codes::RP_KEY_BACKUP_TOO_LARGE,
            "表情数量超过上限",
        ));
    }
    for (cid, _, _, _) in &rows {
        user_backup::validate_cid(cid)?;
    }
    Ok(rows)
}

fn read_sticker_file(root: &Path, stored: &str, cid: &str) -> Result<Vec<u8>, String> {
    let raw = Path::new(stored);
    let path = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        root.join(raw)
    };
    let path = path.canonicalize().map_err(|e| {
        error_codes::coded(
            error_codes::USER_BACKUP_SNAPSHOT_FAILED,
            format!("表情 {cid} 文件缺失或不可读: {e}"),
        )
    })?;
    let root = root.canonicalize().map_err(|e| {
        error_codes::coded(
            error_codes::USER_BACKUP_SNAPSHOT_FAILED,
            format!("应用数据目录不可读: {e}"),
        )
    })?;
    if !path.starts_with(&root) {
        return Err(error_codes::coded(
            error_codes::USER_BACKUP_SNAPSHOT_FAILED,
            format!("表情 {cid} 路径越出应用数据目录"),
        ));
    }
    let file = std::fs::File::open(&path).map_err(|e| {
        error_codes::coded(
            error_codes::USER_BACKUP_SNAPSHOT_FAILED,
            format!("表情 {cid} 文件缺失或不可读: {e}"),
        )
    })?;
    let mut data = Vec::new();
    std::io::Read::take(file, user_backup::MAX_STICKER_BYTES + 1)
        .read_to_end(&mut data)
        .map_err(|e| {
            error_codes::coded(
                error_codes::USER_BACKUP_SNAPSHOT_FAILED,
                format!("读取表情 {cid} 失败: {e}"),
            )
        })?;
    if data.len() as u64 > user_backup::MAX_STICKER_BYTES {
        return Err(error_codes::coded(
            error_codes::RP_KEY_BACKUP_TOO_LARGE,
            format!("表情 {cid} 超过 32 MiB 上限"),
        ));
    }
    Ok(data)
}

fn write_backup_atomically(
    dest: &Path,
    write: impl FnOnce(&mut std::fs::File) -> Result<(), String>,
) -> Result<(), String> {
    let parent = dest.parent().unwrap_or_else(|| Path::new("."));
    let tmp = TempFile::new(parent.join(format!(".gosslan-backup-{}.tmp", uuid::Uuid::new_v4())));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(tmp.path())
        .map_err(|e| {
            error_codes::coded(
                error_codes::USER_BACKUP_WRITE_FAILED,
                format!("创建备份临时文件失败: {e}"),
            )
        })?;
    write(&mut file).map_err(|e| error_codes::coded(error_codes::USER_BACKUP_WRITE_FAILED, e))?;
    file.sync_all().map_err(|e| {
        error_codes::coded(
            error_codes::USER_BACKUP_WRITE_FAILED,
            format!("刷新备份文件失败: {e}"),
        )
    })?;
    drop(file);
    replace_file_with_backup(tmp.path(), dest)?;
    tmp.keep();
    Ok(())
}

/// 旧目标先改名为 UUID 备份，新文件再 rename；任一步失败都把旧目标准确恢复。
fn replace_file_with_backup(tmp: &Path, dest: &Path) -> Result<(), String> {
    replace_file_with_backup_using(tmp, dest, |from, to| {
        std::fs::rename(from, to).map_err(|e| e.to_string())
    })
}

fn replace_file_with_backup_using(
    tmp: &Path,
    dest: &Path,
    mut rename: impl FnMut(&Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    let parent = dest.parent().unwrap_or_else(|| Path::new("."));
    let backup = parent.join(format!(".gosslan-backup-old-{}", uuid::Uuid::new_v4()));
    let had_old = dest.exists();
    if had_old {
        rename(dest, &backup).map_err(|e| {
            error_codes::coded(
                error_codes::USER_BACKUP_WRITE_FAILED,
                format!("备份旧目标失败: {e}"),
            )
        })?;
        let _ = sync_directory(parent);
    }
    if let Err(e) = rename(tmp, dest) {
        if had_old {
            if let Err(restore) = rename(&backup, dest) {
                return Err(error_codes::coded(
                    error_codes::USER_BACKUP_WRITE_FAILED,
                    format!(
                        "写备份失败: {e}；恢复旧备份也失败: {restore}，旧文件保留在 {}",
                        backup.display()
                    ),
                ));
            }
            let _ = sync_directory(parent);
        }
        return Err(error_codes::coded(
            error_codes::USER_BACKUP_WRITE_FAILED,
            format!("写备份文件失败: {e}"),
        ));
    }
    let _ = sync_directory(parent);
    if had_old {
        let _ = std::fs::remove_file(&backup);
        let _ = sync_directory(parent);
    }
    Ok(())
}

fn sync_directory(path: &Path) -> std::io::Result<()> {
    std::fs::File::open(path).and_then(|dir| dir.sync_all())
}

fn rand_salt() -> [u8; user_backup::SALT_LEN] {
    let mut s = [0u8; user_backup::SALT_LEN];
    use rand_core::RngCore;
    rand_core::OsRng.fill_bytes(&mut s);
    s
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
    let _io_guard = RESTORE_IO_LOCK.lock().await;
    let s = state.inner().clone();
    let archive = PathBuf::from(&archive_path);
    spawn_blocking(move || -> Result<ImportPreview, String> {
        let meta = std::fs::metadata(&archive)
            .map_err(|_| error_codes::coded(error_codes::RP_KEY_BACKUP_UNREADABLE, "备份文件读不到"))?;
        // 全程 u64 比较（32 位目标不可转 usize）；v2 还包含最多 2 GiB 表情。
        if meta.len() > user_backup::MAX_ARCHIVE_BYTES {
            return Err(error_codes::coded(
                error_codes::RP_KEY_BACKUP_TOO_LARGE,
                "文件超过备份大小上限",
            ));
        }
        // v2 只打开 File，由 tar::Archive 流式消费；只有 v1 单库格式才整文件读入。
        let mut head = [0u8; user_backup::MAGIC.len()];
        let mut source = std::fs::File::open(&archive)
            .map_err(|e| error_codes::coded(error_codes::RP_KEY_BACKUP_UNREADABLE, format!("读备份失败: {e}")))?;
        source.read_exact(&mut head).map_err(|e| {
            error_codes::coded(error_codes::RP_KEY_BACKUP_UNREADABLE, format!("读备份失败: {e}"))
        })?;
        if &head != user_backup::MAGIC {
            return import_v2_backup(&s, &archive, &password);
        }
        drop(source);
        let bytes = std::fs::read(&archive)
            .map_err(|e| error_codes::coded(error_codes::RP_KEY_BACKUP_UNREADABLE, format!("读备份失败: {e}")))?;
        let db_bytes = user_backup::open_snapshot(&bytes, &password)?;
        // ⚠️ 先落**临时文件**，校验全过之后才改名成 `restore-pending`（2026-11-21 review）。
        // 启动段的口径是"只要 pending 在就换库"（见 state.rs 恢复段），而这里是"先落
        // pending 再校验" —— 完整性/版本校验失败虽然返回了错误、界面上也算"解析失败"，
        // pending 却已经躺在盘上了：下次启动照样把好库挪成 `.bak`、顶上这个库。
        // 于是"恢复了但失败"静默变成"重启后丢数据"。
        let pending = pending_restore_path(&s.db_path);
        let tmp = TempFile::new(s.db_path.with_extension(format!("restore-tmp-{}", uuid::Uuid::new_v4())));
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
        replace_file_with_backup(tmp.path(), &pending).map_err(|e| {
            error_codes::coded(error_codes::RP_KEY_BACKUP_IO, format!("落 pending 失败: {e}"))
        })?;
        tmp.keep();
        // v1 没有表情；只移除当前 pending 对应的 journal，不碰其它 staging。
        let _ = std::fs::remove_file(pending_staging_path(&s.db_path));
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

pub(crate) fn pending_staging_path(db_path: &Path) -> PathBuf {
    db_path.with_extension("restore-staging")
}

#[derive(serde::Serialize, serde::Deserialize)]
struct RestoreJournal {
    version: u32,
    staging: PathBuf,
    backup: Option<PathBuf>,
    committed: bool,
    #[serde(default)]
    pending_sha256: Option<String>,
}

fn read_restore_journal(db_path: &Path) -> Result<Option<RestoreJournal>, String> {
    let path = pending_staging_path(db_path);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("读取恢复 journal 失败: {e}")),
    };
    if let Ok(journal) = serde_json::from_slice::<RestoreJournal>(&bytes) {
        if journal.version != 1 {
            return Err("不支持的恢复 journal 版本".to_string());
        }
        return Ok(Some(journal));
    }
    // 兼容旧版纯路径 marker；后续任何状态变更都会升级成 journal。
    let staging = String::from_utf8(bytes).map_err(|_| "恢复 journal 无效".to_string())?;
    Ok(Some(RestoreJournal {
        version: 1,
        staging: PathBuf::from(staging),
        backup: None,
        committed: false,
        pending_sha256: None,
    }))
}

fn write_restore_journal(db_path: &Path, journal: &RestoreJournal) -> Result<(), String> {
    let bytes = serde_json::to_vec(journal).map_err(|e| format!("编码恢复 journal 失败: {e}"))?;
    write_backup_atomically(&pending_staging_path(db_path), |out| {
        out.write_all(&bytes).map_err(|e| e.to_string())
    })
}

pub(crate) fn restore_journal_matches_pending(
    db_path: &Path,
    pending: &Path,
) -> Result<bool, String> {
    let Some(journal) = read_restore_journal(db_path)? else {
        return Ok(true);
    };
    let Some(expected) = journal.pending_sha256 else {
        return Ok(true);
    };
    let mut file = match std::fs::File::open(pending) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("读取待恢复文件失败: {e}")),
    };
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("读取待恢复文件失败: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()) == expected)
}

fn validate_staging_path(app_data: &Path, staging: &Path) -> Result<(), String> {
    let name = staging
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "staging 路径无效".to_string())?;
    if staging.parent() != Some(app_data) || !name.starts_with("stickers-restore-") {
        return Err("staging 路径越界".to_string());
    }
    Ok(())
}

fn import_v2_backup(
    s: &Arc<AppState>,
    archive: &Path,
    password: &str,
) -> Result<ImportPreview, String> {
    let app_data = s.db_path.parent().ok_or_else(|| {
        error_codes::coded(
            error_codes::USER_BACKUP_SNAPSHOT_FAILED,
            "无法定位应用数据目录",
        )
    })?;
    let staging = app_data.join(format!("stickers-restore-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&staging).map_err(|e| {
        error_codes::coded(
            error_codes::RP_KEY_BACKUP_IO,
            format!("创建表情 staging 失败: {e}"),
        )
    })?;
    let staging_guard = StagingDir(staging.clone());
    let staged_stickers = staging.join("stickers");
    std::fs::create_dir_all(staged_stickers.join("thumbs")).map_err(|e| {
        error_codes::coded(
            error_codes::RP_KEY_BACKUP_IO,
            format!("创建表情 staging 目录失败: {e}"),
        )
    })?;
    let restored = user_backup::open_v2_archive_file(
        archive,
        password,
        crate::db::DB_VERSION,
        &staged_stickers,
        &staging,
    )?;
    let pending = pending_restore_path(&s.db_path);
    let tmp = TempFile::new(
        s.db_path
            .with_extension(format!("restore-tmp-{}", uuid::Uuid::new_v4())),
    );
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(tmp.path())
        .map_err(|e| {
            error_codes::coded(
                error_codes::RP_KEY_BACKUP_IO,
                format!("写恢复临时文件失败: {e}"),
            )
        })?;
    file.write_all(&restored.db_bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| {
            error_codes::coded(
                error_codes::RP_KEY_BACKUP_IO,
                format!("写恢复临时文件失败: {e}"),
            )
        })?;
    drop(file);
    let pending_sha256 = {
        use sha2::{Digest, Sha256};
        format!("{:x}", Sha256::digest(&restored.db_bytes))
    };
    write_restore_journal(
        &s.db_path,
        &RestoreJournal {
            version: 1,
            staging: staging.clone(),
            backup: None,
            committed: false,
            pending_sha256: Some(pending_sha256),
        },
    )?;
    replace_file_with_backup(tmp.path(), &pending).map_err(|e| {
        error_codes::coded(
            error_codes::RP_KEY_BACKUP_IO,
            format!("落 pending 失败: {e}"),
        )
    })?;
    tmp.keep();
    staging_guard.keep();
    let conn = rusqlite::Connection::open_with_flags(
        &pending,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| {
        error_codes::coded(
            error_codes::RP_KEY_BACKUP_UNREADABLE,
            format!("读取恢复库失败: {e}"),
        )
    })?;
    let count = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap_or(0);
    let friends = count("SELECT COUNT(*) FROM friends");
    let messages = count("SELECT COUNT(*) FROM messages");
    let conversations = count("SELECT COUNT(*) FROM conversations");
    let app_version: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key='app_version'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| {
            error_codes::coded(
                error_codes::RP_KEY_BACKUP_UNREADABLE,
                format!("读取备份应用版本失败: {e}"),
            )
        })?;
    let user_version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap_or(0);
    s.logger.info(
        "backup",
        format!(
            "v2 备份解析通过 pending={} stickers={}",
            pending.display(),
            restored.stickers.len()
        ),
    );
    Ok(ImportPreview {
        snapshot_bytes: restored.db_bytes.len() as u64,
        db_user_version: user_version as u32,
        friend_count: friends,
        message_count: messages,
        conversation_count: conversations,
        app_version,
    })
}

struct StagingDir(PathBuf);

impl StagingDir {
    fn keep(mut self) {
        self.0 = PathBuf::new();
    }
}

impl Drop for StagingDir {
    fn drop(&mut self) {
        if !self.0.as_os_str().is_empty() {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

/// 启动换库前提交已校验的 staging。journal 让提交可重试/幂等。
pub fn commit_staged_stickers(db_path: &Path) -> Result<Option<PathBuf>, String> {
    let Some(mut journal) = read_restore_journal(db_path)? else {
        return Ok(None);
    };
    let app_data = db_path
        .parent()
        .ok_or_else(|| "无法定位应用数据目录".to_string())?;
    validate_staging_path(app_data, &journal.staging)?;
    let final_dir = app_data.join("stickers");
    if journal.committed {
        // 已提交但 journal 尚未 finalize 的崩溃窗口：source 可以不存在。
        if !final_dir.is_dir() {
            return Err("恢复 journal 已提交但最终表情目录不存在".to_string());
        }
        return Ok(journal.backup);
    }
    let source = journal.staging.join("stickers");
    if !source.is_dir() {
        if final_dir.is_dir() {
            // 崩溃发生在 source -> final 之后、committed 落盘之前。
            journal.committed = true;
            write_restore_journal(db_path, &journal)?;
            return Ok(journal.backup);
        }
        return Err("staging 表情目录不存在".to_string());
    }
    if final_dir.exists() {
        if journal.backup.is_none() {
            // 先写意图再 rename：崩溃在两步之间时，重试仍知道旧目录该去哪。
            journal.backup =
                Some(app_data.join(format!("stickers-pre-restore-{}", uuid::Uuid::new_v4())));
            write_restore_journal(db_path, &journal)?;
        }
        let backup = journal
            .backup
            .as_ref()
            .ok_or_else(|| "恢复 journal 缺少旧表情目录备份路径".to_string())?;
        if backup.exists() {
            // 上次已挪走旧目录但未完成提交；隔离残留新目录并恢复旧目录后重试。
            std::fs::rename(
                &final_dir,
                journal
                    .staging
                    .join(format!("partial-{}", uuid::Uuid::new_v4())),
            )
            .map_err(|e| format!("隔离未完成表情目录失败: {e}"))?;
            std::fs::rename(backup, &final_dir).map_err(|e| format!("恢复旧表情目录失败: {e}"))?;
        }
        std::fs::rename(&final_dir, backup).map_err(|e| format!("挪开旧表情目录失败: {e}"))?;
        let _ = sync_directory(app_data);
    }
    if let Err(e) = std::fs::rename(&source, &final_dir) {
        if let Some(backup) = &journal.backup {
            if backup.exists() && !final_dir.exists() {
                let _ = std::fs::rename(backup, &final_dir);
            }
        }
        return Err(format!("提交表情 staging 失败: {e}"));
    }
    journal.committed = true;
    write_restore_journal(db_path, &journal)?;
    let _ = sync_directory(app_data);
    Ok(journal.backup)
}

pub fn finalize_staged_stickers(db_path: &Path) {
    if let Ok(Some(journal)) = read_restore_journal(db_path) {
        if let Some(backup) = journal.backup {
            let _ = std::fs::remove_dir_all(backup);
        }
        let _ = std::fs::remove_dir_all(journal.staging);
    }
    let _ = std::fs::remove_file(pending_staging_path(db_path));
    if let Some(app_data) = db_path.parent() {
        let _ = sync_directory(app_data);
    }
}

/// 崩溃后主库已换、但 journal 仍为 committed：只做收尾，不再触碰新库。
pub fn finalize_orphaned_staged_stickers(db_path: &Path) {
    if !pending_restore_path(db_path).exists() {
        if let Ok(Some(journal)) = read_restore_journal(db_path) {
            if journal.committed {
                finalize_staged_stickers(db_path);
            }
        }
    }
}

pub fn rollback_staged_stickers(db_path: &Path, backup: Option<PathBuf>) {
    let Ok(Some(mut journal)) = read_restore_journal(db_path) else {
        return;
    };
    let app_data = db_path.parent().unwrap_or_else(|| Path::new("."));
    let final_dir = app_data.join("stickers");
    let retry_dir = journal.staging.join("stickers");
    if final_dir.exists() && !retry_dir.exists() {
        let _ = std::fs::rename(&final_dir, &retry_dir);
    }
    let old = backup.or(journal.backup);
    if let Some(old) = old {
        if old.exists() {
            let _ = std::fs::remove_dir_all(&final_dir);
            let _ = std::fs::rename(old, &final_dir);
        }
    }
    journal.committed = false;
    journal.backup = None;
    let _ = write_restore_journal(db_path, &journal);
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
    let _io_guard = RESTORE_IO_LOCK.lock().await;
    let s = state.inner().clone();
    spawn_blocking(move || {
        let pending = pending_restore_path(&s.db_path);
        if pending.exists() {
            let _ = std::fs::remove_file(&pending);
            s.logger
                .info("backup", "用户取消了待恢复的备份".to_string());
        }
        // 只删除当前 journal 指向的 staging；绝不扫描/删除其它并发目录。
        if let Ok(Some(journal)) = read_restore_journal(&s.db_path) {
            if let Some(backup) = journal.backup {
                let final_dir = s
                    .db_path
                    .parent()
                    .unwrap_or_else(|| Path::new("."))
                    .join("stickers");
                if backup.exists() && !final_dir.exists() {
                    let _ = std::fs::rename(backup, final_dir);
                }
            }
            if !journal.committed {
                let _ = std::fs::remove_dir_all(journal.staging);
            }
            let _ = std::fs::remove_file(pending_staging_path(&s.db_path));
        }
        Ok::<(), String>(())
    })
    .await
    .unwrap_or(Ok(()))
}

#[cfg(test)]
mod unseal_snapshot_tests {
    use super::*;

    /// **真 DDL 建表**（从 `db.rs` 现读，不手抄列名）——2026-11-21 的 J1-4b 就是凭记忆
    /// 写了不存在的 `device_id` 列，SELECT 一编译就失败、整库导出从此不可能成功，
    /// 而界面把原因说成"磁盘空间不足"（两次真机都栽在这）。这条判据直接执行真 DDL，
    /// 列名再漂必然红。
    fn create_real_table(conn: &rusqlite::Connection) {
        let ddl_src = include_str!("../db.rs");
        let start = ddl_src
            .find("CREATE TABLE IF NOT EXISTS rp_device_bindings")
            .expect("db.rs 里找不到 rp_device_bindings 的 DDL");
        let rest = &ddl_src[start..];
        let end = rest.find(");").expect("DDL 没有闭合的 );") + 2;
        conn.execute_batch(&rest[..end]).expect("真 DDL 执行失败");
    }

    #[test]
    fn unseal_uses_real_columns_and_rewrites_plaintext() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        create_real_table(&conn);
        conn.execute(
            "INSERT INTO rp_device_bindings
             (rp_origin, client_id, display_name, kid, public_key, secret_key,
              pairwise_subject, scopes, status, created_at)
             VALUES ('https://a.example', 'c1', 'A', 'k1', 'pk', 'plain-secret',
                     'sub', '[]', 'active', 0)",
            [],
        )
        .unwrap();
        let (total, kept) = unseal_bindings_in_snapshot(&conn).expect("明文化不许失败");
        assert_eq!((total, kept), (1, 0));
        let got: String = conn
            .query_row(
                "SELECT secret_key FROM rp_device_bindings WHERE rp_origin='https://a.example'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(got, "plain-secret", "明文没写回副本");
    }

    /// **导出 → 导入 全链路**（用户 2026-11-24：「导出之后导入要能按导出的文件完全恢复」）。
    ///
    /// 走的是与命令**同一批函数**：VACUUM INTO 快照 → 副本明文化 → seal_snapshot →
    /// open_snapshot → validate_sqlite_bytes → 打开恢复库做 integrity_check 与逐项比对。
    /// 覆盖三个真机关心点：①行数一字不差；②已授权用的私钥明文原样回来；
    /// ③口令错必须**拒绝**（不是解出垃圾字节）。
    #[test]
    fn export_then_import_round_trip_restores_everything() {
        let dir = std::env::temp_dir().join(format!(
            "gosslan-backup-rt-{}-{}",
            std::process::id(),
            crate::db::now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.db");
        // 源库：真 DDL（绑定表）+ 两行消息（最小自建表，只为验"内容随备份回来"）。
        {
            let conn = rusqlite::Connection::open(&src).unwrap();
            create_real_table(&conn);
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS messages (msg_id TEXT PRIMARY KEY, body TEXT NOT NULL);
                 PRAGMA user_version = 7;",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO rp_device_bindings
                 (rp_origin, client_id, display_name, kid, public_key, secret_key,
                  pairwise_subject, scopes, status, created_at)
                 VALUES ('https://a.example', 'c1', 'A', 'k1', 'pk', 'secret-plain',
                         'sub-1', '[\"friends.read\"]', 'active', 0)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO messages (msg_id, body) VALUES ('m1', '你好'), ('m2', 'backup')",
                [],
            )
            .unwrap();
        }
        // ① 快照（与命令同一句 SQL）+ 明文化
        let snapshot = dir.join("snapshot.db");
        {
            let conn = rusqlite::Connection::open(&src).unwrap();
            conn.execute(
                "VACUUM INTO ?1",
                rusqlite::params![snapshot.to_string_lossy()],
            )
            .unwrap();
            let snap = rusqlite::Connection::open(&snapshot).unwrap();
            assert_eq!(unseal_bindings_in_snapshot(&snap).unwrap(), (1, 0));
        }
        // ② 封装 → 解封（口令往返）
        let raw = std::fs::read(&snapshot).unwrap();
        let pass = "correct horse battery";
        let sealed = crate::user_backup::seal_snapshot(
            &raw,
            pass,
            crate::user_backup::KdfParams::default(),
            [7u8; crate::user_backup::SALT_LEN],
            [9u8; crate::user_backup::NONCE_LEN],
        )
        .unwrap();
        // ③ 口令错必须拒绝
        assert!(
            crate::user_backup::open_snapshot(&sealed, "wrong passphrase!!").is_err(),
            "错误口令竟然解开了"
        );
        let restored_bytes = crate::user_backup::open_snapshot(&sealed, pass).unwrap();
        crate::user_backup::validate_sqlite_bytes(&restored_bytes).unwrap();
        // ④ 恢复库逐项比对
        let restored = dir.join("restored.db");
        std::fs::write(&restored, &restored_bytes).unwrap();
        let r = rusqlite::Connection::open(&restored).unwrap();
        let integrity: String = r
            .query_row("PRAGMA integrity_check", [], |x| x.get(0))
            .unwrap();
        assert_eq!(integrity, "ok");
        let msgs: i64 = r
            .query_row("SELECT COUNT(*) FROM messages", [], |x| x.get(0))
            .unwrap();
        assert_eq!(msgs, 2, "消息没随备份回来");
        let (origin, secret): (String, String) = r
            .query_row(
                "SELECT rp_origin, secret_key FROM rp_device_bindings",
                [],
                |x| Ok((x.get(0)?, x.get(1)?)),
            )
            .unwrap();
        assert_eq!(origin, "https://a.example");
        assert_eq!(
            secret, "secret-plain",
            "已授权应用的私钥没恢复成明文（恢复后第三方登录会失效）"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 空表也必须**不报错**（空态是"没有可导出的应用"而不是磁盘问题——2026-11-19 教训）。
    #[test]
    fn unseal_on_empty_table_is_ok() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        create_real_table(&conn);
        assert_eq!(unseal_bindings_in_snapshot(&conn).unwrap(), (0, 0));
    }

    #[test]
    fn sticker_missing_file_and_outside_path_fail_explicitly() {
        let dir = tempfile::tempdir().unwrap();
        let err = read_sticker_file(dir.path(), "missing.webp", "cid1").unwrap_err();
        assert!(err.contains("缺失"), "缺文件必须明确失败: {err}");
        let outside = tempfile::NamedTempFile::new().unwrap();
        let err =
            read_sticker_file(dir.path(), outside.path().to_str().unwrap(), "cid1").unwrap_err();
        assert!(err.contains("越出"), "目录外路径必须拒: {err}");
    }

    #[test]
    fn backup_replacement_failure_restores_previous_file() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("backup.tar");
        let tmp = dir.path().join("new.tmp");
        std::fs::write(&dest, b"old").unwrap();
        std::fs::write(&tmp, b"new").unwrap();
        let mut calls = 0usize;
        let err = replace_file_with_backup_using(&tmp, &dest, |from, to| {
            calls += 1;
            if calls == 2 {
                return Err("injected rename failure".to_string());
            }
            std::fs::rename(from, to).map_err(|e| e.to_string())
        })
        .unwrap_err();
        assert!(err.contains("injected"), "{err}");
        assert_eq!(std::fs::read(&dest).unwrap(), b"old");
        assert_eq!(std::fs::read(&tmp).unwrap(), b"new");
    }

    #[test]
    fn restore_journal_rejects_pending_from_another_import() {
        use sha2::{Digest, Sha256};
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("gosslan.db");
        let pending = dir.path().join("gosslan.restore-pending");
        std::fs::write(&pending, b"new pending").unwrap();
        write_restore_journal(
            &db,
            &RestoreJournal {
                version: 1,
                staging: dir.path().join("stickers-restore-new"),
                backup: None,
                committed: false,
                pending_sha256: Some(format!("{:x}", Sha256::digest(b"other pending"))),
            },
        )
        .unwrap();
        assert!(!restore_journal_matches_pending(&db, &pending).unwrap());
        std::fs::write(&pending, b"other pending").unwrap();
        assert!(restore_journal_matches_pending(&db, &pending).unwrap());
    }

    #[test]
    fn committed_journal_is_idempotent_when_staging_source_is_gone() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("gosslan.db");
        let staging = dir.path().join("stickers-restore-committed");
        let backup = dir.path().join("stickers-old");
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::create_dir(dir.path().join("stickers")).unwrap();
        std::fs::write(dir.path().join("stickers/new"), b"new").unwrap();
        std::fs::create_dir(&backup).unwrap();
        std::fs::write(backup.join("old"), b"old").unwrap();
        write_restore_journal(
            &db,
            &RestoreJournal {
                version: 1,
                staging: staging.clone(),
                backup: Some(backup.clone()),
                committed: true,
                pending_sha256: None,
            },
        )
        .unwrap();
        assert_eq!(commit_staged_stickers(&db).unwrap(), Some(backup.clone()));
        assert_eq!(commit_staged_stickers(&db).unwrap(), Some(backup.clone()));
        assert!(!staging.join("stickers").exists());
        finalize_orphaned_staged_stickers(&db);
        assert!(!backup.exists());
        assert!(!staging.exists());
        assert!(!pending_staging_path(&db).exists());
    }

    #[test]
    fn staging_commit_is_atomic_and_rollback_restores_old_stickers() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("gosslan.db");
        let staging = dir.path().join("stickers-restore-test");
        std::fs::create_dir_all(staging.join("stickers")).unwrap();
        std::fs::write(staging.join("stickers/cid1"), b"new").unwrap();
        std::fs::write(
            pending_staging_path(&db),
            staging.to_string_lossy().as_bytes(),
        )
        .unwrap();
        std::fs::create_dir(dir.path().join("stickers")).unwrap();
        std::fs::write(dir.path().join("stickers/old"), b"old").unwrap();
        let backup = commit_staged_stickers(&db).unwrap().unwrap();
        assert_eq!(
            std::fs::read(dir.path().join("stickers/cid1")).unwrap(),
            b"new"
        );
        rollback_staged_stickers(&db, Some(backup));
        assert_eq!(
            std::fs::read(dir.path().join("stickers/old")).unwrap(),
            b"old"
        );
        assert!(!dir.path().join("stickers/cid1").exists());
        assert!(
            staging.join("stickers/cid1").exists(),
            "回滚后 staging 必须仍可重试"
        );
    }
}
