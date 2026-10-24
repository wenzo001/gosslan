/**
 * 「新消息进入」的资格判定（设计规范 §8：160–240ms 的进入动效）。
 *
 * 为什么要有这个模块：虚拟列表按 key 重建 DOM 是**常态**（滚动回收、切会话、向上加载 prepend），
 * 所以"这条是不是刚来的"不能交给 CSS 挂载时机 —— 否则翻旧消息时每一行都会重放一遍淡入。
 * 资格只能由**这次数组变化是不是尾部追加一条**决定。
 *
 * 这里是纯函数：不碰 Vue、不读 DOM，输入全是原始值 ⇒ 能跑 `node --test` 的行为真值表。
 */

/** 进入动画时长，必须与 `--gosslan-duration`（240ms）同一口径；由测试现读 CSS 对账。 */
export const ENTER_ANIM_MS = 240;

/** 消息 id 在真实数据里两种写法都出现过，判定只按同一份值比较，不做字符串化。 */
export type MessageId = string | number;

export type EnterDecision<Id extends MessageId = MessageId> = {
  prevLastId: Id | null;
  nextLastId: Id | null;
  prevLen: number;
  nextLen: number;
  /** 这一条是否真的会出现在视野里（自己发的 / 已在底部 / 且用户没在 1.2s 内主动上滑）。 */
  willBeVisible: boolean;
};

/**
 * 返回该做进入动画的 `msg_id`；**没有**则 null。
 *
 * 不做动画的四种形状，每一种都对应一个真实缺陷形状：
 * - 尾 id 没变 ⇒ 不是追加（整体替换、切会话、原地改状态如已读回执）；
 * - 原来空表 ⇒ 首屏填充，用户看到的不是"来了一条"；
 * - 一次进多条 ⇒ 批量回填/导入，整屏同时淡入既贵又像故障；
 * - 不在视野 ⇒ 用户正在读历史，不许为看不见的行做动效（也顺带守住"不得把人拽回底部"）。
 */
export function computeEnteringId<Id extends MessageId>(d: EnterDecision<Id>): Id | null {
  const { prevLastId, nextLastId, prevLen, nextLen, willBeVisible } = d;
  if (!nextLastId || nextLastId === prevLastId) return null;
  if (prevLen === 0) return null;
  if (nextLen - prevLen !== 1) return null;
  if (!willBeVisible) return null;
  return nextLastId;
}
