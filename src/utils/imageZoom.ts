/**
 * 图片灯箱的 FLIP 缩放（从"被点的那张缩略图"展开 / 关闭时缩回）。
 *
 * 背景（用户 2026-11-05）：点聊天里的图片，期望"从原图位置放大展开、关闭缩回"，
 * 实际只有一层整体淡入，没有"从这张图长出来"的连续感。这里只做**纯 transform**：
 * 先量缩略图矩形和查看器里图片落定后的矩形，算出 `scaleX/scaleY/translate`，
 * 让第一帧的矩形**精确等于**缩略图矩形，再把变换收回 1/0。
 *
 * ⚠️ 不许改用 left/top/width/height 之类的布局属性做补间：那会真的去重排，
 * 既掉帧又会让"向右滑一下"这种位移感回来。矩形只读一次，动画只写 transform。
 *
 * 坐标口径：两个矩形都是**同一个文档的 client 坐标**（`getBoundingClientRect`）。
 * 桌面端与移动端共用这一套覆盖层（桌面窗口本身就承载视口），所以不存在跨文档换算。
 */

export interface ImageRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** FLIP 起始变换：以元素中心为原点做非等比缩放 + 中心对齐平移。 */
export interface ImageZoomTransform {
  scaleX: number;
  scaleY: number;
  x: number;
  y: number;
}

const rectOf = (el: Element | null | undefined): ImageRect | null => {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!(r.width > 0) || !(r.height > 0)) return null;
  return { left: r.left, top: r.top, width: r.width, height: r.height };
};

/**
 * 让 `rect`（查看器里的图片当前落定位置）在第一帧看起来与 `origin`（缩略图）重合。
 *
 * 变换以元素中心为原点：`translate(x, y) scale(scaleX, scaleY)`。
 * 中心对齐的平移是 FLIP 的必要分量（缩略图不在屏幕中心时，横向位移必然存在）；
 * 它只负责把中心对齐，不会产生额外的"滑一下"。
 */
export function flipTransform(rect: ImageRect, origin: ImageRect): ImageZoomTransform {
  const scaleX = origin.width / rect.width;
  const scaleY = origin.height / rect.height;
  const x =
    origin.left + origin.width / 2 - (rect.left + rect.width / 2);
  const y =
    origin.top + origin.height / 2 - (rect.top + rect.height / 2);
  return { scaleX, scaleY, x, y };
}

/**
 * "刚刚点的是哪张缩略图"的一次性记忆。
 *
 * 为什么不在 `openGallery` 时去 DOM 里找：点开的入口有消息气泡、待办缩略图、收藏等
 * 多处，靠选择器猜哪个是"被点的"并不可靠；在 pointerdown 那一刻记下真实元素最诚实。
 * ⚠️ 只认 `[data-img-frame]`（消息图片的稳定外框）；其他入口命中不到就返回 null，
 * 灯箱退回原来的淡入，不编造起点。
 */
const ORIGIN_TTL_MS = 1200;
const ORIGIN_SELECTOR = "[data-img-frame]";
let pendingOrigin: { el: Element; rect: ImageRect; at: number } | null = null;

export function rememberImageOrigin(target: EventTarget | null | undefined): void {
  const el = target instanceof Element ? target.closest(ORIGIN_SELECTOR) : null;
  const rect = rectOf(el);
  if (!el || !rect) return;
  pendingOrigin = { el, rect, at: performance.now() };
}

/**
 * 取出并消费这次点击的起点矩形。超过 `ORIGIN_TTL_MS` 的旧记忆不复用
 * （防止"上次点图、这次从键盘/菜单打开"时拿一个过期矩形乱飞）。
 * 元素还在文档里就**重新量一次**（pointerdown 到 click 之间可能刚好滚动过）。
 */
export function takeImageOrigin(maxAgeMs = ORIGIN_TTL_MS): ImageRect | null {
  const p = pendingOrigin;
  pendingOrigin = null;
  if (!p) return null;
  if (performance.now() - p.at > maxAgeMs) return null;
  if (p.el.isConnected) {
    const fresh = rectOf(p.el);
    if (fresh) return fresh;
  }
  return p.rect;
}
