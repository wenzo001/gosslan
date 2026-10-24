//! SQLite 存储层：本地聊天记录、好友关系、群组、离线队列与配置。
//! 使用 rusqlite（bundled，自带 SQLite 源码，跨平台零配置）。
//! 数据库迁移由 PRAGMA user_version 驱动，见 `run_migrations()` / `MIGRATIONS` 数组。

use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, params_from_iter, Connection, OpenFlags, OptionalExtension, Result};

use crate::private_fs::restrict_to_owner;
use crate::state::{
    Conversation, Favorite, Friend, Group, GroupFile, GroupFileRecipient, MessageRecord,
    TransferInfo,
};

/// 当前数据库版本。每次 schema 变更递增一次，并在 `MIGRATIONS` 数组末尾追加一个 step。
///
/// ⚠️ **只有"SCHEMA 表达不了的事"才配一个 step**（加列、回填、清孤儿行、**删**被取代的索引）。
/// 建表 / 建索引不需要 step：`init()` 在版本分支**之前**跑 `execute_batch(SCHEMA)`，
/// 而 SCHEMA 全是 `IF NOT EXISTS` ⇒ 新老库每次启动都会被补齐。
/// 同一条索引同时写在 SCHEMA 与 MIGRATIONS 里 = 两个家（历史上有过，v8→v9 起收敛）。
pub const DB_VERSION: u32 = 12;

/// 迁移 step：(from_version, to_version, 迁移闭包)。
struct Migration {
    from: u32,
    to: u32,
    description: &'static str,
    run: fn(&Connection) -> Result<()>,
}

/// 小工具：安全地读 `pragma_table_info` 判断某表是否有某列。
fn column_exists(conn: &Connection, table: &str, col: &str) -> Result<bool> {
    let exists: bool = conn
        .prepare(&format!(
            "SELECT COUNT(*) FROM pragma_table_info('{}') WHERE name = ?1",
            table
        ))
        .and_then(|mut s| s.query_row([col], |r| r.get::<_, i64>(0)))
        .map(|n| n > 0)?;
    Ok(exists)
}

/// `init()` 的失败分类 —— **必须是有类型的**，不许让调用方按错误字符串猜。
///
/// 协议层已经在这上面摔过一次：`decode_frame` 用 `unknown variant` 前缀分类，结果把
/// "未知嵌套枚举值"也误判成"未知帧类型"，整条消息被吞（INV-P24 第 2 条，v4.22.34 才修掉）。
/// 启动期的降级判定是同一类判断，所以一开始就给它一个类型。
#[derive(Debug, thiserror::Error)]
pub enum InitError {
    /// 数据文件的 `user_version` 比本机 `DB_VERSION` 新 ⇒ **本机程序比数据旧**。
    /// 唯一正确的处置是拒绝打开（AI_RULES 的"能升不能毁"红线），但必须给用户
    /// 可读、可行动的解释（`downgrade_message`），不能只是一个错误。
    #[error("{}", downgrade_display(*current))]
    Downgrade { current: u32 },
    /// 迁移前备份失败或校验不通过。**原库未改动**，备份文件保留供诊断。
    #[error("迁移前备份失败/校验不通过（原库未改动）：{path}: {reason}")]
    Backup { path: String, reason: String },
    /// 建表/内容层 DDL 事务失败并**已整体回滚**（审计 DB-01）。
    /// 与 `Sqlite` 分开：这里是"库能开、但这批 DDL 没落成"，原库仍是启动前的形状。
    #[error("建表/内容层 DDL 事务失败（已整体回滚）：{reason}")]
    SchemaMigrate { reason: String },
    /// 其它 SQLite 错误（打不开、迁移失败……）。
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

/// 日志用的**单行**技术描述（降级那句长文案由 `InitError::downgrade_message` 给人看）。
fn downgrade_display(current: u32) -> String {
    format!(
        "DB user_version={current} > app DB_VERSION={DB_VERSION}: \
         数据来自更新的版本，拒绝降级打开（未执行任何迁移）"
    )
}

impl InitError {
    /// 给用户看的错误码（日志与原生弹窗共用；便于支持人员按码检索）。
    pub fn code(&self) -> &'static str {
        match self {
            InitError::Downgrade { .. } => "DB_DOWNGRADE",
            InitError::Backup { .. } => "DB_BACKUP_FAILED",
            InitError::SchemaMigrate { .. } => "SCHEMA_MIGRATE_FAILED",
            InitError::Sqlite(_) => "DB_OPEN_FAILED",
        }
    }

    /// 启动失败时给人看的完整说明。**每一种都以"原文件未被删除/覆盖"为边界**，
    /// 并把数据目录、日志目录写进去 —— 此刻应用还没有可用的后端状态，
    /// 用户唯一能做的就是把这两处保留下来。
    pub fn user_message(&self, app_data: &Path) -> String {
        let code = self.code();
        let body = match self {
            InitError::Downgrade { current } => Self::downgrade_message(*current),
            InitError::Backup { path, reason } => format!(
                "数据库升级前的备份失败，已中止启动。\n\
                 原数据库没有被修改。\n\
                 备份文件：{path}\n\
                 原因：{reason}\n\
                 \n\
                 ---\n\
                 Gosslan could not create/verify a pre-migration backup, so it stopped \
                 BEFORE writing anything. Your original database is unchanged."
            ),
            InitError::SchemaMigrate { reason } => format!(
                "初始化/升级本地数据库表结构失败，已中止启动。\n\
                 这一批建表语句在同一个事务里，失败后已整体回滚 —— 数据库仍是启动前的形状，\
                 没有留下半套表。\n\
                 原因：{reason}\n\
                 \n\
                 ---\n\
                 Gosslan could not apply its schema in one transaction and stopped. \
                 The whole DDL batch was rolled back, so the database is still in its \
                 pre-startup shape."
            ),
            InitError::Sqlite(e) => format!(
                "无法打开或初始化本地数据库，已停止启动：{e}\n\
                 原数据库文件没有被删除，也没有被替换。\n\
                 \n\
                 ---\n\
                 Gosslan could not open or initialize its local database and stopped. \
                 The original database file was NOT deleted or replaced."
            ),
        };
        format!(
            "{body}\n\n错误码：{code}\n数据目录：{}\n日志目录：{}\n\
             请先把整个数据目录复制一份保留，再导出诊断信息，不要删除或覆盖其中的文件。",
            app_data.display(),
            app_data.join("logs").display()
        )
    }

    /// **只有降级这一种情况**给人看的那句话（启动期原生对话框与日志共用这一份文案）。
    ///
    /// 刻意不做成"每种错误各自配一句人话"的形状：其它 SQLite 错误没有
    /// "该升级还是该修文件"这种可行动作，硬凑一句反而把用户支到错误方向 —— 类型上直接
    /// 不给"把降级文案套到别的错误上"的机会，比写一条测试去禁止它更省事。
    ///
    /// 中英各一句不是敷衍：此刻数据库还没打开，读不到用户存的 `language` 偏好，
    /// 而这个弹窗必须在 webview 之外显示（应用已经没有可用的后端状态了）——
    /// 所以两种语言都给，而不是猜一种。
    pub fn downgrade_message(current: u32) -> String {
        format!(
                "本机 Gosslan 比这份数据旧，无法打开。\n\
                 数据版本 v{current}，本机支持到 v{DB_VERSION}。\n\
                 \n\
                 你的聊天记录没有被修改（迁移在写入任何数据之前就已中止）。\n\
                 请升级到不低于创建这份数据的 Gosslan 版本后再打开；\n\
                 如果必须留在当前版本，请先从更新版本里导出的备份恢复。\n\
                 \n\
                 --- \n\
                 This Gosslan build is older than the data file \
                 (data v{current}, this app supports up to v{DB_VERSION}), so it refuses to open it.\n\
                 Your messages were NOT modified — the check runs before any write.\n\
                 Install a Gosslan version at least as new as the one that created this data."
        )
    }
}

