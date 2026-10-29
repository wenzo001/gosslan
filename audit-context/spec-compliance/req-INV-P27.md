## REQ-INV-P27 — 「用户在看这个会话」只有一个口径，抑制必须共用它

> "凡是**因为"用户正在看这个会话"而抑制某个提醒**的地方 —— 「有人@我」红点、标记已读、系统通知、
> （将来若有）角标降噪 —— 判的必须是**同一份**可见性口径，不许各取一个条件子集。
> ...规则：
> * **口径只有一个家**：`useChatStore::chatViewerLooking()`。消费者只许调用它，不许在自己的条件里
>   重写 `!document.hidden && app.chatVisible` 这个组合（组合出现 >1 次即判红，见钩子）。
> * **纯判定不许自己读 DOM**：摄入层的规则住在 `utils/messages.ts::freshMentionedConvs`，
>   可见性由调用方以 `activeVisible` 传进来。
> * **缺省值只能选"更安静"的那一侧**：`activeVisible` 缺省为 `true`（= 沿用修复前的"开着就抑制"）。
> ⚠️ 边界（这几句要一起读）：本条只管**抑制**；红点是**摄入时刻的一次性判定**、不落库 ⇒ 重启不重放；
> "用户真的在看"**不等于**"消息已送达"。"
> — docs/protocol-invariants.md §26（INV-P27 紧接 INV-P26）/ INV-P27, line 1239

**Verdict:** partial · confidence: high

**What this demands of an implementation:** 所有"因为用户正在看这个会话而抑制提醒"的地方必须判**同一份**可见性口径，不许各取一个条件子集；口径只有一个家（`chatViewerLooking()`）；摄入层的纯判定不许自己读 DOM，可见性由调用方传入；缺省值必须偏"更安静"。

**Where enforcement lives:**

口径的家：

```ts
// src/stores/useChatStore.ts:1097-1099
function chatViewerLooking(): boolean {
  return !document.hidden && app.chatVisible;
}
```

消费者 1（标记已读）：

```ts
// src/stores/useChatStore.ts:2971-2982
const debounceMarkRead = (convId: string) => {
  if (markReadTimer) clearTimeout(markReadTimer);
  markReadTimer = setTimeout(() => {
    markReadTimer = null;
    // 这份口径的家是 `chatViewerLooking()` —— 「有人@我」那条也读它，不许在这里再手写一遍。
    if (activeConv.value !== convId || !chatViewerLooking()) return;
    void api.markRead(convId).then(() => clearUnreadLocally(convId));
  }, 300);
};
```

消费者 2（红点）：

```ts
// src/stores/useChatStore.ts:865-867
for (const cid of freshMentionedConvs(newByConv, activeConv.value, { id: myId, name: myName },
  { alsoMentionsMe: (rec) => todoMentionsMe(rec, myId), activeVisible: chatViewerLooking() })) {
```

纯判定（不读 DOM）：

```ts
// src/utils/messages.ts:583-601
export function freshMentionedConvs(
  freshByConv: Map<string, MessageRecord[]>,
  activeConvId: string | null,
  me: { id: string; name: string },
  opts: { alsoMentionsMe?: (rec: MessageRecord) => boolean; activeVisible?: boolean } = {},
): string[] {
  const out: string[] = [];
  for (const [cid, fresh] of freshByConv) {
    if (cid === activeConvId && opts.activeVisible !== false) continue;
    ...
  }
}
```

- What it checks, and against what：`activeVisible` 缺省 `undefined` ⇒ `opts.activeVisible !== false` 为真 ⇒ **缺省偏"安静"**（抑制红点）✓。`messages.ts` 里**没有** `document` / `window` 引用 ⇒ 纯判定不读 DOM ✓。
- Which paths reach it, and which do not：`freshMentionedConvs` 只被 `useChatStore.ts:865` 一处调用；`chatViewerLooking()` 被两处调用（`:866` 与 `:2979`）。

**形状守卫（"组合出现 >1 次即判红"）：**

```ts
// src/utils/designGuards.test.ts:2147-2162
assert.ok(
  /activeVisible:\s*chatViewerLooking\(\)/.test(storeSrc),
  "红点那条没把「在不在看」传进 freshMentionedConvs ⇒ 退回「开着就等于看着」…",
);
const hiddenHits = storeSrc.split("!document.hidden && app.chatVisible").length - 1;
assert.equal(hiddenHits, 1, `「!document.hidden && app.chatVisible」这个组合在 store 里出现 ${hiddenHits} 次（应为 1 次，只在 chatViewerLooking 那一处）⇒ 这条口径又分出第二个家…`);
const lookerUses = storeSrc.split("chatViewerLooking()").length - 1;
assert.ok(lookerUses >= 2, `chatViewerLooking() 只被引用 ${lookerUses} 次 ⇒ 已读与红点两条没有真的共用这份口径（定义那一处不计）`);
```

