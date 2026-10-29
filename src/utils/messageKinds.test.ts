import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tsFnBody } from "./tsSource.ts";
import {
  BUBBLE_KINDS,
  CARD_KINDS,
  SILENT_KINDS,
  TIP_KINDS,
  UNSUPPORTED_KIND_LABEL,
  isKnownKind,
  isForwardableKind,
  isTransferKind,
  isFavoritableKind,
  isMultiSelectable,
  isRemindableKind,
  isSilentKind,
  isTipKind,
  isRenderedInTimeline,
  countsTowardUnread,
  kindClass,
  shouldShowNickname,
  groupSide,
  GROUP_GAP_MS,
  messageTopGap,
  MSG_GAP_NEW,
  MSG_GAP_TIGHT,
} from "./messageKinds.ts";
import {
  TODO_CATEGORIES,
  TODO_CATEGORY_DEFAULT,
  TODO_CUSTOM_ICONS,
  TODO_CUSTOM_ICON_DEFAULT,
  TODO_PRIORITIES,
  TODO_PRIORITY_DEFAULT,
  TODO_STATUSES,
  TODO_STATUS_DEFAULT,
} from "./todos.ts";

const here = dirname(fileURLToPath(import.meta.url));
const protocolRs = readFileSync(join(here, "../../src-tauri/src/protocol.rs"), "utf8");

test("未知 kind 回退 bubble（宁可多显示，不静默吞）", () => {
  assert.equal(kindClass("未来才有的新类型"), "bubble");
  assert.equal(kindClass(""), "bubble");
});

test("已知 kind 的分类", () => {
  assert.equal(kindClass("text"), "bubble");
  assert.equal(kindClass("system"), "bubble");
  assert.equal(kindClass("reaction"), "silent");
  assert.ok(isSilentKind("reaction"));
  assert.ok(!isSilentKind("text"));
});

/**
 * **跨语言契约**：Rust 的 `WIRE_KINDS` 与 TS 的 `SILENT_KINDS` 必须一致。
 *
 * 两侧判定的后果不同（Rust 决定落库/未读，TS 决定渲染/通知），一旦漂移就会出现
 * 「服务端算静默、前端照常弹通知」这类分裂行为 —— 而且只在真机跑起来才看得见。
 * 直接读源码比对，让它变成编译/测试期就能发现的问题。
 */
test("跨语言契约：kind 分类与 protocol.rs 的 WIRE_KINDS 一致", () => {
  const table = protocolRs.slice(
    protocolRs.indexOf("pub const WIRE_KINDS"),
    protocolRs.indexOf("];", protocolRs.indexOf("pub const WIRE_KINDS")),
  );
  assert.ok(table.includes("WIRE_KINDS"), "应能在 protocol.rs 找到 WIRE_KINDS 表");

  const entries = [...table.matchAll(/\("([^"]+)",\s*KindClass::(\w+)\)/g)].map(
    (m) => [m[1], m[2]] as const,
  );
  assert.ok(entries.length >= 6, `解析出的 kind 太少（${entries.length}），表格式可能变了`);

  const rustSilent = entries.filter(([, c]) => c === "Silent").map(([k]) => k).sort();
  assert.deepEqual([...SILENT_KINDS].sort(), rustSilent, "TS 与 Rust 的静默种类清单必须一致");

  const rustCard = entries.filter(([, c]) => c === "Card").map(([k]) => k).sort();
  assert.deepEqual([...CARD_KINDS].sort(), rustCard, "TS 与 Rust 的 Card 清单必须一致");

  // 内容类清单同样要一致 —— 它是 `isKnownKind` 的三条来源之一，漏一项就会把
  // 一条本机其实会渲染的消息判成「不支持」。
  const rustBubble = entries.filter(([, c]) => c === "Bubble").map(([k]) => k).sort();
  assert.deepEqual([...BUBBLE_KINDS].sort(), rustBubble, "TS 与 Rust 的内容类清单必须一致");

  // 逐个 kind 的分类也要对得上（不只是静默那一列）
  for (const [kind, cls] of entries) {
    const expected = cls === "Silent" ? "silent" : cls === "Card" ? "card" : "bubble";
    assert.equal(kindClass(kind), expected, `${kind} 的分类两侧不一致`);
  }
});

/**
 * **未知 kind 的判据与占位文案必须跨语言一致**（INV-P24 第 2 条）。
 *
 * 为什么必须机器判：会话列表与通知的文案由 Rust 算、气泡由前端算 —— 同一句"不支持"
 * 漂成两个词，用户会在两个位置看到两种说法。更危险的是一种看起来完全合理的写法：
 * 把 `isKnownKind` 实现成 `kindClass(kind) === "bubble"` —— 未知值**也**回落到 bubble，
 * 于是兜底路径永远不触发、载荷原文继续上屏，而页面上只是"少了一个占位"，没人会报 bug。
 */
