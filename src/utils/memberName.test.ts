/**
 * `resolveMemberName` 的行为判据（用户 2026-10-14：「操作记录名字同步，有时候还会显示设备名，会变」）。
 *
 * 每条都只换一个输入，成对交付：
 *  · 「查不到 ⇒ 未知成员」与「查得到 ⇒ 不出现未知成员」是一对；
 *  · 「备注优先」与「没有备注才轮到自报」是一对；
 *  · 「自己用昵称」与「自己没昵称才写『我』」是一对。
 * 单独一条正例只能证明"它返回了点什么"，证明不了"顺序/兜底"这两件真正会错的事。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { memberIdTail, resolveMemberName, MEMBER_ID_TAIL_LEN } from "./memberName.ts";
import { zhCN } from "../i18n/locales/zh-cn.ts";
import { enUS } from "../i18n/locales/en-us.ts";

const TEXT = { me: "我", unknownMember: "未知成员" };
const SELF = "gosslan-aaaaaaaaaaaa1111";
const OTHER = "gosslan-bbbbbbbbbbbb2222";

test("查不到任何人：显示「未知成员 + id 后四位」，绝不出现裸 id 全串", () => {
  const name = resolveMemberName(OTHER, { selfId: SELF }, TEXT);
  assert.equal(name, `未知成员 ${memberIdTail(OTHER)}`);
  assert.ok(!name.includes(OTHER), "兜底里不许出现整串 device_id —— 用户看到的「设备名」就是它");
  assert.equal(memberIdTail(OTHER).length, MEMBER_ID_TAIL_LEN, "尾巴位数是钉死的呈现口径");
});

test("尾巴位数：短 id 原样返回（不许把 'ab' 截成 'ab'以外的形状）", () => {
  assert.equal(memberIdTail("ab"), "ab");
  assert.equal(memberIdTail("abcdefg"), "defg");
});

test("好友备注优先于对方自报的昵称", () => {
  const name = resolveMemberName(OTHER, { selfId: SELF, friendNickname: "老王", peerNickname: "Wang-PC" }, TEXT);
  assert.equal(name, "老王");
});

test("没有备注时才轮到在线自报（只换 friendNickname 这一个输入）", () => {
  const name = resolveMemberName(OTHER, { selfId: SELF, peerNickname: "Wang-PC" }, TEXT);
  assert.equal(name, "Wang-PC");
});

test("空白值不算「有名字」：自报一个空格昵称必须落到未知成员那一支", () => {
  const name = resolveMemberName(OTHER, { selfId: SELF, peerNickname: "   " }, TEXT);
  assert.ok(name.startsWith(TEXT.unknownMember), `空白昵称该被当没有，实际得到 ${JSON.stringify(name)}`);
});

test("本机自己：有昵称用昵称", () => {
  const name = resolveMemberName(SELF, { selfId: SELF, selfNickname: "我的笔记本" }, TEXT);
  assert.equal(name, "我的笔记本");
});

test("本机自己：没昵称写「我」，不写 id（只换 selfNickname 这一个输入）", () => {
  const name = resolveMemberName(SELF, { selfId: SELF, selfNickname: "  " }, TEXT);
  assert.equal(name, TEXT.me);
});

test("空 id 返回空串（调用方靠这一点区分「没有发送者」）", () => {
  assert.equal(resolveMemberName("", { selfId: SELF }, TEXT), "");
});

test("同一个人两次问同一个来源 ⇒ 同一个答案（一处家的那一半证明）", () => {
  const src = { selfId: SELF, friendNickname: "老王" };
  assert.equal(resolveMemberName(OTHER, src, TEXT), resolveMemberName(OTHER, src, TEXT));
});

// ↓ 这三条是一组：只换 `snapshotNickname` 这一个输入，钉的是「重启/离线后名字别变回去」。
test("人不在线但本机上次见过 ⇒ 用上次那个名字（用户报的「会变」那一半）", () => {
  const name = resolveMemberName(OTHER, { selfId: SELF, snapshotNickname: "Wang-PC" }, TEXT);
  assert.equal(name, "Wang-PC");
});

test("上次也没见过 ⇒ 才落到未知成员（只换 snapshotNickname 这一个输入）", () => {
  const name = resolveMemberName(OTHER, { selfId: SELF, snapshotNickname: "" }, TEXT);
  assert.ok(name.startsWith(TEXT.unknownMember), `空快照不该算"见过"，实际得到 ${JSON.stringify(name)}`);
});

test("本机备注压过上次见到的名字（备注是我起的，不该被缓存顶掉）", () => {
  const name = resolveMemberName(OTHER, { selfId: SELF, friendNickname: "老王", snapshotNickname: "Wang-PC" }, TEXT);
  assert.equal(name, "老王");
});

/**
 * 跨语言契约：后端那份 `resolve_nickname`（`src-tauri/src/network/transport/member_notices.rs`）
 * 与这里必须是**同一条兜底**。
 *
 * 为什么值得钉：显示名以前有三个家，前端两个在 4.38.2 收了，后端那一份还写着自己的顺序，
 * 而它的兜底是 `device_id` 原文。后端拿它构造的是**落库**的群系统消息
 * （「X 加入了群聊」）与受众提示里"任务"那一格 ⇒ 界面出现设备标识的那一半根本不在前端这条路上。
 * 两侧漂移是静默的：TS 单测全绿、Rust 单测全绿，用户看到的仍然是 `gosslan-xxxx`。
 *
 * 钉三件事：尾部位数同值、中英两份"未知成员"措辞逐字一致（i18n 与 Rust 各一份，谁改都要红）。
 */
