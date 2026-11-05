/**
 * 气泡「单填充皮肤」的外轮廓路径（2026-11-05）。
 *
 * ## 为什么要另起一份形状
 *
 * 用户第三次报同一处接缝：「自己的消息，气泡底边和尾巴之间有一道浅色缝」。
 * 前几修都在调**间距/圆角**，但根因是结构性的：
 * 气泡自己是一个 `border-radius` 矩形（浏览器逐边抗锯齿一次），尾巴是另一个 14×14
 * SVG（再抗锯齿一次），两者在同色叠合处永远有**两条各自独立的边**；而且旧叶形的
 * 填充底边停在 y=13.5（盒内），盒子又 `bottom:0` 贴着气泡边框盒底边 ⇒ 几何上比气泡
 * 底边**短 0.5px**。自己的消息描边透明，这 0.5px 没有任何一层去补 ⇒ 就是那道缝。
 *
 * 所以这里改成**一条闭合路径**：一次填充就画出「气泡 + 尾巴」的整块轮廓 ——
 * 每角半径照抄气泡当前的实际圆角（可每角不同），尾巴的尖端仍旧落在同一条底边上，
 * 不再有第二条边、也不再有两层各自半透明的边界。
 *
 * ## 几何契约（改一个必须同时改另一处）
 *
 * - 坐标系 = 外壳（= 气泡的 **border-box**）左上角，单位 CSS px；`w/h` 由
 *   `MessageItem` 用 ResizeObserver 现量，圆角用 `getComputedStyle` 现读。
 * - 尾巴只画在**右侧**（自己的消息）。旧实现是「一份朝左的形状 + `scaleX(-1)`」，
 *   皮肤这条路径不能跟着镜像（镜像会把整块气泡的字形/内容一起翻过去），
 *   所以皮肤模式下取消镜像，直接画朝右的那一支 —— 常数与旧叶形是同一组：
 *   根部离底边 10px、尖端伸出边框 8px、尖端落在底边上。
 * - 根部切线必须**竖直**（控制点 `(w, hinge+3)` 在 x=w 的竖线上），与上面的右侧边框
 *   连成一条线；尖端是**尖角**（曲线以斜率 3.5/4 落到水平底边），不得改成直角/圆角。
 * - 路径与 `BubbleTail.vue` 的 `skinD` 是同一份；像素量具 `scripts/` 之外不复制常量。
 */

/** 外壳（= 气泡 border-box）的尺寸与四角外圆角，单位 CSS px。 */
export interface BubbleSkinBox {
  w: number;
  h: number;
  tl: number;
  tr: number;
  bl: number;
  br: number;
}

/** 尾巴从底边向上抬起的高度（旧 14×14 叶形里的 4→14 那一段）。 */
export const TAIL_RISE = 10;
/** 尾巴尖端伸出气泡边框的量（旧叶形 tip 在气泡外 8px）。 */
export const TAIL_REACH = 8;

/** 圆角截到合法范围：同一侧两角之和不得超过对应边长，否则 `A` 弧会画出折点。 */
function fitRadii(box: BubbleSkinBox): [number, number, number, number] {
  const cap = Math.max(0, Math.min(box.w, box.h) / 2);
  const clamp = (r: number) => Math.max(0, Math.min(Number.isFinite(r) ? r : 0, cap));
  let [tl, tr, bl, br] = [clamp(box.tl), clamp(box.tr), clamp(box.bl), clamp(box.br)];
  const shrink = (a: number, b: number, limit: number): [number, number] => {
    if (a + b <= limit || a + b === 0) return [a, b];
    const k = limit / (a + b);
    return [a * k, b * k];
  };
  [tl, bl] = shrink(tl, bl, box.h);
  [tr, br] = shrink(tr, br, box.h);
  [tl, tr] = shrink(tl, tr, box.w);
  [bl, br] = shrink(bl, br, box.w);
  return [tl, tr, bl, br];
}

/** 输出到 3 位小数，去掉多余的 0（路径字符串在小数位数上保持稳定，便于守卫断言）。 */
function n(v: number): string {
  return Number(v.toFixed(3)).toString();
}

/**
 * 一条闭合路径：左上角起笔 → 上边 → 右上角 → 右边 → 根部 → 叶形外缘 → 尖端
 * → 底边 → 左下角 → 左边 → 回到左上角。尾巴在右侧（自己的消息）。
 *
 * 非法尺寸（0 / NaN / 负值）返回 `null` —— 调用方据此退回旧叶形，绝不画一条自我交叉的路径。
 */
export function bubbleSkinPath(box: BubbleSkinBox): string | null {
  const { w, h } = box;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const rise = Math.min(TAIL_RISE, h);
  const reach = TAIL_REACH;
  const [tl, tr, bl] = fitRadii(box);
  const hinge = h - rise;
  const tipX = w + reach;
  const parts: string[] = [`M ${n(tl)} 0`];
  // 上边 + 右上角
  if (tr > 0) parts.push(`L ${n(w - tr)} 0`, `A ${n(tr)} ${n(tr)} 0 0 1 ${n(w)} ${n(tr)}`);
  else parts.push(`L ${n(w)} 0`);
  // 右侧边框直到底边上方 rise 处（根部切线竖直 ⇒ 与右边框无缝）
  parts.push(`L ${n(w)} ${n(hinge)}`);
  // 叶形外缘：切线竖直出发，尖端准确落在底边 y=h 上（不再短 0.5px）
  parts.push(
    `C ${n(w)} ${n(hinge + rise * 0.3)} ${n(w + reach / 2)} ${n(hinge + rise * 0.65)} ${n(tipX)} ${n(h)}`,
  );
  // 底边（从尖端向左）→ 左下角 → 左边 → 左上角
  if (bl > 0) parts.push(`L ${n(bl)} ${n(h)}`, `A ${n(bl)} ${n(bl)} 0 0 1 0 ${n(h - bl)}`);
  else parts.push(`L 0 ${n(h)}`);
  parts.push(`L 0 ${n(tl)}`);
  if (tl > 0) parts.push(`A ${n(tl)} ${n(tl)} 0 0 1 ${n(tl)} 0`);
  parts.push("Z");
  return parts.join(" ");
}

/**
 * 叶形外缘的那一支**开口**路径（描边层用）。
 *
 * 皮肤模式下描边色与旧版同一套（`--bubble-line`，自己的消息是 transparent ⇒ 不可见），
 * 保留它只为两件事：① `designGuards` 要求尾巴必须有一支 `stroke: currentColor` 的线；
 * ② 运行时探针要读得到 `.tail-line` 的 computed stroke。**它不是第二条填充**。
 */
export function bubbleSkinLinePath(box: BubbleSkinBox): string | null {
  const { w, h } = box;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const rise = Math.min(TAIL_RISE, h);
  const hinge = h - rise;
  return `M ${n(w)} ${n(hinge)} C ${n(w)} ${n(hinge + rise * 0.3)} ${n(w + TAIL_REACH / 2)} ${n(
    hinge + rise * 0.65,
  )} ${n(w + TAIL_REACH)} ${n(h)}`;
}
