/**
 * 卡顿判定的**纯逻辑**：给定在途操作与当前时刻，决定要不要提示、提示哪一条。
 *
 * 10 s 提示 / 30 s 升级；`snoozeUntil` 是用户点过「继续等待」之后的静默窗口。
 * 不碰 DOM、不读时钟（时刻由调用方给），所以能被 node:test 直接覆盖。
 */
import { shouldRunThrottled } from "./defer.ts";
import type { InflightOp } from "./ipcTracker";

export const UI_STALL_BANNER_MS = 10_000;
export const UI_STALL_ESCALATE_MS = 30_000;
export const UI_STALL_SNOOZE_MS = 60_000;
/** 浏览器 long task 的取证阈值与最小间隔（只影响日志，不影响界面）。 */
export const LONG_TASK_LOG_MS = 2_000;
export const LONG_TASK_LOG_COOLDOWN_MS = 5_000;

/** 这条 long task 要不要落一行取证日志。 */
export function shouldLogLongTask(durationMs: number, now: number, lastLoggedAt: number): boolean {
  return durationMs >= LONG_TASK_LOG_MS
    && shouldRunThrottled(now, lastLoggedAt, LONG_TASK_LOG_COOLDOWN_MS);
}

export interface StallView {
  id: number;
  label: string;
  seconds: number;
  escalated: boolean;
}

export function decideStall(
  ops: InflightOp[],
  now: number,
  snoozeUntil: number,
): StallView | null {
  if (now < snoozeUntil) return null;
  // `inflightOps()` 已按开始时间升序：第一条够老的就是"卡住的那一条"。
  for (const op of ops) {
    const ms = now - op.startedAt;
    if (ms >= UI_STALL_BANNER_MS) {
      return {
        id: op.id,
        label: op.label,
        seconds: Math.floor(ms / 1000),
        escalated: ms >= UI_STALL_ESCALATE_MS,
      };
    }
  }
  return null;
}