**⚠️ 但系统通知那一路没有共用它：**

```ts
// src/stores/useChatStore.ts:326
if (!document.hidden && document.hasFocus() && activeConv.value === last.conv_id) continue;
// src/stores/useChatStore.ts:481
if (!document.hidden && document.hasFocus() && activeConv.value === rec.conv_id) {
// src/stores/useChatStore.ts:500
if (!document.hidden && document.hasFocus() && activeConv.value === rec.conv_id) return;
// src/stores/useChatStore.ts:661
const viewing = !document.hidden && document.hasFocus() && activeConv.value === rec.conv_id;
```

这四处是**系统通知的抑制**判定（`flushNotifications` 的 `:326`、`maybeNotify` 的 `:481` 与 `:500`、强提醒的 `:661`）。它们用的是 `!document.hidden && document.hasFocus() && activeConv.value === conv_id` —— **不是** `chatViewerLooking()`，而是**另一个条件子集**（多了 `document.hasFocus()`，且**不含** `app.chatVisible`）。

**Paths walked:**
- 标记已读 → `debounceMarkRead` → `chatViewerLooking()` ✓ 与红点同口径
- 「有人@我」红点 → `freshMentionedConvs(..., { activeVisible: chatViewerLooking() })` ✓ 与已读同口径
- **系统通知（普通消息）** → `maybeNotify`（`useChatStore.ts:500`）用 `!document.hidden && document.hasFocus() && activeConv.value === rec.conv_id` ⇒ **第三个条件子集** ✗
- **系统通知（去抖批）** → `flushNotifications`（`:326`）同上 ✗
- **系统通知（任务完成）** → `:481` 同上 ✗
- **强提醒通知** → `:661` 同上 ✗

三个条件子集的实际差异（同一瞬间可能给出相反答案）：
- `chatViewerLooking()` = `!document.hidden && app.chatVisible`。`app.chatVisible`（`src/stores/useAppStore.ts:295-297`）= 桌面端恒 `true`；移动端 = `mobileView === "chat" && !mobileChatObscured`（聊天视图真的可见且没被整页浮层盖住）。
- 通知那一路 = `!document.hidden && document.hasFocus()`（**不含** `app.chatVisible`）⇒ 移动端上聊天页被整页浮层盖住时，通知那一路**会**抑制（因为 `hasFocus()` 仍为真），而 `chatViewerLooking()` 为 **false** ⇒ 已读与红点都判定"没在看" ⇒ **三条规则对同一瞬间给出不同答案**。这正是文档点名的缺陷形状（"两处各写一遍，迟早只改一处"）。

文档自身的表格（`:1247-1251`）如实记着这个历史形状：

| 抑制的是什么 | 当时取的条件 | 强弱 |
|---|---|---|
| 系统通知 | `!document.hidden && document.hasFocus() && 正是这个会话` | 严 |
| 标记已读 | `!document.hidden && app.chatVisible` | 严 |
| 「有人@我」红点 | **只比 `activeConv`** | ★ 最弱 = 缺陷 |

文档把"最弱那条"判成缺陷并要求全部共用同一口径 ⇒ **系统通知那一路也应当共用**。代码只统一了「已读 + 红点」两条，系统通知仍是第三个家。

**Searched:**
- `chatViewerLooking` → 5 hits：`useChatStore.ts:866`（红点）、`:1091`（注释）、`:1097`（定义）、`:2978`（注释）、`:2979`（已读）+ 测试三处（`designGuards.test.ts:2147/2156/2159`、`channelState.test.ts:222/227/232`）。**生产调用点恰好 2 处** ⇒ 系统通知不在其中
- `!document.hidden && app.chatVisible` → 全仓 1 处（`useChatStore.ts:1098`，口径的家）⇒ 守卫 `hiddenHits == 1` 通过 ✓
- `document.hidden` → 全仓生产命中 13 处：`useChatStore.ts:326/481/500/661/801/938/1098/3323`、`App.vue:63/131`、`useAppStore.ts:293`（注释）、`LogViewer.vue:169/197`。**其中 `useChatStore.ts` 的 4 处（`:326/481/500/661`）是通知抑制，另 3 处（`:801` 渲染节流、`:938` 埋点、`:3323` 可见性变化处理）不属"抑制提醒"** ⇒ 通知抑制确有 4 个独立条件子集
- `document.hasFocus` → 全仓生产命中：`useChatStore.ts:326/481/500/661`、`App.vue:131` ⇒ 通知抑制那一族的标志
- `app.chatVisible` → `useAppStore.ts:296`（定义）+ `useChatStore.ts:1098`（口径）+ `useChatStore.ts` 的 2979 附近的 `if (activeConv.value && app.chatVisible)`（回到前台补发已读回执，`channelState.test.ts:235` 钉住）⇒ 这个组合也是"第三个调用点"，但它是**读回执**（已读族），不是通知族
- `freshMentionedConvs` → 生产调用 1 处（`useChatStore.ts:865`）+ 测试多处 ✓
- `activeVisible` → `useChatStore.ts:866`（唯一生产传参）+ `messages.ts:585/589`（签名与判据）+ 测试 ⇒ **纯判定侧不读 DOM** ✓（`messages.ts` 全文无 `document`）

