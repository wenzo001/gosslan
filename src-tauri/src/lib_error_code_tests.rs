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
    // ── 群管理（本笔）──────────────────────────────────────────────────
    ("GROUP_NOT_FOUND", "commands/groups.rs", "群不存在"),
    ("GROUP_NOT_FOUND", "commands/group_files.rs", "群不存在"),
    ("GROUP_NOT_FOUND", "commands/group_announcements.rs", "群不存在"),
    ("GROUP_NOT_FOUND", "commands/window.rs", "群不存在"),
    ("GROUP_NOT_FOUND", "commands/chat.rs", "群不存在"),
    ("GROUP_SELF_NOT_MEMBER", "commands/group_files.rs", "你已不在该群中"),
    ("GROUP_SELF_NOT_MEMBER", "commands/window.rs", "你已不在该群中"),
    ("GROUP_SELF_NOT_MEMBER", "commands/group_announcements.rs", "你不是该群成员"),
    ("GROUP_NAME_EMPTY", "commands/groups.rs", "群名称不能为空"),
    ("GROUP_KEY_MISSING", "commands/groups.rs", "群密钥缺失"),
    ("GROUP_KEY_MISSING", "commands/group_announcements.rs", "群密钥缺失"),
    ("GROUP_KEY_MISSING", "commands/window.rs", "群密钥缺失"),
    ("NUDGE_GROUP_UNSUPPORTED", "commands/window.rs", "窗口抖动只支持单聊"),
    ("MSG_NOT_FOUND", "commands/group_files.rs", "要提醒的消息不存在"),
    ("MSG_NOT_FOUND", "commands/group_announcements.rs", "消息不存在"),
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
        if src.contains(&short) || src.contains(&full) {
            continue;
        }
        // 包了一层日志助手（`coded(CODE, reject(... , "原文"))`）时，码与原文之间隔着
        // `reject(`。这时只要求"同一段表达式里两个事实都在" —— 窗口 400 字符足够覆盖
        // 一个 reject 调用的全部参数，又短到串不进下一条无关分支。
        let marker_short = format!("coded({code},");
        let marker_full = format!("coded(crate::error_codes::{code},");
        let Some(at) = src
            .find(&marker_full)
            .or_else(|| src.find(&marker_short))
        else {
            panic!("{rel} 里找不到 `coded({code}, …)`：这个触发点没带码");
        };
        // 按字符截断，别在中文 UTF-8 字节中间切（切片会 panic）。
        let window: String = src[at..].chars().take(400).collect();
        assert!(
            window.contains(&format!("\"{human}\"")),
            "{rel} 里 `coded({code}, …)` 之后 400 字符内找不到原文 \"{human}\"：码带了，但 human 被改了或换了分支"
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
