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
    // ── 文件 / 设置 / 窗口（本笔）──────────────────────────────────────
    ("FILE_NOT_FOUND", "commands/helpers.rs", "文件不存在"),
    ("FILE_NOT_FOUND", "commands/helpers.rs", "文件不存在或不可访问：{path}"),
    ("FILE_NOT_FOUND", "commands/favorites.rs", "文件不存在"),
    ("FILE_NOT_FOUND", "commands/group_announcements.rs", "文件不存在或不可读：{e}"),
    ("FILE_NOT_FOUND", "open_path.rs", "文件不存在：{}"),
    ("CHANNEL_UNKNOWN", "commands/channel.rs", "未知通道: {channel}"),
];

/// human 是下层原话、没有字面量的触发点：只守"码真的挂在这里"，
/// 原文必须原样透传（由 `b6_does_not_stack_codes` 与 `coded_if_uncoded` 一起兜）。
const B6_DYNAMIC_HUMAN: &[(&str, &str)] = &[
    ("FILE_NOT_FOUND", "commands/files.rs"), // canonicalize 的 OS 原话
    ("TRANSPORT_START_FAILED", "commands/channel.rs"),
];

/// B6 白名单命令的"未带码 return Err"存量基线（只减不增）。
///
/// 只守这 20 条试点命令，其余命令一律不参与 —— 免得一次全红。
/// 新增一条裸 `return Err(...)` 会让该命令的数字超过基线 ⇒ 红；
/// 把存量逐条补码后请**下调**对应数字（不允许上调）。
const B6_COMMAND_UNCODED_BASELINE: &[(&str, &str, usize)] = &[
    ("chat.rs", "cancel_message", 3),
    ("chat.rs", "recall_message", 1),
    ("chat.rs", "set_message_render", 4),
    ("chat.rs", "send_message", 6),
    ("chat.rs", "mark_read", 0),
    ("files.rs", "open_file_native", 0),
    ("files.rs", "request_content", 1),
    ("files.rs", "send_file_auto", 1),
    ("group_files.rs", "send_group_message", 3),
    ("group_files.rs", "send_group_todo", 4),
    ("group_files.rs", "update_group_todo", 8),
    ("group_files.rs", "send_group_announcement", 3),
    ("group_files.rs", "delete_group_announcement", 2),
    ("mobile_picker.rs", "send_friend_request", 1),
    ("mobile_picker.rs", "respond_friend_request", 1),
    ("mobile_picker.rs", "cancel_friend_request", 2),
    ("groups.rs", "rename_group", 1),
    ("groups.rs", "group_add_member", 3),
    ("groups.rs", "group_remove_member", 3),
    ("groups.rs", "transfer_group_creator", 3),
    ("groups.rs", "leave_group", 1),
    ("channel.rs", "set_channel_enabled", 0),
    ("helpers.rs", "copy_file_to_clipboard", 0),
    ("helpers.rs", "save_media_as", 3),
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
        // human 也可能自带空格（`format!("未知通道: {channel}")`），而 `flat` 连字面量里的
        // 空白一起吃掉 ⇒ 比对用的 needle 必须同样 flatten，否则测的是空白而不是绑定。
        let human_flat: String = human.split_whitespace().collect();
        // 两种写法都算：文件的 `use` 风格不同（有的全限定、有的先 use 再简写），
        // 但"码与原文绑在同一个调用里"这件事实不变。
        let short = format!("coded({code},\"{human_flat}\"");
        let full = format!("coded(crate::error_codes::{code},\"{human_flat}\"");
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
            window.contains(&format!("\"{human_flat}\"")),
            "{rel} 里 `coded({code}, …)` 之后 400 字符内找不到原文 \"{human}\"：码带了，但 human 被改了或换了分支"
        );
    }
}

