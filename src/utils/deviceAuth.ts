/**
 * 外部应用设备认证的前端纯逻辑（claim 文案映射 + 过期倒计时），便于单测。
 * 展示/反馈在 DeviceAuthConfirmModal；这里只放可复算的纯函数。
 */

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