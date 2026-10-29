## REQ-INV-P30 — 前端派生状态：唯一事实源 + 引用必须命中

> "| # | 规则 | 今天靠什么成立（不是靠谁记得） |
> | 1 | 同一份语义的每个派生状态**只有一个家** | `markFriendsOnlineFrom` 是 `online` 判定的唯一实现，`useChatStore` 两个调用点都调它（`channelState.test.ts` 钉住"必须恰好 2 处调用"）；`sendToBackend` 是单聊/群聊 invoke 分流的唯一实现（`retrySend.test.ts` 钉住） |
> | 2 | 界面引用的 `t()` key 必须在**中英两侧**都存在 | `src/i18n/index.test.ts` 扫全仓 `t("字面量")` 调用点；`t()` 的回落是 `dict[key] ?? key`，所以缺 key 不是报错而是**把裸 key 显示给用户** |
> | 3 | 重发**复用**失败那条气泡，不新建第二条 | `send(..., retryOfMsgId)` 原地把 failed 转回 sending；`appendLocalOnly` 把 `tmp-*` 视为只在内存，每次 `loadMessages` 重新追加 ⇒ 不复用就是**永久**两条 |
> | 4 | 派生值不许粘住上一轮结果 | `markFriendsOnlineFrom` 每次全量重算（`friendOnline.test.ts` 有"回落成离线"那一条） |
> | 5 | 同一份判据不许被抄成两份 | AI_RULES §32；上面三条的护栏都额外钉住"实现搬家时判据跟着搬"（形状断言扫源码，不扫运行时） |"
> — docs/protocol-invariants.md §30. Frontend Self-Consistency / INV-P30, line 1400

**Verdict:** implemented · confidence: high

**What this demands of an implementation:** 前端每一份语义的每个派生状态只能有一个家；界面引用的 `t()` key 必须在中英两侧都存在；重发必须复用失败那条气泡而不是新建第二条；派生值不许粘住上一轮结果；同一份判据不许被抄成两份。

**Where enforcement lives:**

**规则 1（派生状态一个家）：**

```ts
// src/utils/friendOnline.ts:72-80
export function markFriendsOnlineFrom<T extends FriendOnlineTarget>(
  friends: T[], list: readonly PeerOnlineInput[],
): T[] {
  const onlineIds = new Set(list.map((x) => x.device_id));
  const linkedIds = new Set(list.filter((x) => x.link).map((x) => x.device_id));
  friends.forEach((f) => (f.online = onlineIds.has(f.device_id) || linkedIds.has(f.device_id)));
  return friends;
}
```

调用点恰好 2 处：`src/stores/useChatStore.ts:979`（`onPeers`）与 `:3013`（`searchNearbyPeers`）。

```ts
// src/stores/useChatStore.ts:2035（sendToBackend：单聊/群聊 invoke 分流的唯一实现）
async function sendToBackend(...)
```

调用点恰好 2 处：`useChatStore.ts:1963`（新建）与 `:2000`（整条重发兜底）。

**计数判据（数调用点个数，而不是数"含某个条件"）：**

```ts
// src/utils/channelState.test.ts:442-453
const calls = [...chat.matchAll(/[^.\w]markFriendsOnlineFrom\(/g)].length;
assert.equal(
  calls, 2, // onPeers 与 searchNearbyPeers 各一次
  `useChatStore 里 markFriendsOnlineFrom 被调用 ${calls} 次，期望 2（onPeers + searchNearbyPeers）。
   任一调用点改成自己算 online，linkedIds 那一层就会被悄悄丢掉 —— 那正是本条判据
   2026-09-14 钉住的缺陷。`,
);
```

```ts
// src/utils/retrySend.test.ts:95-110
const at = store.indexOf("async function sendToBackend(");
const body = store.slice(at, store.indexOf("\n  }", at));
const dm = [...body.matchAll(/api\.sendMessage\(/g)].length;
const grp = [...body.matchAll(/api\.sendGroupMessage\(/g)].length;
assert.equal(dm, 1, `sendToBackend 里 api.sendMessage 出现 ${dm} 次，应恰好 1 次`);
assert.equal(grp, 1, `sendToBackend 里 api.sendGroupMessage 出现 ${grp} 次，应恰好 1 次`);
const calls = [...store.matchAll(/await sendToBackend\(/g)].length;
assert.equal(calls, 2, `send() 里有 ${calls} 处 await sendToBackend，应恰好 2 处（新建 + 整条重发）…`);
```

