// B6 试点批：命令返回值里的错误码（**只加码，不改 human**）。
//
// 这一批的契约是"码 + 原中文"，所以每条证据只守两件事：
// ① 产出点真的把码和那句原文绑在同一个 `coded(...)` 调用里（有人只改文案不带码 ⇒ 红）；
// ② `coded()` 的形状能被前端 `errorCode()` 解析（`code=<大写蛇形> 空格 <人话>`）。
//
// 为什么是源码守卫：这些分支要真触发得先有一份完整的 `AppState` + 特定的库/磁盘/射频状态，
// 本仓现有夹具到不了；而它们唯一会静默坏掉的地方就是"码在、但没跟原文绑在一起"。
// 触发条件 → 码 的对照写在下表里（命令、原文、码），人一眼能核对。

/// `(码, 相对 src/ 的文件, 原中文 human)`。
const B6_CASES: &[(&str, &str, &str)] = &[
    // ── 好友/消息（本笔）────────────────────────────────────────────────
    ("MSG_NOT_FOUND", "commands/chat.rs", "消息不存在"),
    ("MSG_NOT_FOUND", "commands/chat.rs", "要提醒的消息不存在"),
    ("MSG_NOT_FOUND", "commands/chat.rs", "要撤回的消息不存在"),
    ("MSG_NOT_FOUND", "commands/chat.rs", "要切换的消息不存在"),
    ("MSG_NOT_FOUND", "commands/files.rs", "消息不存在"),
    ("MSG_NOT_FOUND", "commands/helpers.rs", "消息不存在"),
    ("MSG_NOT_IN_CONV", "commands/chat.rs", "消息不属于该会话"),
    ("MSG_NOT_IN_CONV", "protocol.rs", "消息不属于该会话"),
    ("E2EE_ENCRYPT_FAILED", "commands/chat.rs", "密钥交换失败"),
    ("E2EE_ENCRYPT_FAILED", "commands/chat.rs", "加密失败"),
    ("E2EE_ENCRYPT_FAILED", "commands/mobile_picker.rs", "密钥交换失败"),
    ("E2EE_ENCRYPT_FAILED", "commands/mobile_picker.rs", "加密失败"),
];

fn read_src(rel: &str) -> String {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join(rel);
    std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("读不到 {}：{e}", p.display()))
}

/// 去掉全部空白后比对，避免 rustfmt 把 `coded(a, b)` 拆行导致判据失明。
fn flat(src: &str) -> String {
    src.split_whitespace().collect()
}

#[test]
fn b6_codes_are_bound_to_the_original_human_text() {
    for (code, rel, human) in B6_CASES {
        let src = flat(&read_src(rel));
        // 两种写法都算：文件的 `use` 风格不同（有的全限定、有的先 use 再简写），
        // 但"码与原文绑在同一个调用里"这件事实不变。
        let short = format!("coded({code},\"{human}\"");
        let full = format!("coded(crate::error_codes::{code},\"{human}\"");
        assert!(
            src.contains(&short) || src.contains(&full),
            "{rel} 里找不到 `coded({code}, \"{human}\")`：这个触发点要么没带码，要么原文被改掉了"
        );
    }
}

#[test]
fn b6_codes_have_no_duplicate_names_and_are_defined_once() {
    let defs = read_src("error_codes.rs");
    for (code, _, _) in B6_CASES {
        assert_eq!(
            defs.matches(&format!("pub const {code}: &str = \"{code}\";"))
                .count(),
            1,
            "{code} 必须在 error_codes.rs 里恰好定义一次"
        );
    }
}

#[test]
fn coded_shape_is_code_space_human() {
    let out = crate::error_codes::coded(crate::error_codes::MSG_NOT_FOUND, "消息不存在");
    assert_eq!(out, "code=MSG_NOT_FOUND 消息不存在");
    assert!(
        out.strip_prefix("code=").unwrap().starts_with("MSG_NOT_FOUND "),
        "前端 errorCode() 的判据是 /code=([A-Z0-9_]+)/，码与人话之间必须有空格才切得开"
    );
}