/// 启动期业务数据计数（只用于诊断：日志/诊断包，不参与任何功能判断）。
///
/// 为什么必须留这个读数：2026-10-20 的 P0 是「崩溃后变成默认新用户、好友丢失」。
/// 下一次现场要能一眼分开两种成因 —— ① 还是原来那份库（计数在、身份读失败）；
/// ② 换了一份空库（计数全 0、路径不同）。没有这行读数，两者在日志里长得一样。
pub fn boot_data_counts(conn: &Connection) -> Result<(i64, i64, i64, i64)> {
    conn.query_row(
        "SELECT
            (SELECT COUNT(*) FROM messages),
            (SELECT COUNT(*) FROM friends),
            (SELECT COUNT(*) FROM conversations),
            (SELECT COUNT(*) FROM groups)",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )
}

/// 找同目录下**最近的**迁移前备份（`<stem>.pre-v…-to-v….db`）。
///
/// 用途：主库看起来是空的（文件不存在 / 0 字节）时，若旁边还有一份可用的
/// 迁移备份，**绝不能把它当成首次安装去生成新身份** —— 那正好会把"崩溃后
/// 主库丢失、备份还在"变成一次不可逆的身份切换。调用方应中止启动并提示恢复。
pub fn find_recovery_backup(db_path: &Path) -> Option<std::path::PathBuf> {
    migration_backups_newest_first(db_path)
        .ok()?
        .into_iter()
        .next()
}

/// 本库的迁移前备份（`<stem>.pre-v…-to-v….db`），**按 mtime 从新到旧**。
///
/// `find_recovery_backup` 与 `sweep_old_backups` 共用这一份口径（DB-02）：两处各写一套
/// 排序时，清扫有可能删掉"恢复时本会选中的那一份"，而 `find_recovery_backup` 只会安静地
/// 退回次新的一份 —— 数据没丢，但排查方向会被带偏，而且没人会发现。
fn migration_backups_newest_first(db_path: &Path) -> std::io::Result<Vec<std::path::PathBuf>> {
    let Some(parent) = db_path.parent() else {
        return Ok(Vec::new());
    };
    let Some(stem) = db_path.file_stem().and_then(|s| s.to_str()) else {
        return Ok(Vec::new());
    };
    let prefix = format!("{stem}.pre-v");
    let rd = match std::fs::read_dir(parent) {
        Ok(rd) => rd,
        // 目录不存在 = 还没有任何备份（`db_path` 只有文件名时 parent 是空串，同样落到这里）。
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut found: Vec<(SystemTime, std::path::PathBuf)> = Vec::new();
    for entry in rd {
        let entry = entry?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        // 先做纯字符串匹配再 stat：同目录可能有大量缓存文件。
        if !name.starts_with(&prefix) || !name.contains("-to-v") || !name.ends_with(".db") {
            continue;
        }
        if !path.is_file() {
            continue;
        }
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(UNIX_EPOCH);
        found.push((mtime, path));
    }
    // mtime 相同（同一时间粒度内两份）时按文件名兜底：备份名里带纳秒时间戳，
    // 等长数字串的字典序与数值序一致。
    found.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    Ok(found.into_iter().map(|(_, p)| p).collect())
}

/// 启动恢复：把**既不在单聊 outbox、也不在群 outbox** 的 `sending` 消息落终态。
///
/// 覆盖的是崩溃窗口，不是正常发送：`insert_message_and_outbox` 是同一事务，
/// 正常入队不会出现"有消息没队列行"；只有进程在极窄窗口里死掉、或历史版本
/// 的收尾顺序把队列行先删了，才会留下这种行。没有这一步，它们会永远显示"发送中"
/// 且没有任何清扫器能再看见（sweeper 只扫 outbox 表）。
///
/// ⚠️ **文件管线的消息必须排除**：`file-{transfer_id}`（1:1）与 `gfile-{transfer_id}`
/// （群文件）的 `sending` 由 `file_transfers` / `group_files` 表管理，**从不写**这两张
/// outbox 表。不排除就会在每次启动把"正在传/待补发的文件"误判成失败（群文件发送与
/// 接收两侧的卡片都以 sending 起步）。前缀是 `commands/files.rs` 与
/// `network/transport/group_file.rs` 的建记录口径，改动那边要同步这条谓词。
///
/// 置 `failed` 而不是 `sent`：没有 Ack/队列行就没有送达证据，诚实地说"这次没成"。
/// 接收端按 `msg_id` 幂等，用户重发也不会重复入库。
pub fn recover_orphan_sending_messages(conn: &Connection) -> Result<usize> {
    let changed = conn.execute(
        "UPDATE messages SET status = 'failed'
          WHERE status = 'sending'
            AND msg_id NOT LIKE 'file-%'
            AND msg_id NOT LIKE 'gfile-%'
            AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.msg_id = messages.msg_id)
            AND NOT EXISTS (SELECT 1 FROM group_outbox g WHERE g.msg_id = messages.msg_id)",
        [],
    )?;
    Ok(changed)
}

/// 执行迁移（**只在 `current <= DB_VERSION` 时**被调用，见 `init` 里唯一的降级判定）。
fn run_migrations(conn: &Connection, current: u32) -> Result<()> {
    if current == DB_VERSION {
        return Ok(());
    }
    for step in MIGRATIONS.iter() {
        if step.from >= DB_VERSION {
            break;
        }
        if step.from < current {
            continue;
        }
        eprintln!(
            "[gosslan-db] running v{}→v{}: {}",
            step.from, step.to, step.description
        );
        (step.run)(conn)?;
        conn.pragma_update(None, "user_version", step.to)?;
    }
    Ok(())
}

/// **SCHEMA 表达不了、又必须每条启动路径都拿到**的形状，集中在这一个地方补。
///
/// 为什么存在：`init()` 里 `execute_batch(SCHEMA)` 跑在迁移**之前**，所以任何
/// "建在只有迁移才会加的列上"的对象都进不了 SCHEMA —— 老库那一刻还没那一列，
/// 写进去会让 `init()` 直接失败（`no such column: seq`，2026-09-25 真撞过一次，
/// 判据是 `migration_tests::index_on_a_migration_added_column_must_not_live_in_schema`）。
///
/// 为什么**两条分支都要经过**：全新库走 `is_fresh` 不重放迁移，而会话内排序的
/// 热查询（`db/messages.rs` 按 `(conv_id, seq)`）没有这条索引就是全表扫 ——
/// 那比"少一条日志"严重得多。判据是恒等的：
/// `migration_tests::fresh_schema_alone_has_exactly_the_migrated_shape`
/// 逐条比对「SCHEMA + 这里」与「SCHEMA + 整条迁移链」的 `sqlite_master` 形状。
///
/// 加进来的每一条都必须是**幂等**的（`IF NOT EXISTS` / 先判存在），因为老库那条分支
/// 已经由迁移建过一遍。
fn ensure_post_schema_shape(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_messages_conv_seq ON messages(conv_id, seq);
         -- 按 (会话, kind) 取某类消息（群任务徽标要用：只想要 todo/todo_update 那几十条）。
         -- 没有它时 `WHERE conv_id=? AND kind IN (...)` 会退化成本会话的**全行扫**，
         -- 而这个查询排在全局那一把 `Mutex<Connection>` 后面 —— 大群会冻住整个 UI。
         -- 与上面那条同理由放在这里（幂等、每次开库确认一次），不再动版本号。
         -- 它让 messages 长出第三个索引，因此 `hot_tables_carry_exactly_the_intended_indexes`
         -- 的期望值跟着从 2 改 3，写放大的实测数字记在那条判据的注释里。
         CREATE INDEX IF NOT EXISTS idx_messages_conv_kind ON messages(conv_id, kind);",
    )?;
    Ok(())
}

