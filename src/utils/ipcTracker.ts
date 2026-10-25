/**
 * 在途 IPC 追踪：给"界面卡在哪"提供唯一一份事实。
 *
 * 只记账，不改变任何调用语义；tracker 自身的任何异常都必须吞掉 —— 它绝不能
 * 成为一次 IPC 失败或界面异常的新来源。
 */
export interface InflightOp {
  id: number;
  cmd: string;
  /** 给用户看的标签（例如 `set_channel_enabled(bluetooth)`）。 */
  label: string;
  /** `performance.now()` 的单调时刻。 */
  startedAt: number;
}

const inflight = new Map<number, InflightOp>();
let nextId = 1;

/** 不进追踪表的命令：心跳与慢调用上报本身（否则自我递归/自噪声）。 */
const EXCLUDED = new Set(["ui_heartbeat", "report_frontend_slow_op"]);

export function beginOp(cmd: string, args?: unknown): number {
  try {
    if (EXCLUDED.has(cmd)) return 0;
    const id = nextId++;
    inflight.set(id, { id, cmd, label: labelOf(cmd, args), startedAt: performance.now() });
    return id;
  } catch {
    return 0;
  }
}

export function endOp(id: number): { label: string; ms: number } | null {
  try {
    if (!id) return null;
    const op = inflight.get(id);
    if (!op) return null;
    inflight.delete(id);
    return { label: op.label, ms: performance.now() - op.startedAt };
  } catch {
    return null;
  }
}

/** 当前在途操作（最老的排最前：卡死时就是它）。 */
export function inflightOps(): InflightOp[] {
  try {
    return [...inflight.values()].sort((a, b) => a.startedAt - b.startedAt);
  } catch {
    return [];
  }
}

/** 最近一次发起的操作（心跳上报给后端，用于写卡死现场）。 */
export function lastOpLabel(): string | null {
  const ops = inflightOps();
  return ops.length ? ops[ops.length - 1].label : null;
}

function labelOf(cmd: string, args?: unknown): string {
  if (cmd === "set_channel_enabled") {
    const ch = (args as Record<string, unknown> | undefined)?.channel;
    if (typeof ch === "string" && ch) return `set_channel_enabled(${ch})`;
  }
  return cmd;
}