test("跨语言契约：未知 kind 判据与占位文案与 protocol.rs 一致", () => {
  const label = protocolRs.match(/pub const UNSUPPORTED_PREVIEW_LABEL: &str = "([^"]+)"/)?.[1];
  assert.ok(label, "应在 protocol.rs 找到 UNSUPPORTED_PREVIEW_LABEL");
  assert.equal(UNSUPPORTED_KIND_LABEL, label, "两侧占位文案必须一字不差");

  const table = protocolRs.slice(
    protocolRs.indexOf("pub const WIRE_KINDS"),
    protocolRs.indexOf("];", protocolRs.indexOf("pub const WIRE_KINDS")),
  );
  for (const m of table.matchAll(/\("([^"]+)",\s*KindClass::\w+\)/g)) {
    assert.ok(isKnownKind(m[1]), `Rust 表里的 ${m[1]} 被前端判成未知`);
  }
  // 表外的必须判未知 —— 整条兜底路径的开关
  assert.ok(!isKnownKind("sticker"), "表里没有的 kind 必须判为未知");
  assert.ok(!isKnownKind(""), "空 kind 必须判为未知");
  // 反向对照：kindClass 对未知仍返回 bubble ⇒ 两个判据不可互相替代
  assert.equal(kindClass("sticker"), "bubble");
  assert.ok(!isKnownKind("sticker"));
});

/**
 * **跨语言契约**：任务状态取值表两侧必须一致。
 *
 * 状态用字符串在线上传（`TodoPayload.status`），后端还会用它做命令层校验
 * （`todo_status_is_valid`）。两侧漂移的后果是**静默**的：前端给一个后端不认的值时，
 * 用户会看到"改状态失败"，而代码里两边看起来都写对了 —— 所以直接读源码比对。
 */