/// 群孤儿清理 —— **谓词只有这一份**，v7 与 v10 共用（两处各写一份就是本仓反复付学费的漂移形状）。
///
/// 双锚：群不在 `groups` **且** 会话不在 `conversations` 才算孤儿。单用
/// `NOT IN conversations` 是数据事故 —— 用户删群会话是合法操作（`delete_conversation`），
/// `groups` 行还在，那样会把一整段在册群的历史不可逆清空。
///
/// 谓词必须锚 `group_id` / `substr(conv_id, 7)`，不能锚 `id`：那几张表的 `id` 是自增行号
/// （`group_reads` / `pending_group_reads` 干脆没有 `id` 列），两个域永不相交 ⇒ 锚 `id` 的
/// 实际后果是"两条删在册群数据、两条报错被吞"（#60，判据
/// `migration_tests::v7_orphan_cleanup_keeps_live_group_rows_and_drops_true_orphans`）。
///
/// 返回失败语句的错误而不自己吞：调用方决定日志口径（v7 与 v10 都是"尽力清理、不拦启动"）。
fn sweep_group_orphans(conn: &Connection) -> Vec<String> {
    let orphan_group = "group_id NOT IN (SELECT id FROM groups) \
         AND ('group:' || group_id) NOT IN (SELECT id FROM conversations)";
    let orphan_conv = "substr(conv_id, 7) NOT IN (SELECT id FROM groups) \
         AND conv_id NOT IN (SELECT id FROM conversations)";
    [
        format!("DELETE FROM messages WHERE conv_id LIKE 'group:%' AND {orphan_conv}"),
        format!("DELETE FROM group_outbox WHERE {orphan_group}"),
        format!("DELETE FROM file_outbox WHERE group_id IS NOT NULL AND {orphan_group}"),
        format!("DELETE FROM group_reads WHERE {orphan_group}"),
        format!("DELETE FROM pending_group_reads WHERE {orphan_group}"),
        format!(
            "DELETE FROM group_recalled_messages WHERE conv_id LIKE 'group:%' AND {orphan_conv}"
        ),
    ]
    .iter()
    .filter_map(|sql| conn.execute(sql, []).err().map(|e| format!("{sql} ⇒ {e}")))
    .collect()
}

