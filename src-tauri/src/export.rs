//! 聊天记录导出（纯文字）。
//!
//! 定位：**磁盘满时的自救手段**。存储清理只删媒体、不动文字，但一旦数据库损坏或
//! 用户要迁机，没有导出入口就只能看着数据丢。因此这里只做"把文字安全地落到一个
//! 用户能打开的文件里"这一件事，不追求完整备份（媒体另说）。
//!
//! 为什么导出 Markdown 而不是 HTML：消息正文来自**对端**。导出成 HTML 再用浏览器
//! 打开，等于让对端的内容在本机执行脚本——这是一条我们自己造出来的 XSS 通道。
//! Markdown/纯文本在任何编辑器里都能读，且不存在执行语义。
//!
//! 本模块的渲染与时间换算都是纯函数，便于单测（不依赖 `AppState` / 文件系统）。

use std::collections::HashMap;

use crate::db;
use crate::state::{Conversation, MessageRecord};

/// 导出摘要，回给前端做"导出了多少条"的反馈。
#[derive(serde::Serialize)]
pub struct ExportSummary {
    /// 写入的会话数（只统计有消息的会话）
    pub conversations: usize,
    /// 写入的消息条数
    pub messages: usize,
    /// 实际落盘路径
    pub path: String,
}

/// 导出渲染用的消息视图：与 `MessageRecord` 解耦，纯函数只认这几个字段，便于单测。
pub struct ExportMessage {
    /// 显示名："我" 或对端昵称
    pub who: String,
    /// epoch 毫秒
    pub ts: i64,
    /// 已转成纯文本的正文（非文本消息为 `[图片] 名字` 这类占位）
    pub body: String,
}

/// 把一条消息的 `kind + content` 转成导出用的纯文本正文。
///
/// 图片 / 文件消息的 `content` 是 JSON 元数据（name/size/subtype），只保留文件名——
/// 导出的是文字记录，媒体本体不在文件里，写路径既无用又可能泄露本机目录结构。
pub fn message_body(kind: &str, content: &str) -> String {
    match kind {
        "text" | "code" => content.to_string(),
        "image" => {
            let name = json_str_field(content, "name");
            match name {
                Some(n) => format!("[图片] {n}"),
                None => "[图片]".to_string(),
            }
        }
        "file" => {
            let name = json_str_field(content, "name");
            let size = content
                .parse::<serde_json::Value>()
                .ok()
                .and_then(|v| v.get("size").and_then(|s| s.as_u64()));
            match (name, size) {
                (Some(n), Some(s)) => format!("[文件] {n} ({})", human_size(s)),
                (Some(n), None) => format!("[文件] {n}"),
                (None, _) => "[文件]".to_string(),
            }
        }
        other => format!("[{other}]"),
    }
}

fn json_str_field(content: &str, key: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(content)
        .ok()
        .and_then(|v| v.get(key).and_then(|x| x.as_str()).map(|s| s.to_string()))
}

/// 人类可读体积。与前端 `humanSize` 保持同一档位口径（B/KB/MB/GB）。
fn human_size(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    let b = bytes as f64;
    if b < KB {
        return format!("{bytes} B");
    }
    if b < KB * KB {
        return format!("{:.1} KB", b / KB);
    }
    if b < KB * KB * KB {
        return format!("{:.1} MB", b / (KB * KB));
    }
    format!("{:.2} GB", b / (KB * KB * KB))
}

/// epoch 毫秒 + UTC 偏移（分钟）→ `YYYY-MM-DD HH:MM`。
///
/// 不引入时区库（`AI_RULES §25` 依赖审慎）：偏移由前端 `getTimezoneOffset()` 给出。
/// 代价是**跨夏令时切换的历史消息可能有 1 小时偏差**——对一个"先把文字抢救出来"的
/// 导出功能可以接受，但必须在文档里写明，不能假装精确。
pub fn format_local_time(ms: i64, utc_offset_minutes: i64) -> String {
    let (y, mo, d, h, mi) = civil_from_ms(ms, utc_offset_minutes);
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}")
}

