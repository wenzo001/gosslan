/**
 * 可视区之外还要预渲染多少行 —— 由**像素位移**决定，而不是固定条目数。
 *
 * 2026-10-25 实测（`perf/scrollab.mjs`，1200 条混合消息，冷测量缓存）：
 *   · 固定 overscan=6（≈360px）时，400px/帧 有 45/90 帧出现空白带，800px/帧 83/90；
 *   · 固定 overscan=36 能让 400px/帧归零，但 800px/帧 反而更差（81 行、p95 97ms、单帧 700ms）。
 * ⇒ 缓冲必须随「速度 + 视口 + 当前平均行高」走，并且有硬上限；方向优先给前进侧。
 *
 * 这里只做纯算术（可跑真值表）；读滚动位置、更新 `edgeBuffer` 由组件负责。
 */
export interface ListBufferInput {
  /** 可视区高度（px） */
  viewport: number;
  /** 最近一帧的滚动位移（px，正 = 向下）。 */
  velocity: number;
  /** 当前总高度 / 条目数（px/条）；未知时传 0，会按 80 兜底。 */
  avgRow: number;
  /** 库自身已经包含的条目 overscan。 */
  overscan: number;
  /** 渲染行数硬上限（含 overscan 与视口）。 */
  maxRows?: number;
}

export interface ListBuffer {
  /** 可视区之后额外多渲染的条目数（不含库自带的 overscan）。 */
  forward: number;
  /** 可视区之前额外多渲染的条目数。 */
  backward: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function computeListBuffer({
  viewport,
  velocity,
  avgRow,
  overscan,
  maxRows = 56,
}: ListBufferInput): ListBuffer {
  const vp = clamp(Number.isFinite(viewport) ? viewport : 0, 200, 4000);
  const rawV = Number.isFinite(velocity) ? velocity : 0;
  const v = clamp(Math.abs(rawV), 0, 20_000);
  const avg = clamp(Number.isFinite(avgRow) && avgRow > 0 ? avgRow : 80, 24, 320);
  const base = Math.ceil(Math.max(vp * 0.5, 240) / avg);
  const lead = Math.ceil((Math.max(vp * 0.75, 360) + v * 1.5) / avg);
  const idle = v < 8;
  // 方向优先：只有前进侧吃速度；后退侧只留半屏。
  const extraFor = (rows: number) => (idle ? 0 : clamp(rows - overscan, 2, 34));
  let forward = extraFor(lead);
  let backward = extraFor(base);
  if (rawV < 0) [forward, backward] = [backward, forward];
  // 硬上限：总行数（可视区约 ceil(vp/avg) + overscan*2 + 两侧额外）不超过 maxRows。
  const visible = Math.ceil(vp / avg);
  const budget = Math.max(0, maxRows - visible - overscan * 2);
  while (forward + backward > budget && (forward > 0 || backward > 0)) {
    if (forward >= backward && forward > 0) forward -= 1;
    else if (backward > 0) backward -= 1;
    else break;
  }
  return { forward, backward };
}
