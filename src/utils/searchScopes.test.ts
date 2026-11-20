import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 搜索的三处口径（用户 2026-11-20 一次性提的 5 件事）：
 *
 * ① **搜索结果页要分得清「人」与「消息」**：
 *    「我搜索的那个关键词…一个用户名是 15，然后很多聊天里面也有 15，
 *      我没法判断这条 15 是到底是这个用户的窗口，还是说那个消息的哪些消息窗口」
 *    ⇒ 人名命中与消息命中必须有**两个带图标的分区标题**，且每行挂一枚**类型徽标**。
 * ② **点结果跳进聊天后要闭环**：搜索界面关掉之后，**聊天界面搜索框里的词要清掉**
 *    （留着会让人以为还在搜这个）。
 * ③ **通讯录里的搜索是下拉过滤**，回车**不弹窗**（弹窗是「消息」页搜索的语义）。
 * ④ **消息列表里的搜索既能搜人也能搜全库消息**（弹窗里两样都有）。
 * ⑤ **搜索框内容能快速清除**。
 *
 * 这一份是**源码形状**守卫（不跑浏览器）：它钉的是"这些入口/出口都存在且接对了"，
 * 形状对了但行为坏了由运行时探针（`check-ui-runtime.mjs` 的 search 段）兜底。
 */

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const dialogSrc = read("../components/search/ChatSearchDialog.vue");
const listSrc = read("../components/ConversationList.vue");
const composableSrc = read("../composables/useSearchKeyword.ts");
const layoutSrc = read("../layouts/ResponsiveLayout.vue");

test("搜索结果页：「人」与「消息」是两个带图标的分区（用户分不清哪条是哪条）", () => {
  // 两个分区标题：人（user-round）与消息（message-circle）。
  // ⚠️ 判据认的是「图标 + 标题」成对出现，不是泛泛地找标题 —— 少一个图标就分不清了。
  assert.match(
    dialogSrc,
    /<Icon\s+name="user-round"[^>]*\/>\s*\n?\s*\{\{ t\("search\.peopleSection"\)\s*\}\}/,
    "人名分区必须有 user-round 图标 + 标题",
  );
  assert.match(
    dialogSrc,
    /<Icon\s+name="message-circle"[^>]*\/>\s*\n?\s*\{\{ t\("search\.messagesSection"\)\s*\}\}/,
    "消息分区必须有 message-circle 图标 + 标题（原来这一区完全没有标题）",
  );
  // 消息分区的标题只在真的有消息命中时才出现（不能空挂一个标题）。
  assert.match(
    dialogSrc,
    /v-if="groups\.length"[\s\S]{0,400}search\.messagesSection/,
    "消息分区标题必须挂在 groups.length 上（没有命中就不该挂标题）",
  );
});

