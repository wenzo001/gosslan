/**
 * 外部应用设备认证的前端纯逻辑（claim 文案映射 + 过期倒计时 + 披露 + 代际守卫），便于单测。
 * 展示/反馈在 DeviceAuthConfirmModal；这里只放可复算的纯函数。
 */
import type { DeviceAuthPrompt } from "@/types";

/** claim → i18n key 的静态映射（后端已把未知 claim 整笔拒，这里只覆盖 allowlist 三项）。 */
export const DEVICE_AUTH_CLAIM_KEYS: Record<string, string> = {
  device_subject: "deviceAuth.claim.device_subject",
  device_public_key: "deviceAuth.claim.device_public_key",
  nickname: "deviceAuth.claim.nickname",
};

/** 取 claim 的文案 key；未知 claim 原样返回（兜底，不静默吞）。 */
export function deviceAuthClaimKey(claim: string): string {
  return DEVICE_AUTH_CLAIM_KEYS[claim] ?? claim;
}

/** 距过期的整秒数（向上取整，过期后恒 0，不为负）。 */
export function deviceAuthSecondsLeft(expiresAtMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000));
}

/**
 * 绑定必需、**恒发**的 claim（#4，与后端断言恒含 subject/公钥同口径）。
 * 即便 RP 只请求 nickname，确认页也必须披露这两项 —— 它们是绑定必需，批准即提供。
 */
export const DEVICE_AUTH_ALWAYS_DISCLOSED: readonly string[] = ["device_subject", "device_public_key"];

/**
 * 确认页应披露的 claim 列表（#4）：恒发两项在前，再并入 RP 请求的其它项（去重）。
 * 只请求 nickname 时也会返回 [device_subject, device_public_key, nickname]，杜绝「未披露恒发项」。
 */
export function disclosedClaims(requested: string[]): string[] {
  const out: string[] = [...DEVICE_AUTH_ALWAYS_DISCLOSED];
  for (const c of requested) {
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * 待确认事务的**代际守卫核心**（纯逻辑，无 Vue/api 依赖 ⇒ 可单测，#8）。
 *
 * `generation` 单调递增：新事务到达 / 清空 / 消费各 +1。异步操作（刷新、批准）出发前 capture，
 * 回填前比对：代际变了（清数据 / 新事务到达）⇒ 丢弃旧结果，**绝不复活已消费/已清的事务**。
 * store 用 `reactive(createPendingGuard())` 包一层即获得 Vue 响应性，逻辑本身在这里可复算。
 */
export interface PendingGuard {
  pending: DeviceAuthPrompt | null;
  generation: number;
}

export function createPendingGuard(): PendingGuard {
  return { pending: null, generation: 0 };
}

/** 新事务到达（深链事件 / 手动粘贴）：推进代际并替换。 */
export function guardSetPending(g: PendingGuard, p: DeviceAuthPrompt): void {
  g.generation += 1;
  g.pending = p;
}

/** 清空（拒绝 / 清数据 / 关闭）：推进代际，让所有在途异步对账失败。 */
export function guardClear(g: PendingGuard): void {
  g.generation += 1;
  g.pending = null;
}

/** 刷新回填（同一事务，**不**推进代际）：仅当代际未变才更新；返回是否生效。 */
export function guardRefresh(g: PendingGuard, captured: number, p: DeviceAuthPrompt): boolean {
  if (g.generation !== captured) return false;
  g.pending = p;
  return true;
}

/** 批准/拒绝成功后消费：仅当代际未变才清（避免清掉新到达的事务）；返回是否生效。 */
export function guardConsume(g: PendingGuard, captured: number): boolean {
  if (g.generation !== captured) return false;
  g.generation += 1;
  g.pending = null;
  return true;
}