const MIGRATIONS: &[Migration] = &[
    // v1 → v2：friends 加公钥列
    Migration {
        from: 1,
        to: 2,
        description: "friends 加 x25519_pubkey / ed25519_pubkey",
        run: |conn| {
            let tx = conn.unchecked_transaction()?;
            for (col, sql) in [
                (
                    "x25519_pubkey",
                    "ALTER TABLE friends ADD COLUMN x25519_pubkey TEXT",
                ),
                (
                    "ed25519_pubkey",
                    "ALTER TABLE friends ADD COLUMN ed25519_pubkey TEXT",
                ),
            ] {
                match column_exists(&tx, "friends", col) {
                    Ok(false) => {
                        tx.execute(sql, [])?;
                    }
                    Ok(true) => {}
                    Err(e) => {
                        eprintln!("[gosslan-db] v1→v2: skip {col}: {e}");
                    }
                }
            }
            tx.commit()?;
            Ok(())
        },
    },
    // v2 → v3：messages 加 seq + 回填 + 索引。
    // ⚠️ 索引必须留在这条迁移里（建列**之后**）：SCHEMA 跑在迁移之前，
    //   把 `idx_messages_conv_seq` 写进 SCHEMA 会让没有 seq 列的老库直接开不起来。
    //   判据测试：`migration_tests::index_on_a_migration_added_column_must_not_live_in_schema`。
    Migration {
        from: 2,
        to: 3,
        description: "messages 加 seq 列 + 回填 + idx_messages_conv_seq",
        run: |conn| {
            let tx = conn.unchecked_transaction()?;
            match column_exists(&tx, "messages", "seq") {
                Ok(false) => {
                    tx.execute(
                        "ALTER TABLE messages ADD COLUMN seq INTEGER NOT NULL DEFAULT 0",
                        [],
                    )?;
                    tx.execute(
                        "UPDATE messages SET seq = (SELECT COUNT(*) FROM messages m2 WHERE m2.conv_id = messages.conv_id AND (m2.ts < messages.ts OR (m2.ts = messages.ts AND m2.id <= messages.id)))",
                        [],
                    )?;
                }
                Ok(true) => {}
                Err(e) => {
                    eprintln!("[gosslan-db] v2→v3: skip: {e}");
                }
            }
            tx.execute(
                "CREATE INDEX IF NOT EXISTS idx_messages_conv_seq ON messages(conv_id, seq)",
                [],
            )?;
            tx.commit()?;
            Ok(())
        },
    },
    // v3 → v4：conversations 加 pinned
    Migration {
        from: 3,
        to: 4,
        description: "conversations 加 pinned 列",
        run: |conn| {
            let tx = conn.unchecked_transaction()?;
            match column_exists(&tx, "conversations", "pinned") {
                Ok(false) => {
                    tx.execute(
                        "ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
                        [],
                    )?;
                }
                Ok(true) => {}
                Err(e) => {
                    eprintln!("[gosslan-db] v3→v4: skip: {e}");
                }
            }
            tx.commit()?;
            Ok(())
        },
    },
    // v4 → v5：group_files 加 scope / todo_id
    Migration {
        from: 4,
        to: 5,
        description: "group_files 加 scope / todo_id 列",
        run: |conn| {
            let tx = conn.unchecked_transaction()?;
            for (col, default) in [("scope", "'chat'"), ("todo_id", "''")] {
                match column_exists(&tx, "group_files", col) {
                    Ok(false) => {
                        let _ = tx.execute(
                            &format!("ALTER TABLE group_files ADD COLUMN {col} TEXT NOT NULL DEFAULT {default}"),
                            [],
                        );
                    }
                    Ok(true) => {}
                    Err(e) => {
                        eprintln!("[gosslan-db] v4→v5: skip {col}: {e}");
                    }
                }
            }
            tx.commit()?;
            Ok(())
        },
    },
    // v5 → v6：outbox 清重复 + 唯一索引
    Migration {
        from: 5,
        to: 6,
        description: "outbox 清重复行 + 建 idx_outbox_msg_id 唯一索引",
        run: |conn| {
            let tx = conn.unchecked_transaction()?;
            tx.execute(
                "DELETE FROM outbox WHERE id NOT IN (SELECT MIN(id) FROM outbox GROUP BY msg_id)",
                [],
            )?;
            tx.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_msg_id ON outbox(msg_id)",
                [],
            )?;
            tx.commit()?;
            Ok(())
        },
    },
    // v6 → v7：清除历史孤儿群消息与投递残留（2026-09-19 删除级联收口）。
    // 旧版 delete_group / leave_group 不删 messages 等表，退群成员库里留着
    // 一整段搜得到、点不开的历史；delete_conversation 也不清 outbox/file_outbox。
    // 新代码已同事务收口，这里把**存量**垃圾清掉（只清群行已不确定的数据，
    // 保守口径：groups 表里没有的 group_id ⇒ 一定是孤儿）。
    Migration {
        from: 6,
        to: 7,
        description: "清理历史孤儿群消息与投递/回执残留",
        run: |conn| {
            // 谓词见 `sweep_group_orphans`（双锚、必须锚 group_id，理由写在那里）。
            // 与 v3-v5 同风格：尽力清理、eprintln 容错，绝不 `?` 上抛把 db::init 变成 Err
            // 让应用起不来（清不干净下次升级还会再来一遍）。
            for err in sweep_group_orphans(conn) {
                eprintln!("[gosslan-db] v7 孤儿清理跳过一条语句（不影响启动）：{err}");
            }
            Ok(())
        },
    },
    // v7 → v8：sweeper 三条队列的 created_at 索引（2026-09-19 自审建议#4）。
    // sweeper 每 30s 按 created_at 扫三张表；离线保留窗改为 7 天后行数会显著变多，
    // 无索引就是每 tick 三次全表扫。软失败：建不动索引不拦启动（下次再来）。
    Migration {
        from: 7,
        to: 8,
        description: "outbox/group_outbox/file_outbox 建 created_at 索引（sweeper 扫描成本）",
        run: |conn| {
            for sql in [
                "CREATE INDEX IF NOT EXISTS idx_outbox_created ON outbox(created_at)",
                "CREATE INDEX IF NOT EXISTS idx_group_outbox_created ON group_outbox(created_at)",
                "CREATE INDEX IF NOT EXISTS idx_file_outbox_created ON file_outbox(created_at)",
            ] {
                if let Err(e) = conn.execute(sql, []) {
                    eprintln!("[gosslan-db] v8 索引跳过一条（不影响启动）：{e}");
                }
            }
            Ok(())
        },
    },
    // v8 → v9：删掉两条**已被取代**的索引（0-B）。
    //
    // 为什么这必须是迁移而不是 SCHEMA：`CREATE INDEX IF NOT EXISTS` 只会建不会删，
    // 而这两条留着就是热写路径上白付的写放大 ——
    // ① `idx_outbox_msg_id`（v5→v6 建的唯一索引）与 `outbox.msg_id` 的**内联 UNIQUE**
    //    是同一件事的两份。约束的权威是内联那个（`sqlite_autoindex` 一直在守），
    //    这条测试会证明删掉索引后重复插入仍然被挡。
    // ② `idx_file_outbox_peer(peer_id, status)` 是新的
    //    `idx_file_outbox_peer_due(peer_id, status, next_attempt_at)` 的严格前缀。
    // 软失败：删不动不拦启动（它们留着只是慢一点，不是错）。
    Migration {
        from: 8,
        to: 9,
        description: "删掉被取代的 idx_outbox_msg_id / idx_file_outbox_peer（写放大）",
        run: |conn| {
            for sql in [
                "DROP INDEX IF EXISTS idx_outbox_msg_id",
                "DROP INDEX IF EXISTS idx_file_outbox_peer",
            ] {
                if let Err(e) = conn.execute(sql, []) {
                    eprintln!("[gosslan-db] v9 删冗余索引跳过一条（不影响启动）：{e}");
                }
            }
            Ok(())
        },
    },
    // v9 → v10：把 v7 那段孤儿清理**再跑一遍**（#61，用户 2026-09-26 拍板＝加一次清理）。
    //
    // 为什么需要重跑而不是"修好 v7 就完了"：迁移链按 `user_version` 前进，
    // **已经跨过 v7 的老库永远不会重放它** —— 那批"群早就不在册、待发已读回执还活着"的行
    // 就留在库里。用户可见后果：那个设备每次上线，本机都会给它发一条
    // `GroupReadReceipt`（"我在一个我并不存在的群里读到了某时刻"），而对端只能照单收下。
    //
    // 谓词与 v7 同一份（`sweep_group_orphans`），双锚 ⇒ 重跑对已经干净的库是纯空操作，
    // 对"群仍在册但会话被用户删掉"的库一个字节都不动（这条反向断言在判据里）。
    // 同 v7 的容错口径：尽力清理、清不动只留痕，绝不把 `init` 变成 Err。
    Migration {
        from: 9,
        to: 10,
        description: "重跑群孤儿清理（补上坏版本 v7 漏掉的存量）",
        run: |conn| {
            for err in sweep_group_orphans(conn) {
                eprintln!("[gosslan-db] v10 存量清理跳过一条语句（不影响启动）：{err}");
            }
            Ok(())
        },
    },
    // #122 第二段：@ 的**落点**（`mention_targets`）以前只活在一次投递里 ⇒ 重启读历史又退回
    // 按昵称判，群里同名两个人重新互相点亮。这一列是"SCHEMA 表达不了的事"里的那一类：
    // 新库由 SCHEMA 直接带上，而**已经在用的库**那句 `CREATE TABLE IF NOT EXISTS` 根本不会执行，
    // 所以只有迁移能给老库补上它（判据：`migration_tests::v10_to_v11_adds_mention_targets_column_without_touching_existing_rows`）。
    // 可空、**不回填**：老行没有落点就是"不知道"，呈现层继续按昵称兜底 ——
    // 回填成 `'[]'` 会把历史上每一条 @ 都判成"谁都没 @ 我"，那是把缺数据读成权威结论（INV-P24）。
    Migration {
        from: 10,
        to: 11,
        description: "messages 加 mention_targets 列（@ 的落点活过一次重启）",
        run: |conn| {
            // 先数一遍再决定加不加：`ALTER ... ADD COLUMN` 撞到已有列会直接 Err，
            // 而迁移报错 = 启动被拒 = 用户打不开应用。代价不对称，这里宁可多四行。
            let has: bool = conn.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name = 'mention_targets'",
                [],
                |r| r.get::<_, i64>(0),
            )? > 0;
            if !has {
                conn.execute("ALTER TABLE messages ADD COLUMN mention_targets TEXT", [])?;
            }
            Ok(())
        },
    },
    // v11 → v12：主动取消的终态墓碑。只有它能让一条 cancelled 行拒绝后续
    // progress/attempt/续传的复活；自动超时/放弃不置位，断点续传仍可用。
    // 判据：send 方向取消后 upsert active 不生效；自动 failed 仍可复活
    // （`cascade_tests::a_user_cancelled_transfer_is_never_revived_by_a_late_write`）。
    Migration {
        from: 11,
        to: 12,
        description: "file_transfers 加 cancel_terminal 列（用户/对端主动取消的终态墓碑）",
        run: |conn| {
            // ⚠️ 先问"这张表在不在"，再问"这一列在不在"：`pragma_table_info('不存在的表')`
            // 返回**空结果**而不是报错，所以只判列的话这一步会拿着 false 去 ALTER，
            // 撞出 "no such table: file_transfers" ⇒ 迁移报错 = 启动被拒 = 用户打不开应用。
            // 真实场景里 `init` 先 apply SCHEMA 再跑迁移，表一定在；这条不是为真机加的，
            // 是被 `migration_tests::a_failing_migration_step_rolls_back_completely_and_never_advances_the_version`
            // 抓到的（它直接 run_migrations，喂的是一份没有 file_transfers 的老库形状）。
            let table: bool = conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'file_transfers'",
                [],
                |r| r.get::<_, i64>(0),
            )? > 0;
            if table && !column_exists(conn, "file_transfers", "cancel_terminal")? {
                conn.execute(
                    "ALTER TABLE file_transfers ADD COLUMN cancel_terminal INTEGER NOT NULL DEFAULT 0",
                    [],
                )?;
            }
            Ok(())
        },
    },
];

