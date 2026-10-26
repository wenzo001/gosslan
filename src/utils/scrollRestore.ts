/**
 * 「离开再回来，落回上次读到的那一屏」的判定与位置形状（用户 2026-10-23；2026-10-26 改锚点）。
 *
 * **位置不是像素**：动态高度列表按估算布局，同一个 scrollTop 会落到另一条消息上。
 * 这里同时保存视口上沿消息的稳定 key + 行内偏移，ChatWindow 恢复时按消息身份落位，
 * 再由 VirtualList 对真实 DOM 校正；`top` 只在锚点消息不在已加载范围时兜底。
 *
 * 三条口径（这里是唯一实现，ChatWindow 只负责保存/调用）：
 * ① 离开超过 `SCROLL_RESTORE_TTL_MS` ⇒ **贴底**。隔很久回来还停在一屏旧内容上，
 *    用户得自己往下滑才能看到新消息，那比"丢掉位置"更烦人。
 * ② 回来时已有未读跳转 ⇒ 位置让给未读（未读才是用户最需要看的那条）。
 * ③ 离开时本来就在底部 ⇒ 回来也贴底：那是"看最新"的意图，不是一个像素坐标。
 *
 * 边界取闭区间外的严格大于：**恰好** 3 分钟仍算"刚离开"（与时间窗判据的通用口径一致：
 * 阈值那一格走"仍然恢复"）。这个值由用户拍板，改它只改这一个常量。
 */
export interface SavedScroll {
  /** 离开时的 scrollTop（px）——**只作兜底**：虚拟列表用估算高度时，同一个像素会落到另一条消息。 */
  top: number;
  /** 离开时刻（ms，`Date.now()`）。 */
  at: number;
  /** 离开时是否已经在底部。 */
  atBottom: boolean;
  /**
   * 离开时视口上沿那条消息的稳定 key（`local_id ?? msg_id ?? id`）。
   *
   * 为什么必须有它：消息列表是**动态高度 + 估算布局**，`scrollToOffset(top)` 在估算与
   * 实测不一致时会把用户放到**另一条消息**上（2026-10-26 实测：锚点从 m-scroll-5
   * 漂到 m-scroll-9，scrollTop 只差 226px 却跨了 4 条）。恢复必须按消息身份 + 行内偏移，
   * 再由 VirtualList 对真实 DOM 做一次校正。
   */
  anchorKey?: string;
  /** 锚点行上沿相对视口顶的偏移（px，可为负：行跨过视口上沿时）。 */
  anchorOffset?: number;
}

/** 阅读位置的有效期：超过这个时长回来一律贴底。 */
export const SCROLL_RESTORE_TTL_MS = 3 * 60_000;

/**
 * 跨**组件挂载**的阅读位置表（模块生命周期）。
 *
 * ⚠️ 2026-10-25 用户实测：单聊往上滑 → 点对方资料 → 返回，视口又回到底部。
 * 根因是这张表原先长在 `ChatWindow` 的 `<script setup>` 里：点资料页会把 `ChatWindow`
 * 卸载，表随组件实例一起消失 ⇒ 返回时怎么查都是"没保存过"，只能贴底。
 * 放到模块级后，下面那三条 TTL/未读/贴底口径才真正有东西可查。
 */
const savedPositions = new Map<string, SavedScroll>();
/** 与消息缓存同量级，防止长时间使用无界增长。 */
const SAVED_POSITIONS_MAX = 50;

/** 记下一条会话离开时的位置；重复写入按"最近一次"重新排到队尾。 */
export function rememberScrollPosition(convId: string, saved: SavedScroll): void {
  savedPositions.delete(convId);
  savedPositions.set(convId, saved);
  if (savedPositions.size <= SAVED_POSITIONS_MAX) return;
  for (const key of savedPositions.keys()) {
    if (savedPositions.size <= SAVED_POSITIONS_MAX) break;
    savedPositions.delete(key);
  }
}

export function savedScrollPosition(convId: string): SavedScroll | undefined {
  return savedPositions.get(convId);
}

/** 测试专用：让每条判据从干净状态起跑（生产代码不调用）。 */
export function clearSavedScrollPositions(): void {
  savedPositions.clear();
}

/**
 * 该不该把视口恢复到 `saved.top`。
 *
 * 返回 `false` 的三种情况都表示"交给默认的贴底行为"：过期、有未读、离开时就在底部。
 */
export function shouldRestoreScroll(
  saved: SavedScroll | undefined,
  now: number,
  unreadWins: boolean,
): boolean {
  if (!saved) return false;
  if (unreadWins) return false;
  if (saved.atBottom) return false;
  return now - saved.at <= SCROLL_RESTORE_TTL_MS;
}
