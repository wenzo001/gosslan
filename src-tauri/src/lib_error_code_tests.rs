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
    // ── B6 第二批：好友申请（本笔）──────────────────────────────────────
    ("FRIEND_SELF_REQUEST", "commands/mobile_picker.rs", "不能向自己发送好友申请"),
    ("FRIEND_ACCEPT_FAILED", "commands/mobile_picker.rs", "同意好友申请失败，请重试"),
    ("FRIEND_REQUEST_GONE", "commands/mobile_picker.rs", "好友申请不存在或已被对方撤回"),
    ("FRIEND_REQUEST_GONE", "commands/mobile_picker.rs", "好友申请不存在或已处理"),
    ("FRIEND_INVALID_CONTACT", "commands/mobile_picker.rs", "无效的联系人"),
    ("FRIEND_ALREADY_FRIEND", "commands/mobile_picker.rs", "已经是好友，无法撤回好友申请"),
    // ── B6 第三批：消息/会话（本笔）─────────────────────────────────────
    ("CANCEL_SELF_CHAT_UNSUPPORTED", "commands/chat.rs", "自聊消息不支持取消"),
    ("CANCEL_NOT_OWN_MESSAGE", "commands/chat.rs", "只能取消自己发送的消息"),
    ("CANCEL_FILE_USE_TRANSFER", "commands/chat.rs", "文件/图片请用「取消发送」的传输通道"),
    ("GROUP_RESEND_ONLY_FOR_GROUPS", "commands/chat.rs", "只有群消息支持按成员补发"),
    ("GROUP_RESEND_NOT_OWN", "commands/chat.rs", "只能补发自己在该群发送的消息"),
    ("RECALL_OWN_CONV_UNSUPPORTED", "commands/chat.rs", "不能撤回自己会话里的消息"),
    ("RENDER_UNSUPPORTED", "commands/chat.rs", "不支持的渲染方式"),
    ("RENDER_SELF_ONLY", "commands/chat.rs", "只能切换自己发送的消息"),
    ("RENDER_TEXT_CODE_ONLY", "commands/chat.rs", "只有文本/代码消息可以切换渲染"),
    ("RENDER_RECALLED", "commands/chat.rs", "已撤回的消息不能切换"),
    ("NUDGE_SELF_UNSUPPORTED", "commands/chat.rs", "不能对自己发起窗口抖动"),
    ("MESSAGE_KIND_UNSUPPORTED", "commands/chat.rs", "不支持的消息类型"),
    ("NUDGE_MISSING", "commands/chat.rs", "对应的强提醒不存在"),
    ("RESEND_USE_GROUP_DELIVERY", "commands/chat.rs", "群消息请用「按成员补发」"),
    ("RESEND_SELF_CHAT_UNNEEDED", "commands/chat.rs", "自聊消息不需要重发"),
    ("RESEND_SELF_ONLY", "commands/chat.rs", "只能重发自己发送的消息"),
    ("RESEND_KIND_UNSUPPORTED", "commands/chat.rs", "这种消息不支持原地重发"),
    ("RESEND_NOT_FAILED", "commands/chat.rs", "这条消息不是失败/已取消状态，不需要重发"),
    ("RESEND_ALREADY_DELIVERED", "commands/chat.rs", "这条消息已经送达或状态已变，不能重发"),
    ("SELF_CHAT_NO_MEDIA", "commands/chat.rs", "和自己聊天暂不支持图片或文件"),
    // ── B6 第四批：群管理（本笔）───────────────────────────────────────
    ("GROUP_INVITE_FRIENDS_ONLY", "commands/groups.rs", "只能把好友加入群聊"),
    ("GROUP_RENAME_OWNER_ONLY", "commands/groups.rs", "只有群创建者可以修改群名称"),
    ("GROUP_ADD_MEMBER_OWNER_ONLY", "commands/groups.rs", "只有群创建者可以添加成员"),
    ("GROUP_MEMBER_ALREADY_IN", "commands/groups.rs", "该成员已在群中"),
    ("GROUP_ADD_FRIEND_MEMBER_ONLY", "commands/groups.rs", "只能添加好友入群"),
    ("GROUP_REMOVE_OWNER_ONLY", "commands/groups.rs", "只有群创建者可以移除成员"),
    ("GROUP_REMOVE_SELF", "commands/groups.rs", "不能移除自己"),
    ("GROUP_MEMBER_NOT_IN", "commands/groups.rs", "该成员不在群中"),
    ("GROUP_TRANSFER_OWNER_ONLY", "commands/groups.rs", "只有群创建者可以转让群主"),
    ("GROUP_TRANSFER_TO_SELF", "commands/groups.rs", "不能把群主转让给自己"),
    ("GROUP_TRANSFER_MEMBER_ONLY", "commands/groups.rs", "只能转让给群成员"),
    ("GROUP_OWNER_LEAVE_TRANSFER_FIRST", "commands/groups.rs", "群主退群前请先转让群主"),
    ("GROUP_FILE_KIND_UNSUPPORTED", "commands/group_files.rs", "群聊不支持该消息类型"),
    ("GROUP_TODO_TYPE_NAME_EMPTY", "commands/group_files.rs", "自定义类型名称不能为空"),
    ("GROUP_TODO_TYPE_ICON_INVALID", "commands/group_files.rs", "自定义类型图标不合法"),
    ("GROUP_TODO_TYPE_INVALID", "commands/group_files.rs", "任务类型不合法"),
    ("GROUP_TODO_TITLE_EMPTY", "commands/group_files.rs", "任务标题不能为空"),
    ("GROUP_TODO_ASSIGNEE_REQUIRED", "commands/group_files.rs", "请至少指派一名成员"),
    ("GROUP_TODO_STATUS_INVALID", "commands/group_files.rs", "任务状态不合法"),
    ("GROUP_TODO_PRIORITY_INVALID", "commands/group_files.rs", "任务优先级不合法"),
    ("GROUP_ANNOUNCEMENT_EMPTY", "commands/group_files.rs", "公告内容不能为空"),
    ("GROUP_ANNOUNCEMENT_ID_MISSING", "commands/group_files.rs", "公告标识缺失"),
    ("GROUP_REPLY_TARGET_MISSING", "commands/group_announcements.rs", "缺少目标消息"),
    ("GROUP_REPLY_TARGET_MISSING", "commands/group_announcements.rs", "回应缺少目标消息"),
    ("GROUP_REACTION_UNKNOWN", "commands/group_announcements.rs", "不认识的表情"),
    ("GROUP_FORWARD_FILE_NOT_OWNED", "commands/group_announcements.rs", "这个文件不属于这条消息，已拒绝转发"),
    ("GROUP_FILE_ONLY_PLAIN", "commands/group_announcements.rs", "只能发送普通文件"),
    ("GROUP_NO_OTHER_MEMBERS", "commands/group_announcements.rs", "群内没有其他成员"),
    ("GROUP_MEDIA_NOT_FILE", "commands/group_todo_media.rs", "不是文件"),
    ("GROUP_IMAGE_BYTES_INVALID", "commands/group_todo_media.rs", "图片数据格式不正确"),
    ("GROUP_IMAGE_EMPTY", "commands/group_todo_media.rs", "图片数据为空"),
    ("GROUP_IMAGE_PASTE_ONLY", "commands/group_todo_media.rs", "只支持粘贴图片"),
    // ── B6 第五批：收藏（本笔）─────────────────────────────────────────
    ("FAVORITE_EXPORT_PATH_EMPTY", "commands/favorites.rs", "导出路径为空"),
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
    ("chat.rs", "cancel_message", 0),
    ("chat.rs", "recall_message", 0),
    ("chat.rs", "set_message_render", 0),
    ("chat.rs", "send_message", 0),
    ("chat.rs", "resend_message", 0),
    ("chat.rs", "mark_read", 0),
    ("files.rs", "open_file_native", 0),
    ("files.rs", "request_content", 1),
    ("files.rs", "send_file_auto", 1),
    ("group_files.rs", "send_group_message", 2),
    ("group_files.rs", "send_group_todo", 2),
    ("group_files.rs", "update_group_todo", 4),
    ("group_files.rs", "send_group_announcement", 2),
    ("group_files.rs", "delete_group_announcement", 1),
    ("mobile_picker.rs", "send_friend_request", 0),
    ("mobile_picker.rs", "respond_friend_request", 0),
    ("mobile_picker.rs", "cancel_friend_request", 0),
    ("groups.rs", "rename_group", 0),
    ("groups.rs", "group_add_member", 0),
    ("groups.rs", "group_remove_member", 0),
    ("groups.rs", "transfer_group_creator", 0),
    ("groups.rs", "leave_group", 0),
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