/// 建表脚本 —— 表结构的**唯一真源**（另有一张 `content` 表由
/// `content/store.rs::ensure_schema` 建）。曾经另有一份手写 `schema.sql` 自称"与本文件一致"，
/// 实测两边表名集合不等而全仓没有一行代码读它 ⇒ 2026-09-26 退役。要再留一份"给人看的 DDL"，
/// 先回答"谁机器核对它一致"。
pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS friends (
    device_id TEXT PRIMARY KEY,
    nickname  TEXT NOT NULL,
    avatar    TEXT,
    x25519_pubkey  TEXT,
    ed25519_pubkey TEXT,
    added_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
    id        TEXT PRIMARY KEY,
    kind      TEXT NOT NULL,           -- 'single' | 'group'
    name      TEXT NOT NULL,
    avatar    TEXT,
    last_msg  TEXT,
    last_ts   INTEGER,
    unread    INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER,
    -- 本机置顶（纯本地偏好，不广播不同步）：列表排序时优先于 last_ts
    pinned    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    msg_id      TEXT UNIQUE NOT NULL,
    conv_id     TEXT NOT NULL,
    sender_id   TEXT NOT NULL,
    receiver_id TEXT NOT NULL,
    kind        TEXT NOT NULL,          -- text | code | image | file | system
    content     TEXT NOT NULL,
    ts          INTEGER NOT NULL,
    seq         INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'sent',
    -- @ 的落点（JSON 数组 `[{id,name,n}]`，见 `protocol::MentionTarget`）。
    -- **可空，NULL = 不知道**（老行 / 老对端 / 这一列写坏了）⇒ 呈现层按昵称兜底。
    -- 不加索引：它只随行读回，从不按内容查（热查询仍走 `idx_messages_conv_seq`）。
    mention_targets TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id, ts);
-- ⚠️ `idx_messages_conv_seq` **不在这里**，而且不能放进来：`seq` 是迁移 v2→v3 才加到
-- `messages` 上的列，而 `execute_batch(SCHEMA)` 跑在迁移**之前** ⇒ 老库里这句会
-- `no such column: seq` 直接让 `init()` 失败（用户打不开自己的库）。
-- 它的家在 `ensure_post_schema_shape`（两条分支都经过：老库由 v2→v3 在建列之后建，
-- 新库不重放迁移、由那个函数补）—— 顺序是语义，不是风格问题。
-- 判据测试：`migration_tests::index_on_a_migration_added_column_must_not_live_in_schema`
-- + `migration_tests::fresh_schema_alone_has_exactly_the_migrated_shape`。

-- 每会话逻辑时钟（Lamport 风格，单调递增）。消息排序与群聊清空边界都以此为准，
-- 不使用发送方或接收方的墙上时钟。
CREATE TABLE IF NOT EXISTS conversation_clocks (
    conv_id TEXT PRIMARY KEY,
    seq     INTEGER NOT NULL
);

-- 撤回的**权威集合**（G-Set，只增不减）。`messages` 行的 content 置空 / kind='recalled'
-- 只是它的**物化视图** —— 两者都必需：撤回事件可能先于被撤回消息到达
-- （Gossip 泛洪与 outbox 直发是两条无顺序保证的路径），只靠 UPDATE 会打到 0 行，
-- 随后消息正常落库 ⇒ 撤回失效。落库前查这张表即可解决「先撤后到」。
CREATE TABLE IF NOT EXISTS group_recalled_messages (
    conv_id     TEXT NOT NULL,
    msg_id      TEXT NOT NULL,
    recaller_id TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    PRIMARY KEY (conv_id, msg_id)
);
-- 判定"这条消息是否已被撤回"只给 msg_id（`is_recalled`），PK 的前缀是 conv_id 用不上
-- ⇒ 每次群收件都要全表扫这张**只增不减**的 G-Set。这条索引在收件热路径上。
CREATE INDEX IF NOT EXISTS idx_group_recalled_msg ON group_recalled_messages(msg_id);

-- 代码/文本消息渲染切换的 LWW 状态：只存最后一次生效的 (seq, mode)。
-- `messages.kind` 是它的物化视图；用独立表而不是给 messages 加列，避免老库迁移。
CREATE TABLE IF NOT EXISTS message_render (
    msg_id TEXT PRIMARY KEY,
    seq    INTEGER NOT NULL,
    mode   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    creator    TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
    group_id  TEXT NOT NULL,
    device_id TEXT NOT NULL,
    PRIMARY KEY (group_id, device_id)
);

-- 群成员已读位置：每个成员只保留读到的最大时间戳
CREATE TABLE IF NOT EXISTS group_reads (
    group_id      TEXT NOT NULL,
    reader_id     TEXT NOT NULL,
    last_read_ts  INTEGER NOT NULL,
    PRIMARY KEY (group_id, reader_id)
);

