//! 内容传输**逻辑层**：把"文本 / 文件 / 图片"统一成一条内容生命周期。
//!
//! ## 分层（用户 2026-09-15 要求：各层相互独立、只通过能力函数调用、且都能扩展）
//!
//! - **网络层**（network/）：链路、分帧、中继、**能力协商位图**。对外只暴露
//!   "发给谁 / 广播 / 有没有链路 / 能不能拉取" 这组能力。
//! - **逻辑层**（本模块）：内容生命周期 + 重试策略 + 持久化。
//!   **不依赖**具体传输实现（网络能力以 trait 注入），可脱离网络单测。
//! - **业务层**（commands/ + network/ 的 handler）：把逻辑层能力组合成
//!   "发文件 / 收图 / 群投递 / 点击重取" 等用例。
//! - **功能层**（前端）：只消费统一状态与命令，不关心走了哪条链路、哪条通道。
//!
//! 扩展点：新增一种内容（如视频）只需在业务层登记 cid + 复用本模块；
//! 新增一条链路只需实现网络能力 trait，逻辑层与前端无需改动。

pub mod model;
pub mod policy;
pub mod store;

pub use model::{ContentId, Direction, FailReason, TransferRecord, TransferStatus};
pub use policy::{backoff_ms, can_transition, on_failure, should_retry_now};