/// epoch 毫秒 + UTC 偏移（分钟）→ (年, 月, 日, 时, 分)。
fn civil_from_ms(ms: i64, utc_offset_minutes: i64) -> (i64, u32, u32, u32, u32) {
    let local = ms + utc_offset_minutes * 60_000;
    let days = local.div_euclid(86_400_000);
    let ms_of_day = local.rem_euclid(86_400_000);
    let (y, mo, d) = civil_from_days(days);
    (
        y,
        mo,
        d,
        (ms_of_day / 3_600_000) as u32,
        ((ms_of_day % 3_600_000) / 60_000) as u32,
    )
}

/// Howard Hinnant 的 `civil_from_days`：自 1970-01-01 起的天数 → 公历年月日。
/// 纯整数运算，对负数天数（1970 年之前）也正确。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 渲染整份导出文件。
pub fn render_markdown(
    device_name: &str,
    generated_at: &str,
    sections: &[(String, Vec<ExportMessage>)],
    utc_offset_minutes: i64,
) -> String {
    let total: usize = sections.iter().map(|(_, m)| m.len()).sum();
    let mut out = String::with_capacity(1024 + total * 120);
    out.push_str("# Gosslan 聊天记录\n\n");
    out.push_str(&format!("- 导出时间：{generated_at}\n"));
    out.push_str(&format!("- 本机设备：{device_name}\n"));
    out.push_str(&format!("- 消息条数：{total}\n"));
    out.push_str(
        "\n> 本文件只包含聊天文字。图片与文件消息仅保留文件名，媒体本体不在导出内容中。\n",
    );

    for (title, messages) in sections {
        out.push_str("\n---\n\n");
        out.push_str(&format!("## {title}\n\n"));
        if messages.is_empty() {
            out.push_str("_（本会话没有文字记录）_\n");
            continue;
        }
        for m in messages {
            out.push_str(&format!(
                "**{} · {}**\n\n",
                format_local_time(m.ts, utc_offset_minutes),
                m.who
            ));
            // 正文整体缩进不做处理：Markdown 里正文保持原样即可读；
            // 多行文本（代码消息）原样写入，用户看到的就是自己发过的内容。
            out.push_str(&m.body);
            out.push_str("\n\n");
        }
    }
    out
}

/// 会话在导出文件里的标题。群聊用原名，单聊优先好友昵称、退回会话名、最后退回 ID。
fn conversation_title(conv: &Conversation, nickname: &HashMap<String, String>) -> String {
    if conv.kind == "group" {
        let name = conv.name.trim();
        return if name.is_empty() {
            format!("群聊 {}", conv.id)
        } else {
            format!("群聊「{name}」")
        };
    }
    let name = nickname
        .get(&conv.id)
        .map(|s| s.as_str())
        .unwrap_or_else(|| conv.name.trim());
    if name.is_empty() {
        // 昵称与会话名都拿不到时退回设备 ID，至少让用户知道这是跟谁的记录。
        format!("与 {} 的对话", conv.id)
    } else {
        format!("与 {name} 的对话")
    }
}