-- 离线补发队列：发给离线/未连接好友的消息
CREATE TABLE IF NOT EXISTS outbox (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    msg_id     TEXT NOT NULL UNIQUE,
    peer_id    TEXT NOT NULL,
    payload    TEXT NOT NULL,          -- 序列化后的 Message JSON
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_peer ON outbox(peer_id);
CREATE INDEX IF NOT EXISTS idx_outbox_created ON outbox(created_at);

-- 群消息离线补发队列：同一 msg_id 需按成员各自维护投递状态。
CREATE TABLE IF NOT EXISTS group_outbox (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    msg_id     TEXT NOT NULL,
    group_id   TEXT NOT NULL,
    peer_id    TEXT NOT NULL,
    payload    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(msg_id, peer_id)
);
CREATE INDEX IF NOT EXISTS idx_group_outbox_peer ON group_outbox(peer_id);
CREATE INDEX IF NOT EXISTS idx_group_outbox_group ON group_outbox(group_id);
CREATE INDEX IF NOT EXISTS idx_group_outbox_created ON group_outbox(created_at);

CREATE TABLE IF NOT EXISTS file_transfers (
    id         TEXT PRIMARY KEY,
    peer_id    TEXT NOT NULL,
    name       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    direction  TEXT NOT NULL,          -- 'send' | 'receive'
    status     TEXT NOT NULL,          -- 'pending'|'active'|'done'|'failed'|'sent'|'cancelled'（sent=send 侧已写出但无对端回执；cancelled=用户/对端主动取消）
    path       TEXT,
    progress   REAL NOT NULL DEFAULT 0,
    -- 1 = 用户/对端主动取消，终态墓碑：之后的进度/attempt/续传不得把 status 写回 active/done。
    -- 自动超时/重试耗尽仍是 0（保留断点续传的复活能力）。迁移 v11→v12 补列。
    cancel_terminal INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
-- 传输面板首屏是 `ORDER BY created_at DESC` —— 零索引时每次打开都要全表扫 +
-- 临时 B-tree 排序，而行数是只增的（历史传输不删）。
CREATE INDEX IF NOT EXISTS idx_file_transfers_created ON file_transfers(created_at DESC);
-- DB-03：`list_transfers` 只回「未完成 + 最近 N 条终态」，两条腿各用一条索引。
-- 终态那条走上面的 `idx_file_transfers_created`（按序扫、凑够 N 条就停）；
-- 未完成那条必须**自己有一条**：`status IN ('pending','active')` 不在任何索引里，
-- 否则每次读都要把只增的历史表整扫一遍才能捞出那几行。
-- 部分索引（partial index）的谓词与查询里的谓词逐字一致，SQLite 才肯用它。
CREATE INDEX IF NOT EXISTS idx_file_transfers_open ON file_transfers(created_at DESC)
    WHERE status IN ('pending','active');

-- 文件离线投递队列：断线后重启可恢复，重连后自动补发。
CREATE TABLE IF NOT EXISTS file_outbox (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    transfer_id     TEXT NOT NULL UNIQUE,
    peer_id         TEXT NOT NULL,
    group_id        TEXT,
    local_path      TEXT NOT NULL,
    name            TEXT NOT NULL,
    size            INTEGER NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'sending' | 'failed' | 'cancelled'（后者=用户主动取消，见 INV-P26）
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    created_at      INTEGER NOT NULL
);
-- 取某 peer 待投递的文件是「每次建链 / 每次心跳」都跑一遍的读：判据是
-- peer_id + status + `next_attempt_at <= now`。原先的 (peer_id, status) 只能定位到
-- "这个 peer 的所有待发行"，时间窗还得逐行回表比 ⇒ 把 next_attempt_at 收进第三列。
-- ⚠️ 被它取代的旧 `idx_file_outbox_peer` **不在这里**（SCHEMA 造不出"删"），
-- 由迁移 v8→v9 一次性删掉；两处都写会变成每次启动"建了又删"。
CREATE INDEX IF NOT EXISTS idx_file_outbox_peer_due ON file_outbox(peer_id, status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_file_outbox_created ON file_outbox(created_at);

-- 群文件：一个 transfer_id 对应一个群文件。
-- 每个群成员的投递状态在 group_file_recipients 中独立维护（DB 是最终状态来源）。
CREATE TABLE IF NOT EXISTS group_files (
    transfer_id TEXT PRIMARY KEY,
    group_id    TEXT NOT NULL,
    sender_id   TEXT NOT NULL,
    name        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    sha256      TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'sending' | 'completed' | 'failed' | 'cancelled'（后者=用户主动取消整条群文件，B2 的硬终态，见 INV-P26）
    created_at  INTEGER NOT NULL,
    scope       TEXT NOT NULL DEFAULT 'chat',      -- 'chat' | 'todo'
    todo_id     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_group_files_group ON group_files(group_id);

-- 群文件 per-recipient 投递状态：同一 (transfer_id, recipient_id) 唯一
CREATE TABLE IF NOT EXISTS group_file_recipients (
    transfer_id  TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'sending' | 'completed' | 'failed' | 'cancelled'（后者=用户取消这一格；这张表**不需要墓碑列**：只有主动取消会写 cancelled，状态本身就是墓碑）
    progress     REAL NOT NULL DEFAULT 0,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (transfer_id, recipient_id)
);
CREATE INDEX IF NOT EXISTS idx_group_file_recipients_status
    ON group_file_recipients(transfer_id, status);
-- 离线投递定向查询：peer 上线时按 recipient 精确取其 pending 群文件
CREATE INDEX IF NOT EXISTS idx_group_file_recipients_recipient
    ON group_file_recipients(recipient_id, status);

-- 群文件 ACK 的**持久化账本**（2026-10-21）。
-- 为什么需要这张表：ACK 帧是**一次性**的（对端不会为同一条 transfer 再发第二遍），
-- 而落库可能失败（SQLITE_BUSY / 磁盘满 / 进程被杀）⇒ 一条**已经送达**的群文件会永远停在 sending。
-- 现在先把"收到过这条 ACK"落一行，再做状态收尾；收尾失败 ⇒ 这一行留着，
-- 由进程级清扫器（network/transport/outbox_sweep.rs）重放 ⇒ **跨进程也能恢复**。
-- 老库没有这张表：SCHEMA 每次启动都会跑一遍（IF NOT EXISTS）⇒ 自动补齐，历史数据一行不动；
-- 协议帧与消息格式**一个字都没改** ⇒ 老 peer 与新版本互操作不变。
CREATE TABLE IF NOT EXISTS group_file_acks (
    transfer_id  TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    group_id     TEXT NOT NULL,
    success      INTEGER NOT NULL DEFAULT 0,   -- 1 = 对端收成功，0 = 对端失败
    received_at  INTEGER NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 0,   -- 重放次数（超上界 ⇒ 落 failed 终态，不许永久挂起）
    last_error   TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (transfer_id, recipient_id)
);
-- 重放查询：按收到时间取最早的一小批（每 tick 一批，不做全表扫）
CREATE INDEX IF NOT EXISTS idx_group_file_acks_received ON group_file_acks(received_at);

-- 待发已读回执：进程重启后从 DB 恢复，避免 ReadReceipt 丢失
CREATE TABLE IF NOT EXISTS pending_reads (
    peer_id       TEXT PRIMARY KEY,
    last_read_ts  INTEGER NOT NULL
);

-- 待发群已读回执：成员离线/链路不可用时暂存，建链/心跳时补发。
CREATE TABLE IF NOT EXISTS pending_group_reads (
    group_id      TEXT NOT NULL,
    peer_id       TEXT NOT NULL,
    last_read_ts  INTEGER NOT NULL,
    PRIMARY KEY (group_id, peer_id)
);
CREATE INDEX IF NOT EXISTS idx_pending_group_reads_peer ON pending_group_reads(peer_id);

-- 收藏（微信式）：**独立本地存储**，不随会话删除、不随消息清理消失。
--
-- 为什么是独立表而不是像置顶/待办那样发一条 kind='pin' 的静默消息：那些是"消息的派生状态"，
-- 随消息生命周期走；收藏是"用户对某条内容的**独立副本**"——原消息被删、会话被删、
-- 本机存储清理之后，收藏仍要能打开。所以这里存 content 快照，并把媒体**复制**一份到
-- 收藏专用目录（`media_path`），副本路径已改写进 `content.path`。
--
-- UNIQUE(msg_id)：同一条消息重复收藏是幂等的（INSERT OR IGNORE），不会攒出两条。
CREATE TABLE IF NOT EXISTS favorites (
    id           TEXT PRIMARY KEY,              -- uuid：删除/预览都按它定位
    msg_id       TEXT NOT NULL,
    conv_id      TEXT NOT NULL,
    sender_id    TEXT NOT NULL,
    kind         TEXT NOT NULL,                 -- text | code | image | file
    content      TEXT NOT NULL,                 -- 收藏时的快照（媒体已改写成副本路径）
    ts           INTEGER NOT NULL,              -- 原消息时间
    favorited_at INTEGER NOT NULL,              -- 收藏时间（列表排序键）
    media_path   TEXT,                          -- 收藏副本绝对路径（仅 image/file）
    media_size   INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_favorites_msg  ON favorites(msg_id);
CREATE INDEX        IF NOT EXISTS idx_favorites_time ON favorites(favorited_at DESC);
"#;

/// 迁移前备份的保留份数（含本次刚生成的那一份）。
///
/// 3 份够覆盖"连续两次升级都出问题、要回头看上一版"的场景；再多只是在磁盘上堆积
/// **完整消息库 + 身份密钥**的副本（审计 DB-02）。迁移是低频事件，所以取小不取大。
const MAX_MIGRATION_BACKUPS: usize = 3;

/// 迁移备份清扫失败（审计 DB-02）。
///
/// **不中止启动**：库和备份都还在，删不掉的是旧副本 —— 那是磁盘/权限问题，不该把用户
/// 拦在应用外面。但必须带码落日志：否则"备份越堆越多"这件事在日志里完全看不见。
#[derive(Debug, thiserror::Error)]
#[error("迁移备份清扫失败：{path}: {reason}")]
pub struct BackupSweepError {
    path: String,
    reason: String,
}

impl BackupSweepError {
    /// 给日志与支持人员检索的错误码。
    pub fn code(&self) -> &'static str {
        "BACKUP_SWEEP_FAILED"
    }
}

/// 启动/迁移后的**统一清扫**：补齐历史备份的 `0600`，并把超出保留份数的旧备份删掉。
///
/// 5.0.22–5.0.25 创建的备份可能是 `0644`（B6 只保证新备份是 `0600`），里面含身份密钥与
/// 全部消息，所以先统一收紧再谈删。只匹配本库的 `<stem>.pre-v…-to-v….db`，不碰同目录
/// 其它文件/目录。
///
/// 返回删掉的份数（日志用）。某一份删不掉不会让后面可删的继续留着：走完全部候选，
/// 最后报第一处失败 —— 一次清零比每次启动都剩同一批更有用。
fn sweep_old_backups(db_path: &Path) -> std::result::Result<usize, BackupSweepError> {
    let backups = migration_backups_newest_first(db_path).map_err(|e| BackupSweepError {
        path: db_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .display()
            .to_string(),
        reason: format!("扫描备份目录: {e}"),
    })?;
    for p in &backups {
        restrict_to_owner(p);
    }
    let mut removed = 0usize;
    let mut first_err: Option<BackupSweepError> = None;
    for p in backups.into_iter().skip(MAX_MIGRATION_BACKUPS) {
        match std::fs::remove_file(&p) {
            Ok(()) => removed += 1,
            Err(e) => {
                if first_err.is_none() {
                    first_err = Some(BackupSweepError {
                        path: p.display().to_string(),
                        reason: format!("删除过期备份: {e}"),
                    });
                }
            }
        }
    }
    first_err.map_or(Ok(removed), Err)
}

/// `gosslan.db` → `gosslan.db-wal` / `gosslan.db-shm`（不能用 `with_extension`，会吃掉 `.db`）。
fn sidecar_path(path: &Path, suffix: &str) -> std::path::PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(suffix);
    std::path::PathBuf::from(s)
}

/// 迁移前一致性快照 + 可验证判据（数据安全优先）。
///
/// 为什么用 `VACUUM INTO` 而不是复制主文件：WAL 模式下已提交数据可能还在 `-wal` 里，
/// 直接 `fs::copy` 主文件（或连同 `-wal/-shm` 一起）不是原子快照。`VACUUM INTO` 由
/// SQLite 自己开读事务，把**已提交状态**写成一个独立单文件；随后用只读连接校验
/// `integrity_check=ok`、迁移前版本、业务表数，三者任一不满足就中止迁移并保留原库。
///
/// 备份名带进程 id + 纳秒时间戳：失败重试不会覆盖上一份可用备份。**不在这里删除旧备份** ——
/// 保留策略统一由 `sweep_old_backups`（`MAX_MIGRATION_BACKUPS`）在启动路径上裁决，
/// 否则"谁在什么时候删"会散成好几处口径。
fn backup_before_migration(
    conn: &Connection,
    db_path: &Path,
    from_version: u32,
    expected_tables: i64,
) -> std::result::Result<(), InitError> {
    let parent = db_path.parent().unwrap_or_else(|| Path::new("."));
    let stem = db_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("gosslan");
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let backup = parent.join(format!(
        "{stem}.pre-v{from_version}-to-v{DB_VERSION}-{}-{stamp}.db",
        std::process::id()
    ));
    let backup_str = backup.to_string_lossy().to_string();
    let fail = |reason: String| InitError::Backup {
        path: backup_str.clone(),
        reason,
    };
    conn.execute("VACUUM INTO ?1", [backup_str.as_str()])
        .map_err(|e| fail(format!("VACUUM INTO: {e}")))?;
    // 备份是完整副本（含身份密钥与消息），权限不得比原库宽。
    restrict_to_owner(&backup);
    let check = Connection::open_with_flags(&backup, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| fail(format!("打开备份: {e}")))?;
    let integrity: String = check
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|e| fail(format!("integrity_check: {e}")))?;
    if integrity != "ok" {
        return Err(fail(format!("integrity_check 结果不是 ok：{integrity}")));
    }
    let version: u32 = check
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| fail(format!("读取备份版本: {e}")))?;
    if version != from_version {
        return Err(fail(format!(
            "备份 user_version={version}，迁移前应为 {from_version}"
        )));
    }
    let tables: i64 = check
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| fail(format!("统计备份表数: {e}")))?;
    if tables != expected_tables {
        return Err(fail(format!(
            "备份业务表数={tables}，迁移前为 {expected_tables}"
        )));
    }
    eprintln!(
        "[gosslan-db] pre-migration backup ok: {backup_str} \
         (v{from_version}→v{DB_VERSION}, tables={tables}, integrity=ok)"
    );
    Ok(())
}

