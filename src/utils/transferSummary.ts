/**
 * 进度取值的纯计算（传输相关 UI 共用）。
 *
 * 为什么单独抽出来：组件测试不跑 DOM ⇒ "越界进度把条画成 140%"只会在真机上被看见；
 * 这里把它归一成一份可被 `npm test` 钉住的判据。
 */

/**
 * 把进度夹回 0..1。
 *
 * 后端给的是 f64，越界不是不可能（续传时先写了半块再回填）。界面不能因为一个
 * 越界值画出 140% 的条，也不能让 `NaN` 把宽度算成 `NaN`。
 */
export function clampProgress(value: number | undefined | null): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}
