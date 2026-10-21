/**
 * 强提醒「接收 → 提醒 → 点击定位」链路的形状判据（第 3 阶段）。
 *
 * 算法（折叠/紧急判定）在 reminders.test.ts / notifyUrgency.test.ts 里逐条判；
 * 这里判的是**接线**：受众门控、S3 回执与本地通知解耦、抑制矩阵、移动端通道与
 * 权限、点击载荷把 msg_id 带到定位链。系统级副作用（真通知/振动/Dock）在 node 侧
 * 跑不起来，静态读源码是本仓对这类链路的标准做法（见 channelState.test.ts）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const srcDir = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(srcDir, p), "utf8");

test("onMessage：remind 走专门通道，其它消息才走普通通知", () => {
  const store = read("stores/useChatStore.ts");
  assert.match(
    store,
    /if \(rec\.kind === "remind"\) handleIncomingRemind\(rec\);\s*\n\s*else maybeNotify\(rec\);/,
    "remind 必须走 handleIncomingRemind；remind_ack/普通消息走 maybeNotify（ack 绝不能弹通知）",
  );
});

test("接收门控：群聊先判 actors 名单，再以当前成员表复核（R6 被移出群不提醒）", () => {
  const store = read("stores/useChatStore.ts");
  const at = store.indexOf("function handleIncomingRemind");
  assert.ok(at > 0, "handleIncomingRemind 必须存在");
  const body = store.slice(at, at + 1600);
  assert.match(body, /payload\.actors\.includes\(myId\)/, "不在受众名单里直接返回");
  assert.match(
    body,
    /g\.id === gid && g\.members\.includes\(myId\)/,
    "必须以**当前**群成员表复核（发起后被移出的人不该再被提醒）",
  );
  // 两道门都必须在去重/回执之前：不该回 S3、不该占 remindedIds
  const memberGate = body.indexOf("g.members.includes(myId)");
  const dedup = body.indexOf("remindedIds.add");
  const ack = body.indexOf('"alerted"');
  assert.ok(memberGate > 0 && memberGate < dedup && dedup < ack, "门控 → 去重 → S3 回执 的顺序");
});

test("S3 自动回执与本地通知是否弹出解耦（R1：通知 API 成功不是对方已收到）", () => {
  const store = read("stores/useChatStore.ts");
  const at = store.indexOf("function handleIncomingRemind");
  const body = store.slice(at, at + 3200);
  // 回执在所有本地通知逻辑之前（移动端权限询问与桌面 notify 命令都在其后）
  const ack = body.indexOf("buildRemindAckPayload(rec.msg_id, \"alerted\")");
  const permAsk = body.indexOf("app.ensureNotifyPermission()");
  const notify = body.indexOf("notifyDesktop");
  assert.ok(ack > 0 && ack < permAsk && ack < notify, "S3 回执必须先于且独立于本地提醒");
});

test("抑制矩阵：总开关关着 / 前台正查看该会话 / 抖动帧 → 不振不弹；判定含 document.hidden", () => {
  const store = read("stores/useChatStore.ts");
  const at = store.indexOf("function handleIncomingRemind");
  const body = store.slice(at, at + 2600);
  assert.match(
    body,
    /if \(!app\.notifyEnabled \|\| viewing \|\| payload\.shake\) return;/,
    "总开关与查看抑制必须在振动/通知之前短路（抖动帧 shake 也在同一句短路：只抖不弹）",
  );
  assert.match(
    body,
    /!document\.hidden && document\.hasFocus\(\) && activeConv\.value === rec\.conv_id/,
    "viewing 必须同时判 hidden（最小化/隐藏时 hasFocus 可能仍为真）",
  );
});

test("移动端：权限门控 + 高优先级通道 + 点击载荷带 msg_id", () => {
  const store = read("stores/useChatStore.ts");
  const at = store.indexOf("function handleIncomingRemind");
  const body = store.slice(at, at + 3600);
  assert.match(body, /app\.ensureNotifyPermission\(\)\.then\(\(granted\)/, "发通知前必须过运行时权限");
  assert.match(
    body,
    /remindChannelReady \? \{ channelId: REMIND_CHANNEL_ID \} : \{\}/,
    "通道就绪才挂 channelId（不存在的通道会让通知整条不发）",
  );
  assert.match(
    body,
    /extra: \{ type: "chat", conv_id: rec\.conv_id, msg_id: payload\.target \}/,
    "移动端通知 extra 必须带原消息 msg_id",
  );
  // 通道在 init 的移动端块里建好，设置变化时重建
  const init = read("stores/useChatStore.ts");
  assert.match(init, /void ensureRemindChannel\(false\);/, "init 必须先建通道");
  assert.match(init, /ensureRemindChannel\(true\)/, "振动设置变化必须 remove+create 重建");
  // watch 建在可重入的 init 里，停止句柄必须挂 scope，否则每轮 init 叠一个监听器
  assert.match(
    init,
    /const stopRemindChannelWatch = watch\(\s*\(\) => app\.remindVibrate,[\s\S]*?ensureRemindChannel\(true\);[\s\S]*?\);\s*scope\.onDispose\(stopRemindChannelWatch\);/,
    "通道重建 watch 只跟振动设置且挂 scope（声音改由系统通道设置管，不该重建清掉用户定制）",
  );
});

test("移动端不额外调 navigator.vibrate（避免与通知通道双重震动）", () => {
  const store = read("stores/useChatStore.ts");
  const at = store.indexOf("function handleIncomingRemind");
  const body = store.slice(at, at + 3600);
  // 剥掉注释行后再判：注释里可以提到这个 API，真实调用不许有
  const code = body
    .split("\n")
    .filter((l) => {
      const s = l.trim();
      return !s.startsWith("//") && !s.startsWith("*") && !s.startsWith("/*");
    })
    .join("\n");
  assert.ok(
    !/navigator\.vibrate\(/.test(code),
    "强提醒振动必须只由 Android 通知通道承载（JS 再调一次会震两遍；桌面 vibrate 恒 no-op）",
  );
});

test("桌面端：通知命令带 msg_id/声音/按钮文案，且只有 sent=true 才请求注意", () => {
  const store = read("stores/useChatStore.ts");
  const at = store.indexOf("function handleIncomingRemind");
  const body = store.slice(at, at + 3600);
  assert.match(
    body,
    /api\s*\.\s*notifyDesktop\(\s*title,\s*body,\s*rec\.conv_id,\s*\{\s*msgId:\s*payload\.target,\s*sound:\s*app\.remindSound,\s*actionLabel:\s*t\("notification\.view"\),?\s*\}\s*\)/s,
    "桌面通知必须以 opts 带原消息 msg_id、声音开关与本地化按钮文案",
  );
  assert.match(body, /if \(sent\) requestAttentionOnce\(true\);/, "通知没真正发出不许闪 Dock/任务栏");
});

test("点击路由：桌面事件与移动端 actionPerformed 都把 msg_id 送进定位链", () => {
  const store = read("stores/useChatStore.ts");
  assert.match(
    store,
    /routeNotificationClick\(p\.type, p\.conv_id, p\.msg_id\)/,
    "桌面 notification-clicked 事件必须透传 msg_id",
  );
  assert.match(
    store,
    /raw\.extra\?\.msg_id != null \? String\(raw\.extra\.msg_id\)/,
    "移动端点击必须从 extra 取 msg_id",
  );
  assert.match(
    store,
    /const r = await locateMessageInConv\(convId, msgId\);/,
    "打开会话后必须继续翻页定位原消息",
  );
});

test("后端：notify_desktop 以 opts 收 msg_id/action_label，点击载荷带 msg_id；无按钮文案时按语言补", () => {
  const network = read("../src-tauri/src/commands/network.rs");
  assert.match(network, /pub msg_id: Option<String>/, "opts 必须收 msg_id");
  assert.match(network, /pub action_label: Option<String>/, "opts 必须收 action_label");
  assert.match(network, /opts: Option<DesktopNotificationOpts>/, "可选项必须收进 opts 结构");
  assert.match(
    network,
    /crate::db::get_setting\(&dbc, "language"\)/,
    "前端没给按钮文案时按语言设置补（macOS 点击捕获的承重件）",
  );
  const notif = read("../src-tauri/src/notifications.rs");
  assert.match(notif, /pub msg_id: Option<String>/, "点击事件载荷必须带 msg_id");
  // macOS 实现必须同时认 Default（点正文）与 Action("open")（点按钮）
  const macAt = notif.indexOf('#[cfg(target_os = "macos")]\nfn show_click_impl');
  assert.ok(macAt > 0, "macOS 必须有自己的 show_click_impl（此前点击通道整条缺失）");
  const macBody = notif.slice(macAt, macAt + 2000);
  assert.match(macBody, /is_default_action\(\)/, "点正文必须触发");
  assert.match(macBody, /Action\(k\) if k == "open"/, "点 action 按钮也必须触发");
  assert.match(
    notif,
    /NSUserNotificationDefaultSoundName/,
    "macOS 默认声音必须用完整常量（传 default 会被当成不存在的声音文件）",
  );
  // action 按钮只能加在 macOS 块里：Windows/Linux 正文点击本身就能回调，
  // 全局加按钮会给每条 toast 添外观元素，且非 mac 的回调只认 Default，按钮成死键。
  const buildAt = notif.indexOf("fn build(");
  const buildBody = notif.slice(buildAt, buildAt + 4500);
  const macBlockAt = buildBody.indexOf('#[cfg(target_os = "macos")]');
  const actionAt = buildBody.indexOf('.action("open"');
  assert.ok(macBlockAt > 0 && actionAt > macBlockAt,
    "notification.action 必须只在 macOS cfg 块内（Windows/Linux 不加按钮）");
});

test("MessageItem：发起入口要求消息已成功发出；接收标识与确认按钮齐备", () => {
  const item = read("components/MessageItem.vue");
  assert.match(
    item,
    /REMINDABLE_STATUS\s*=\s*new Set\(\["sent", "delivered", "read"\]\)/,
    "sending/failed/cancelled 的消息不能发起强提醒（会指向对方没收到的幽灵消息）",
  );
  assert.match(item, /:can-remind="canRemindEntry"/, "右键菜单入口必须接上");
  assert.match(item, /@remind="doRemind"/, "菜单事件必须接上 doRemind");
  assert.match(item, /t\("remind\.gotIt"\)/, "必须有「我知道了」按钮");
  assert.match(item, /doConfirmReminder/, "确认按钮必须接 store 的确认动作");
});

test("ChatWindow：会话层折叠一次再分发（与 reactionMap 同构，不做 O(n²)）", () => {
  const win = read("components/ChatWindow.vue");
  assert.match(win, /foldReminders\(chat\.messages\[convId\] \?\? \[\]\)/);
  assert.match(win, /:reminder="reminderMap\.get\(item\.msg_id\) \?\? null"/);
});

test("群受众弹窗：排除自己、至少 1 人才能确认", () => {
  const dlg = read("components/RemindAudienceDialog.vue");
  assert.match(dlg, /filter\(\(id\) => id !== myId\.value\)/, "候选必须排除自己");
  assert.match(dlg, /:disabled="selected\.size === 0"/, "零选择不能确认（第一版不默认全群）");
});

test("工具栏「抖动」入口 + 收到强提醒时把窗口拉到前台并抖动", () => {
  const store = read("stores/useChatStore.ts");
  const at = store.indexOf("function handleIncomingRemind");
  const body = store.slice(at, at + 2800);
  assert.match(
    body,
    /if \(app\.notifyEnabled\) raiseAndShakeOnRemind\(rec\.conv_id\);/,
    "收到强提醒要先把窗口拉到前台（用户要求：抖动可以不提醒，但窗口直接打开）",
  );
  assert.match(
    store,
    /function raiseAndShakeOnRemind\(convId: string\) \{\s*void api\.focusWindow\(\);\s*if \(activeConv\.value !== convId\) void openConversation\(convId\);/,
    "先拉起窗口 + 切到发起方会话",
  );
  assert.match(
    store,
    /void api\.shakeWindow\(\)\.catch/,
    "桌面端抖动**整扇窗口**（Rust 移动 OS 窗口，不是只抖聊天区）",
  );
  // 工具栏「抖动」按钮：图标（Zap）排在表情之后，点击走 shakeConversation
  const composer = read("components/chat/MessageComposer.vue");
  assert.match(composer, /\(e: "shake"\): void;/, "输入区必须声明 shake 事件");
  assert.match(
    composer,
    /:aria-label="t\('chat\.composer\.emoji'\)"[\s\S]{0,900}v-if="shakeEnabled"[\s\S]{0,600}Zap/,
    "抖动的图标按钮必须排在表情按钮之后",
  );
  const win = read("components/ChatWindow.vue");
  assert.match(win, /@shake="onShake"/, "ChatWindow 必须接住 shake 事件");
  assert.match(win, /chat\.shakeConversation\(convId\)/, "onShake 必须走 shakeConversation");
  assert.match(win, /chat\.shakeSignal/, "ChatWindow 必须消费 shakeSignal");
  assert.match(win, /gosslan-shake/, "根容器必须挂抖动的动画类");
  assert.match(
    store,
    /async function shakeConversation\([\s\S]{0,600}sendReminder\(convId, last\.msg_id, \[\], true\)/,
    "shakeConversation 必须对最近一条可提醒的消息发起**带 shake 标记**的强提醒",
  );
  // 抖动帧只抖不弹：shake 标记必须在"该不该弹系统通知"那一句里抑制掉普通通知，
  // 且 raiseAndShakeOnRemind 仍在它之前（抖不因抑制而丢）。用户 2026-10-15。
  assert.match(
    body,
    /if \(!app\.notifyEnabled \|\| viewing \|\| payload\.shake\) return;/,
    "抖动帧只抖不弹：shake 标记必须抑制强提醒的系统通知（用户 2026-10-15「不要接强提醒的弹窗通知」）",
  );
});

/**
 * 桌面抖窗是**整个动效族里唯一 CSS 管不着**的出口（Rust 直接 `set_position` 搬 OS 窗口），
 * 所以系统「减弱动态效果」这一个开关必须由 JS 在调用它之前接住。
 * 2026-10-19 实测到的缺陷形状：CSS 全局降级、骨架呼吸、触觉三家都接了，只有这一家没接
 * ⇒ 同一条系统开关，四种感官里三种守约、一种最响的不守约，且不会有任何报错。
 */