test("搜索结果页：人名行有类型徽标（好友 / 群成员 / 群聊）", () => {
  // 徽标文案必须是三种类型的映射，不许只写一种。
  for (const key of ["search.kindFriend", "search.kindMember", "search.kindGroup"]) {
    assert.ok(dialogSrc.includes(`t("${key}")`), `人名行缺类型徽标文案：${key}`);
  }
  assert.match(
    dialogSrc,
    /function peopleKindLabel\(/,
    "类型徽标必须收在一个函数里（不许在三处各写一遍）",
  );
  // 徽标要真的挂在人名行上。
  assert.match(
    dialogSrc,
    /peopleKindLabel\(p\.kind\)/,
    "人名行必须挂上类型徽标",
  );
});

test("搜索结果页：右栏自报身份（当前会话名 + 该会话的命中数）", () => {
  // 右栏只写全局总数时，用户分不清"这些消息是谁说的"。
  assert.match(
    dialogSrc,
    /activeGroup\.name/,
    "右栏头部必须显示当前会话名",
  );
  assert.match(
    dialogSrc,
    /search\.header[\s\S]{0,120}activeGroup\?\.total/,
    "右栏头部的命中数必须是**该会话**的（不是全库总数）",
  );
});

test("跳转闭环：点搜索结果跳进聊天后，聊天界面搜索框里的词要清掉", () => {
  // 清空出口必须是**唯一**的一份（模块级单例），不然清的是另一处 state。
  assert.match(
    composableSrc,
    /export function clearSearchKeyword\(\)/,
    "搜索词必须有一个明确的清空出口",
  );
  assert.match(
    composableSrc,
    /const keyword = ref\(""\)/,
    "搜索词必须是模块级单例（局部 ref 没法从搜索弹窗那边清掉）",
  );
  // 三条跳转路径都要清：人名结果 / 某条命中 / 「进入聊天」。
  const clears = (dialogSrc.match(/clearSearchKeyword\(\);/g) ?? []).length;
  assert.ok(clears >= 3, `三条跳转路径都要清搜索词（现在只有 ${clears} 处）`);
  // 会话列表卸载时也要复位（模块级单例会跨挂载存活）。
  assert.match(
    listSrc,
    /onUnmounted\([\s\S]{0,400}clearSearchKeyword\(\)/,
    "会话列表卸载时必须复位搜索词（模块级单例跨挂载存活）",
  );
});

test("通讯录的搜索是下拉过滤：回车不弹搜索结果页", () => {
  // 回车在通讯录视图下走的是"打开下拉里高亮的那一条"，**不是** emit('search-history')。
  assert.match(
    listSrc,
    /if \(props\.view === "contacts"\) \{\s*\n?\s*openContactHit\(\);\s*\n?\s*return;/,
    "通讯录视图下回车必须打开下拉候选，不许落到 search-history（那是弹窗路径）",
  );
  // 「只有消息视图才弹窗」按**语义**判：回车分支里，弹窗那条路必须落在 contacts 早退**之后**。
  const enterBody = listSrc.slice(
    listSrc.indexOf("function onSearchEnter"),
    listSrc.indexOf("function openContactHit"),
  );
  assert.ok(
    enterBody.includes('emit("search-history"'),
    "回车分支里必须有弹窗那条路（消息视图用）",
  );
  assert.ok(
    enterBody.indexOf('props.view === "contacts"') < enterBody.indexOf('emit("search-history"'),
    "通讯录的早退必须排在弹窗之前（否则通讯录回车也会弹窗）",
  );
  // 下拉必须真的存在（Popover + 候选列表）。
  assert.match(listSrc, /<PopoverRoot/, "通讯录搜索必须有下拉浮层（Popover）");
  assert.match(
    listSrc,
    /data-contact-hit/,
    "下拉候选必须可点（每行一个 data-contact-hit）",
  );
});

test("通讯录：搜索结果只进下拉，列表本体不被替换（浏览态保持）", () => {
  // 2026-11-20 之前：搜索时整列被平铺结果替换（friendGroups 返回 []）⇒ 浏览上下文被换掉。
  assert.ok(
    !/query\.value\.trim\(\) \? \[\] : groupByInitial/.test(listSrc),
    "通讯录的分组浏览态不许再因搜索而清空（结果只进下拉）",
  );
  assert.match(
    listSrc,
    /groupByInitial\(allFriends\.value/,
    "分组必须按**全量**通讯录算（与过滤后的候选列表分开）",
  );
});

test("搜索框能快速清除（清除按钮 + 焦点回到输入框）", () => {
  assert.match(
    listSrc,
    /v-if="keyword"[\s\S]{0,400}@click="clearSearchInput"/,
    "会话列表的搜索框必须有清除按钮（有内容才出现）",
  );
  assert.match(
    listSrc,
    /:aria-label="t\('search\.clear'\)"/,
    "清除按钮必须有 aria-label（图标按钮的可访问名）",
  );
  assert.match(
    listSrc,
    /function clearSearchInput\(\)[\s\S]{0,300}searchInput\.value\?\.focus\(\)/,
    "清空后焦点要回到输入框（可以立刻改一个词重搜）",
  );
});

test("反例自证：撤掉任一入口都必须被上面这些判据抓到", () => {
  // ① 去掉人名分区的图标 ⇒ 上面第 1 条必须红。
  const noIcon = dialogSrc.replace(
    /<Icon\s+name="user-round"[^>]*\/>/,
    "",
  );
  assert.notEqual(noIcon, dialogSrc, "反例自证：user-round 图标没被替换到，锚点已漂");
  assert.ok(
    !/<Icon\s+name="user-round"[^>]*\/>\s*\n?\s*\{\{ t\("search\.peopleSection"\)\s*\}\}/.test(noIcon),
    "去掉人名分区图标后判据竟然还绿 ⇒ 这条判据在空转",
  );

  // ② 去掉消息分区标题 ⇒ 第 1 条必须红。
  const noMessagesSection = dialogSrc.replace('t("search.messagesSection")', '"消息记录"');
  assert.notEqual(noMessagesSection, dialogSrc, "反例自证：消息分区标题没被替换到");
  assert.ok(
    !/search\.messagesSection/.test(noMessagesSection),
    "去掉消息分区标题后判据竟然还绿 ⇒ 这条判据在空转",
  );

  // ③ 把「回车弹窗」的守卫去掉 ⇒ 通讯录那条必须红。
  const enterAlwaysModal = listSrc.replace(
    /if \(props\.view === "contacts"\) \{\s*\n?\s*openContactHit\(\);\s*\n?\s*return;/,
    "",
  );
  assert.notEqual(enterAlwaysModal, listSrc, "反例自证：通讯录回车分支没被替换到");
  assert.ok(
    !/if \(props\.view === "contacts"\) \{\s*\n?\s*openContactHit\(\);\s*\n?\s*return;/.test(enterAlwaysModal),
    "撤掉通讯录回车分支后判据竟然还绿 ⇒ 这条判据在空转",
  );
});
