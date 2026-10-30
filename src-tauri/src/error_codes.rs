//! 跨 FFI 的**错误码**（INV-P16 的窄口落地，2026-10-29）。
//!
//! ## 为什么只有这一族需要码
//!
//! 法条要的是五档语义（recoverable / retryable / permanent / user_action_required /
//! security_related）。实况是：**能靠字符串做到的只有"界面上要说哪句话"这一件事**，
//! 而真正需要分档的收尾判断早就有结构化的家（`file::send_retry_verdict` 吃的是
//! `SendFileError{retryable, cancelled}` 两个布尔，不是字符串；台账落库走 `FailReason` 九档）。
//! 所以这里不铺 163 条命令的类型，只把**前端按文案分支的那几条**换成按码分支 ——
//! 那几处今天真的会因为"后端把中文改了个字"而静默换档。
//!
//! ## 形状
//!
//! `code=<大写蛇形> 给人看的那句话`。人话留在码后面：老前端读到的是"code=… 原句"，
//! 仍然能把原句显示出来；新前端先认码、没有码才回落到正则（OS 与第三方库的串本来就没有码，
//! 那一档**必须**继续按签名猜，这是兜底不是分类）。
//!
//! ## 这份清单是与前端对账的
//!
//! `src/utils/errors.test.ts` 现读这里的常量名与前端 `CODE_RULES` 的键，双向比：
//! 前端读了这里没有的码 ⇒ 红；这里定义了码却没人用 ⇒ 也红（那是一条已经失效的契约）。

/// 拿不到对端的 X25519 公钥 ⇒ 无法加密 / 无法发送。
/// 前端那一档的话术要点是"不用重发，先让对方上线或重新配对"。
pub const E2EE_PUBKEY_MISSING: &str = "E2EE_PUBKEY_MISSING";
/// 监听端口被占用（`AddrInUse` 重试耗尽后）。前端那一档要给"先退掉另一个实例"的动作。
pub const PORT_IN_USE: &str = "PORT_IN_USE";

/// 把码拼到人话前面 —— **唯一**的写法（不散着 `format!("code=…")`，否则对账判据读不出来）。
pub fn coded(code: &'static str, msg: impl std::fmt::Display) -> String {
    format!("code={code} {msg}")
}

// ── 消息气泡的失败原因（`messages.fail_code`，DB v14→v15）──────────────────────
//
// 上面那两个码走的是**命令返回值**那条通道（一次性、当场弹给用户）；这一族走的是**落库**
// 那条通道：一条被判失败的气泡要能在重启之后仍然说得出"为什么"。此前所有失败都只写成
// `status='failed'`，于是"对方一直不在线所以放弃"与"你把对方删了"在界面上是同一句话。
//
// 全部档位都是**写这一行时就知道原因**的位置。1:1 文件与群文件那一族自 5.15.31 / 5.15.32
// 起也进这张表（原先它们只活在 `file-failed` 事件里，重启就忘）。
// ★ 在册 ≠ 一切原因：**不在册的原因不写这一列**（读回来是 NULL，含义"这一格没记原因"，
//   不是"没有原因"）—— 因为这一列的读者是查词典的界面，写进内部串等于把文案塞进数据
//   （`group_file.rs::persistable_group_fail_code` 守的就是这条）。

/// 重试窗口耗尽（清扫器把仍在队列里的行落终态）。
pub const SEND_RETRY_EXPIRED: &str = "SEND_RETRY_EXPIRED";
/// 本机启动时发现"发送中但没有任何队列行"的孤儿（崩溃窗口 / 旧版本收尾顺序）。
pub const SEND_ORPHAN_AT_START: &str = "SEND_ORPHAN_AT_START";
/// 好友被删除时，仍在队列里发给这个人的消息随之落败（不是用户取消这一条）。
pub const SEND_PEER_DELETED: &str = "SEND_PEER_DELETED";
/// 群成员退群/被移出，这条群消息对该成员已无处可投、且没有别的成员还在等。
pub const SEND_GROUP_MEMBER_GONE: &str = "SEND_GROUP_MEMBER_GONE";

/// 文件单的两种"不是用户取消"的终态。**码只有一个出处**：这里。
/// 同一对常量既写进 `messages.fail_code`（`FileJobEnd::fail_code`）也发进 `file-failed`
/// 事件载荷（`outbox_sweep.rs`）⇒ 界面上同一格不会因"事件说 A、重启后读回来是 B"而变两样。
/// 家原先在 `logging.rs` 的 `FAIL_CODE_*`（那是事件载荷族的对账分母），搬过来是因为
/// 它们从 5.15.31 起**也要落库**，而落库档位的分母是下面那个数组。
pub const FILE_SEND_EXPIRED: &str = "FILE_SEND_EXPIRED";
/// 重试次数用尽（或队列行已不在），这一单再也发不出去。
pub const FILE_SEND_GIVEUP: &str = "FILE_SEND_GIVEUP";