#[test]
fn b6_codes_have_no_duplicate_names_and_are_defined_once() {
    let defs = read_src("error_codes.rs");
    let mut codes: Vec<&str> = B6_CASES.iter().map(|(code, _, _)| *code).collect();
    codes.extend(B6_DYNAMIC_HUMAN.iter().map(|(code, _)| *code));
    codes.sort_unstable();
    codes.dedup();
    for code in codes {
        assert_eq!(
            defs.matches(&format!("pub const {code}: &str = \"{code}\";"))
                .count(),
            1,
            "{code} 必须在 error_codes.rs 里恰好定义一次"
        );
    }
}

/// human 是下层原话、没有字面量的触发点：只守"码真的挂在这里"，
/// 原文由 `coded_if_uncoded` 原样透传（不许自己造一句中文去顶替 OS / 通道原话）。
#[test]
fn b6_dynamic_human_sites_carry_the_code() {
    for (code, rel) in B6_DYNAMIC_HUMAN {
        let src = flat(&read_src(rel));
        let markers = [
            format!("coded({code},"),
            format!("coded(crate::error_codes::{code},"),
            format!("coded_if_uncoded({code},"),
            format!("coded_if_uncoded(crate::error_codes::{code},"),
        ];
        assert!(
            markers.iter().any(|m| src.contains(m)),
            "{rel} 里找不到把 {code} 挂到下层原话上的调用：这一格要么没带码，要么把下层原话改写了"
        );
    }
}

/// `coded_if_uncoded` 的核心契约：**不许套码**（内层已经带码就原样放行）。
#[test]
fn b6_does_not_stack_codes() {
    use crate::error_codes::{coded_if_uncoded, TRANSPORT_START_FAILED};
    let inner = "code=PORT_IN_USE 端口已占用";
    assert_eq!(
        coded_if_uncoded(TRANSPORT_START_FAILED, inner),
        inner,
        "内层已经带码时不许再套一层 —— 否则前端只认最外层，真原因（端口被占）被吃掉"
    );
    assert_eq!(
        coded_if_uncoded(TRANSPORT_START_FAILED, "适配器未开启"),
        "code=TRANSPORT_START_FAILED 适配器未开启",
        "没有码时才补本层的码，human 原文一字不动"
    );
}

/// 数一个函数体里**未带码**的 `return Err(...)`。
///
/// 只认 `return Err`：`?` 与 `.map_err(...)` 是**下层**的出口，那部分由调用链上游负责，
/// 审这一格会把所有透传都误算成本命令自己造的错。
fn count_uncoded_return_err(body: &str) -> usize {
    let body = flat(body);
    let total = body.matches("returnErr(").count();
    let coded = body.matches("returnErr(crate::error_codes::coded(").count()
        + body.matches("returnErr(coded(").count();
    total.saturating_sub(coded)
}

/// 「新命令返回 `Err` 必须带码」的**白名单版**静态护栏。
///
/// 为什么只守这 20 条、且用存量基线：168 条命令里绝大多数还没补码，一次全红只会催生
/// `--no-verify`（那等于把门禁关掉）。这条守的是「本批之后**新增**的裸 `return Err`」——
/// 反例自证：给任意一条基线命令手写一个 `return Err("…")`，数字立刻越线变红。
/// 数字只许**下调**（把存量补成带码时，同步把这里改小），不许上调。
#[test]
fn new_err_in_pilot_commands_must_carry_a_code() {
    for (file, name, baseline) in B6_COMMAND_UNCODED_BASELINE {
        let src = read_src(&format!("commands/{file}"));
        let body = rust_fn_body(&src, &format!("pub async fn {name}("));
        let uncoded = count_uncoded_return_err(&body);
        assert_eq!(
            uncoded, *baseline,
            "{file}::{name} 的未带码 `return Err` 是 {uncoded}，基线写着 {baseline}：\n\
             · 新加的错误必须用 `coded(码, 原文)`；\n\
             · 把存量补成带码时，同步把本表的数字**改小**（只许下调）。"
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
