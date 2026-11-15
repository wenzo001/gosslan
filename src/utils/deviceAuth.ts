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

/**
 * scope → i18n key 的静态映射。
 *
 * scope（交付范围）与 claim（这条断言带什么）是两件事：claim 管登录凭据的面，
 * scope 管「这次事务能读到什么」。allowlist 三项（裁决 2026-11-15：好友 + 消息元事件，
 * 同日追加群列表）。这张表同时是**前端侧的白名单**（`grantedScopes` 用它挡第三重），
 * 所以它必须与后端 `ALLOWED_SCOPES` 逐字一致（判据见 `openExtensionScopeWiring.test.ts`）。
 */
export const DEVICE_AUTH_SCOPE_KEYS: Record<string, string> = {
  "friends.read": "deviceAuth.scope.friends_read",
  "events.metadata": "deviceAuth.scope.events_metadata",
  "groups.read": "deviceAuth.scope.groups_read",
};

/** 取 scope 的文案 key；未知 scope 原样返回（兜底，不静默吞）。 */
export function deviceAuthScopeKey(scope: string): string {
  return DEVICE_AUTH_SCOPE_KEYS[scope] ?? scope;
}

/**
 * 用户勾选后**实际交付**的 scope：请求的 ∩ 勾选的 ∩ allowlist 里的。
 *
 * 三重收窄的第三道（前端侧）：后端还会再收窄一次（请求 ∩ 用户允许 ∩ allowlist），
 * 这里先拦一道，让「界面上没勾的东西不可能被交出去」在类型之外还有一层白名单。
 */
export function grantedScopes(requested: string[], checked: string[]): string[] {
  return requested.filter((s) => DEVICE_AUTH_SCOPE_KEYS[s] && checked.includes(s));
}

/**
 * 绑定状态 → 文案 key。首绑状态机扩展出 `pending_registration` / `registration_failed`
 * 两个中间/失败态后，设置页不能把它们一律当「已撤销」显示（就绪度审计 §3.2）。
 * 未知状态一律归到「绑定未完成」，fail closed，不误标成 active。
 */
export function deviceAuthStatusKey(status: string): string {
  if (status === "active") return "deviceAuth.statusActive";
  if (status === "revoked") return "deviceAuth.statusRevoked";
  return "deviceAuth.statusIncomplete";
}

/**
 * 是否需要为「拒绝」显示重试入口（P1 拒绝可观察）。
 * 只有后端明确 `rp_notified === false`（本机已拒绝、RP 未收到）才要重试；
 * `undefined`（老后端 / 字段缺失）保持既有一次性语义，不弹重试入口。
 */
export function deviceAuthDenyNeedsRetry(rpNotified: boolean | undefined): boolean {
  return rpNotified === false;
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