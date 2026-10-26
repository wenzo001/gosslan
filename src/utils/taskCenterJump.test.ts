import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { escapeRe } from "./escapeRe.ts";

/**
 * 任务中心「去会话」的接线判据。
 *
 * 为什么这一半只能钉源码（而另一半在 CDP 探针里）：真实反馈（负责人 2026-10-26）是
 * 「不报错了，但没跳到对应会话；手动进去之后那条消息倒是高亮的」—— store 那一半做了
 * （`openConversation` 写了 activeConv、`locateInLoaded` 标了消息），**屏幕没换**。
 * 而"哪一屏可见"的权威是路由：`ResponsiveLayout` 的 `navState = navOfRoute()`，
 * `ChatWindow` 只在 `navState === 'chats' && chat.activeConv` 下渲染。只写 store 不落路由，
 * 用户站在收藏/联系人那一屏时就正好是这句现象。
 *
 * 探针判不了这一半：给挂载的组件挂上应用那份 `mainRouter` 实例之后，同页里真实应用与探针应用
 * 共用同一个 router、两套 pinia，实测把隔壁格子的 `chat.operations` 从 6 读成 1（2026-10-26 试过，
 * 结论记在 `check-ui-runtime.mjs` 的 opscenter 段注释里）。所以路由这一半在这里钉，
 * "到达 + 不许把快照没到说成不存在"那一半由 `--only=opscenter` 的形状 A/B/C 三格钉。
 *
 * 同族先例：`friendChatAction.test.ts` 用同一形状钉「发起聊天必须落 URL」。
 */
const root = join(import.meta.dirname, "..", "..");
const jump = readFileSync(join(root, "src/components/TaskCenter.vue"), "utf8");
const groupCreate = readFileSync(join(root, "src/components/GroupCreateModal.vue"), "utf8");

/** 只取 `<script>` 那一段并去掉整行注释：模板里的 `@close="…"` 与判据自己的注释都不该被算进来。 */
function scriptOnly(src: string): string {
  const end = src.indexOf("</script>");
  return src.slice(0, end < 0 ? src.length : end).replace(/^[ \t]*\/\/.*$/gm, "");
}
const jumpScript = scriptOnly(jump);
const groupScript = scriptOnly(groupCreate);

test("任务中心「去会话」必须两步齐全：打开会话 + 把路由落到那个会话", () => {
  assert.match(jump, /const router = useRouter\(\);/, "组件必须拿到 router（跳转的权威在路由不在 store）");
  assert.match(
    jump,
    /chat\.openConversation\(cid\)/,
    "必须真的打开那个会话（store 那一半：写 activeConv、拉消息、补建会话行）",
  );
  assert.match(
    jump,
    /router\.push\(\{ name: "conversation", params: \{ convId: cid \} \}\)/,
    "必须把 URL 落到那个会话 —— 少了这一半就是「不报错但屏幕没换」",
  );
});

test("顺序与唯一权威：先起 openConversation 再落路由，且不再手写 mobileView", () => {
  const at = jump.indexOf("const opening = chat.openConversation(cid);");
  const push = jump.indexOf('router.push({ name: "conversation", params: { convId: cid } })');
  assert.ok(at > 0 && push > at, "路由必须紧跟在 openConversation 之后（同一 tick）：`openConversation` 第一行同步写 activeConv，路由 watcher 看到已打开就跳过，不会重复拉一次消息");
  // `app.mobileView` 是这条路由的派生值（ResponsiveLayout 里 `mobileView` computed + watcher 写回），
  // 组件再手写一份 = 两份权威，watcher 一跑就把刚写的那个值盖掉。
  assert.ok(
    !/app\.mobileView\s*=/.test(jump),
    "TaskCenter 不许再手写 `app.mobileView`：移动端那一屏由路由算出来",
  );
});