/// 从数据库把导出所需的内容读出来，返回（会话标题, 该会话消息）列表。
///
/// 与渲染分开的原因：读库需要持锁，而渲染 + 写盘可能耗时较长（几十万条消息）。
/// 调用方应在**读完即释放锁**，不要让一次导出把消息落库卡住。
///
/// 会话按 `list_conversations` 的顺序（最近活跃在前）输出，与用户在列表里看到的一致。
pub fn collect_sections(
    conn: &rusqlite::Connection,
    my_device_id: &str,
) -> Result<Vec<(String, Vec<ExportMessage>)>, String> {
    // 导出内容里出现的所有发送者昵称，一次性取表，避免每条消息都查一次库。
    let mut nickname: HashMap<String, String> = HashMap::new();
    for f in db::list_friends(conn).map_err(|e| e.to_string())? {
        nickname.insert(f.device_id, f.nickname);
    }

    let conversations = db::list_conversations(conn).map_err(|e| e.to_string())?;
    let mut sections: Vec<(String, Vec<ExportMessage>)> = Vec::new();
    for conv in &conversations {
        // LIMIT -1 = 不限量（SQLite 语义）。导出必须完整，不能像列表那样分页。
        let rows: Vec<MessageRecord> =
            db::get_messages(conn, &conv.id, -1, 0).map_err(|e| e.to_string())?;
        let messages: Vec<ExportMessage> = rows
            .into_iter()
            .map(|m| ExportMessage {
                who: if m.sender_id == my_device_id {
                    "我".to_string()
                } else {
                    nickname
                        .get(&m.sender_id)
                        .cloned()
                        .unwrap_or_else(|| m.sender_id.clone())
                },
                ts: m.ts,
                body: message_body(&m.kind, &m.content),
            })
            .collect();
        if messages.is_empty() {
            // 没有消息的空会话不占篇幅（否则"清除聊天数据"后导出一堆空标题）。
            continue;
        }
        sections.push((conversation_title(conv, &nickname), messages));
    }
    Ok(sections)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_local_time_matches_known_instants() {
        // 时间戳一律用 `date -u -j -f "%Y-%m-%d %H:%M:%S" "<UTC>" +%s` 取得后 ×1000，
        // 不要手算——手算极易错一天（本文件的第一个版本就写错过）。
        assert_eq!(format_local_time(0, 0), "1970-01-01 00:00");
        // 东八区：同一时刻显示 08:00
        assert_eq!(format_local_time(0, 480), "1970-01-01 08:00");
        // 西五区：回到前一天
        assert_eq!(format_local_time(0, -300), "1969-12-31 19:00");
        // 2026-09-10 09:05:00 UTC = 1789031100s → 东八区 17:05
        assert_eq!(format_local_time(1_789_031_100_000, 480), "2026-09-10 17:05");
        // 负偏移跨日：同一时刻在西五区是 04:05
        assert_eq!(format_local_time(1_789_031_100_000, -300), "2026-09-10 04:05");
    }

    #[test]
    fn format_local_time_handles_leap_day_and_year_rollover() {
        // 2024-02-29 12:00:00 UTC = 1709208000s（闰日）
        assert_eq!(format_local_time(1_709_208_000_000, 0), "2024-02-29 12:00");
        // 2025-12-31 23:59:00 UTC = 1767225540s，加东八区后应跨到 2026-01-01
        assert_eq!(format_local_time(1_767_225_540_000, 480), "2026-01-01 07:59");
    }

    #[test]
    fn message_body_keeps_text_and_code_verbatim() {
        assert_eq!(message_body("text", "下午三点开会"), "下午三点开会");
        assert_eq!(message_body("code", "fn main() {}"), "fn main() {}");
    }

    #[test]
    fn message_body_summarises_media_without_dumping_paths() {
        let img = r#"{"name":"截图.png","path":"/Users/wd/Downloads/截图.png","size":2048,"subtype":"image"}"#;
        assert_eq!(message_body("image", img), "[图片] 截图.png");
        assert!(
            !message_body("image", img).contains("/Users/wd"),
            "导出文件不得泄露本机目录结构"
        );

        let file = r#"{"name":"合同.pdf","path":"/Users/wd/Downloads/合同.pdf","size":1048576}"#;
        assert_eq!(message_body("file", file), "[文件] 合同.pdf (1.0 MB)");
    }

    #[test]
    fn message_body_survives_broken_metadata() {
        assert_eq!(message_body("image", "not-json"), "[图片]");
        assert_eq!(message_body("file", "{}"), "[文件]");
        assert_eq!(message_body("system", "对方已上线"), "[system]");
    }

    #[test]
    fn rendered_markdown_contains_sections_and_headers() {
        let sections = vec![
            (
                "与 张三 的对话".to_string(),
                vec![
                    ExportMessage {
                        who: "我".to_string(),
                        ts: 0,
                        body: "你好".to_string(),
                    },
                    ExportMessage {
                        who: "张三".to_string(),
                        ts: 60_000,
                        body: "[图片] a.png".to_string(),
                    },
                ],
            ),
            ("群聊「项目组」".to_string(), vec![]),
        ];
        let md = render_markdown("wd 的 MacBook", "2026-09-10 17:30", &sections, 480);

        assert!(md.starts_with("# Gosslan 聊天记录"));
        assert!(md.contains("与 张三 的对话"));
        assert!(md.contains("群聊「项目组」"));
        assert!(md.contains("**1970-01-01 08:00 · 我**"));
        assert!(md.contains("你好"));
        assert!(md.contains("[图片] a.png"));
        // 空会话明确说明，而不是留一个空白标题让人以为导出漏了
        assert!(md.contains("（本会话没有文字记录）"));
        // 条数统计与实际一致
        assert!(md.contains("消息条数：2"));
    }
}
