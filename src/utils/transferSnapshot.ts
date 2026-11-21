/**
 * 传输/任务台账快照的**逐字段比较**（2026-11-21，Windows 抖动修复的另一半）。
 *
 * 背景见 `taskCenter.ts::refreshTransfers`：后端心跳每 ~333ms 触发一次台账刷新，
 * 内容没变时引用也被替换 ⇒ 依赖它们的 computed 全失效 ⇒ 消息行全量重渲染。
 * 这里把「变没变」的判定收敛成一个家：三种快照各自的字段清单手写在这里，
 * **新增字段必须登记**（否则新增字段的变化会被比较漏掉 ⇒ 界面不更新——宁可多渲染，
 * 不可漏更新，所以这里有「字段清单 ≠ 类型字段」的守卫测试钉着）。
 *
 * 为什么不用 JSON.stringify：快照每 400ms 比一次，几十行 × 每行十几字段，
 * 手写字段循环比序列化快一个量级，且对字段顺序不敏感。
 */

/** 通用标量比较：NaN 视为相等（进度/时间戳不会出现，防御性）。 */
function scalarEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // eslint-disable-next-line no-self-compare
  if (typeof a === "number" && typeof b === "number" && a !== a && b !== b) return true;
  return false;
}

/** 按给定字段清单逐字段比较两组同构行（长度不同直接不等）。 */
function rowsEqual<T extends object>(a: readonly T[], b: readonly T[], fields: readonly (keyof T)[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const ra = a[i];
    const rb = b[i];
    for (const f of fields) {
      if (!scalarEq(ra[f], rb[f])) return false;
    }
  }
  return true;
}

/** `TransferInfo` 的全部展示字段（types.ts:337）。 */
export const TRANSFER_FIELDS = [
  "id",
  "peer_id",
  "name",
  "size",
  "direction",
  "status",
  "path",
  "progress",
  "blocked_reason",
  "created_at",
] as const;

/** `ContentTransfer` 的全部展示字段（types.ts:320）。 */
export const CONTENT_FIELDS = [
  "cid",
  "peerId",
  "groupId",
  "name",
  "size",
  "direction",
  "status",
  "received",
  "attempts",
  "nextAttemptAt",
  "lastError",
  "path",
  "createdAt",
  "updatedAt",
] as const;

/** `PendingMessageOp` 的全部展示字段（types.ts:357）。 */
export const OP_FIELDS = [
  "msg_id",
  "kind",
  "peer_id",
  "group_id",
  "waiting_for",
  "created_at",
  "preview",
  "peer_offline",
  "can_cancel",
  "some_delivered",
  "failed",
  "fail_code",
  "nudge",
] as const;

export function transferListEqual(
  a: readonly { [K in (typeof TRANSFER_FIELDS)[number]]: unknown }[],
  b: readonly { [K in (typeof TRANSFER_FIELDS)[number]]: unknown }[],
): boolean {
  return rowsEqual(a, b, TRANSFER_FIELDS);
}

export function contentListEqual(
  a: readonly { [K in (typeof CONTENT_FIELDS)[number]]: unknown }[],
  b: readonly { [K in (typeof CONTENT_FIELDS)[number]]: unknown }[],
): boolean {
  return rowsEqual(a, b, CONTENT_FIELDS);
}

export function opsListEqual(
  a: readonly { [K in (typeof OP_FIELDS)[number]]: unknown }[],
  b: readonly { [K in (typeof OP_FIELDS)[number]]: unknown }[],
): boolean {
  return rowsEqual(a, b, OP_FIELDS);
}