test("桌面抖窗必须查在减弱动态这条系统开关之后（CSS 降级管不到 OS 窗口）", () => {
  const store = read("stores/useChatStore.ts");
  const at = store.indexOf("function raiseAndShakeOnRemind");
  assert.notEqual(at, -1, "raiseAndShakeOnRemind 不见了 ⇒ 这条判据失去锚点");
  const end = store.indexOf("\n  }", at);
  assert.notEqual(end, -1, "raiseAndShakeOnRemind 的函数体没有正常闭合");
  const body = store.slice(at, end);
  // 正控：切片里必须真的看得见那句调用 —— 否则"开关在调用之前"会退化成空转
  assert.match(body, /void api\.shakeWindow\(\)\.catch/, "切片里必须含桌面抖窗的调用");
  const gateAt = body.indexOf("prefersReducedMotion()");
  assert.notEqual(gateAt, -1, "桌面抖窗这条路径没查系统「减弱动态效果」开关");
  assert.ok(
    gateAt < body.indexOf("api.shakeWindow("),
    "开关必须查在调用**之前**（写在后面一样不报错，但窗口照抖）",
  );
  // 移动端那一路退回 CSS 动画，由 style.css 的全局降级接住 ⇒ 这里不该长出第二份判断
  assert.equal(body.split("prefersReducedMotion()").length - 1, 1, "同一个函数里只该查一次");
});