test("判「不存在」之前必须先向真源补读（快照没到 ≠ 群不存在）", () => {  const src = jump.replace(/^[ \t]*\/\/.*$/gm, "");
  const first = src.indexOf("if (!listsReady()) await readListsFromSource(");
  const second = src.indexOf("if (chat.activeConv === cid && !rowVisible && !groupVisible)");
  assert.ok(first > 0, "打开之前那份快照没到位时必须先补读真源（旧写法是 waitUntil 旗标 ⇒ 等满 3 秒再拿空快照判）");
  assert.ok(second > first, "打开之后仍然看不见目标时，也必须再读一次真源才允许定性");
  assert.ok(
    /noteJumpFailure\("active-mismatch"/.test(src) && /noteJumpFailure\("not-in-source"/.test(src),
    "两种失败必须分开留痕（没到达 = error；真源里没有 = info），否则下一次报告还是只能靠猜",
  );
});

/**
 * 「先关弹窗、再跳路由」会把刚推进的会话页原路退回 —— 这一格不是推测，是这个仓库
 * 2026-10-23 已经实地踩过一次的那条（`useBackLayer.ts` 顶部注释把教训写死了）：
 *
 *   `BaseModal` 的 `backLayer` 默认 true ⇒ 弹窗一打开就压了一条**同 URL** 的历史条目；
 *   `app.closeTaskCenter()` / `emit("close")` 让 `useBackLayer` 的 watcher 释放那一层，
 *   释放里会调 `history.back()`。而 Vue 的 watcher 跑在微任务里，**早于** vue-router 写历史条目，
 *   于是 back() 排在推送之后执行 ⇒ 人退回原来那一屏（收藏/通讯录）。
 *   症状正是负责人的第二份报告：「不报错了，但屏幕没换」—— store 与路由两半都做了，
 *   跳转却被打回。
 *
 * 修法是同族已验证的那一份（`ResponsiveLayout.openChatFromFriend`）：**await 导航落历史，
 * `finally` 里再关弹窗**。URL 变了之后 `browserPort.back()` 自己就只摘登记、不退历史。
 */
test("★ 跳转必须等路由落历史之后再关弹窗（否则弹窗那层返回键会把跳转撤销）", () => {
  // 前提现读不手抄：默认值一旦被改掉，下面这条顺序判据就失去意义，要回来重判。
  const base = readFileSync(join(root, "src/components/BaseModal.vue"), "utf8");
  assert.match(base, /backLayer: true/, "前提：BaseModal 的返回层默认开启（弹窗会压一条同 URL 历史条目）");

  const cases = [
    { name: "TaskCenter", src: jumpScript, close: "app.closeTaskCenter();", push: 'await router.push({ name: "conversation", params: { convId: cid } })' },
    { name: "GroupCreateModal", src: groupScript, close: 'emit("close");', push: 'await router.push({ name: "conversation", params: { convId: `group:${g.id}` } })' },
  ];
  for (const c of cases) {
    const at = c.src.indexOf(c.push);
    const close = c.src.indexOf(c.close);
    assert.ok(at > 0, `${c.name}: 跳转必须 await（不 await 就不知道历史条目何时落定）`);
    assert.ok(
      close > at,
      `${c.name}: 关弹窗(${c.close})必须排在路由落地之后 —— 先关会让 useBackLayer 的 history.back() 撤销这次跳转`,
    );
    assert.match(
      c.src,
      new RegExp(`finally\\s*\\{[^}]*${escapeRe(c.close)}`),
      `${c.name}: 关弹窗要放在 try/finally 里 —— 导航被守卫挡掉时弹窗也得关得上`,
    );
  }
});

/**
 * 同族第二个入口（负责人 2026-10-26 拍板"一起收"）：建群成功后也是只写了 store 那一半。
 * 那个场景看不出来（刚建完群本来就在聊天那一屏），但同一件事不该有两套口径 ——
 * 少一半的代价是"以后谁把这个弹窗挪到别的屏打开，建完群就不跳"。
 */
test("建群成功那一步同样必须两步齐全（store + 路由）", () => {
  const modal = readFileSync(join(root, "src/components/GroupCreateModal.vue"), "utf8");
  assert.match(modal, /const router = useRouter\(\);/, "GroupCreateModal 必须拿到 router");
  assert.match(
    modal,
    /chat\.openConversation\(`group:\$\{g\.id\}`\)/,
    "建完群必须打开那个群的会话（store 那一半）",
  );
  assert.match(
    modal,
    /router\.push\(\{ name: "conversation", params: \{ convId: `group:\$\{g\.id\}` \} \}\)/,
    "建完群必须把 URL 落到那个会话 —— 与任务中心/会话列表同一口径",
  );
});
