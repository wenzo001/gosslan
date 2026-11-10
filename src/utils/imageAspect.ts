/**
 * 聊天缩略图的「安全长宽比」盒子（纯函数，零依赖，便于 node --test）。
 *
 * 为什么需要：气泡定宽 208、最高 288。超长截图（宽高比 1:5）按 contain 放进这个框后，
 * 图只剩一条 ~40px 宽的细条（用户 2026-11-10：「非常难点细长细长的那种图片」）。
 * 规则：宽高比夹在 `1/maxRatio`–`maxRatio` 之间；被夹掉的极端图**裁切**显示
 * （`cover=true`，取中间最大冗余），原图仍可点开灯箱看全。普通比例返回实际比例、不裁。
 * 旧消息没有像素尺寸时不调用本函数（固定 208×288 的兼容路径）。
 */
export interface ImageBox {
  width: number;
  height: number;
  /** true = 比例被夹过，渲染端应该用 object-cover 裁切；false = 按真实比例 contain 即可。 */
  cover: boolean;
}

export function clampImageBox(
  w: number,
  h: number,
  maxWidth: number,
  maxHeight: number,
  maxRatio = 3,
): ImageBox {
  if (!(w > 0) || !(h > 0) || maxWidth <= 0 || maxHeight <= 0 || maxRatio <= 1) {
    return { width: maxWidth, height: maxHeight, cover: false };
  }
  const ratio = w / h;
  const lo = 1 / maxRatio;
  const hi = maxRatio;
  if (ratio >= hi) {
    return { width: maxWidth, height: Math.round((maxWidth / hi) * 100) / 100, cover: ratio > hi };
  }
  if (ratio <= lo) {
    return { width: Math.round(maxHeight * lo * 100) / 100, height: maxHeight, cover: ratio < lo };
  }
  // 中间档：高度先按宽度/比例算，再受最大高度限制；宽度由最终高度反推，
  // 保证竖图不会缩成细条（宽 ≥ maxHeight / maxRatio）。
  const height = Math.min(maxHeight, Math.round((maxWidth / ratio) * 100) / 100);
  const width = Math.round(height * ratio * 100) / 100;
  return { width, height, cover: false };
}
