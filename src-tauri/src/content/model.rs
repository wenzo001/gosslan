//! 内容传输的**领域模型**（逻辑层，不依赖网络层与 UI）。
//!
//! 统一词汇：文本 / 文件 / 图片共用同一条生命周期（见 ADR-0019 §3.1）。

use serde::{Deserialize, Serialize};

/// 内容标识：明文 SHA-256（hex）。同一份字节在任何端都是同一个 cid。
///
/// 「按 cid 寻址」是整套设计的地基：任何持有完整字节的端（原始发送方，或
/// 已收完的任意群友）都能作为**种子**为同一个 cid 提供数据。
pub type ContentId = String;

/// 传输方向。
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Send,
    Receive,
}

impl Direction {
    pub fn as_str(self) -> &'static str {
        match self {
            Direction::Send => "send",
            Direction::Receive => "receive",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "send" => Some(Direction::Send),
            "receive" => Some(Direction::Receive),
            _ => None,
        }
    }
}

/// 统一传输状态（文本/文件/图片共用一套词汇）。
///
/// 旧实现有三套并行词汇：file_transfers 的 pending/active/done/failed、
/// group_file_recipients 的 pending/sending/completed/failed、内存 FileReceiver。
/// 这里收敛成一条，且**显式区分可恢复与终态** —— 这是"断网也不丢、能自动再来"的前提。
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferStatus {
    /// 已创建，等待发送（离线 / 暂无可用链路）。
    Queued,
    /// 正在传输。
    Active,
    /// 字节已收齐，正在校验（SHA-256）。
    Verifying,
    /// 完成且校验通过。
    Complete,
    /// 未完成但**可恢复**（断网 / 丢片 / 超时）：建链或用户点击后继续。
    Incomplete,
    /// 终态失败（校验不符且来源已无 / 对端不支持）：只能换源或放弃。
    Rejected,
}

impl TransferStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            TransferStatus::Queued => "queued",
            TransferStatus::Active => "active",
            TransferStatus::Verifying => "verifying",
            TransferStatus::Complete => "complete",
            TransferStatus::Incomplete => "incomplete",
            TransferStatus::Rejected => "rejected",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "queued" => Some(TransferStatus::Queued),
            "active" => Some(TransferStatus::Active),
            "verifying" => Some(TransferStatus::Verifying),
            "complete" => Some(TransferStatus::Complete),
            "incomplete" => Some(TransferStatus::Incomplete),
            "rejected" => Some(TransferStatus::Rejected),
            _ => None,
        }
    }
    /// 终态：不再自动重试。
    pub fn is_terminal(self) -> bool {
        matches!(self, TransferStatus::Complete | TransferStatus::Rejected)
    }
    /// 仍在流转 / 可恢复：前端据此决定显示进度还是「重试」。
    pub fn is_resumable(self) -> bool {
        matches!(
            self,
            TransferStatus::Queued | TransferStatus::Active | TransferStatus::Incomplete
        )
    }
}

/// 失败原因 —— 决定"自动重试"还是"终态"。
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FailReason {
    /// 链路断开 / 无可用链路。
    LinkDown,
    /// 分片或完成等待超时。
    Timeout,
    /// 只收了一半（字节不全）。
    Partial,
    /// 完整字节的 SHA-256 不符。
    HashMismatch,
    /// 来源不再持有该内容（文件被清理 / 重启后丢失）。
    SourceGone,
    /// 对端版本不支持内容拉取。
    Unsupported,
    /// 本地问题（路径/权限/磁盘）。
    Local,
}

impl FailReason {
    /// 可恢复 ⇒ Incomplete；否则 ⇒ Rejected。
    pub fn retryable(self) -> bool {
        matches!(
            self,
            FailReason::LinkDown | FailReason::Timeout | FailReason::Partial | FailReason::Local
        )
    }
    pub fn code(self) -> &'static str {
        match self {
            FailReason::LinkDown => "link_down",
            FailReason::Timeout => "timeout",
            FailReason::Partial => "partial",
            FailReason::HashMismatch => "hash_mismatch",
            FailReason::SourceGone => "source_gone",
            FailReason::Unsupported => "unsupported",
            FailReason::Local => "local",
        }
    }
    /// 面向用户的短句（前端直接显示，不再自己拼）。
    pub fn message(self) -> &'static str {
        match self {
            FailReason::LinkDown => "对方不在线，联网后自动继续",
            FailReason::Timeout => "网络不佳，正在自动重试",
            FailReason::Partial => "传输未完成，可点击重试",
            FailReason::HashMismatch => "数据校验失败，可点击重新获取",
            FailReason::SourceGone => "对方已没有这份文件",
            FailReason::Unsupported => "对方版本不支持重新获取",
            FailReason::Local => "本机保存失败，可点击重试",
        }
    }
}

/// 一条内容传输记录（持久化与内存同构）。可序列化给前端做统一状态展示。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransferRecord {
    pub cid: ContentId,
    /// 单聊对端 device_id；群文件是 group_id，另见 group_id 字段。
    pub peer_id: String,
    pub group_id: Option<String>,
    pub name: String,
    pub size: u64,
    pub direction: Direction,
    pub status: TransferStatus,
    /// 已接收 / 已发出的字节数（续传依据）。
    pub received: u64,
    /// 已尝试次数（退避依据）。
    pub attempts: u32,
    pub next_attempt_at: i64,
    pub last_error: Option<String>,
    pub path: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_round_trips_and_classifies() {
        for s in [
            TransferStatus::Queued,
            TransferStatus::Active,
            TransferStatus::Verifying,
            TransferStatus::Complete,
            TransferStatus::Incomplete,
            TransferStatus::Rejected,
        ] {
            assert_eq!(TransferStatus::parse(s.as_str()), Some(s));
            assert_eq!(serde_json::to_string(&s).unwrap(), format!("\"{}\"", s.as_str()));
        }
        assert!(TransferStatus::Complete.is_terminal());
        assert!(TransferStatus::Rejected.is_terminal());
        assert!(!TransferStatus::Incomplete.is_terminal());
        assert!(TransferStatus::Incomplete.is_resumable());
        assert!(!TransferStatus::Complete.is_resumable());
    }

    #[test]
    fn fail_reason_separates_retryable_from_terminal() {
        for r in [FailReason::LinkDown, FailReason::Timeout, FailReason::Partial, FailReason::Local] {
            assert!(r.retryable(), "{r:?} 应可恢复");
        }
        for r in [FailReason::HashMismatch, FailReason::SourceGone, FailReason::Unsupported] {
            assert!(!r.retryable(), "{r:?} 应是终态");
        }
        assert!(!FailReason::HashMismatch.message().is_empty());
    }
}
