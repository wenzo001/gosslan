/**
 * 把上一轮崩溃报告拼成**可复制**的纯文本（不依赖 i18n / DOM，可单测）。
 *
 * 这份文本是用户发给开发者的那一份：位置、版本、现场路径必须一眼能读，且不能带
 * 消息正文或密钥（报告里本来就只有位置与路径）。
 */
import type { PreviousRunReport } from "@/types";

export function formatCrashReport(r: PreviousRunReport): string {
  const lines: string[] = [
    "Gosslan 上一轮运行报告 / previous run report",
    `code: ${r.code}`,
    `kind: ${r.kind}`,
    `time: ${r.at ?? "(unknown)"}`,
    `version: ${r.version ?? "(unknown)"}`,
  ];
  if (r.panic) {
    lines.push(`panic: ${r.panic.location}`);
    if (r.panic.message) lines.push(`message: ${r.panic.message}`);
  }
  if (r.hang) {
    lines.push(
      `hang: ${r.hang.seconds}s last_op=${r.hang.lastOp ?? "unknown"} ended=${r.hang.ended}`,
    );
  }
  if (r.recentPanicCount > 0) lines.push(`recent_panic_count: ${r.recentPanicCount}`);
  if (r.bleSuspect) lines.push("ble_suspect: true");
  lines.push(`crash_log: ${r.crashLog}`);
  lines.push(`log_dir: ${r.logDir}`);
  return lines.join("\n");
}

/** 这份报告该不该在界面上提示（clean / no_history 不打扰）。 */
export function shouldShowCrashNotice(kind: string): boolean {
  return kind === "panic" || kind === "silent_kill" || kind === "startup_failed" || kind === "abort";
}

/** 复制到剪贴板：优先异步 API，失败回退到隐藏 textarea（WKWebView 下也可靠）。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到下面的回退 */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