**Hook verification:**
- `src/utils/messages.test.ts#用户其实没在看` — **存在**：`src/utils/messages.test.ts:1105`（`test("会话只是开着、用户其实没在看（窗口在后台或被浮层盖住）⇒ 仍要点亮「有人@我」"`），断言 `activeVisible: false` ⇒ 红点亮 ✓
- `src/utils/messages.test.ts#仍然不点亮` — **存在**：`src/utils/messages.test.ts:1116`（`test("反向对照：同样的会话、用户真在看 ⇒ 仍然不点亮（新口径不许把这条一起放开）"`），断言 `activeVisible: true` ⇒ 不亮 ✓
- `src/utils/designGuards.test.ts#只许走 messageMentionsMe` — **存在**：`designGuards.test.ts:2110` 起的形状判据（"三态入口"），含 `activeVisible: chatViewerLooking()` 与 `hiddenHits == 1` 两条 ✓
- `src/utils/channelState.test.ts#聊天视图真的可见` — **存在**：`src/utils/channelState.test.ts:219`（`test("已读回执只在「聊天视图真的可见」时才发（用户 2026-09-12 实测）"`），钉 `chatViewerLooking` 的定义形状与已读那条真的走它 ✓

四条钩子全部存在并注册（`npm test` 的 glob 覆盖 `src/**/*.test.ts`）。

**How the verdict was reached:** 不是 `implemented`：文档规则的第一句是"凡是**因为'用户正在看这个会话'而抑制某个提醒**的地方 —— 「有人@我」红点、标记已读、**系统通知**、（将来若有）角标降噪 —— 判的必须是**同一份**可见性口径"。代码里系统通知那一族的**四处**抑制判定（`useChatStore.ts:326/481/500/661`）用的是 `!document.hidden && document.hasFocus() && activeConv === conv_id` —— 与 `chatViewerLooking()` 是**两个不同的条件子集**（多了 `hasFocus()`、缺了 `chatVisible`），且**没有**被"组合出现 >1 次即判红"那条守卫覆盖（守卫只数 `!document.hidden && app.chatVisible` 这个具体组合，通知族用的是另一个组合，所以守卫判绿）。文档自己的表格把系统通知列为"严"而非"缺陷"，但规则句要求三处共用同一份口径 ⇒ 系统通知那一路是缺口。也不是 `absent`：核心的两条（已读 + 红点）确实共用 `chatViewerLooking()`，纯判定不读 DOM，缺省值偏安静，三条反面/正向判据齐全。定为 `partial`。

**Open questions:**
- 通知那一族的条件**比** `chatViewerLooking()` 严（多 `hasFocus()`、桌面端 `chatVisible` 恒真所以少一个条件）。"同一份口径"是否允许"更严的子集"？文档说"不许各取一个条件子集"，字面上不许；但文档表格又把通知那条标为"严"（意为它本来就严，不是缺陷）。若允许严子集，则本条应为 `implemented` —— 这是判定分界的关键。
- 移动端上"聊天页被整页浮层盖住"这一状态（`app.chatVisible` 为 false、`document.hasFocus()` 仍为真）下，三条规则给出的答案分别是：已读 = 不判已读、红点 = 亮、系统通知 = 抑制。这是不是就是用户报的那一类症状？
- `useChatStore.ts:938` 的 `hidden: document.hidden` 与 `:3323` 的 `if (document.hidden) return;` 属于"可见性变化处理"而非"抑制提醒"，不算缺口 —— 但若将来那里要抑制某个提醒，会不会长出第四个家？守卫只数那一个组合，看不见。
