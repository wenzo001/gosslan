-- 真实 4.x v10 schema：原样取自 git `0b84f11^:src-tauri/src/db.rs` 的 SCHEMA 常量。
-- `0b84f11` 是引入 v11 / messages.mention_targets 的提交；它的父提交 DB_VERSION=10。
-- 不要手改：这条迁移判据要的是当时的 DDL，不是今天 SCHEMA 的复制品。
-- 复跑取证：git show 0b84f11^:src-tauri/src/db.rs | sed -n '/pub const SCHEMA/,/^"#;/p'

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
    status      TEXT NOT NULL DEFAULT 'sent'
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
    status     TEXT NOT NULL,          -- 'pending'|'active'|'done'|'failed'|'sent'（sent=send 侧已写出但无对端回执，终态）
    path       TEXT,
    progress   REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
-- 传输面板首屏是 `ORDER BY created_at DESC` 且**没有任何 WHERE** —— 零索引时
-- 每次打开都要全表扫 + 临时 B-tree 排序，而行数是只增的（历史传输不删）。
CREATE INDEX IF NOT EXISTS idx_file_transfers_created ON file_transfers(created_at DESC);

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
    status      TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'sending' | 'completed' | 'failed'
    created_at  INTEGER NOT NULL,
    scope       TEXT NOT NULL DEFAULT 'chat',      -- 'chat' | 'todo'
    todo_id     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_group_files_group ON group_files(group_id);

-- 群文件 per-recipient 投递状态：同一 (transfer_id, recipient_id) 唯一
CREATE TABLE IF NOT EXISTS group_file_recipients (
    transfer_id  TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'sending' | 'completed' | 'failed'
    progress     REAL NOT NULL DEFAULT 0,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (transfer_id, recipient_id)
);
CREATE INDEX IF NOT EXISTS idx_group_file_recipients_status
    ON group_file_recipients(transfer_id, status);
-- 离线投递定向查询：peer 上线时按 recipient 精确取其 pending 群文件
CREATE INDEX IF NOT EXISTS idx_group_file_recipients_recipient
    ON group_file_recipients(recipient_id, status);

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
