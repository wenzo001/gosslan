// 消息行高度估算：VirtualList 按它排布，MessageItem 按 previewMetrics 渲染，
// 两边必须共用同一套常量（见 previewMetrics.ts 顶部说明），否则相邻消息会互相遮挡。

import {
  CLAMPED_CODE_BLOCK_HEIGHT,
  codeBlockHeight,
  textBubbleHeight,
} from "@/utils/previewMetrics";
import type { FontSizeKey } from "@/utils/chatStyle";
import type { MessageRecord } from "@/types";

/** 时间分割线阈值（≥5 分钟）。 */
const TIME_DIVIDER_GAP = 5 * 60 * 1000;

/** MessageItem: py-0.5 */
const ROW_PADDING = 4;
/** 气泡下方时间行：mt-0.5(2) + text-[11px](16) */
const TIME_ROW = 18;
/** 群聊昵称行：mb-0.5(2) + text-[11px](16) */
const NICKNAME_ROW = 18;
/** 时间分割线（含 py-2） */
const TIME_DIVIDER = 32;
/** 图片气泡：max-h-72 */
const IMAGE_BUBBLE = 288;
/** 普通文件卡片 */
const FILE_CARD = 92;
/** 系统消息行 */
const SYSTEM_ROW = 28;

export interface EstimateContext {
  messages: MessageRecord[];
  isGroup: boolean;
  /** 本机 device_id：用于判断「非本人」及昵称行。 */
  selfId?: string;
  fontSize: FontSizeKey;
}

/** 单条消息的占位高度（气泡 + 时间/昵称/分割线，头像与气泡同行不计入）。 */
export function estimateMessageHeight(
  m: MessageRecord,
  index: number | undefined,
  ctx: EstimateContext,
): number {
  const prev = index != null && index > 0 ? ctx.messages[index - 1] : null;

  let bubble: number;
  switch (m.kind) {
    case "code":
      bubble = codeBlockHeight(m.content);
      break;
    case "image":
      bubble = IMAGE_BUBBLE;
      break;
    case "file": {
      // 普通文件卡片 92；附件图片 ≤288；附件代码按截断态占位（读文件前预知不了行数）。
      let sub = "file";
      let hasPath = false;
      try {
        const o = JSON.parse(m.content) as { subtype?: string; path?: string };
        sub = o?.subtype ?? "file";
        hasPath = !!o?.path;
      } catch {
        /* 历史 / 异常内容按普通 file 卡片估 */
      }
      if (hasPath && sub === "image") bubble = IMAGE_BUBBLE;
      else if (hasPath && sub === "code") bubble = CLAMPED_CODE_BLOCK_HEIGHT;
      else bubble = FILE_CARD;
      break;
    }
    case "system":
      bubble = SYSTEM_ROW;
      break;
    default:
      bubble = textBubbleHeight(m.content, ctx.fontSize);
  }

  // 每条消息独立完整渲染（无合并）：时间行恒有；群聊非本人显示昵称
  const showDivider = !prev || m.ts - prev.ts >= TIME_DIVIDER_GAP;
  const showNickname = ctx.isGroup && m.sender_id !== ctx.selfId;

  return (
    bubble +
    ROW_PADDING +
    TIME_ROW +
    (showNickname ? NICKNAME_ROW : 0) +
    (showDivider ? TIME_DIVIDER : 0)
  );
}
