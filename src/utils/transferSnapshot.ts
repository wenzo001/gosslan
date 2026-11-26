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

/**
 * 消息列表的**展示字段**清单（`MessageRecord`，types.ts:151）。
 *
 * ⚠️ 新增会改变气泡外观的列必须登记在这里 —— 漏一个，那次变化就会被判成"没变"、
 * 界面不刷新（这比多渲染一次严重得多）。
 */
export const MESSAGE_FIELDS = [
  "id",
  "msg_id",
  "local_id",
  "conv_id",
  "sender_id",
  "receiver_id",
  "kind",
  "content",
  "ts",
  "seq",
  "status",
  "fail_code",
] as const;

/** 两个字符串/对象数组内容相同（`undefined` 与 `null` 视为同一态）。 */
function listEq<T>(a: readonly T[] | null | undefined, b: readonly T[] | null | undefined): boolean {
  if (a === b) return true;
  const x = a ?? [];
  const y = b ?? [];
  if (x === y) return true;
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i += 1) {
    const ea = x[i] as unknown;
    const eb = y[i] as unknown;
    if (ea === eb) continue;
    // `mention_targets` 是 `{id,name,n}` 结构体：逐格比，别指望引用相等。
    if (ea && eb && typeof ea === "object" && typeof eb === "object") {
      const ra = ea as Record<string, unknown>;
      const rb = eb as Record<string, unknown>;
      if (ra.id !== rb.id || ra.name !== rb.name || ra.n !== rb.n) return false;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * 两份消息列表**内容相同**（不是同一引用）。
 *
 * 为什么需要（2026-11-26 切会话卡顿的第二个大头）：`loadMessages` 拿到的 DB 快照
 * 经 `preserveDeliveryStatus` 之后**每条都是新对象**、整个数组也是新引用 ⇒ 虚拟列表
 * 那 18 行 `MessageItem` 的 props 全部"变了" ⇒ 全量 patch。用户实测切回已缓存会话会白付
 * 两三百毫秒，而其中没有一条消息真的变过。
 * 与 `taskCenter` 的 `transferListEqual` 同一套路：内容没变就保留旧引用，渲染链在源头断掉。
 */
/**
 * `MessageRecord` 的展示字段视图：`local_id` 等列在类型里是**可选**的，
 * 所以这里不能用"全部必填"的映射类型（否则调用点的 `MessageRecord[]` 直接 TS2345）。
 */
type MessageLike = { [K in (typeof MESSAGE_FIELDS)[number]]?: unknown } & {
  /** 两个数组列不在标量清单里，但同样是"没变就别重渲染"必须比的部分。 */
  mention_ids?: unknown;
  mention_targets?: unknown;
};

export function messageListEqual(a: readonly MessageLike[], b: readonly MessageLike[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!messageRowEqual(a[i], b[i])) return false;
  }
  return true;
}

/** 单条消息的展示字段是否全等。 */
function messageRowEqual(a: MessageLike, b: MessageLike): boolean {
  for (const f of MESSAGE_FIELDS) {
    if (!scalarEq(a[f], b[f])) return false;
  }
  if (!listEq(a.mention_ids as string[] | null, b.mention_ids as string[] | null)) return false;
  return listEq(
    a.mention_targets as { id: string; name: string; n: number }[] | null,
    b.mention_targets as { id: string; name: string; n: number }[] | null,
  );
}
