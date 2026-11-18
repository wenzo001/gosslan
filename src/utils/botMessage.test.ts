/**
 * 机器人消息渲染的判据：外部正文是不可信输入 ⇒ 渲染链路的每一条边界都要钉住。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BOT_MESSAGE_ALLOWED_TAGS,
  botMessageToHtml,
  capBotMessageText,
  normalizeBotFormat,
} from "./botMessage.ts";

test("格式归一化：只认 markdown/md，其余按纯文本（不猜）", () => {
  assert.equal(normalizeBotFormat("markdown"), "markdown");
  assert.equal(normalizeBotFormat("MD"), "markdown");
  assert.equal(normalizeBotFormat("text"), "text");
  assert.equal(normalizeBotFormat("html"), "text");
  assert.equal(normalizeBotFormat(""), "text");
  assert.equal(normalizeBotFormat(null), "text");
  assert.equal(normalizeBotFormat(undefined), "text");
});

test("纯文本：尖括号当字面量，不当标签渲染", () => {
  const html = botMessageToHtml("<b>粗</b> <script>alert(1)</script>", "text");
  assert.ok(html.includes("&lt;b&gt;"), "纯文本里的标签必须被转义");
  assert.ok(!html.includes("<script"), "纯文本里不许出现脚本标签");
  assert.ok(!html.includes("<b>"), "纯文本不许被渲染成粗体");
});

test("Markdown：结构化元素真的渲染出来（标题/列表/表格/代码块）", () => {
  const html = botMessageToHtml(
    "# 标题\n\n- 一\n- 二\n\n| 项 | 结果 |\n| --- | --- |\n| 测试 | 通过 |\n\n```\ncode\n```",
    "markdown",
  );
  assert.ok(html.includes("<h1"), "标题要渲染");
  assert.ok(html.includes("<li"), "列表要渲染");
  assert.ok(html.includes("<table"), "表格要渲染");
  assert.ok(html.includes("<code"), "代码块要渲染");
  assert.ok(html.includes("标题"), "正文文字要保留");
});

test("Markdown：外部内容里的脚本/事件属性/远程图片一律不进 DOM", () => {
  const html = botMessageToHtml(
    '<script>alert(1)</script>\n\n<img src="https://evil.example/x.png">\n\n[x](javascript:alert(1))\n\n<span onclick="alert(1)">点</span>',
    "markdown",
  );
  assert.ok(!html.includes("<script"), "脚本必须被消毒");
  assert.ok(!html.includes("onclick"), "事件属性必须被消毒");
  assert.ok(!html.includes("<img"), "远程图片不许自动加载（图片走附件通道）");
  assert.ok(!html.includes("javascript:"), "javascript: 链接必须被挡");
});

test("白名单里没有 img/style（图片与内联样式都不许）", () => {
  assert.ok(!BOT_MESSAGE_ALLOWED_TAGS.includes("img"));
  assert.ok(!BOT_MESSAGE_ALLOWED_TAGS.includes("style"));
  // 表格与代码块要**在**白名单里（全格式的要求）
  assert.ok(BOT_MESSAGE_ALLOWED_TAGS.includes("table"));
  assert.ok(BOT_MESSAGE_ALLOWED_TAGS.includes("pre"));
  assert.ok(BOT_MESSAGE_ALLOWED_TAGS.includes("code"));
});

test("超长正文截断（不留无声吞掉的痕迹）", () => {
  const long = "x".repeat(40_000);
  const out = capBotMessageText(long);
  assert.ok(out.length < long.length);
  assert.ok(out.endsWith("…"), "截断要留下可辨认的省略号");
  assert.equal(capBotMessageText("短"), "短");
});

test("空正文渲染成空串（界面据此不画正文区）", () => {
  assert.equal(botMessageToHtml("", "markdown"), "");
  assert.equal(botMessageToHtml("   ", "markdown"), "");
  assert.equal(botMessageToHtml(null, "markdown"), "");
});

// ---------------- 后台轮询：通知要能自动进来（2026-11-16） ----------------

test("机器人消息能自动进来：后端有轮询 worker，前端订阅它的刷新事件", () => {
  // `src/utils` ⇒ 上两级是仓库根；`src` 是源码根。
  const repoRoot = join(import.meta.dirname, "..", "..");
  const srcRoot = join(repoRoot, "src");
  const read = (p: string) => readFileSync(join(srcRoot, p), "utf8");

  // ① 后端：worker 存在 + 已接线。
  const bots = readFileSync(join(repoRoot, "src-tauri", "src", "commands", "bots.rs"), "utf8");
  assert.ok(
    bots.includes("pub fn spawn_bot_poller("),
    "没有后台轮询 worker ⇒ 外部发的通知不会自动进来（用户得手动点「立即取件」）",
  );
  const lib = readFileSync(join(repoRoot, "src-tauri", "src", "lib.rs"), "utf8");
  assert.ok(
    lib.includes("commands::spawn_bot_poller(&state);"),
    "轮询 worker 没在 setup 里启动",
  );

  // ② 前端：订阅事件 ⇒ 收件箱会刷新。
  const api = read("api/index.ts");
  assert.ok(
    api.includes('listen<{ bot_id?: string; count?: number }>("bot-inbox-updated"'),
    "前端没有订阅 bot-inbox-updated ⇒ 收件箱不会自动刷新",
  );
  const wizard = read("components/BotSetupWizard.vue");
  assert.ok(
    wizard.includes("api.botCreate("),
    "创建向导没有调 bot_create（配好就能发）",
  );

  // ③ 系统通知只给摘要，不放正文（外部内容不可信）。
  const notif = read("stores/chat/notifications.ts");
  assert.ok(
    notif.includes('t("bot.notifyBody", { n: count })'),
    "系统通知必须走「只给条数」的摘要文案",
  );
  assert.ok(
    !notif.includes("entry.text"),
    "系统通知里不许带机器人正文（正文是外部来的不可信内容）",
  );
});

// ---------------- 产品形态：像联系人一样 + 两处入口 + 设置里不再堆配置 ----------------

test("两处创建入口（加好友 / 群成员），设置里不再有机器人配置", () => {
  const repoRoot = join(import.meta.dirname, "..", "..");
  const srcRoot = join(repoRoot, "src");
  const read = (p: string) => readFileSync(join(srcRoot, p), "utf8");

  // ① 加好友弹窗：个人机器人入口（创建时配好中转 + 密钥）。
  const addFriend = read("components/AddFriendModal.vue");
  assert.ok(
    addFriend.includes('scope="personal"') && addFriend.includes("BotSetupWizard"),
    "「加好友」弹窗没有「添加个人机器人」入口",
  );
  // ② 群成员面板：群机器人入口 + 权限门（只有群主/管理员看得到按钮）。
  const members = read("components/GroupMemberPanel.vue");
  assert.ok(
    members.includes('scope="group"') && members.includes("botWizardOpen"),
    "群成员面板没有「添加群机器人」入口",
  );
  // 模板里「添加群机器人」按钮必须落在 <template v-if="canManage"> 块内。
  const btnAt = members.indexOf("botWizardOpen = true");
  const lastManage = members.lastIndexOf('<template v-if="canManage">');
  assert.ok(
    btnAt > lastManage && lastManage >= 0,
    "群机器人入口没有 canManage 权限门（必须只有群主/管理员能添加）",
  );

  // ③ 设置里不再堆机器人配置（BotSection 删除，两个外壳都不引）。
  assert.ok(
    !existsSync(join(srcRoot, "components", "settings", "BotSection.vue")),
    "旧的设置页机器人面板还在（应该移到两处入口 + 详情）",
  );
  for (const shell of ["components/SettingsPanel.vue", "components/SettingsWindow.vue"]) {
    assert.ok(!read(shell).includes("BotSection"), `${shell} 仍引用 BotSection`);
  }
});

test("详情页能看配置 / 免打扰 / 删除；点机器人头像能进详情", () => {
  const srcRoot = join(import.meta.dirname, "..");
  const read = (p: string) => readFileSync(join(srcRoot, p), "utf8");

  const detail = read("components/BotDetailModal.vue");
  for (const [needle, why] of [
    ["api.botSetDnd(", "详情页没有免打扰开关"],
    ["api.botDelete(", "详情页没有删除按钮"],
    ["bot.deleteConfirm", "删除没有二次确认（删了 hook 立即失效且不可逆）"],
    ["api.botPullOnce(", "详情页没有「立即取件」"],
  ] as const) {
    assert.ok(detail.includes(needle), why);
  }

  // 点机器人消息头像 ⇒ 详情（不是好友资料页）
  const chat = read("components/ChatWindow.vue");
  assert.ok(
    chat.includes('senderId.startsWith("bot:")'),
    "点机器人头像没有拦截 bot: 前缀（会错误地跳成好友资料页）",
  );
  assert.ok(chat.includes("BotDetailModal"), "会话里没渲染机器人详情弹窗");
});

test("机器人消息走本机假身份会话，但不写 outbox；正文按 Markdown 消毒渲染", () => {
  const repoRoot = join(import.meta.dirname, "..", "..");
  const srcRoot = join(repoRoot, "src");
  const rust = readFileSync(join(repoRoot, "src-tauri", "src", "commands", "bots.rs"), "utf8");

  // 个人 bot 落消息表但不进网络（Frozen Core 红线）。
  assert.ok(rust.includes('format!("bot:{bot_id}")'), "个人机器人没有建 bot: 假身份会话");
  const personalAt = rust.indexOf('"inbox" | "personal" =>');
  assert.ok(personalAt > 0, "没有个人机器人投递分支");
  const personal = rust.slice(personalAt, rust.indexOf('"group" =>', personalAt));
  assert.ok(personal.includes("db::insert_message("), "机器人消息没落本机消息表");
  assert.ok(!personal.includes("insert_message_and_outbox("), "机器人消息写了 outbox ⇒ 会跨设备同步（红线）");

  // Markdown：走消毒器，绝不裸 v-html。
  const bubble = readFileSync(join(srcRoot, "components", "message", "MessageTextBubble.vue"), "utf8");
  assert.ok(
    /v-html="renderBotMessage\(content, 'markdown'\)"/.test(bubble),
    "机器人正文没有走消毒后的 Markdown 渲染",
  );
  const item = readFileSync(join(srcRoot, "components", "MessageItem.vue"), "utf8");
  assert.ok(
    item.includes('props.message.conv_id.startsWith("bot:")'),
    "消息行没有识别机器人会话",
  );
});

test("收尾：机器人消息必须 emit 到聊天窗口，且中文正文截断不许 panic", () => {
  const repoRoot = join(import.meta.dirname, "..", "..");
  const rust = readFileSync(join(repoRoot, "src-tauri", "src", "commands", "bots.rs"), "utf8");
  const at = rust.indexOf('"inbox" | "personal" =>');
  const personal = rust.slice(at, rust.indexOf('"group" =>', at));

  assert.ok(
    personal.includes('emit("message-received"'),
    "机器人消息落库后必须 emit message-received —— 否则已打开的聊天窗口不显示新消息（要手动切走再切回）",
  );
  // 审计：消息体存全文（服务端已限 8192 字节），不能在落库时截断 ——
  // 否则用户永远看不到长通知全文（此前截 240 字且没有全文入口）。
  assert.ok(
    !personal.includes("PERSONAL_PREVIEW_MAX"),
    "不许在落库时截断正文（全文不可达）：预览交给 UI 的 line-clamp",
  );
  assert.ok(
    personal.includes("let content: String = e.text.clone()"),
    "机器人消息必须存全文",
  );

  // 前端：机器人消息不能走普通消息的通知/回执（否则正文泄漏 + 双通知 + 白发给假设备）。
  const store = readFileSync(join(repoRoot, "src", "stores", "useChatStore.ts"), "utf8");
  assert.ok(
    /if \(rec\.conv_id\.startsWith\("bot:"\)\) return;/.test(store),
    "前端 onMessage 必须把 bot: 消息挡在 maybeNotify/已读回执之外",
  );

  // format 分路：botmsg-md-* 才按 Markdown 渲染（纯文本的 # 不该被误解析）。
  const bubble = readFileSync(join(repoRoot, "src", "components", "message", "MessageTextBubble.vue"), "utf8");
  assert.ok(
    bubble.includes("botmsg-md-"),
    "必须按 format 区分 Markdown / 纯文本渲染",
  );
});

test("孤儿消息兜底：删除/撤销写墓碑，轮询时清掉服务端残留", () => {
  const repoRoot = join(import.meta.dirname, "..", "..");
  const rust = readFileSync(join(repoRoot, "src-tauri", "src", "commands", "bots.rs"), "utf8");
  const db = readFileSync(join(repoRoot, "src-tauri", "src", "db", "bots.rs"), "utf8");

  // 墓碑存储存在且有上限（防膨胀）
  assert.ok(db.includes("pub fn add_bot_tombstone("), "缺墓碑存储");
  assert.ok(db.includes("list.truncate(50)"), "墓碑必须有上限（防膨胀）");
  // 删除与撤销都写墓碑
  const del = rust.slice(rust.indexOf("pub async fn bot_delete("), rust.indexOf("pub async fn bot_pull_once("));
  assert.ok(del.includes("add_bot_tombstone("), "删除机器人没写墓碑 ⇒ 服务端残留会积压 7 天");
  const status = rust.slice(rust.indexOf("pub async fn bot_set_status("), rust.indexOf("pub async fn bot_delete("));
  assert.ok(status.includes("add_bot_tombstone("), "撤销机器人没写墓碑");
  // 轮询里清孤儿（拉墓碑 token + ack 丢弃）
  assert.ok(rust.includes("purge_tombstoned_events("), "轮询没清孤儿消息");
  assert.ok(rust.includes("/ack/"), "孤儿消息必须 ACK 丢弃（不是只拉不算）");
});

test("群机器人管理能力：白名单仅建任务，危险操作不可达，身份仍是本机代发", () => {
  const repoRoot = join(import.meta.dirname, "..", "..");
  const rust = readFileSync(join(repoRoot, "src-tauri", "src", "commands", "bots.rs"), "utf8");
  const store = readFileSync(join(repoRoot, "src", "stores", "useChatStore.ts"), "utf8");

  // 白名单只有 create_todo（公告/危险操作不在首版）
  assert.ok(rust.includes('kind == "create_todo"'), "群机器人 action 白名单缺 create_todo");
  for (const danger of ["remove_member", "appoint_admin", "transfer_owner", "dissolve_group"]) {
    assert.ok(!rust.includes(`"${danger}"`), `危险操作 ${danger} 不该在机器人 action 路径里`);
  }
  // 双重校验：管理员 + 群存在
  assert.ok(rust.includes("g.is_manager(&s.device_id)"), "执行 action 前没复核管理员权限");
  // 机器人代发：仍走既有 send_group_payload（线格式不动）
  assert.ok(rust.includes("send_group_payload("), "群消息没走既有群发送链路（线格式会被改）");
  // 前端只执行白名单 type，且走既有 sendGroupTodo
  assert.ok(store.includes('a.type !== "create_todo"'), "前端没挡住非白名单 action");
  assert.ok(store.includes("api.sendGroupTodo("), "前端没用既有群任务命令");
});

test("昵称共享选择按 RP 缓存（同一应用记住上次）", () => {
  const repoRoot = join(import.meta.dirname, "..", "..");
  const auth = readFileSync(join(repoRoot, "src-tauri", "src", "device_auth.rs"), "utf8");
  const cmd = readFileSync(join(repoRoot, "src-tauri", "src", "commands", "device_auth.rs"), "utf8");
  const db = readFileSync(join(repoRoot, "src-tauri", "src", "db", "device_auth.rs"), "utf8");
  const comp = readFileSync(join(repoRoot, "src", "components", "DeviceAuthConfirmModal.vue"), "utf8");

  assert.ok(db.includes("save_nickname_memory("), "缺昵称记忆存储");
  assert.ok(cmd.includes("save_nickname_memory("), "批准时没记住昵称选择");
  assert.ok(auth.includes("nickname_default: self.remembered_nickname"), "prompt 没带回记忆值");
  assert.ok(comp.includes("allowNickname.value = p.nickname_default"), "确认页没用记忆值初始化开关");
});

test("v7 撤销用 client_token（BotRecord 不存 send_token；服务端两种都收）", () => {
  const repoRoot = join(import.meta.dirname, "..", "..");
  const rust = readFileSync(join(repoRoot, "src-tauri", "src", "commands", "bots.rs"), "utf8");

  // BotRecord 没有 send_token 字段 ⇒ 客户端只能传一直持有的 client_token。
  // 服务端「两种 token 都收」由 relay-server 的 notify-selftest.mjs 钉住（CI 只 checkout 本仓，
  // 这里不能读外部仓路径 —— 本地绿 CI 红的经典坑）。
  assert.ok(!rust.includes('/v1/bots/{bot_id}'), "还有用 bot_id 撤销 ⇒ 远端 404，删除失败");
  assert.ok(rust.includes('format!("{server}/v1/bots/{}", created.client_token)'), "创建回滚没传 client_token");
  assert.ok(rust.includes('format!("{}/v1/bots/{}", record.server_url, record.client_token)'), "撤销没传 client_token");
  assert.ok(rust.includes('format!("{}/v1/bots/{}", rec.server_url, rec.client_token)'), "删除没传 client_token");
});

test("机器人会话展示：无在线状态、头像常亮、通讯录可见、资料可编辑", () => {
  const repoRoot = join(import.meta.dirname, "..", "..");
  const list = readFileSync(join(repoRoot, "src", "components", "ConversationList.vue"), "utf8");
  const item = readFileSync(join(repoRoot, "src", "components", "conversation", "ConversationListItem.vue"), "utf8");
  const modal = readFileSync(join(repoRoot, "src", "components", "BotDetailModal.vue"), "utf8");
  const rust = readFileSync(join(repoRoot, "src-tauri", "src", "commands", "bots.rs"), "utf8");
  const db = readFileSync(join(repoRoot, "src-tauri", "src", "db", "bots.rs"), "utf8");

  // 机器人不是设备 ⇒ isOnline 必须返回 null（不显示状态点、不灰头像 = 一直亮着）
  assert.ok(list.includes('if (id.startsWith("bot:")) return null;'), "机器人还被当成离线设备");
  // 会话行专属样式：主色环 + 列表标记
  assert.ok(item.includes('isBot ? \'ring-2 ring-[var(--gosslan-primary)]\''), "机器人头像没有常亮专属样式");
  assert.ok(item.includes('v-if="isBot"'), "机器人列表缺专属标记");
  // 通讯录分组（点起来源 = api.botList）
  assert.ok(/\.botList\(\)/.test(list), "通讯录没拉机器人列表");
  assert.ok(list.includes('bot:${b.botId}'), "通讯录点击没打开机器人会话");
  // 资料编辑：后端字段 + 命令 + 会话表同步；前端入口
  assert.ok(db.includes('pub avatar: String,'), "BotRecord 缺 avatar 字段");
  assert.ok(rust.includes('pub async fn bot_set_profile('), "缺机器人资料编辑命令");
  assert.ok(rust.includes('db::update_conversation_profile('), "改名后没同步会话列表");
  assert.ok(modal.includes('api.botSetProfile('), "详情页没有保存资料入口");
  assert.ok(modal.includes('AvatarPresetDialog'), "详情页没有头像选择器");
});

test("机器人会话是只读通知流：头像下 tag、无输入框/共享目录、专用空态", () => {
  const repoRoot = join(import.meta.dirname, "..", "..");
  const read = (p: string) => readFileSync(join(repoRoot, p), "utf8");
  const item = read("src/components/conversation/ConversationListItem.vue");
  const chat = read("src/components/ChatWindow.vue");
  const header = read("src/components/chat/ChatHeader.vue");
  const modal = read("src/components/BotDetailModal.vue");
  const api = read("src/api/index.ts");
  const rust = read("src-tauri/src/commands/bots.rs");

  // tag 在头像下方，不再贴着名字（用户 2026-11-17）
  assert.ok(item.includes('-bottom-1 left-1/2'), "机器人标记没移到头像下方");
  assert.ok(!/ml-1[^>]*bot\.listBadge/.test(item), "名字后面还贴着机器人标记");
  // 单向通知流：整块输入框（含「不是好友」提示）不渲染；共享目录也不渲染
  assert.ok(chat.includes('v-if="!isBotChat"'), "机器人会话还渲染输入框外壳");
  assert.ok(chat.includes('chat.activeConv?.startsWith("bot:")'), "没识别机器人会话");
  assert.ok(header.includes('v-if="!isGroup && !isBot"'), "机器人会话还有共享目录入口");
  // 空态兜底
  assert.ok(chat.includes("isBotChat ? t('bot.emptyChat')"), "机器人空消息没有专用兜底文案");
  // 资料编辑含地址（bot_id 创建后不可变）
  assert.ok(rust.includes('server_url: Option<String>,') && rust.includes('normalize_bot_server(&u)?'), "地址编辑没做 URL 校验");
  assert.ok(api.includes('serverUrl: string | null'), "API 没传地址");
  assert.ok(modal.includes('editServerUrl.value.trim() || null'), "详情页没保存地址");
});


test("通讯录机器人：只列个人、点头像看详情、右键删除且删完即消失", () => {
  const repoRoot = join(import.meta.dirname, "..", "..");
  const read = (p: string) => readFileSync(join(repoRoot, p), "utf8");
  const list = read("src/components/ConversationList.vue");
  const menu = read("src/components/conversation/BotContactMenu.vue");
  const rust = read("src-tauri/src/commands/bots.rs");

  // 群机器人不进通讯录（入口在群成员面板，用户 2026-11-18）
  assert.ok(list.includes('b.target?.kind !== "group"'), "通讯录还把群机器人列出来了");
  // 头像按钮打开详情（不是开会话）；整行才是开会话
  assert.ok(list.includes('@click.stop="openBotDetail(b)"'), "点头像没有打开详情");
  assert.ok(list.includes('@click="openBotContact(b)"'), "整行不能开会话");
  // 右键 → 菜单 → 二次确认 → 删除机器人
  assert.ok(list.includes('@contextmenu.prevent="onBotContext(b, $event)"'), "机器人行没有右键入口");
  assert.ok(menu.includes('t("bot.action.delete")'), "右键菜单里没有删除项");
  assert.ok(list.includes("await api.botDelete(b.botId)"), "确认后没有真的删除");
  assert.ok(list.includes("botContacts.value = botContacts.value.filter"), "删除后没有从列表移除（会残留）");
  assert.ok(list.includes("void chat.refreshConversations()"), "删除后没刷新会话列表");
  // 群机器人删除：后端必须校验群主/管理员（fail-closed）
  assert.ok(
    rust.includes('"只有群主或管理员可以删除群机器人"') && rust.includes("g.is_manager(&me)"),
    "删除群机器人没有权限校验",
  );
});
