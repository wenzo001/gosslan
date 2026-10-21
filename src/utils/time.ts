/**
 * 时间格式的单一出口。
 *
 * ## 两档语义，别混
 * - **固定形状**（`fmtDateTime` / `fmtClock` / `fmtDateStamp`）：日志、诊断面板、导出文件名。
 *   刻意不用 `toLocaleTimeString()` —— 它随 WebView 的区域设置变（12/24 小时、分隔符），
 *   同一份日志在 Windows / macOS / Android / iOS 上会长得不一样，排障时没法对照。
 * - **给人看的相对日期**（`fmtConversationTime` / `fmtTimeDivider`）：会话列表、收藏、
 *   群文件 / 任务详情、消息时间分割线。文案与"年月日"的形状归 vue-i18n，星期名 / 月份名
 *   归 dayjs 的 locale 数据 —— 由调用点把**当前语言**传进来（见 `fmtTimeDivider` 的 locale 参数）。
 *
 * ## 为什么文案与语言都由调用方传进来
 * 本文件被 `node --test` 直接 import（`time.test.ts`），而裸 Node 解析不了 `@/` 别名 ⇒
 * 这里不许引 `@/i18n`。与 `fileKind.extBadgeLabel(name, fallback)` 同一手法：
 * 纯逻辑留在这里，语言相关的串与语言标识由应用层注入。
 * 语言必须显式传，不能靠 `dayjs.locale()` 那份全局状态：实测过一条三天前的消息，
 * 切回中文后分割线仍印 `Fri 12:00` —— 全局 locale 变了，而 computed 没有依赖它、不会重算
 * （`scripts/check-ui-runtime.mjs` 的 `locale` 段抓到的）。传进来就同时解决两件事：
 * 读 reactive 的语言 ⇒ 会重算，且这个函数不再有全局副作用。
 *
 * ## 修掉的历史缺陷（2026-10-19 全量盘点）
 * 「今天/昨天/一周内/年内/跨年」这套判断原先在 `utils/chatStyle.ts` 的 `formatTimeDivider`
 * 与本文件的 `fmtConversationTime` 里**各写一遍**，而且星期表 `["周日","周一"…]` 与「昨天」
 * 「M月D日」是硬编码中文 —— 英文界面里每条消息的时间分割线都是中文。现在只有一份。
 */
import dayjs from "dayjs";
import "dayjs/locale/zh-cn.js";

/** 由调用方注入的翻译出口（应用层传 vue-i18n 的 `t`）。 */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

/** dayjs 的 locale 名只有两种取法：中文用库自带的 `zh-cn`，其余一律按英文走。 */
const dayjsLocale = (locale: string): string => (locale.startsWith("zh") ? "zh-cn" : "en");

/** 日志/诊断的本地时间：固定 `YYYY-MM-DD HH:mm:ss`。 */
export function fmtDateTime(ts: number): string {
  return dayjs(ts).format("YYYY-MM-DD HH:mm:ss");
}

/** 仅时刻（日志行、蓝牙扫描时间）。 */
export function fmtClock(ts: number): string {
  return dayjs(ts).format("HH:mm:ss");
}

/** 导出文件名里的日期戳（本地时区）。 */
export function fmtDateStamp(ts: number = Date.now()): string {
  return dayjs(ts).format("YYYYMMDD");
}

/**
 * 会话列表 / 收藏 / 群文件 / 任务的时间列：
 * 今天=时分，昨天=词典文案，更早=`MM-DD`（纯数字形状，两种语言都读得懂，不改视觉密度）。
 */
export function fmtConversationTime(ts: number | null | undefined, tr: Translate): string {
  if (!ts) return "";
  const d = dayjs(ts);
  if (d.isSame(dayjs(), "day")) return d.format("HH:mm");
  if (d.isSame(dayjs().subtract(1, "day"), "day")) return tr("date.yesterday");
  return d.format("MM-DD");
}

/**
 * 消息时间分割线（微信式智能格式）：今天只报时分；昨天报「昨天 HH:mm」；
 * 一周内报星期（星期名来自 dayjs locale）；今年内报「M月D日 HH:mm」；跨年带年份。
 * 形状（哪一段用月日、哪一段用年份）留在这里 —— 那是产品口径；
 * 词语与月日的**排列顺序**交给词典，所以英文下是 "Aug 30 12:00" 而不是 "8月30日 12:00"。
 */
export function fmtTimeDivider(
  ts: number,
  tr: Translate,
  locale: string,
  now: number = Date.now(),
): string {
  const L = dayjsLocale(locale);
  const d = dayjs(ts).locale(L);
  const n = dayjs(now).locale(L);
  const hm = d.format("HH:mm");
  if (d.isSame(n, "day")) return hm;
  if (d.isSame(n.subtract(1, "day"), "day")) return `${tr("date.yesterday")} ${hm}`;
  if (n.diff(d, "day") < 7) return `${d.format("ddd")} ${hm}`;
  const parts = {
    y: d.format("YYYY"),
    m: d.format("M"),
    d: d.format("D"),
    mmm: d.format("MMM"),
  };
  if (d.isSame(n, "year")) return `${tr("date.md", parts)} ${hm}`;
  return `${tr("date.ymd", parts)} ${hm}`;
}
