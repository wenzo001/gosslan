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

/** MessageItem: py-1.5（同发方连续消息间距 12px，学微信的呼吸感） */
const ROW_PADDING = 12;
/** 群聊昵称行：leading-none(11) + mb-[7px](7) = 18px。
 *  字号/行高改动必须同步这里与 MessageItem 的昵称行（两者是同一份高度的两处表达）。
 *  行高取 leading-none 是为了让墨迹贴住行盒顶、与头像顶边齐平（行高 1.5 会往下推 ~3.7px，看着"名字偏低"）。 */
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

/**
 * 气泡高度缓存：键 = 字号 + msg_id。
 *
 * 为什么必须有：VirtualList 的 offsets 是**全表前缀和**（O(n)），任何时候有行的实测高度与估算
 * 不一致，就会触发整表重算 → 重算里对每条消息都要调一次估算。50 万条的会话一重算就是
 * 50 万次估算，而估算对 file 类消息还要 `JSON.parse(content)`（10% 的消息命中）。
 *
 * 为什么只缓存「气泡」这一段：整体的高度还包含昵称行与时间分割线，而**分割线取决于上一条消息
 * 的时间**（`prev.ts`），所以整函数的结果随下标变化、不能按 msg_id 缓存。气泡段只依赖
 * (kind, content, 字号)，这三者对同一条消息是不变的（本应用没有「编辑消息」功能）。
 *
 * 为什么把字号放进键里：唯一会变的就是设置页的字号——放进去之后改字号自然全部失效，
 * 不需要任何手动清理逻辑。
 */
const bubbleCache = new Map<string, number>();
/** 缓存上限：超出后按插入顺序淘汰最早的一条（Map 保序，O(1)）。 */
const BUBBLE_CACHE_MAX = 50_000;

function bubbleHeightCached(m: MessageRecord, fontSize: FontSizeKey): number {
  const key = `${fontSize}|${m.msg_id}`;
  const hit = bubbleCache.get(key);
  if (hit !== undefined) return hit;
  const v = computeBubbleHeight(m, fontSize);
  if (bubbleCache.size >= BUBBLE_CACHE_MAX) {
    const oldest = bubbleCache.keys().next().value;
    if (oldest !== undefined) bubbleCache.delete(oldest);
  }
  bubbleCache.set(key, v);
  return v;
}

/** 气泡本身的高度（不含昵称行 / 时间分割线）。 */
function computeBubbleHeight(m: MessageRecord, fontSize: FontSizeKey): number {
  switch (m.kind) {
    case "code":
      return codeBlockHeight(m.content);
    case "image":
      return IMAGE_BUBBLE;
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
      if (hasPath && sub === "image") return IMAGE_BUBBLE;
      if (hasPath && sub === "code") return CLAMPED_CODE_BLOCK_HEIGHT;
      return FILE_CARD;
    }
    case "system":
      return SYSTEM_ROW;
    default:
      return textBubbleHeight(m.content, fontSize);
  }
}

/** 单条消息的占位高度（气泡 + 时间/昵称/分割线，头像与气泡同行不计入）。 */
export function estimateMessageHeight(
  m: MessageRecord,
  index: number | undefined,
  ctx: EstimateContext,
): number {
  const prev = index != null && index > 0 ? ctx.messages[index - 1] : null;

  const bubble = bubbleHeightCached(m, ctx.fontSize);

  // 每条消息独立完整渲染（无合并）：时间行恒有；群聊非本人显示昵称
  const showDivider = !prev || m.ts - prev.ts >= TIME_DIVIDER_GAP;
  const showNickname = ctx.isGroup && m.sender_id !== ctx.selfId;

  return (
    bubble +
    ROW_PADDING +
    (showNickname ? NICKNAME_ROW : 0) +
    (showDivider ? TIME_DIVIDER : 0)
  );
}
