/**
 * 「这一行文件传输多久没有动过」的**唯一**判定（10-22 审计 D-27 / R-05 的界面那一半）。
 *
 * ## 为什么前端要自己判一次
 * 后端对停滞是有发言权的：writer 塞住会发 `file-stalled`，前端据此显示「网络停滞」+ 原因。
 * 但那一族有一条它自己说不了的情况 —— **常驻 worker 静默死亡**（审计 R-05：10 个 worker 全部
 * 丢弃 `JoinHandle`、`is_finished` 全仓 0 命中、没有任何监督）。worker 死了就没有 `file-progress`、
 * 也没有 `file-stalled`、更没有终态事件，于是界面上是一条**永远停在 84% 的进度条**，
 * 既不报错也不动 —— 用户只能猜"是不是还在传"。这属于"必须靠重启才能恢复"那一族。
 *
 * ## 与后端那条判据的分工（不是复制它）
 * - 后端 `file-stalled`：说的是**这条链路的写出**卡住了（有原因、有阈值、会自愈）。
 * - 本模块：说的是**这一行已经 N 秒没有任何来自后端的更新，而且后端也没说它在停滞**
 *   ⇒ 覆盖的正是后端不会报告的那一格（终态与停滞两条路都没人来按）。
 * 两者不许叠成同一句话：后端已经标了停滞时，界面继续用后端那个原因（它更准、带原因文案）。
 *
 * ## 为什么 60s
 * 必须**长于**后端那条 45s 心跳看门狗（`transport.rs` 心跳 15s × 3），否则同一行会先在
 * 「网络停滞」和「传输已停止」之间来回跳 —— 两个判据打架时，用户看到的是抖动而不是信息。
 * 而只要传输真的还在推进，每个分块都会带一次 `file-progress`（BLE 上是 4KiB 级），
 * 60s 里一个字节都没更新过，就已经不是"慢"了。
 */
export const NO_PROGRESS_TIMEOUT_MS = 60_000;

/**
 * 进度是否已经停止推进。
 *
 * `lastChangeMs` 为 0 或非法时**不算停滞**：那是"这一行还没拿到过第一个读数"，
 * 判它停了会在切换会话/首帧的瞬间给出一条假故障（假故障比沉默更贵 —— 用户会去按取消）。
 * 恰好等于阈值算停滞（两侧都试过的夹具见同名测试）。
 */
export function progressHasStalled(
  nowMs: number,
  lastChangeMs: number,
  timeoutMs: number = NO_PROGRESS_TIMEOUT_MS,
): boolean {
  if (!Number.isFinite(lastChangeMs) || lastChangeMs <= 0) return false;
  if (!Number.isFinite(nowMs)) return false;
  return nowMs - lastChangeMs >= timeoutMs;
}

/**
 * 进度值是否"真的变了"（用来决定要不要重置计时）。
 *
 * 判据是读数**变了**，不是"变大了"：重传 / 续传会把进度回退，那同样是后端还在动，
 * 不该被判成停滞。真正要排除的是**相同**的读数 —— 否则后端每隔几秒重发同一个百分比
 * 就能把这条判据永远按住（那正是"守卫被喂着不动"的形状）。
 */
export function progressAdvanced(prev: number | null, next: number | null): boolean {
  if (next === null) return false;
  if (prev === null) return true;
  return next !== prev;
}

/**
 * 「停滞」标签的有效期（10-22 审计 D-5：停滞标记无 TTL，漏一条事件就永久挂着）。
 *
 * 后端只在**翻转**时发 `file-stalled`，所以"停滞已恢复"那一条一旦漏掉（重连、窗口切换、
 * 事件绑定失败那一族），界面上这行会**永远**写着「网络停滞」—— 而它下面还在走进度。
 * 这是本仓 `loading 永不停在 true` 那一族里唯一没被 `finally` 覆盖的成员。
 *
 * 90s = 心跳 15s × 6：持续性的停滞（例如"只有蓝牙、等 LAN 回来"）后端每个心跳 flush 会重发一次，
 * 重发会刷新盖章时间；连着错过 6 次说明这条链上已经没人再提这件事了。
 * ⚠️ 同样是**下限核对**而非跨语言同值承诺：15s 那个数在 Rust 侧，这里只钉"前端不许比后端的
 * 重发节奏更早开口"。
 */
export const STALL_FLAG_TTL_MS = 90_000;

/** 停滞标记是否还算数。`flaggedAt` 非法（0/NaN）按"不算数"处理 —— 宁可不显示警告，也不显示假的。 */
export function stallFlagAlive(
  nowMs: number,
  flaggedAt: number,
  ttlMs: number = STALL_FLAG_TTL_MS,
): boolean {
  if (!Number.isFinite(flaggedAt) || flaggedAt <= 0) return false;
  if (!Number.isFinite(nowMs)) return false;
  return nowMs - flaggedAt < ttlMs;
}