/// DDL 阶段的错误分类：**格式问题**（文件不是数据库 / 库损坏）仍按 `Sqlite` 报，
/// 只有"库是好的、但这批 DDL 没写成"才是 `SchemaMigrate`。
///
/// 为什么要分：损坏库的既有判据（`a_corrupt_database_is_rejected_and_left_byte_for_byte_untouched`）
/// 与启动文案都认 `InitError::Sqlite`；如果一律包成 `SchemaMigrate`，用户会看到
/// "表结构事务失败"这种指错方向的提示，而实际是文件根本不是数据库。
fn ddl_error(stage: &str, e: rusqlite::Error) -> InitError {
    let format_problem = match &e {
        rusqlite::Error::SqliteFailure(code, _) => matches!(
            code.code,
            rusqlite::ErrorCode::NotADatabase | rusqlite::ErrorCode::DatabaseCorrupt
        ),
        _ => false,
    };
    if format_problem {
        InitError::Sqlite(e)
    } else {
        InitError::SchemaMigrate {
            reason: format!("{stage}: {e}"),
        }
    }
}

/// 把「基础 schema + 内容层 schema」作为**一个** DDL 事务应用（审计 DB-01）。
///
/// 旧实现是两句独立的 `execute_batch`：第一句建完全部表、第二句失败（磁盘满，或两次调用
/// 之间被 kill）时，库里就留下"一半新、一半旧"的形状 —— 下次启动既不算 fresh（数表 > 0），
/// 也未必还能按旧版本重放迁移，只能人工恢复。`SCHEMA` 与 `ensure_schema` 里都只有
/// `CREATE ...` / `ALTER TABLE`，没有 `PRAGMA journal_mode` 那类不能进事务的语句。
///
/// `ddl` 在生产路径恒为 `SCHEMA`；这个参数只为回归用例留一个注入点 —— 不给注入点，
/// "整批回滚"就只能靠人相信（用例会喂一份中途会失败的 DDL）。
fn apply_base_schema_atomically(
    conn: &Connection,
    ddl: &str,
    fresh_version: Option<u32>,
) -> std::result::Result<(), InitError> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| ddl_error("开启 DDL 事务", e))?;
    tx.execute_batch(ddl)
        .map_err(|e| ddl_error("基础 schema", e))?;
    crate::content::store::ensure_schema(&tx).map_err(|e| ddl_error("内容层 schema", e))?;
    // 全新库的 `user_version` 必须和建表在**同一个事务**里（审计 DB-01 复审）：
    // 崩在"表建完、版本还没写"之间，下次启动会看到 current=0 + 表齐全 ⇒ 判成老库、
    // 先备份再重放整条迁移链。写进事务之后只有"全有"与"全无"两种形状。
    if let Some(version) = fresh_version {
        tx.pragma_update(None, "user_version", version)
            .map_err(|e| ddl_error("写入初始版本", e))?;
    }
    tx.commit().map_err(|e| ddl_error("提交 DDL 事务", e))?;
    Ok(())
}