**规则 2（t() key 中英两侧都存在）：**

```ts
// src/i18n/index.test.ts:64-80（扫全仓 t("字面量") 调用点）
const CALL = /\bt\(\s*(["'])([a-z][\w]*(?:\.[\w]+)+)\1/g;
// src/i18n/index.test.ts:17-26（中英 key 集合完全一致 + 值非空）
```

**规则 3（重发复用气泡）：**

```ts
// src/stores/useChatStore.ts:1954-1981
if (retryOfMsgId) {
  const list = messages.value[convId];
  const i = list?.findIndex((m) => m.msg_id === retryOfMsgId) ?? -1;
  if (list && i >= 0) {
    const reverted = { ...list[i], status: "sending" as const };
    messages.value[convId] = [...list.slice(0, i), reverted, ...list.slice(i + 1)];
    try {
      const rec = await sendToBackend(convId, content, kind, mentionIds);
      ...
      replaceMessage(convId, retryOfMsgId, acked ? {...rec, status: furthestStatus(rec.status, "delivered")} : rec);
      return rec;
    } catch (e) {
      replaceMessage(convId, retryOfMsgId, { ...reverted, status: "failed" });
      throw e;
    }
  }
}
```

```ts
// src/utils/retrySend.test.ts:81-92（重发分支里绝不能出现 enqueueMessage）
const enqueueAt = store.indexOf("enqueueMessage(optimistic)");
const retryBranchAt = store.indexOf("if (retryOfMsgId)");
assert.ok(retryBranchAt > 0 && enqueueAt > retryBranchAt, "enqueueMessage 应在重发分支之后");
const branch = store.slice(retryBranchAt, enqueueAt);
assert.ok(!branch.includes("enqueueMessage"), "重发分支里绝不能出现 enqueueMessage —— 那会新建一条乐观记录，旧 failed 又不会被删 ⇒ 两条一样的文字。");
```

```ts
// src/utils/messages.ts:214（appendLocalOnly：tmp-* 视为只在内存）
```

**规则 4（派生值不许粘住上一轮结果）：**

```ts
// src/utils/friendOnline.ts:78
friends.forEach((f) => (f.online = onlineIds.has(f.device_id) || linkedIds.has(f.device_id)));
```

**每次全量重算** ⇒ 这一轮没出现的那个好友必然被置回 `false`（`onlineIds.has` 为假）⇒ 不粘住上一轮 ✓。

**Paths walked:**
- `useChatStore.ts:979` `markFriendsOnlineFrom(friends.value, list)` ⇒ 唯一实现 ✓
- `useChatStore.ts:3013` `markFriendsOnlineFrom(friends.value, p)` ⇒ 唯一实现 ✓
- `useChatStore.ts:1963` `await sendToBackend(convId, content, kind, mentionIds)` ⇒ 唯一分流实现 ✓
- `useChatStore.ts:2000` `await sendToBackend(convId, content, kind, mentionIds, localId)` ⇒ 同上 ✓
- `useChatStore.ts:1956` `if (retryOfMsgId)` ⇒ 重发分支**不含** `enqueueMessage`（判据扫描 `retryBranchAt` 到 `enqueueAt` 之间）✓
- `useChatStore.ts:1701` `appendLocalOnly(preserveDeliveryStatus(list, prev), prev)` ⇒ `tmp-*` 只在内存，每次重读重新追加 ⇒ 不会与权威行重复 ✓
- 群消息重发 → `components/MessageItem.vue` 走 `api.resendGroupDelivery(conv_id, msg_id)`（按成员补发），只有 `no_ledger` / `unsupported` 才退回整条重发 ⇒ 退回时把旧 `msg_id` 传下去（`retrySend.test.ts:60-77`）✓

