import dayjs from "dayjs";

/** 会话列表时间：今天显示时刻，昨天显示「昨天」，更早显示月日。 */
export function fmtConversationTime(ts: number | null | undefined): string {
  if (!ts) return "";
  const d = dayjs(ts);
  if (d.isSame(dayjs(), "day")) return d.format("HH:mm");
  if (d.isSame(dayjs().subtract(1, "day"), "day")) return "昨天";
  return d.format("MM-DD");
}
