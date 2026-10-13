// 气泡缩略图的**浏览器侧转码器**：真实 `createImageBitmap` + canvas。
//
// 决策部分（该不该压 / 算不算成功 / 失败怎么办）全在 `imageThumb.ts` 里，那一份可在
// Node 单测；本文件只负责"真的去解码与重编码"这件必须待在浏览器里的事。
//
// ⚠️ 本文件**不抛异常**给调用方：`thumbnailBytes` 已经把任何抛出都兜成"回退原图"，
// 但这里仍然自己先判环境（没有 canvas 就直接回 null），省掉一次必然的异常开销。

import {
  fitThumbnailSize,
  thumbnailBytes,
  THUMB_JPEG_QUALITY,
  type Thumbnail,
  type ThumbnailEncoder,
} from "@/utils/imageThumb";
import { imageMime } from "@/utils/imageMime";

/** 这个环境能不能转码（没有任何一部分缺失才返回 true）。 */
export function canEncodeThumbnail(): boolean {
  return (
    typeof createImageBitmap === "function" &&
    typeof document !== "undefined" &&
    typeof HTMLCanvasElement !== "undefined"
  );
}

/**
 * 真的把原图字节转成缩略图 JPEG 字节。
 *
 * 做不到就返回 `null`（而不是抛）—— 三条"做不到"的路径：
 * ① 环境缺 API（老 WebView / 测试环境）；② 解码失败（HEIC 这类浏览器不认的格式）；
 * ③ canvas 拿不到 2d 上下文或 `toBlob` 产出空。
 */
export const canvasThumbnailEncoder: ThumbnailEncoder = async (bytes, mime): Promise<Thumbnail | null> => {
  if (!canEncodeThumbnail()) return null;
  let bitmap: ImageBitmap | null = null;
  try {
    // `new Blob` 接受 Uint8Array；MIME 用调用方给的那份（它来自 `imageMime(name)`）。
    const blob = new Blob([bytes], { type: mime });
    // imageOrientation: "from-image" 让 EXIF 旋转照样生效 —— 手机竖拍的照片若忽略
    // EXIF，缩略图会横过来，而气泡是定宽 208px 的，横过来就是明显错位。
    bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
    const size = fitThumbnailSize(bitmap.width, bitmap.height);
    // 退化尺寸（0 宽/0 高）⇒ 别建 0 尺寸 canvas（`toBlob` 会产出空字节）。
    if (size.width <= 0 || size.height <= 0) return null;

    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    // 白底：JPEG 没有 alpha 通道，透明区域不铺底会变成黑块。
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size.width, size.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);

    const out: Blob | null = await new Promise((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/jpeg", THUMB_JPEG_QUALITY);
    });
    if (!out || out.size === 0) return null;
    return { bytes: new Uint8Array(await out.arrayBuffer()), mime: "image/jpeg" };
  } catch {
    // 解码失败/格式不支持（HEIC 等）都落这里 ⇒ 交给上层回退原图。
    return null;
  } finally {
    // ImageBitmap 持有一份解码后的位图（可达原图数倍），必须显式关掉，
    // 否则这十几 MB 要等 GC —— 而本任务正是来治内存的。
    bitmap?.close();
  }
};

/**
 * 给一份原图字节产出"气泡该用的那份字节"：能压就压，压不了原样返回。
 *
 * 调用方（`filePreview`）拿这个结果建 Blob/objectURL，因此它**永远返回可用的字节**。
 */
export async function bubbleImageBytes(
  bytes: Uint8Array,
  name: string,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string; thumbnailed: boolean }> {
  const mime = imageMime(name);
  return thumbnailBytes({ bytes, mime, name }, canvasThumbnailEncoder);
}