**Searched:**
- `markFriendsOnlineFrom` → 生产 2 处（`useChatStore.ts:979/3013`）+ 定义 `friendOnline.ts:72` + 测试。判据数的是**带左括号的调用**（import 行不带括号）⇒ 计数精确 ✓
- `sendToBackend` → 定义 `useChatStore.ts:2035` + 生产调用 2 处 + 测试若干 ✓
- `t("` 扫全仓 → `src/i18n/index.test.ts:64-80` 的实现扫 `src/` 下所有 `.vue` / `.ts`（跳过 `.test.ts`）⇒ 覆盖界面全部调用点
- `dict[key] ?? key` 回落 → `src/i18n/index.ts`（`t()` 的实现，判据注释 `:39-43` 引用）
- `enqueueMessage` → 生产 1 处（新建分支）+ 判据两处断言（`retrySend.test.ts:85` 与 `:88`）
- `appendLocalOnly` → `src/utils/messages.ts:214`（定义）+ `useChatStore.ts:1701`（调用）+ 测试多处 ✓
- `ordinals`（位置序号当编号）→ 见 INV-P29 的判据（`designGuards.test.ts:2405`）—— 属 P29 但同属"派生状态不许第二份"
- `t` 的动态键（模板字符串）→ 判据**刻意跳过**（`src/i18n/index.test.ts:50-56` 的注释解释：`t(\`prefix.${kind}\`)` 静态扫不出展开后的全部键，由各自的专项用例钉住）—— 这是判据的**已知边界**，写在判据自己的注释里

**Hook verification:**
- `src/utils/friendOnline.test.ts` — **存在**：`src/utils/friendOnline.test.ts`（含"回落成离线"那条：`:106` `markFriendsOnlineFrom(fs, []); // 下一轮没拿到它 ⇒ 必须回落成离线`）✓
- `src/utils/retrySend.test.ts` — **存在**：`src/utils/retrySend.test.ts`（4 条：群消息按成员补发 / 重发路径不许 enqueueMessage / 分流只有一份 / 后端前提对账）✓
- `src/i18n/index.test.ts` — **存在**：`src/i18n/index.test.ts`（中英 key 一致 / 值非空 / 全仓 `t()` 调用点扫描）✓
- `src/utils/channelState.test.ts#链路徽标/在线状态必须实时` — **存在**：`src/utils/channelState.test.ts` 内（该文件里 `markFriendsOnlineFrom` 计数那条用例）✓

全部四条钩子存在并注册（`npm test` 的 glob `src/**/*.test.ts` 覆盖）。

**How the verdict was reached:** 五条规则逐条对上：规则 1 有两个"唯一实现"（`markFriendsOnlineFrom` / `sendToBackend`）且都有**计数判据**（恰好 2 处调用）—— 这正是文档强调的"只钉'判定含 linkedIds'是不够的 …数调用点个数才关得住第二个家"；规则 2 有全仓 `t()` 字面量扫描 + 中英 key 集合一致 + 值非空三条；规则 3 有"重发分支不含 enqueueMessage"的形状断言 + `retryOfMsgId` 原地转 sending 的实现 + `appendLocalOnly` 的 `tmp-*` 语义；规则 4 有"全量重算 ⇒ 回落成离线"的用例；规则 5 由上面每一条的形状断言（扫源码不扫运行时）承担。定为 `implemented`：文档点名的四条钩子全部存在并注册，且每条规则都有可执行的机器判据。

**Open questions:**
- `t()` 的**模板字符串**调用点不在扫描面内（判据自陈，`src/i18n/index.test.ts:50-56`）。若某处 `t(\`errors.${kind}\`)` 展开出的某个 kind 没有对应 key，裸 key 仍会���屏。这条边界是判据自己登记的，不构成本条偏差，但它让规则 2 的覆盖面小于文字表述。
- `src/utils/designGuards.test.ts` 里还有一大批"同一个家"类判据（㉖ 群任务编号、`messageMentionsMe` 三态入口等），它们与本条规则 1 同形但分别属于 P29 / P27 的记账范围。
- 文档规则 5 说"AI_RULES §32"承载"同一份判据不许被抄成两份"。本次审计未核 `AI_RULES.md` §32 的内容 —— 它是规则 5 的规范侧引用，不是本仓的可执行判据。
