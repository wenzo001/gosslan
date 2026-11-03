/**
 * 乐观更新的**纯判据**（5.16.91 第一批）。
 *
 * 这里不碰 pinia、不碰 IPC、不碰词典：只把「什么时候可以回滚」「回滚会不会盖掉
 * 已经先到的真实结果」这两类判断写成可被 `node --test` 直接 import 的函数。
 * store 里只负责按这些结论动投影。
 *
 * 三分法与全量动作归类表住在 `src/stores/useChatStore.ts` 的文件头（那是**唯一**的真源）；
 * 本文件是它下面那层"判据的判据"，不重复抄那张表。
 *
 * ## 三类结果与顺序
 *
 * 一次乐观动作只有三种落地：`pending`（还没等到真实结果）、`succeeded`、`failed`。
 * 真实结果可能**先于**乐观回滚到达（例如后端已经 emit 了真实记录，invoke 才 reject），
 * 所以回滚前必须先问 `canRollback()`；真实成功一旦到过，任何迟到的回滚都必须被丢弃。
 *
 * ## 为什么失败不能"再改成成功"
 *
 * `settle()` 是幂等的：同一结果重复到达不改变结论；`failed` 之后再收到真实成功时
 * **允许**升级成 `succeeded`（回滚后重试 / 真实记录晚到），但 `succeeded` 之后
 * 永远不许降级。这条单向性就是"UI 不回退成错误状态"的判据。
 */

export type SettleState = "pending" | "succeeded" | "failed";

/**
 * 已读回执的每会话序号（5.16.92 从 store 闭包里抽出来）。
 *
 * 同一会话可能有好几次并发 `markRead`（打开会话 / 去抖 / 通知动作 / 回前台）。
 * 只有**最新一次**的失败允许回滚未读：更早那次的失败已被后来的尝试取代，
 * 回滚它会把后来清掉的红点又点亮 —— 这是上一批实测到的乱序。
 *
 * 抽成纯函数有两个原因：store 里那套 Map 无法在 `node --test` 里直接跑；而且
 * 「谁是最后一次」这个判据不该和 pinia 的状态混在一起。
 */
export function nextReadSeq(current: number | undefined): number {
  return (current ?? 0) + 1;
}

/** 这次回执是不是该会话的**最新一次**（只有它才有资格清理槽位/回滚）。 */
export function isLatestReadSeq(current: number | undefined, seq: number): boolean {
  return current === seq;
}

/** 真实结果推进。幂等；`succeeded` 是吸收态。 */
export function settle(state: SettleState, outcome: "succeeded" | "failed"): SettleState {
  if (state === "succeeded") return "succeeded";
  return outcome;
}

/** 迟到的回滚只对"还没收到真实结果"的投影有效。 */
export function canRollback(state: SettleState): boolean {
  return state === "pending";
}

/**
 * 乐观失败可以落在哪一行：必须是**同一条**投影（`msg_id` 逐字相同）且仍是 `sending`。
 *
 * 为什么不能用 `local_id` 找：真实记录也带同一个 `local_id`，用它会命中真实行，
 * 把真实 `msg_id` 换成 `tmp-*`（后续 ack 全部对不上）。真实结果先到时这里返回 `false`，
 * 调用方应**丢弃**这次迟到失败。
 */
export function canApplyOptimisticFailure(
  row: { msg_id: string; status: string } | undefined,
  msgId: string,
): row is { msg_id: string; status: string } {
  return !!row && row.msg_id === msgId && row.status === "sending";
}

/** 会话摘要是否仍由这次投影拥有：期间来过更新的消息 ⇒ 不许回滚（否则会把新消息挤掉）。 */
export function summaryOwnedByProjection(
  currentLastTs: number | undefined,
  projectedTs: number,
): boolean {
  return currentLastTs === projectedTs;
}

/**
 * 乐观清未读的失败回滚：把清零前的那份数**加回**当前值。
 *
 * 不能直接赋回 `previous`：await 期间可能又有新消息进来，当前 `unread` 里含那几条，
 * 直接覆盖会把它们一起吞掉（"少一条未读"和"多一条未读"一样是错）。
 */
export function rollbackUnread(current: number, previous: number): number {
  return current + previous;
}

/**
 * 真实记录是否已经替代了同一个 `local_id` 的乐观行。
 *
 * 用途：`message-received` 可能**先于**乐观批次落地（rAF 还没跑）。此时若把
 * `tmp-*` 再合并进去，`mergeMessages` 会按 `local_id` 把真实行覆盖成 `tmp-*`
 * （状态虽被 `furthestStatus` 保住，`msg_id` 却换了）⇒ 后续 ack 静默丢失。
 */
export function isSupersededProjection(
  rec: { msg_id: string; local_id?: string | null },
  others: readonly { msg_id: string; local_id?: string | null }[],
): boolean {
  if (!rec.msg_id.startsWith("tmp-") || !rec.local_id) return false;
  return others.some((o) => o.local_id === rec.local_id && !o.msg_id.startsWith("tmp-"));
}

/**
 * 在"待落地批次"里找**可以回滚的那一格**：必须同 `msg_id` 且仍 `sending`。
 *
 * 与下面 `findByMsgId` 分家的理由：批次里的行还没进列表，按"同 id + 仍 sending"筛是
 * **回滚专用**的判据（失败投影不许被第二次回滚命中）。返回 `-1` 表示这一格已经落定。
 */
export function pendingRollbackIndex(
  rows: readonly { msg_id: string; status: string }[],
  msgId: string,
): number {
  return rows.findIndex((m) => m.msg_id === msgId && m.status === "sending");
}

/**
 * 按 `msg_id` 取一条已在列表里的行（**只读查找**，不改任何东西）。
 *
 * 为什么把这一行也算进纯判据：store 里"手写 `find/findIndex(m => m.msg_id …)`"曾经每处一份、
 * 没法单测（`designGuards` 把它归零）。查找形状只有一种，住在这里可以让守卫只盯一处。
 */
export function findByMsgId<T extends { msg_id: string }>(
  rows: readonly T[] | undefined,
  msgId: string,
): T | undefined {
  return rows?.find((m) => m.msg_id === msgId);
}
