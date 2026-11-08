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
    // `at` 是**起点**、`last_seen` 是最后一条现场记录。分开写是因为 2026-11-08 用户把
    // `time: 10:21:50` 读成了"10:21 那次结束"（其实那一轮那时才刚启动）。
    `started_at: ${r.at ?? "(unknown)"}`,
    `last_seen: ${r.lastSeenAt ?? "(unknown)"}`,
    `version: ${r.version ?? "(unknown)"}`,
  ];
  if (r.panic) {
    lines.push(`panic: ${r.panic.location}`);
    if (r.panic.message) lines.push(`message: ${r.panic.message}`);
  }
  // 只写后端能确凿给出的归因码（区分"我们自己的代码"与"运行环境初始化失败"）。
  if (r.reason) lines.push(`reason: ${r.reason}`);
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

/**
 * 这份报告该不该在界面上提示。
 *
 * - `clean`（正常退出）/ `no_history`（没有可判定路标）不打扰；
 * - `updater`（更新安装器接管）/ `single_instance`（单实例交接）/ `sigterm`（外部发的
 *   正常终止信号）都是**正常路径**，也不打扰 —— 2026-11-08 用户要求："我们主动结束"
 *   不能和"被外部杀死"混成一个提示；
 * - `early_exit`（进了事件循环却没到 logger）是真实异常，要提示。
 */
export function shouldShowCrashNotice(kind: string): boolean {
  return (
    kind === "panic" ||
    kind === "silent_kill" ||
    kind === "startup_failed" ||
    kind === "abort" ||
    kind === "early_exit"
  );
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
