/**
 * 安全码「已与对方比对一致」的本机标记（J1-4a，旅程走查 2026-11-20，用户拍板）。
 *
 * ## 为什么放本机（safeStorage）而不是协议/库里
 * 「我有没有跟对方当面核对过安全码」是**本机用户自己的操作记忆** —— 换台设备
 * 天然就不存在这个事实（核对发生在那台设备的屏幕前）。与 `memberNameCache` /
 * `announcementDismiss` 同一立场：本机记录、不参与任何信任判断（好友关系的
 * 信任锚始终是公钥绑定，这里只是把"我核对过"这个动作留个痕）。
 *
 * ## 失败方向
 * 读失败 ⇒ 全部按「未核对」显示（最坏是徽章消失，用户重新勾一次）；
 * 写失败 ⇒ 静默吞掉（勾选状态当场由 UI 响应，持久化尽力而为）。
 * **抛错绝不允许往上冒**：资料页挂载会读它，炸了整个资料页挂载失败
 * （同 `memberNameCache` 文件头那条教训）。
 */

export const SAFETY_VERIFIED_KEY = "gosslan.safetyVerified.v1";

/** 上限。核对标记按 device_id 记，一个网络里核对过的设备上界再宽一档；裁旧。 */
export const SAFETY_VERIFIED_MAX = 240;

/** `device_id -> 核对时刻（毫秒）`。键的插入顺序 = 新旧顺序（重新勾选会重插）。 */
export type SafetyVerifiedCache = Record<string, number>;

type KVStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

/**
 * 只收「正整数时间戳」这一种形状：旧版本写过的字符串/负数/0 一律丢掉，
 * 宁可显示成未核对，也不把一个可疑值展示成"已核对于 …"。
 */
export function parseSafetyVerified(raw: string | null): SafetyVerifiedCache {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: SafetyVerifiedCache = {};
    for (const [id, ts] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) out[id] = ts;
    }
    return out;
  } catch {
    return {};
  }
}

/** 裁旧：超过上限时丢掉最旧的条目（键的插入顺序 = 新旧顺序）。 */
export function trimSafetyVerified(cache: SafetyVerifiedCache): SafetyVerifiedCache | null {
  const ids = Object.keys(cache);
  if (ids.length <= SAFETY_VERIFIED_MAX) return null;
  const next: SafetyVerifiedCache = {};
  for (const id of ids.slice(ids.length - SAFETY_VERIFIED_MAX)) next[id] = cache[id];
  return next;
}

export function readSafetyVerified(store: KVStore | null): SafetyVerifiedCache {
  if (!store) return {};
  try {
    return parseSafetyVerified(store.getItem(SAFETY_VERIFIED_KEY));
  } catch {
    return {};
  }
}

export function writeSafetyVerified(store: KVStore | null, cache: SafetyVerifiedCache): void {
  if (!store) return;
  try {
    store.setItem(SAFETY_VERIFIED_KEY, JSON.stringify(cache));
  } catch {
    // 隐私模式/配额满：用户重开资料页还会再试，不把异常抛给资料页挂载链路。
  }
}
