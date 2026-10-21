/**
 * 「搜索聊天记录」的纯逻辑：日期区间预设、发送人筛选项、命中片段截取。
 *
 * 抽成纯函数的原因与项目其它 utils 一致：这些判据**没有界面也能验证**，
 * 而它们的错误表现是"看起来对、其实筛错了"（搜漏了/筛多了），靠肉眼回归发现不了。
 * 组件（`ChatSearchDialog.vue`）只负责渲染与交互。
 */
import dayjs from "dayjs";
import type { ChatSearchGroup } from "@/types";

/** 「日期」筛选预设（对应微信搜索页的日期筛选，粒度比日历简单但语义一致）。 */
export type SearchDatePreset = "all" | "today" | "yesterday" | "week" | "month";

/** 预设顺序（界面按这个顺序渲染）。 */
export const SEARCH_DATE_PRESETS: SearchDatePreset[] = ["all", "today", "yesterday", "week", "month"];

export interface SearchDateRange {
  /** 起始时间（含）；`null` = 不限。 */
  sinceMs: number | null;
  /** 结束时间（含）；`null` = 不限。 */
  untilMs: number | null;
}

/**
 * 把日期预设换算成时间区间。
 *
 * 语义按**本地日历日**算（不是"最近 24 小时"）：用户说"今天"指的是今天这一天，
 * 不是过去 86400 秒 —— 否则早上搜"今天"会漏掉昨天深夜的消息、把今天零点前的算进来。
 * `all` 返回全 `null`（不过滤）。
 *
 * ⚠️ 「N 天前」必须用 dayjs 的**日历减法**，不能用 `零点 - N × 86_400_000`：
 * 实行夏令时的地区里"一天"不是常数 —— 回拨日 25 小时、拨前日 23 小时，于是切换日的**次日**
 * 往前推 24 小时会落在 01:00（或 23:00），边界把那天头一小时的消息筛掉（或多算一小时）。
 * 同一套减法在 `utils/time.ts` 的「昨天」标签那里用的就是日历法 ⇒ 两处必须同法，
 * 否则列表标着「昨天」的那条消息在搜索里选「昨天」会找不到。
 */
export function dateRangeFor(preset: SearchDatePreset, now: number = Date.now()): SearchDateRange {
  if (preset === "all") return { sinceMs: null, untilMs: null };
  const startOfToday = dayjs(now).startOf("day");
  const todayMs = startOfToday.valueOf();
  switch (preset) {
    case "today":
      return { sinceMs: todayMs, untilMs: null };
    case "yesterday":
      return { sinceMs: startOfToday.subtract(1, "day").valueOf(), untilMs: todayMs - 1 };
    case "week":
      // 近 7 天：含今天 ⇒ 从 6 天前的零点开始（"最近 7 天"的通行口径）
      return { sinceMs: startOfToday.subtract(6, "day").valueOf(), untilMs: null };
    case "month":
      return { sinceMs: startOfToday.subtract(29, "day").valueOf(), untilMs: null };
    default:
      return { sinceMs: null, untilMs: null };
  }
}

export interface SenderOption {
  id: string;
  name: string;
  /** 该发送者在当前结果里的命中条数（排序用）。 */
  count: number;
}

/**
 * 从结果里汇总「发送人」筛选项：按命中条数降序，条数相同按名字稳定排序。
 *
 * 注意：筛选项来自**未按发送人过滤**的那次查询结果（组件里单独缓存），
 * 否则一旦选了一个发送人，可选项就只剩他自己，用户无法切换 —— 这是设计而非疏漏。
 */
export function senderOptionsFrom(groups: ChatSearchGroup[]): SenderOption[] {
  const map = new Map<string, SenderOption>();
  for (const g of groups) {
    for (const m of g.messages) {
      const cur = map.get(m.sender_id);
      if (cur) cur.count += 1;
      else map.set(m.sender_id, { id: m.sender_id, name: m.sender_name, count: 1 });
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * 命中片段：长消息只截取关键词附近的一段（左右各 `radius` 字），两端加省略号。
 *
 * 为什么需要：一条几万字的粘贴消息会把结果页撑爆，而用户要看的只是**命中那处**。
 * 与 `useConversationSearch` 的会话列表摘要同一思路，但这里保证**一定包含关键词**
 * （截取窗口锚定在首个命中位置，而不是从头截）。
 */
export function hitSnippet(content: string, keyword: string, radius = 30): string {
  const kw = keyword.trim();
  if (!kw) return content;
  const idx = content.toLowerCase().indexOf(kw.toLowerCase());
  if (idx < 0) return content;
  // 按**字符**（而非 UTF-16 码元）截取，避免把 emoji / 代理对切成半个字符
  const chars = [...content];
  const lower = [...content.toLowerCase()];
  const kwChars = [...kw.toLowerCase()];
  let at = -1;
  for (let i = 0; i + kwChars.length <= lower.length; i++) {
    if (lower.slice(i, i + kwChars.length).join("") === kwChars.join("")) {
      at = i;
      break;
    }
  }
  if (at < 0) return content;
  const start = Math.max(0, at - radius);
  const end = Math.min(chars.length, at + kwChars.length + radius);
  return `${start > 0 ? "…" : ""}${chars.slice(start, end).join("")}${end < chars.length ? "…" : ""}`;
}

/** 结果页顶部的标题：共 N 条与「关键词」的聊天记录。 */
export function totalHits(groups: ChatSearchGroup[]): number {
  return groups.reduce((sum, g) => sum + g.total, 0);
}