test("跨语言契约：任务状态表与 protocol.rs 的 TODO_STATUSES 一致", () => {
  const table = protocolRs.slice(
    protocolRs.indexOf("pub const TODO_STATUSES"),
    protocolRs.indexOf("];", protocolRs.indexOf("pub const TODO_STATUSES")),
  );
  const rust = [...table.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(rust.length >= 4, `解析出的状态太少（${rust.length}），表格式可能变了`);
  assert.deepEqual([...TODO_STATUSES], rust, "TS 与 Rust 的任务状态表必须一致");
});

/** 从 Rust 源码里取一张 `pub const NAME: [&str; N] = ["a", "b"];` 的表。 */
function rustTableOf(src: string, name: string): string[] {
  const at = src.indexOf(`pub const ${name}`);
  assert.ok(at > 0, `protocol.rs 里找不到 ${name} ⇒ 这张表搬家或改名，判据要跟着改`);
  const end = src.indexOf("];", at);
  assert.ok(end > at, `${name} 的表体没闭合 ⇒ 解析落点会一路读到文件末尾`);
  return [...src.slice(at, end).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

/** 取 `pub const NAME: &str = "x";` 里那个字面量。 */
function rustStringOf(src: string, name: string): string {
  const m = src.match(new RegExp(`pub const ${name}: &str = "([a-z_]+)"`));
  assert.ok(m, `找不到 ${name} 的字面量 ⇒ 默认值这条判据失去落点`);
  return m[1];
}

/** 取 `pub fn NAME() -> String { "x".to_string() }` 里那个字面量。 */
function rustDefaultOf(src: string, fn: string): string {
  const m = src.match(new RegExp(`pub fn ${fn}\\(\\) -> String \\{\\s*"([a-z_]+)"\\.to_string\\(\\)`));
  assert.ok(m, `找不到 ${fn}() 的缺省字面量 ⇒ 回落值这条判据失去落点`);
  return m[1];
}

/**
 * 跨语言契约第二格：任务**优先级**（三档，2026-09-29 落地）。
 *
 * 与状态那条同一条理由：优先级是**字符串在线上传**的，后端命令层还会拿它做校验
 * （`todo_priority_is_valid`）。两侧漂移的表现是静默的 —— 前端给出一个后端不认的值，
 * 用户只看到"保存失败"，而两边代码各自看起来都对。
 *
 * 顺带钉**缺省值**：旧载荷没有 `priority` 时，后端解析成一份、前端 `foldTodos` 回落成另一份 ⇒
 * 同一条任务在两侧显示成不同档位（那是比"表不一致"更难发现的一种飘）。
 */
test("跨语言契约：优先级表与缺省值两侧一致", () => {
  const rust = rustTableOf(protocolRs, "TODO_PRIORITIES");
  assert.ok(rust.length >= 3, `解析出的档位太少（${rust.length}），表格式可能变了`);
  assert.deepEqual([...TODO_PRIORITIES], rust, "TS 与 Rust 的优先级表必须同序同值");
  assert.equal(
    TODO_PRIORITY_DEFAULT,
    rustDefaultOf(protocolRs, "default_todo_priority"),
    "缺省档位必须同一个",
  );
  assert.equal(
    TODO_STATUS_DEFAULT,
    rustDefaultOf(protocolRs, "default_todo_status"),
    "缺省状态必须同一个",
  );
  // 缺省值必须真的落在自己那张表里（写成一个表外的字符串会"合法地"显示不出来）
  assert.ok(rust.includes(TODO_PRIORITY_DEFAULT), "缺省档位不在表内 ⇒ 界面拿不到它的 label/class");
});

/**
 * 跨语言契约第三格：任务**类型**（三档，2026-09-29 落地）。
 *
 * 同优先级那条的理由，但这一格的漂移面更大：类型既进命令层校验（`todo_category_is_valid`），
 * 又决定前端那张 label/pill 两张表的键 —— 少一个值就是"存得进去、显示不出来"。
 * ⚠️ 缺省值必须一起钉：旧载荷没有 `category` 时两侧各回落一份 ⇒ 同一条任务在两个成员界面上
 * 一个显示「任务」角标、另一个显示空白。
 */
/**
 * 跨语言契约第四格：自定义类型的**图标键白名单**（用户 2026-10-14 要的那格）。
 *
 * 与类型表同一类风险：后端 `todo_custom_icon_is_valid` 按自己那份白名单拒收，
 * 前端按自己那份画选择器 —— 两侧一飘，症状是"选了保存被拒"或"存进去了但对端画不出"。
 * ⚠️ 默认值必须一起钉：旧对端不认识这一格时，两侧各回落一枚就是两种形状。
 */
test("跨语言契约：自定义图标白名单与默认值两侧一致", () => {
  const rust = rustTableOf(protocolRs, "TODO_CUSTOM_ICONS");
  assert.ok(rust.length >= 3, `解析出的图标键太少（${rust.length}），表格式可能变了`);
  assert.deepEqual([...TODO_CUSTOM_ICONS].sort(), [...rust].sort(), "TS 与 Rust 的图标白名单必须同集合");
  assert.deepEqual([...TODO_CUSTOM_ICONS], rust, "TS 与 Rust 的图标白名单必须同序（选择器顺序跟着它）");
  assert.equal(
    TODO_CUSTOM_ICON_DEFAULT,
    rustStringOf(protocolRs, "TODO_CUSTOM_ICON_DEFAULT"),
    "默认图标键必须同一个",
  );
  assert.ok(rust.includes(TODO_CUSTOM_ICON_DEFAULT), "默认键必须落在白名单内");
});

test("跨语言契约：任务类型表与缺省值两侧一致", () => {
  const rust = rustTableOf(protocolRs, "TODO_CATEGORIES");
  assert.ok(rust.length >= 3, `解析出的类型太少（${rust.length}），表格式可能变了`);
  assert.deepEqual([...TODO_CATEGORIES], rust, "TS 与 Rust 的类型表必须同序同值");
  assert.equal(
    TODO_CATEGORY_DEFAULT,
    rustDefaultOf(protocolRs, "default_todo_category"),
    "缺省类型必须同一个",
  );
  assert.ok(rust.includes(TODO_CATEGORY_DEFAULT), "缺省类型不在表内 ⇒ 界面拿不到它的 label/pill");
});

/**
 * 阳性对照（这几条判据不是恒过的证明）：把 Rust 那张表改一个值，比对必须变红。
 *
 * 为什么单独钉一条：跨语言比对最容易写成"两侧都从同一处读"从而永远相等；
 * 这里喂给同一个解析器一份**手动漂移过**的源码，要求它看得见差异。
 */
test("对照：解析器看得见人为造的漂移（判据不空转）", () => {
  const mutated = protocolRs.replace('["high", "normal", "low"]', '["high", "normal", "urgent"]');
  assert.notEqual(mutated, protocolRs, "替换没生效 ⇒ 这条对照什么都没测");
  assert.notDeepEqual(
    rustTableOf(mutated, "TODO_PRIORITIES"),
    [...TODO_PRIORITIES],
    "改了 Rust 那侧的值，判据必须报不一致",
  );
  const defMutated = protocolRs.replace(
    'pub fn default_todo_priority() -> String {\n    "normal"',
    'pub fn default_todo_priority() -> String {\n    "low"',
  );
  assert.notEqual(defMutated, protocolRs, "缺省值那条替换没生效 ⇒ 对照空转");
  assert.equal(rustDefaultOf(defMutated, "default_todo_priority"), "low");
  // 类型那一格同理：只改 Rust 侧的值 / 只改 Rust 侧的缺省，比对都必须看得见
  const catMutated = protocolRs.replace('["task", "requirement", "bug", "custom"]', '["task", "requirement", "bug", "defect"]');
  assert.notEqual(catMutated, protocolRs, "类型表那条替换没生效 ⇒ 对照空转");
  assert.notDeepEqual(
    rustTableOf(catMutated, "TODO_CATEGORIES"),
    [...TODO_CATEGORIES],
    "改了 Rust 那侧的类型值，判据必须报不一致",
  );
  const catDefMutated = protocolRs.replace(
    'pub fn default_todo_category() -> String {\n    "task"',
    'pub fn default_todo_category() -> String {\n    "bug"',
  );
  assert.notEqual(catDefMutated, protocolRs, "缺省类型那条替换没生效 ⇒ 对照空转");
  assert.equal(rustDefaultOf(catDefMutated, "default_todo_category"), "bug");
});

/**
 * 提示行（微信式居中灰字）的判定**只能有一个来源**。
 *
 * 为什么必须守：`isTipKind` 直接决定两件事 —— 渲染分支（有没有头像/气泡）与
 * **高度估算**（`messageHeight` 还要据此决定要不要留昵称行）。两边各写一份
 * `kind === "system"` 时，`recalled` 就被漏掉：群聊里一条"对方撤回"会多估 18px，
 * 虚拟列表把下面那条推偏、两条消息互相遮挡 —— 而这只在群里、有对方撤回时现形。
 */
test("提示行的判定只有一个来源；昵称行判定渲染端与估算端共用一个函数（§6.64）", () => {
  const read = (p: string) => readFileSync(join(here, p), "utf8");
  const messageItem = read("../../src/components/MessageItem.vue");
  const messageHeight = read("./messageHeight.ts");

  assert.ok(TIP_KINDS.includes("system") && TIP_KINDS.includes("recalled"), "系统消息与撤回都算提示行");
  assert.ok(isTipKind("system") && isTipKind("recalled") && !isTipKind("text"));

  /*
   * §6.64 之后这一半改了口径，**不是放宽**：原先这里要求 `messageHeight` 自己出现 `isTipKind(`，
   * 那是"估算端把提示行规则又抄一遍"的抄本 —— 现在它不该再抄，规则收在 `shouldShowNickname` 里。
   * 所以"必须出现 isTipKind(" 只对**渲染分支**（MessageItem）仍然成立，
   * 而"估算端有没有把提示行算进昵称行"这件事，改由下面那张**真值表**直接跑函数来证 ——
   * 它比"源码里有没有那个字面量"强：摘掉规则里任何一角，表里就有一行翻转。
   * "不许自己比 kind 字面量"这条对三本文件都还留着（漏掉 recalled 就是那条老 bug 的成因）。
   */
  assert.match(messageItem, /isTipKind\(/, "MessageItem 必须用 isTipKind 判定提示行（不要自己比 kind 字面量）");
  for (const [name, src] of [
    ["MessageItem.vue", messageItem],
    ["messageHeight.ts", messageHeight],
    ["useMessageDisplay.ts", read("../../src/composables/useMessageDisplay.ts")],
  ] as const) {
    assert.ok(
      !/kind === "system"/.test(src),
      `${name} 不得再自己写 kind === "system" —— 那样会漏掉 recalled（两边漂移即高度估算出错）`,
    );
  }
  // 昵称行的判定（§6.64）：提示行没有昵称行这条规则现在写在 `shouldShowNickname` 里，
  // 而它**占 18px** ⇒ 渲染端与估高端必须共用，不能各写一半（此前正是估算端带 `!isTipKind`、
  // 渲染端不带，靠 MessageItem 的 v-if/v-else 结构差持平）。
  // 真值表跑的是函数本身（本文件零 `@/` 依赖才跑得动）：摘掉那条 `!isTipKind` 当场红在
  // `system` / `recalled` 两行上，不需要靠"读源码里有没有那个字面量"来推断。
  const NICK_CASES: Array<{ input: { isGroup: boolean; mine: boolean; kind: string }; want: boolean }> = [
    { input: { isGroup: true, mine: false, kind: "text" }, want: true }, // 群里别人发的
    { input: { isGroup: true, mine: true, kind: "text" }, want: false }, // 自己发的没有昵称行
    { input: { isGroup: false, mine: false, kind: "text" }, want: false }, // 单聊没有昵称行
    { input: { isGroup: true, mine: false, kind: "system" }, want: false }, // 提示行没有
    { input: { isGroup: true, mine: false, kind: "recalled" }, want: false }, // 撤回也没有（旧写法漏的就是它）
  ];
  for (const c of NICK_CASES) {
    assert.equal(shouldShowNickname(c.input), c.want, `昵称行判据与预期不符：${JSON.stringify(c.input)}`);
  }
  // 至少有一行是 true，否则上面那张表会因为"恒 false"全绿（那是另一种空转）
  assert.ok(NICK_CASES.some((c) => c.want && shouldShowNickname(c.input)), "真值表里必须有会亮的格子");

  for (const [name, src] of [
    ["useMessageDisplay.ts（渲染端）", read("../../src/composables/useMessageDisplay.ts")],
    ["messageHeight.ts（估算端）", messageHeight],
  ] as const) {
    assert.match(src, /shouldShowNickname\(/, `${name} 必须走那个共用的判定函数`);
    assert.ok(
      !/isTipKind\(/.test(src),
      `${name} 里又出现 isTipKind( ⇒ 昵称行的规则被拆回两边各写一份了（要合并进 shouldShowNickname）`,
    );
  }
});

// ── §30 那条回归：「自己创建的群任务在聊天里看不见」（2026-09-26 用户实测报出，#82 已修）──
// 根因不在渲染组件，而在**同一件事有两份口径**：`messageKinds.ts` 的注释当时写着"Card 不进时间线"，
// 与 `isRenderedInTimeline("todo") === true` 相反 ⇒ "看不见"被当成设计如此，没人去查。
// 所以这三条钉的不是"todo 恰好可见"这一个点，而是**逼着每一次改动都必须做一次决定**：
// ① 逐项判决表要覆盖全部已知 kind（新增一种而这里没登记 ⇒ 当场红）；
// ② 时间线过滤只有一个来源（ChatWindow 不许再写一份 kind 名单，否则未读分割线会画错消息）；
// ③ 过滤出来了还得有人渲染它（摘掉专门卡片就退回原始 JSON，那是这条 bug 的另一半）。
const VISIBLE_IN_TIMELINE = [
  "text", "code", "image", "file", "system", "recalled", "merge", "todo",
];
const NOT_IN_TIMELINE = [...SILENT_KINDS, "announcement", "poll"];

test("时间线可见性逐项判决表：新增一种 kind 必须在这里决定可不可见", () => {
  assert.deepEqual(
    [...new Set([...VISIBLE_IN_TIMELINE, ...NOT_IN_TIMELINE])].sort(),
    [...new Set([...BUBBLE_KINDS, ...SILENT_KINDS, ...CARD_KINDS])].sort(),
    "判决表与已知 kind 全集对不上 —— 新增长出来的那一种必须被显式判一次，不许默认不可见",
  );
  for (const k of VISIBLE_IN_TIMELINE) {
    assert.equal(isRenderedInTimeline(k), true, `${k} 必须在时间线里可见`);
  }
  for (const k of NOT_IN_TIMELINE) {
    assert.equal(isRenderedInTimeline(k), false, `${k} 不该出现在时间线里（各有各的去处）`);
  }
  // 未知 kind 走 bubble 兜底 ⇒ 默认可见：宁可多显示一条，也不静默吞掉对端的新内容
  assert.equal(isRenderedInTimeline("a_kind_from_a_newer_version"), true);
});

test("「不进时间线」的那两种 Card 各自有具名去处，不是没人显示", () => {
  const read = (p: string) => readFileSync(join(here, p), "utf8");
  // announcement → 聊天窗顶部的公告条（与时间线是两条路，所以它不进过滤结果）
  const chat = read("../../src/components/ChatWindow.vue");
  // 2026-10-22：公告不再每次消息变动扫整段历史，而是读 store 里后端折好的
  // `activeAnnouncements`（公告 + 墓碑一条 SQL 算完）。具名去处仍是聊天窗顶部横幅。
  assert.match(
    chat,
    /const announcement = computed\(\(\) => \{/,
    "公告条没有具名 computed 了 —— announcement 失去了呈现入口",
  );
  assert.match(
    chat,
    /chat\.activeAnnouncements\.get\(convId\)/,
    "公告条必须从 activeAnnouncements 缓存取，别退回逐条 JSON.parse",
  );
  assert.match(chat, /announcementVisible/, "公告横幅的可见性判据不见了");
  // poll → **本客户端今天发不出投票**：api 层没有任何发投票的包装。
  // 这条钉的是"发不出去"这个前提本身 —— 哪天真加上入口，它会红，逼着做一次决定，
  // 而不是让新种出来的 poll 静默落在时间线之外（= 复现 #82 的形状）。
  const api = read("../../src/api/index.ts");
  assert.doesNotMatch(
    api,
    /invoke<[^>]*>\(\s*"send_group_poll"/,
    "出现发投票的入口了 ⇒ 先决定 poll 到底在不在时间线渲染，再改 VISIBLE_IN_TIMELINE",
  );
});

test("时间线过滤只有一份判据，且 todo 卡片真的在渲染链里", () => {
  const read = (p: string) => readFileSync(join(here, p), "utf8");
  const chat = read("../../src/components/ChatWindow.vue");
  assert.match(
    chat,
    /filter\(\(m\) => isRenderedInTimeline\(m\.kind\)\)/,
    "ChatWindow 的时间线过滤不再走 isRenderedInTimeline ⇒ 与 store 侧算未读分割线的那份会漂移",
  );
  const item = read("../../src/components/MessageItem.vue");
  assert.match(item, /TodoCardBubble/, "todo 的专门卡片被摘掉了 —— 时间线里会退回原始 JSON");
});

test("强提醒：发起/回执是静默 kind（不计未读、不进时间线、不走普通通知）", () => {
  for (const k of ["remind", "remind_ack"]) {
    assert.ok(SILENT_KINDS.includes(k), `${k} 必须在静默清单里`);
    assert.equal(isSilentKind(k), true);
    assert.equal(isRenderedInTimeline(k), false, `${k} 不进时间线（标识挂在原消息上）`);
    assert.equal(countsTowardUnread(k), false, `${k} 不计未读`);
    assert.ok(isKnownKind(k), `${k} 必须是本机认识的 kind（不能走未知兜底）`);
  }
});

test("isRemindableKind：只有有实质内容的消息可被强提醒；提示行/静默事件不行", () => {
  for (const k of ["text", "code", "image", "file", "merge", "poll", "todo", "announcement"]) {
    assert.equal(isRemindableKind(k), true, `${k} 应当可提醒`);
  }
  for (const k of ["system", "recalled", "remind", "remind_ack", "reaction", "pin", ""]) {
    assert.equal(isRemindableKind(k), false, `${k} 不应当可提醒`);
  }
});

// ---------------- 连续消息分组（2026-10-23） ----------------
// 判定同时决定「间距 / 圆角压平 / 群聊是否重复身份信息」，渲染端与估高端共用一份。

const T0 = 1_700_000_000_000;
const peer = (kind: string, ts: number, senderId = "peer-a") => ({ kind, senderId, ts });

test("groupSide：同人连续三条依次是 first / middle / last，孤立一条是 single", () => {
  const a = peer("text", T0);
  const b = peer("text", T0 + 1000);
  const c = peer("text", T0 + 2000);
  assert.equal(groupSide({ ...a, prev: null, next: b }), "first");
  assert.equal(groupSide({ ...b, prev: a, next: c }), "middle");
  assert.equal(groupSide({ ...c, prev: b, next: null }), "last");
  assert.equal(groupSide({ ...a, prev: null, next: null }), "single");
  // 只有两条：前 first、后 last
  assert.equal(groupSide({ ...b, prev: a, next: null }), "last");
});

test("groupSide：换人 / 超过时间窗 / 非 text-code 都会断开", () => {
  const a = peer("text", T0);
  assert.equal(groupSide({ ...peer("text", T0 + 1000), prev: a, next: null }), "last");
  // 换发送者
  assert.equal(
    groupSide({ ...peer("text", T0 + 1000, "peer-b"), prev: a, next: null }),
    "single",
  );
  // 恰好 5 分钟 = 已断开（与时间分割线同阈值：那边会插一条分割行）
  assert.equal(
    groupSide({ ...peer("text", T0 + GROUP_GAP_MS), prev: a, next: null }),
    "single",
  );
  // 媒体 / 卡片各自是完整一张，不参与合并
  for (const k of ["image", "file", "merge", "todo", "system", "recalled"]) {
    assert.equal(
      groupSide({ ...peer(k, T0 + 1000), prev: a, next: peer("text", T0 + 2000) }),
      "single",
      `${k} 不应当参与连续合并`,
    );
  }
});

test("groupSide：上/下有分割线时强制断开（不跨通栏分割行压圆角）", () => {
  const a = peer("text", T0);
  const b = peer("text", T0 + 1000);
  assert.equal(groupSide({ ...b, prev: a, next: null, breakAbove: true }), "single");
  assert.equal(groupSide({ ...a, prev: null, next: b, breakBelow: true }), "single");
});

test("shouldShowNickname：群聊只在组首显示；单聊/自己/提示行一律不显示", () => {
  const base = { isGroup: true, mine: false, kind: "text" };
  assert.equal(shouldShowNickname({ ...base, atGroupStart: true }), true);
  assert.equal(shouldShowNickname({ ...base, atGroupStart: false }), false);
  // 缺省 = 组首（老调用点行为不变）
  assert.equal(shouldShowNickname(base), true);
  assert.equal(shouldShowNickname({ ...base, isGroup: false }), false);
  assert.equal(shouldShowNickname({ ...base, mine: true }), false);
  assert.equal(shouldShowNickname({ ...base, kind: "system" }), false);
  assert.equal(shouldShowNickname({ ...base, kind: "recalled" }), false);
});

// ---------------- 组内 / 换组的上间距（2026-10-23） ----------------
// 渲染端（MessageItem 的 pt-1.5 / pb-1）与估高端（messageHeight）都取这一个函数。
// 为什么不在 messageHeight 上直接测：它要 `@/utils/*` 别名，node --test 加载不了
// （实测 ERR_MODULE_NOT_FOUND: @/utils）⇒ 能跑真值表的只有这一个零依赖的家。

test("messageTopGap：组首/孤立 6px、组内 0、分割行自己带间距所以是 0", () => {
  assert.equal(MSG_GAP_NEW, 6);
  assert.equal(MSG_GAP_TIGHT, 0);
  for (const side of ["single", "first"] as const) {
    assert.equal(messageTopGap(side, false), 6, `${side} 应给换组间距`);
    assert.equal(messageTopGap(side, true), 0, `${side} 上方有分割行时不叠加间距`);
  }
  for (const side of ["middle", "last"] as const) {
    assert.equal(messageTopGap(side, false), 0, `${side} 应贴住上一条`);
    assert.equal(messageTopGap(side, true), 0);
  }
});

// ---------------- 多选排除表（2026-10-24） ----------------
// §10 要求「待办不参与多选」必须保留，而此前这条规则**没有任何一条判据**：
// `isMultiSelectable` 只有 5 个生产调用点（MessageItem 的勾选框/整行点击/菜单入口 +
// MessageContextMenu 的菜单项与分隔线），测试与探针里一次都没出现过。
// 所以这里钉住两侧：todo 必须被排除；时间线里其余可多选的类型必须仍然可多选
//（把谓词改成 `false` 或顺手多排除一类，都会让这条红）。
test("多选排除表：待办卡片不参与，时间线其余类型仍参与", () => {
  assert.equal(isMultiSelectable("todo"), false, "待办卡片不得进入批量操作");
  for (const kind of ["text", "code", "image", "file", "merge", "system", "recalled"]) {
    assert.equal(isMultiSelectable(kind), true, `${kind} 应可多选`);
  }
});

// ---------------- 转发 / 收藏的动作白名单（2026-10-24） ----------------
// §10 点名「转发严格复用 messageKinds.ts 的类型判断，只允许 text/code/image/file/merge；
// 卡片不能因外观改版获得转发能力」「收藏保持可转发类型 + 卡片白名单」——而这两个谓词
// 此前**零测试引用**（生产侧 9 / 6 处调用，判据侧 0）。两侧一起钉：
//   · 转发**不含卡片**：那是有副作用的动作（跨群转任务得走专用发送路径）；
//   · 收藏**含卡片**：走后端复制内容，无副作用（收藏夹已按卡片补了渲染分支）。
test("转发 / 收藏白名单：卡片可收藏、但不得获得转发能力", () => {
  const forwardable = ["text", "code", "image", "file", "merge"];
  for (const kind of forwardable) {
    assert.equal(isForwardableKind(kind), true, `${kind} 应可转发`);
    assert.equal(isFavoritableKind(kind), true, `${kind} 应可收藏`);
  }
  for (const card of ["todo", "announcement", "poll"]) {
    assert.equal(isForwardableKind(card), false, `${card} 不得获得转发能力`);
    assert.equal(isFavoritableKind(card), true, `${card} 应可收藏（卡片白名单）`);
  }
  for (const kind of ["system", "recalled"]) {
    assert.equal(isForwardableKind(kind), false, `${kind} 不可转发`);
    assert.equal(isFavoritableKind(kind), false, `${kind} 不可收藏`);
  }
});

/**
 * **跨层对账**：前端说"这条能转发"时，后端必须有一条真的接得住的通道
 * （2026-10-29 审计 FUN-01 / DUP-01：`isForwardableKind` 含 `image`，而两条发送命令的
 * 白名单都不收 `"image"` ⇒ 单条转发图片 100% 失败，只有批量那条（走了文件通道）是对的）。
 *
 * 对账口径：可转发的 kind 要么被 `send_message` 的白名单接受，要么属于**文件通道**
 * （`file` / `image`，必须由 `send_file*` 造出来 —— 后端不收 `"image"` 是刻意的）。
 */
test("可转发的每个 kind 都必须有后端通道（发送白名单 ∪ 文件通道）", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const chatRs = readFileSync(join(here, "..", "..", "src-tauri", "src", "commands", "chat.rs"), "utf8");
  // 取 `send_message` 里那段 kind 匹配的左臂字面量。
  const at = chatRs.indexOf("pub async fn send_message(");
  assert.ok(at > 0, "找不到 send_message（对账会空转）");
  const body = chatRs.slice(at, chatRs.indexOf("_ => return Err(", at));
  const whitelist = new Set([...body.matchAll(/^\s*"([a-z_]+)" =>/gm)].map((m) => m[1]));
  assert.ok(whitelist.size >= 5, `只解析出 ${whitelist.size} 个 kind ⇒ 解析器坏了`);

  // 全量 kind = 四张分组的并集（本模块自己就是这么分组的，别再手抄第五份清单）
  const allKinds = [...BUBBLE_KINDS, ...CARD_KINDS, ...SILENT_KINDS, ...TIP_KINDS];
  const forwardable = allKinds.filter((k) => isForwardableKind(k));
  assert.ok(forwardable.length >= 3, "分母太小 ⇒ 判据可能已失效");
  const uncovered = forwardable.filter((k) => !whitelist.has(k) && !isTransferKind(k));
  assert.deepEqual(
    uncovered,
    [],
    `这些 kind 前端说能转发、后端没有任何通道接得住：${uncovered.join(", ")}`,
  );
  // 反控：确认后端确实**不收** image —— 这正是"图必须走文件通道"的原因，
  // 也是本判据存在的理由（两边都收的话这条对账就没有约束力了）。
  assert.equal(whitelist.has("image"), false, "send_message 不该收 image（图片由 send_file* 造）");
});

/**
 * 三个转发落点必须共用 `isTransferKind`（同一份判据），不许再各自写 `kind === "file"`。
 * 这条钉的是 FUN-01 的真实形状：**通道选择的分支**与"能不能转发"的清单对不齐。
 */
test("转发落点：单条 / 批量 / 收藏 三处都按 isTransferKind 选通道", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (rel: string) => readFileSync(join(here, "..", rel), "utf8");
  for (const [rel, label] of [
    ["components/ChatWindow.vue", "聊天窗（单条）"],
    ["components/FavoritePanel.vue", "收藏页"],
    ["components/MessageItem.vue", "消息气泡（发起转发）"],
  ] as const) {
    const src = read(rel);
    assert.match(src, /isTransferKind\(/, `${label} 必须用共享判据选通道`);
    assert.doesNotMatch(
      src,
      /(?:f|msg|m)\.kind === "file" \?/,
      `${label} 还留着"只判 file"的三元式 —— 图片会漏进 send()`,
    );
  }
});

/**
 * **批量逐条转发也要过越权闸**（2026-10-29 审计 DUP-02 的残留）。
 *
 * 后端 `owned_payload_rejection` 只在**给了 `msg_id`** 时才要求「这条路径归这条消息」
 * —— 不给就是"用户自己挑的文件"，放行。单条转发（消息气泡 → 弹窗）一直传，
 * 批量这条漏了 ⇒ 同一份判据在两条入口上一宽一严。
 * 单条那侧一并钉住，否则删掉两边都没人喊。
 */
test("批量逐条转发：两条通道都必须把 msg_id 交给后端（与单条同一道闸）", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "components", "ChatWindow.vue"), "utf8");
  const batch = tsFnBody(src, "async function forwardOne(");
  assert.ok(batch.length > 0, "找不到 forwardOne（判据会空转）");
  const calls = [...batch.matchAll(/chat\.send(?:Group)?FileTo\(((?:[^()]|\([^()]*\))*)\)/g)];
  assert.equal(calls.length, 2, `forwardOne 里应有 2 处发送调用，实际 ${calls.length} ⇒ 判据要跟着改`);
  for (const c of calls) {
    assert.match(c[1], /\bm\.msg_id\b/, `这条通道漏了 msg_id：${c[0]}`);
  }
  const single = tsFnBody(src, "async function doForward(");
  assert.ok(single.length > 0, "找不到 doForward（判据会空转）");
  const singleCalls = [...single.matchAll(/chat\.send(?:Group)?FileTo\(((?:[^()]|\([^()]*\))*)\)/g)];
  assert.equal(singleCalls.length, 2, `doForward 里应有 2 处发送调用，实际 ${singleCalls.length}`);
  for (const c of singleCalls) {
    assert.match(c[1], /\bf\.msgId\b/, `单条转发这条通道漏了 msgId：${c[0]}`);
  }
});

/**
 * **跨层对账：已读推进的排除清单**（2026-10-29 审计 DUP-09）。
 *
 * 同一份判据在 FFI 两侧各写一份是**必要的**（TS 决定乐观列表怎么推、Rust 决定 SQL 怎么更新），
 * 但"必要"不等于"不需要护栏"：这两份一旦漂移，表现是**列表显示已读、库里还是未读**（或反过来），
 * 而且只在本机重读时才看出来。这条把两侧的字面清单逐项比。
 */
test("跨语言契约：已读推进的排除清单两侧逐项一致（DUP-09）", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const ts = readFileSync(join(here, "messages.ts"), "utf8");
  const tsList = /const READ_PROMOTE_BLOCKED = \[([^\]]*)\]/.exec(ts);
  assert.ok(tsList, "找不到 READ_PROMOTE_BLOCKED（判据会空转）");
  const tsItems = [...tsList[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();

  const rs = readFileSync(join(here, "../../src-tauri/src/db/read_receipts.rs"), "utf8");
  const rsList = /status NOT IN \(([^)]*)\)/.exec(rs);
  assert.ok(rsList, "找不到 SQL 里的 NOT IN 清单（判据会空转）");
  const rsItems = [...rsList[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();

  assert.ok(tsItems.length >= 4 && rsItems.length >= 4, "分母太小 ⇒ 解析器坏了");
  assert.deepEqual(tsItems, rsItems, "两侧的已读排除清单必须逐项一致");
});

/**
 * **跨层对账：会话预览的固定文案**（2026-10-29 审计 DUP-12）。
 *
 * `previewBody`（TS，列表显示）与 `preview_text`（Rust，通知与库侧摘要）手抄了同一组
 * `[文件]`/`[图片]`/… 字面量。两侧漂移的代价是"同一句话在列表和通知里不一样"。
 *
 * 只比**独立字符串字面量**（`return "[X]";` 与 `=> "[X]"`），不比模板串与注释：
 * TS 那边的 `[任务] ${title}` 是带正文的模板，Rust 那边对应逻辑在 `todo_preview` 等
 * 三个小函数里 —— 所以把它们的函数体也算进 Rust 一侧。
 */
test("跨语言契约：会话预览的固定文案两侧一致（DUP-12）", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const ts = readFileSync(join(here, "messages.ts"), "utf8");
  const tsBody = ts.slice(ts.indexOf("export function previewBody"), ts.indexOf("export function previewText"));

  /** 取一个 Rust 函数的函数体（按行首 `}` 收尾；本项目这几处没有嵌套到列 0 的花括号）。 */
  const rustFn = (src: string, name: string): string => {
    const at = src.indexOf(`fn ${name}(`);
    assert.ok(at > 0, `protocol.rs 里找不到 ${name}（判据要跟着改）`);
    const endAt = src.indexOf("\n}", at);
    return src.slice(at, endAt < 0 ? src.length : endAt);
  };
  const rsBody = [
    rustFn(protocolRs, "preview_text"),
    rustFn(protocolRs, "todo_preview"),
    rustFn(protocolRs, "poll_preview"),
    rustFn(protocolRs, "announcement_preview"),
  ].join("\n");

  const tsLabels = [...new Set([...tsBody.matchAll(/return "(\[[^\]]{1,8}\])";/g)].map((m) => m[1]))].sort();
  const rsLabels = [
    ...new Set([...rsBody.matchAll(/=> "(\[[^\]]{1,8}\])"(?:\.to_string\(\))?/g)].map((m) => m[1])),
  ].sort();
  assert.ok(tsLabels.length >= 8, `TS 只解析出 ${tsLabels.length} 个预览标签 ⇒ 解析器坏了`);
  assert.deepEqual(tsLabels, rsLabels, "预览文案两侧必须逐项一致");
});
