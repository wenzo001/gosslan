// 气泡缩略图的**决策层**（纯函数，可在 Node 单测）。
//
// ## 为什么要有这一层
// 气泡显示宽只有 208px（`MessageImageBubble` 的 `w-52`），却走 `read_file_preview` 读
// **整份原图**（上限 15 MiB）⇒ 一张 4K 截图在气泡里和点开大图时占一样多的内存。
// 用户 2026-10-12 报主 WebView2 601.7 MB，这是其中一条确定的放大器。
//
// ## 为什么决策与执行分开
// 真实转码要 `createImageBitmap` + canvas，两样在 Node 里都没有 ⇒ 混在一起就**不可单测**，
// 而"该不该压、压完算不算成功、失败了怎么办"这些恰恰是最容易写错、也最该被钉住的部分。
// 所以：本文件只做"要不要压 / 这算不算成功"的判断，真正的 canvas 调用留在
// `imageThumbnail.ts` 里由调用方注入。与 `avatarImage.ts` 的质量阶梯同一手法。
//
// ## 三条硬规则（都来自既有的真机教训，别推翻）
// 1. **GIF 不压**：canvas 只画第一帧 ⇒ 压完动画就没了。宁可不省这点内存，也不能把动图变静图。
// 2. **失败一律回退原图**：转码失败/不支持/环境没有 canvas，都必须**静默**用原图 ——
//    缩略图是优化，任何情况下不许让它挡住"消息发送"或"图片显示"。
// 3. **NEAREST 之外的算法不额外引入**：默认 `imageSmoothingQuality` 就够，不引第三方库。

/** 缩略图目标宽度（CSS px 的 2 倍，供高 DPI 屏用）：208 × 2 = 416。 */
export const THUMB_MAX_WIDTH = 416;

/** JPEG 质量：与 `avatarImage` 的"尽量高、接近无损"口径一致。 */
export const THUMB_JPEG_QUALITY = 0.85;

/** 已压好的缩略图。 */
export type Thumbnail = {
  /** 缩略图字节。 */
  bytes: Uint8Array<ArrayBuffer>;
  /** 输出 MIME（目前恒为 image/jpeg）。 */
  mime: string;
};

/** 转码器：给了原图字节与 MIME，返回缩略图；做不到就返回 null（调用方回退原图）。 */
export type ThumbnailEncoder = (
  bytes: Uint8Array<ArrayBuffer>,
  mime: string,
) => Promise<Thumbnail | null>;

/** 判断某个 MIME 是否**禁止**压缩（保动画/保透明）。 */
export function isThumbnailExempt(mime: string, name: string): boolean {
  // GIF：压了就丢动画（canvas 只画第一帧）。
  if (mime === "image/gif") return true;
  if (name.toLowerCase().endsWith(".gif")) return true;
  // SVG：本来就是矢量，缩放不省内存；且光栅化会掉质量。
  if (mime === "image/svg+xml") return true;
  return false;
}

/**
 * 缩略图值不值得做 —— 小于这个尺寸的原图本来就比缩略图大不了多少。
 *
 * 取值理由：一屏气泡按 208px 宽算，JPEG q85 的缩略图约 10–40 KB。
 * 原图若已经 ≤ 64 KB，再压一次的收益抵不上一次转码成本与一次质量损失。
 */
export const THUMB_MIN_SOURCE_BYTES = 64 * 1024;

/** 该不该为这条图生成缩略图。 */
export function shouldThumbnail(opts: {
  bytes: Uint8Array;
  mime: string;
  name: string;
}): boolean {
  const { bytes, mime, name } = opts;
  // 空字节：没东西可压（调用方本来也拿不到 url）。
  if (bytes.length === 0) return false;
  // 非图片（代码预览/失败结果）：不碰。
  if (!mime.startsWith("image/")) return false;
  if (isThumbnailExempt(mime, name)) return false;
  if (bytes.length <= THUMB_MIN_SOURCE_BYTES) return false;
  return true;
}

/**
 * 跑一遍缩略图管线，**任何失败都回退原图**。
 *
 * 返回 `{ bytes, mime, thumbnailed }`：`thumbnailed=false` 表示"用传进来的那份原图"，
 * 调用方据此建 Blob 即可 —— 也就是说这个函数**永远有一个可用的返回值**，不会抛出。
 *
 * ⚠️ 三种"不该压"的输入（见 `shouldThumbnail` / `isThumbnailExempt`）直接原样返回，
 * 连转码器都不叫 —— 尤其别把 GIF 叫进去（有些实现会"成功地"返回一张静态图）。
 */
export async function thumbnailBytes(
  opts: {
    bytes: Uint8Array;
    mime: string;
    name: string;
  },
  encode: ThumbnailEncoder,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string; thumbnailed: boolean }> {
  const { bytes: given, mime, name } = opts;
  // 回退路径上把入参原样带出；入参可能来自 `Uint8Array(raw)`（类型上是
  // `Uint8Array<ArrayBufferLike>`），这里统一收窄成 Blob 能接受的 `Uint8Array<ArrayBuffer>`：
  // 实参在运行时**一定**是普通 ArrayBuffer 视图（后端回传来的是 ArrayBuffer 或 number[]），
  // 收窄只是把 TS 的 SharedArrayBuffer 分支排除掉，不改任何运行时行为。
  const bytes = given as Uint8Array<ArrayBuffer>;
  const fallback = { bytes, mime, thumbnailed: false };
  if (!shouldThumbnail({ bytes, mime, name })) return fallback;
  try {
    const out = await encode(bytes, mime);
    // 转码器说做不到 ⇒ 回退。
    if (!out) return fallback;
    // 产出空字节 ⇒ 当失败处理（拿空 Blob 去渲染就是个裂图，比原图糟得多）。
    if (out.bytes.length === 0) return fallback;
    // 压完反而更大 ⇒ 用原图（小图/已高度压缩的 PNG 会这样）。
    if (out.bytes.length >= bytes.length) return fallback;
    return { bytes: out.bytes, mime: out.mime, thumbnailed: true };
  } catch {
    // 静默回退：缩略图是优化，不许它挡住图片显示。
    return fallback;
  }
}

/**
 * 按目标宽高算出缩略图尺寸（保持宽高比，**绝不放大**）。
 *
 * 不放大是一条真规则：把 100px 宽的原图"缩"到 416px 只会得到一张糊的巨图。
 */
export function fitThumbnailSize(
  width: number,
  height: number,
  maxWidth = THUMB_MAX_WIDTH,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  if (width <= maxWidth) return { width, height };
  const scale = maxWidth / width;
  return { width: maxWidth, height: Math.max(1, Math.round(height * scale)) };
}