/// 群文件**接收**侧的六种"收不下去"。名字前缀 `GROUP_` 是因为它们只代表**这一格收件人**的
/// 这一单收完了没（逐收件人台账），与 1:1 的失败不是一回事。
/// 以前它们是 `group_file.rs` 里的中文常量，只进日志、永不上屏；
/// 5.15.32 起它们是码 ⇒ 气泡行能带上"为什么"，界面按词典说话，重启之后还在。
///
/// ⚠️ **有码不等于要弹 toast**：断链时每个在途群文件都会失败一次，逐条弹通知就是噪音回归
///（`group_file.rs::should_notify_group_failure` 那份显式名单管这件事）。
pub const GROUP_FILE_STALLED: &str = "GROUP_FILE_STALLED";
/// 一个分片都没收到过（对端根本没开始发）。
pub const GROUP_FILE_NO_CHUNK: &str = "GROUP_FILE_NO_CHUNK";
/// 分片解密后与本机不匹配（内容与密钥/身份对不上）。
pub const GROUP_FILE_DECRYPT_FAILED: &str = "GROUP_FILE_DECRYPT_FAILED";
/// 分片顺序有洞（中间缺片），这一单已经补不齐。
pub const GROUP_FILE_CHUNK_GAP: &str = "GROUP_FILE_CHUNK_GAP";
/// 分片累计超出声明大小（协议层硬失败）。
pub const GROUP_FILE_CHUNK_EXCEEDS_SIZE: &str = "GROUP_FILE_CHUNK_EXCEEDS_SIZE";
/// 对端一条链路都不剩 —— 与"对端没上线"不同：这一单要重发才收得到。
pub const GROUP_FILE_PEER_UNLINKED: &str = "GROUP_FILE_PEER_UNLINKED";

// ── 文件**接收收尾**那一族的四种终态（5.15.35）───────────────────────────────
//
// 这一族的形状与上面两族不同：**判定在文件层、上屏有两道**。1:1 与群共用同一份判据
// （`file/receive.rs::finish_receiver_into` 与 `file/group_receive.rs::finish_group_receive_into`
// 各写一遍同一个决定），所以这里的码**不带 GROUP_ 前缀** —— 它们说的不是"这个收件人这一单"，
// 而是"这份内容收没收成"，两家用同一句话。
//
// 以前这四格给的是**中文散文**（`Err("文件完整性校验失败")`），其中写盘/占名那两格更糟：
// 直接把 `io::Error` 的原文当载荷（"No space left on device (os error 28)"）。⇒ 两种后果：
// 英文界面那格显示中文或显示 OS 原文（前端对未知 reason 是**原样上屏**，那条回落是刻意的）；
// 而群气泡那边因为拿不到在册的码，只能把原因**标成别的事**（详见 `group_file.rs` 收尾那一格）。
// 人话留在日志里（日志读者是排查的人，中文且不该随版本翻改）。
//
// `FILE_INTEGRITY_FAILED` 原先住在 `logging.rs`（事件载荷族），中继接收那一格在用。
// 搬过来是因为接收收尾也用同一个事实 —— 一个事实只许有一个名字，两处各定一条常量
// 就是等着分叉。

/// 收到的字节数与对端声明的大小不符（没收完就收到完成帧）。
pub const FILE_RECEIVE_INCOMPLETE: &str = "FILE_RECEIVE_INCOMPLETE";
/// 内容能收齐但哈希/密钥对不上 —— **这份不是那一份**，已丢弃。
pub const FILE_INTEGRITY_FAILED: &str = "FILE_INTEGRITY_FAILED";
/// 本机写盘/落盘失败（`sync_all` 没能把内容固定住）。盘满另有条 `DISK_FULL`，那条更 actionable。
pub const FILE_RECEIVE_WRITE_FAILED: &str = "FILE_RECEIVE_WRITE_FAILED";
/// 内容已经固定住，但没能把它放到最终名字上（同名占位失败）。
pub const FILE_RECEIVE_PLACE_FAILED: &str = "FILE_RECEIVE_PLACE_FAILED";

/// 落进 `messages.fail_code` 的全部档位 —— **与前端那张文案表双向对账的分母**
/// （`src/utils/fileFailReason.test.ts` 现读这里，两侧任何一侧多加一条都会红）。
pub const MESSAGE_FAIL_CODES: [&str; 16] = [
    SEND_RETRY_EXPIRED,
    SEND_ORPHAN_AT_START,
    SEND_PEER_DELETED,
    SEND_GROUP_MEMBER_GONE,
    FILE_SEND_EXPIRED,
    FILE_SEND_GIVEUP,
    GROUP_FILE_STALLED,
    GROUP_FILE_NO_CHUNK,
    GROUP_FILE_DECRYPT_FAILED,
    GROUP_FILE_CHUNK_GAP,
    GROUP_FILE_CHUNK_EXCEEDS_SIZE,
    GROUP_FILE_PEER_UNLINKED,
    FILE_RECEIVE_INCOMPLETE,
    FILE_INTEGRITY_FAILED,
    FILE_RECEIVE_WRITE_FAILED,
    FILE_RECEIVE_PLACE_FAILED,
];
