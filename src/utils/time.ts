import dayjs from "dayjs";

/**
 * 日志/诊断的本地时间：固定 `YYYY-MM-DD HH:mm:ss`。
 *
 * 不用 `toLocaleTimeString()`：它随 WebView 的区域设置变（12/24 小时、分隔符），
 * 同一份日志在 Windows / macOS / Android / iOS 上会长得不一样，排障时没法对照。
 */
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

/** 会话列表时间：今天显示时刻，昨天显示「昨天」，更早显示月日。 */
export function fmtConversationTime(ts: number | null | undefined): string {
  if (!ts) return "";
  const d = dayjs(ts);
  if (d.isSame(dayjs(), "day")) return d.format("HH:mm");
  if (d.isSame(dayjs().subtract(1, "day"), "day")) return "昨天";
  return d.format("MM-DD");
}
