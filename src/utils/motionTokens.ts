/**
 * 动效令牌的 JS 读取口（给 motion-v 这类**必须传数字**的 API 用）。
 *
 * 规范要求全站时长/曲线只有一个来源：`src/style.css` 的 `--gosslan-duration-*` /
 * `--gosslan-ease`。但 `animate()` / `layout` 的 `transition` 参数只收秒数与
 * 贝塞尔数组，组件里直接写 `0.24` 等于又开了一份口径（改令牌时它不会跟着变）。
 * 所以这里现读 computedStyle，把 CSS 变量转成 motion-v 需要的形状。
 *
 * 不做缓存：`html.is-mobile` 会把桌面档抬到移动档，缓存会让移动端继续吃桌面值。
 */
function readToken(token: string): string {
  if (typeof document === "undefined") {
    throw new Error(`动效令牌只能在浏览器里读取：${token}`);
  }
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim();
}

/** 令牌 → 毫秒数。 */
export function motionMs(token: string): number {
  const raw = readToken(token);
  if (raw.endsWith("ms")) return Number.parseFloat(raw);
  if (raw.endsWith("s")) return Number.parseFloat(raw) * 1000;
  throw new Error(`动效令牌 ${token} 的值不是时长：${raw || "(空)"}`);
}

/** 令牌 → motion-v 的秒数单位。 */
export function motionSeconds(token: string): number {
  return motionMs(token) / 1000;
}

/**
 * 曲线令牌 → motion-v 的 cubic-bezier 数组。
 * `--gosslan-ease` 是 `cubic-bezier(a, b, c, d)`；解析失败直接抛错，
 * 避免"读不到就悄悄退回默认曲线"这种静默分叉。
 */
export function motionEase(token = "--gosslan-ease"): [number, number, number, number] {
  const raw = readToken(token);
  const m = raw.match(/cubic-bezier\(\s*([\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*([\d.]+)\s*,\s*(-?[\d.]+)\s*\)/);
  if (!m) throw new Error(`动效令牌 ${token} 不是 cubic-bezier：${raw || "(空)"}`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}
