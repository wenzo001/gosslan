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
