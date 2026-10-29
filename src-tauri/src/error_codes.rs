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