/// 打开（或创建）数据库并执行迁移 —— **测试便捷入口**（生产走 [`init_with_notices`]，
/// 因为它需要把启动期诊断串交给 logger）。
///
/// `#[cfg(test)]`：留一个不带诊断串的签名只会让未来的生产调用点悄悄丢掉那几条日志。
#[cfg(test)]
pub fn init(path: &Path) -> std::result::Result<Connection, InitError> {
    init_with_notices(path).map(|(conn, _)| conn)
}

/// 同 [`init`]，另外把"启动阶段只能排队、等 logger 就绪后再写"的诊断串带出来。
///
/// 审计 DB-02 复审：备份清扫失败原来只 `eprintln!` —— 打包后的 Windows 没有控制台，
/// 那条 `code=BACKUP_SWEEP_FAILED` 在生产里等于没写。现在由调用方（`state.rs`）
/// 在 `Logger::new` 之后用 `logger.warn` 落盘。
pub fn init_with_notices(path: &Path) -> std::result::Result<(Connection, Vec<String>), InitError> {
    let mut startup_notices: Vec<String> = Vec::new();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let conn = Connection::open(path)?;
    // 先收紧主库权限：SQLite 之后新建的 `-wal/-shm` 会沿用主库的权限位。
    restrict_to_owner(path);
    // 备份 / VACUUM / 其它进程短暂持锁时不要立刻 SQLITE_BUSY；5s 内排队等待。
    // 这不是"把锁竞争藏起来"：等待有上界，超时仍返回错误，调用方照常进入错误态。
    conn.busy_timeout(Duration::from_secs(5))?;
    // S13: 数据库版本高于当前程序 — 说明用户从更新版本的 App 降级了，旧代码不认识新
    // schema，继续使用会导致数据损坏。**拒绝继续，不降级、不删除。**
    //
    // ★ 位置是**语义的一部分**：必须早于下面任何一句写操作。`execute_batch(SCHEMA)`
    //   看着是 `CREATE TABLE IF NOT EXISTS`（对老表无害），但它确实写文件，而且一旦先跑它，
    //   "你的数据没有被改动"这句提示就成了谎话。全仓只允许这一处降级判定。
    let current: u32 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap_or(0);
    if current > DB_VERSION {
        let err = InitError::Downgrade { current };
        eprintln!("[gosslan-db] FATAL: {err}");
        return Err(err);
    }
    // ★ 数表必须发生在 `execute_batch(SCHEMA)` **之前**：SCHEMA 会建出全部 19 张表，
    //   之后再数就区分不了"全新库"与"老库"—— 那正是本仓曾经的样子（`is_fresh` 恒为假，
    //   于是全新库把整条迁移链重放一遍：9 行假的「running v1→v2…」日志、v7 两条
    //   "孤儿清理跳过一条语句"的告警、以及先建 `idx_outbox_msg_id` 再在 v8→v9 删掉它）。
    let pre_table_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    // 判据：`user_version` 没写过 **且** 一张业务表都没有。只看前者会把
    // "老库（v1/v2 时代根本不存在 user_version）"误判成新库 ⇒ 那条库的形状就永远补不回来。
    let is_fresh = current == 0 && pre_table_count == 0;

    // **迁移前保护**：已有库且需要前进 schema 时，先在**任何写操作之前**做一致性快照。
    // 这里位于 `execute_batch(SCHEMA)` 之前是语义的一部分：备份失败就中止，原库一个字节
    // 都不改；不许带着"备份没成功"继续往下迁移。
    if !is_fresh && current < DB_VERSION {
        backup_before_migration(&conn, path, current, pre_table_count)?;
    }

    // 迁移备份的统一清扫（审计 DB-02）：补齐历史备份的 0600，只保留最近
    // `MAX_MIGRATION_BACKUPS` 份。放在备份之后 = 一次调用同时覆盖"启动时清理历史积压"
    // 与"本轮迁移后清理刚多出来的那份"。
    // **失败不中止启动**：库与备份都还在，删不掉的只是旧副本（磁盘/权限问题），
    // 不该把用户拦在应用外面；但必须带码落日志，否则"备份越堆越多"在日志里看不见。
    match sweep_old_backups(path) {
        Ok(0) => {}
        Ok(n) => startup_notices.push(format!(
            "迁移备份清扫：删除 {n} 份过期备份（保留 {MAX_MIGRATION_BACKUPS} 份）"
        )),
        Err(e) => startup_notices.push(format!(
            "code={} {e} —— 旧迁移备份可能继续堆积，下一次启动会再试",
            e.code()
        )),
    }

    // DB-01：基础 schema 与内容层 schema 必须在**同一个事务**里落地 —— 分开跑时，
    // 第二段失败会留下半套表（既不是 fresh 也不再是旧版本形状），只能人工恢复。
    // 全新库的 `user_version` 也并进这个事务（复审：两笔写之间的崩溃会造出"表齐全但 version=0"）。
    apply_base_schema_atomically(&conn, SCHEMA, is_fresh.then_some(DB_VERSION))?;

    if !is_fresh {
        run_migrations(&conn, current)?;
    }
    // **两条分支都要经过**这里：有形状是 SCHEMA 表达不了的（见 `ensure_post_schema_shape`），
    // 而 fresh 分支不重放迁移 —— 这个函数就是那笔差额，缺了它新安装会少一条热查询索引。
    ensure_post_schema_shape(&conn)?;
    // 每次启动都把会话时钟同步到「该会话已有最大逻辑序号」
    conn.execute(
        "INSERT INTO conversation_clocks(conv_id, seq)
         SELECT conv_id, MAX(seq) FROM messages GROUP BY conv_id
         ON CONFLICT(conv_id) DO UPDATE SET seq = MAX(conversation_clocks.seq, excluded.seq)",
        [],
    )?;
    // 开启 WAL，提升并发读写
    conn.pragma_update(None, "journal_mode", "WAL").ok();
    // 已有侧车可能带着历史安装的 0644；补收紧一次（新建侧车已继承主库 0600）。
    restrict_to_owner(&sidecar_path(path, "-wal"));
    restrict_to_owner(&sidecar_path(path, "-shm"));
    // NORMAL：牺牲极小崩溃一致性换取更高写入吞吐（500-1000 节点高频落库场景）
    conn.pragma_update(None, "synchronous", "NORMAL").ok();
    conn.pragma_update(None, "foreign_keys", "ON").ok();
    Ok((conn, startup_notices))
}

#[cfg(test)]
mod startup_safety_tests;

include!("db/settings.rs");

include!("db/clocks.rs");

include!("db/group_delete_boundary.rs");

include!("db/friends.rs");

include!("db/groups.rs");

include!("db/messages.rs");

include!("db/conversations.rs");

include!("db/message_delete.rs");

include!("db/offline_queue.rs");

include!("db/group_offline_queue.rs");

include!("db/file_transfer.rs");

include!("db/file_offline.rs");

include!("db/group_files.rs");

include!("db/read_receipts.rs");

include!("db/favorites.rs");

include!("db/recalls.rs");
// 群历史同步的两半：服务端分页取数 + 新成员侧幂等落库（2026-10-16 需求）
include!("db/group_history.rs");

#[cfg(test)]
mod cascade_tests;
#[cfg(test)]
mod migration_tests;
#[cfg(test)]
mod read_receipts_tests;
#[cfg(test)]
mod todo_reads_tests;