test("跨语言契约：后端兜底与这里的位数/措辞同一条", () => {
  const rs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../src-tauri/src/network/transport/member_notices.rs"),
    "utf8",
  );
  const tailM = rs.match(/pub const MEMBER_ID_TAIL_LEN: usize = (\d+)/);
  assert.ok(tailM, "member_notices.rs 里找不到 MEMBER_ID_TAIL_LEN ⇒ 后端那份搬家或改名，判据要跟着改");
  assert.equal(Number(tailM[1]), MEMBER_ID_TAIL_LEN, "id 尾巴位数两侧必须同值");

  const labelM = rs.match(/format!\("([^"]+) \{\}"/g) ?? [];
  const zhLabels = labelM.map((s) => (s.match(/format!\("([^"]+) \{\}"/) ?? [])[1]).filter(Boolean);
  assert.ok(zhLabels.length >= 2, `后端"未知成员"那一支的文案字面量少于两份（实得 ${zhLabels.length}）⇒ 中英有一边被删`);
  // 与 i18n 逐字对账：一门语言对不上就红（不许按"文件里有无中文"判是哪一门）。
  assert.ok(zhLabels.includes(zhCN["common.unknownMember"]), `后端中文兜底与 i18n 不一致: ${zhLabels.join(" / ")}`);
  assert.ok(zhLabels.includes(enUS["common.unknownMember"]), `后端英文兜底与 i18n 不一致: ${zhLabels.join(" / ")}`);
  // 反证的正面对写法：后端那**一个入口**必须把判断交给纯函数。判"不许出现某字面量"会漏
  //（旧写法 `return n; } id.to_string() }` 就不长得像任何一种固定形状），而"必须委托"这条
  // 只要有人把判断抄回入口就会红。
  //
  // ⚠️ 用**花括号配对切函数体**而不是定长窗口：`resolve_nickname` 的取数有五条锁链，
  // 窗口太短会读到函数体外（本次实测 900 字符就假红过一次），太宽又会跨进下一个函数体。
  const body = sliceFnBody(rs, "pub fn resolve_nickname");
  assert.ok(body !== null, "member_notices.rs 里找不到 pub fn resolve_nickname ⇒ 入口搬家，这条判据失去落点");
  const callAt = body!.lastIndexOf("pick_member_display_name(");
  assert.ok(
    callAt >= 0,
    "resolve_nickname 不再委托 pick_member_display_name ⇒ 显示名判据出现第二个家",
  );
  // 「调用点还在」不等于「返回的那条路是它」：实测两条假绿 ——
  //  · 在委托之前插一条 `if true { return id.to_string(); }`，上一条照样绿；
  //  · 把委托降级成 `let _ = 调用; id.to_string()`（返回值变成裸 id），上一条也照样绿。
  // 所以补两条窄判据：入口里不许出现"把裸 id 当结果返回"的语句，且**调用必须是函数体末尾那个表达式**
  //（调用之后除了空白不许再有代码，调用之前除了上一条语句的分号也不许夹别的东西）。
  assert.doesNotMatch(
    body!,
    /return\s+id\b/,
    "resolve_nickname 里出现 `return id…`：查不到的人会把设备标识当名字返回（用户报的那一格）",
  );
  const after = matchParen(body!, callAt + "pick_member_display_name".length);
  assert.ok(after >= 0, "委托调用的实参括号没闭合 ⇒ 这份源码形状已经不是本判据认识的那种");
  assert.equal(
    body!.slice(after + 1).trim(),
    "",
    "委托调用之后还有别的代码 ⇒ 返回值不再是纯函数的结果（第二条家换了位置）",
  );
});

// ↓↓↓ 这两格管的是**入口**，上面那些管的是纯函数本身。
/**
 * 跨入口契约（前端这一侧）：`useChatStore.nicknameOf` 必须把判断**交给** `resolveMemberName`。
 *
 * 为什么不能只测纯函数（用户 2026-10-14：「操作记录名字同步，有时候还会显示设备名，会变」）：
 * 缺陷当时的形状是"入口自己写了一遍顺序 + 自己兜 `return id`"，那时纯函数根本不存在；
 * 反过来今天只测纯函数的话，有人把判断抄回入口 ⇒ 这一册全绿而用户看到的仍是 `gosslan-xxxx`。
 * 与上面那条钉**后端**入口（`resolve_nickname`）的是同一族判据，两条各管一个入口，
 * 缺一条就是半个守卫。
 *
 * 反例能力（本轮实测两句都真红过，形状写在 `docs/migration-ledger.md` 那一行里）：
 *  · 把委托摘掉、退回 `return id;` ⇒ 红在"必须委托"那一格；
 *  · 委托之后另起一条 `return id;` ⇒ 红在"调用之后不许再有代码"那一格；
 *  · 委托之前插一条 `if (!f && !p) return id;` ⇒ 红在"裸 id 不许出现在返回位"那一格。
 */
test("入口委托：nicknameOf 必须把判断交给 memberName.ts 那一个家", () => {
  const at = (rel: string) => join(dirname(fileURLToPath(import.meta.url)), rel);
  const body0 = sliceFnBody(readFileSync(at("../stores/useChatStore.ts"), "utf8"), "function nicknameOf(");
  assert.ok(body0 !== null, "useChatStore.ts 里找不到 `function nicknameOf(` ⇒ 入口搬家，这条判据失去落点");
  // 先去掉整行注释：那两段注释里**复述了**"这里返回裸 device_id"，留着它既能把反例判成绿、
  // 也能把正例判成红（本仓那条"注释里复述被断言句"的旧账同族）。
  const body = body0!.replace(/^[ \t]*\/\/.*$/gm, "");
  assert.match(body, /return\s+resolveMemberName\(/, "nicknameOf 不再委托 resolveMemberName ⇒ 显示名判据长出第二个家");
  const call = body.lastIndexOf("resolveMemberName(");
  const close = matchParen(body, call + "resolveMemberName".length);
  assert.ok(close >= 0, "委托调用的实参括号没闭合 ⇒ 这份源码形状已不是本判据认识的那种");
  // 「调用点还在」不等于「返回的是它」：调用之后除一个分号不许再有代码。
  assert.equal(body.slice(close + 1).trim(), ";", "委托调用之后还有别的代码 ⇒ 返回的不再是纯函数那个结果");
  // 裸 id 兜底的两种真实写法（第一种就是修之前那一支）：`return id` / `… || id` / `… ?? id`。
  assert.doesNotMatch(body, /return\s+id\b/, "nicknameOf 里出现 `return id…`：查不到的人会把设备标识当名字返回");
  assert.doesNotMatch(body, /(\|\||\?\?)\s*id\b/, "nicknameOf 里出现 `|| id`／`?? id`：第二个兜底家又长回来了");
  // 兜底措辞必须来自 i18n 那一个家（不许在入口里手打一份"未知成员"）。
  const flat = body.replace(/\s+/g, " ");
  assert.ok(
    flat.includes('unknownMember: t("common.unknownMember")'),
    "nicknameOf 没把 i18n 的「未知成员」措辞交给纯函数 ⇒ 兜底文案出现第二个家",
  );
});

/**
 * 消费侧不许再有第二个兜底家：两个读名字的地方都必须止步于那一个家。
 *
 *  · `MessageItem.vue` 的头像取色名原来写的是 `… || chat.nicknameOf(…) || props.message.sender_id`
 *    —— `nicknameOf` 判不到时给的是「未知成员 abcd」，**永远非空**，再接一次既把设备标识送进
 *    取色（同一个人两处颜色分叉），又把兜底抄进第三个家。
 *  · `useMemberProfile.ts` 原来自己写过一遍「自己 → 好友表 → 在线节点表 → 兜底」，而且兜底与
 *    store 不同形（那边返回裸 device_id、这边对自己返回「我」）⇒「聊天里的名字和操作记录里的
 *    名字不一样」就是这么来的。现在它只许取 `nicknameOf` 的结果，不许在返回处重新判名字。
 *
 * ⚠️ 这两格判的是**形状**（第二个家不许长回来），不是运行时行为 —— 行为那半边由上面的真值表用例管。
 * 本仓没有任何测试构造过 `AppState` / pinia store，所以这里也**不声称**有入口级的端到端覆盖。
 */
test("消费侧不再兜裸 id：头像取色名与资料页都止步于那一个家", () => {
  const at = (rel: string) => join(dirname(fileURLToPath(import.meta.url)), rel);
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|^[ \t]*\/\/.*$/gm, "");

  const vue = readFileSync(at("../components/MessageItem.vue"), "utf8");
  const from = vue.indexOf("const avatarName");
  assert.ok(from >= 0, "MessageItem.vue 里找不到 `const avatarName` ⇒ 那一格搬家/改名，这条判据失去落点");
  // 切片按"下一个顶层 const"收口，不用定长窗口：窗口跨进邻规则就会误判（本仓那条旧账）。
  const to = vue.indexOf("\nconst ", from + 1);
  assert.ok(to > from, "avatarName 之后找不到下一个顶层 `const` ⇒ 切片边界判不出来，本判据认识的那种形状已变");
  const seg = stripComments(vue.slice(from, to));
  assert.match(seg, /chat\.nicknameOf\(/, "头像取色名不再走 nicknameOf ⇒ 名字来源长出第二个家");
  assert.doesNotMatch(
    seg,
    /(\|\||\?\?)\s*(?:props\.)?(?:message\.)?sender_id\b/,
    "取色名后面又接了裸 sender_id 兜底 ⇒ 第二个家 + 同一个人两处颜色分叉",
  );

  const profile = readFileSync(at("../composables/useMemberProfile.ts"), "utf8");
  const fn = sliceFnBody(profile, "function memberProfile(");
  assert.ok(fn !== null, "useMemberProfile.ts 里找不到 `function memberProfile(` ⇒ 入口搬家，这条判据失去落点");
  const fnBody = stripComments(fn!);
  assert.match(fnBody, /chat\.nicknameOf\(/, "资料页不再走 nicknameOf ⇒ 显示名判据长出第二个家");
  assert.doesNotMatch(fnBody, /name:\s/, "memberProfile 在返回处重新判了名字（只许用那一次委托的结果）");
  assert.doesNotMatch(fnBody, /(\|\||\?\?)\s*id\b/, "memberProfile 里出现 `|| id`／`?? id`：裸设备标识的兜底回来了");
});

/** 从 `open` 这个 `(` 出发，按配对找到它自己的 `)`，返回其下标（找不到返回 -1）。 */
function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 按花括号配对切出一个函数体的原文（从签名之后的第一个 `{` 到与之配对的 `}`）。 */
function sliceFnBody(src: string, sig: string): string | null {
  const at = src.indexOf(sig);
  if (at < 0) return null;
  const open = src.indexOf("{", at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}
