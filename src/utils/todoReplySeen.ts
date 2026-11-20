/**
 * 任务回复的「已读游标」（用户 2026-11-20：回复通知太不明显，卡片上要能看出来）。
 *
 * ## 为什么是"本机"
 * 未读是**这个人**的视角，理想状态是跨设备同步；但落库要加「每用户每任务已读游标」
 * （SQLite schema 变更，属需评审的那一档）。先按本机做：`localStorage` 存一张
 * `convId:todoId → 已读到的最大 ts`，零 schema、当天可用。
 * 升级成跨设备时**只换这一层的读写**，界面与判据不用动。
 *
 * ## 为什么存 ts 而不是"最后一次看过的 reply_id"
 * ts 单调、可比较，`> 游标` 就是未读；reply_id 要反查顺序表，任务行迟到/被裁掉时会丢。
 * 代价是同一毫秒内的两条回复只算一条 —— 回复是人手发的，这个精度足够，且不会漏掉
 * "比游标新"的那些。
 *
 * ## 兜底（用户要求：所有情况都有兜底）
 * `localStorage` 在隐私模式 / 配额满 / 某些 WebView 里会**直接抛**。这里全部 try/catch：
 * 读失败 ⇒ 当空表（全部未读，功能照常）；写失败 ⇒ 只影响"下次启动还记不记得"，
 * 本次会话仍然按内存里的游标工作，不会把界面卡住或抛到上层。
 */
import type { TodoReply } from "./todos.ts";
import { storageGet, storageSet } from "./safeStorage.ts";

/** 只取判据需要的那两个字段（结构化，避免 util 依赖整个 todos 模块）。 */
type ReplyLike = Pick<TodoReply, "ts" | "author">;

export type SeenMap = Record<string, number>;

/** 储存键：与 `localStorage` 里其它键同一命名空间。 */
const TODO_REPLY_SEEN_KEY = "gosslan.todoReplySeen";

/**
 * 最多记多少条任务。超出按**最旧**淘汰（`ts` 小的先丢）。
 * 500 条约 25 KB，远低于配额；一个群一年也攒不到这么多活跃任务。
 */
export const SEEN_MAX_ENTRIES = 500;

/** 一条任务在已读表里的键：群 + 任务（同一任务在两个群不会串）。 */
export function seenScopeKey(convId: string, todoId: string): string {
  return `${convId}:${todoId}`;
}

/**
 * 解析持久化值。任何异常形状都退化成空表 —— 宁可从"全部未读"重新开始，
 * 也不要让一条坏数据把整个任务的未读算崩（这里抛出去就是白屏级故障）。
 */
export function parseSeen(raw: string | null | undefined): SeenMap {
  if (!raw) return {};
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const out: SeenMap = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    // 只收非负有限数：别的形状（null、"123"、NaN）一律丢，别让 `>` 比较变成永远真/假
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return out;
}

/**
 * 未读条数：**别人发的**、比游标新的。
 *
 * 自己刚回复完就转身去看，不该给自己显示"1 条新回复" —— 所以按 author 排掉自己。
 * `selfId` 为空（设备还没就绪）时不做这个排除：少排一次只会多算自己那条，
 * 比"把别人的也算漏"轻。
 */
export function countUnseen(replies: readonly ReplyLike[], seenTs: number, selfId?: string): number {
  let n = 0;
  for (const r of replies) {
    if (r.ts <= seenTs) continue;
    if (selfId && r.author === selfId) continue;
    n += 1;
  }
  return n;
}

/**
 * 推进游标：取「旧游标」与「这批回复最大 ts」的较大值。
 *
 * **只增不减**：任务行迟到、消息被裁、后来只读到更少的回复时，游标都不能回退 ——
 * 回退会让已经看过的回复重新变成未读，用户会以为"怎么又冒出来了"。
 */
export function advanceSeen(seenTs: number, replies: readonly ReplyLike[]): number {
  let next = Number.isFinite(seenTs) && seenTs > 0 ? seenTs : 0;
  for (const r of replies) {
    if (Number.isFinite(r.ts) && r.ts > next) next = r.ts;
  }
  return next;
}

/** 超出上限时丢最旧的（按 ts 升序保留末尾），返回新对象（不改入参）。 */
export function pruneSeen(map: SeenMap, max = SEEN_MAX_ENTRIES): SeenMap {
  const entries = Object.entries(map).sort((a, b) => a[1] - b[1]);
  if (entries.length <= max) return { ...map };
  return Object.fromEntries(entries.slice(entries.length - max));
}

/**
 * 读本机已读表。
 *
 * 存储走 `utils/safeStorage`（全仓唯一出口）：隐私模式 / 配额满 / WebView 里
 * **读属性本身**都会抛，那一家已经把"取后端 + 读写"整段包住且绝不 rethrow；
 * 这里再加一层 try 反而会让人以为它有别的失败模式。
 */
export function loadSeen(): SeenMap {
  return parseSeen(storageGet(TODO_REPLY_SEEN_KEY));
}

/** 写本机已读表；写不进去只影响下次启动的记忆，本次会话照常（safeStorage 返回 false 不抛）。 */
export function saveSeen(map: SeenMap): void {
  storageSet(TODO_REPLY_SEEN_KEY, JSON.stringify(pruneSeen(map)));
}
