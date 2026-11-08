/**
 * 背景动效的**能力**判定（不是用户偏好）—— 2026-11-08 用户口径。
 *
 * 用户原话：「如果判断用户没开的话，那设置里面默认选项就不能选择，并且是关闭的。」
 * 动机是一台 Windows 关掉系统「透明效果」后雾看不见：开着一个**看不出效果**的开关，
 * 用户只会以为功能坏了。所以能力不支持时：档位显示为关、控件置灰、并写明原因。
 *
 * ⚠️ 关键区分（用户同一条要求里的原话）：**"用户主动选过"与"能力不支持"是两件事**。
 *   · 能力不支持 → 不给选，显示 off；但**不写库**，用户原来的显式值仍留在存储里；
 *   · 能力恢复   → 回到用户显式选过的值（从未选过则回到三层优先级的默认）。
 *
 * 两个能力条件（任一不满足 ⇒ 动效不可能看见）：
 *   1. 系统要求减少透明（Windows「透明效果」关闭 = `prefers-reduced-transparency: reduce`）。
 *      WKWebView 不实现这条查询，读不到按"不限制"处理（与 reducedTransparency.ts 同口径）。
 *   2. 内核不支持 `backdrop-filter`。判据必须与 `style.css` 的
 *      `@supports not ((backdrop-filter) or (-webkit-backdrop-filter))` 同口径 ——
 *      两个属性都问，只问无前缀那个会在旧 WebKit 上误判。
 *
 * 单一出口：`utils/ambient.ts` 只调 `readAmbientCapability()`，不自己拼媒体查询；
 * 视图层不碰 `matchMedia` / `CSS.supports`（designGuards ㉟）。
 */
import {
  REDUCED_TRANSPARENCY_QUERY,
  systemPrefersReducedTransparency,
} from "./reducedTransparency.ts";

export type AmbientUnavailableReason = "reduced-transparency" | "no-backdrop-filter";

export interface AmbientCapability {
  available: boolean;
  /** 不可用时的第一条原因（按影响面排序）；可用时为 null。 */
  reason: AmbientUnavailableReason | null;
}

/** 纯函数：能力两个输入的聚合（单测直接喂真值表，不碰 DOM）。 */
export function resolveAmbientCapability(input: {
  systemReducedTransparency: boolean;
  supportsBackdropFilter: boolean;
}): AmbientCapability {
  if (input.systemReducedTransparency) return { available: false, reason: "reduced-transparency" };
  if (!input.supportsBackdropFilter) return { available: false, reason: "no-backdrop-filter" };
  return { available: true, reason: null };
}

/** 纯函数：`backdrop-filter` 双属性探测（与 style.css 的 `@supports not (… or -webkit-…)` 同口径）。 */
export function supportsBackdropFilterBy(
  supports: (property: string, value: string) => boolean,
): boolean {
  return (
    supports("backdrop-filter", "blur(2px)") ||
    supports("-webkit-backdrop-filter", "blur(2px)")
  );
}

/**
 * 运行时能力读数。**每次现读**：系统「透明效果」在会话中途被切换时，下一次解析就能拿到新值。
 * 环境读不到（Node 单测 / 没有 CSS 对象）按"不限制"处理 —— 与 `matchMedia` 那一条同口径，
 * 不把"量不到"当成"不支持"。
 */
export function readAmbientCapability(): AmbientCapability {
  const css = typeof CSS !== "undefined" ? CSS : null;
  return resolveAmbientCapability({
    systemReducedTransparency: systemPrefersReducedTransparency(),
    supportsBackdropFilter:
      css && typeof css.supports === "function"
        ? supportsBackdropFilterBy((p, v) => css.supports(p, v))
        : true,
  });
}

/**
 * 订阅能力变化并回调最新读数。返回摘除函数（`installAmbient` 每个窗口装一次，不摘）。
 *
 * ⚠️ 只能订阅媒体查询这一半：`CSS.supports` 没有 change 事件，内核能力在一次会话里也不会变
 * （换内核 = 重启应用），所以那半只在启动/建窗时定值。这个不对称是有意的，不是漏了监听。
 */
export function watchAmbientCapability(onChange: (c: AmbientCapability) => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  let mq: MediaQueryList;
  try {
    mq = window.matchMedia(REDUCED_TRANSPARENCY_QUERY);
  } catch {
    return () => {};
  }
  // 老 WebKit 的 MediaQueryList 只有 addListener（没有 addEventListener）—— 不硬造兼容层，
  // 直接不订阅：那类内核本来也不实现这条查询（恒为 false），没有变化可等。
  if (typeof mq.addEventListener !== "function") return () => {};
  const handler = () => onChange(readAmbientCapability());
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}
