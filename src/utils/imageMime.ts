// 扩展名 → MIME（单列一家的理由见下）。
//
// ## 为什么从 `filePreview.ts` 搬出来
// `imageThumbnail.ts`（浏览器侧转码器）需要 `imageMime`，而 `filePreview.ts` 又需要
// 引入 `bubbleImageBytes` 来生成缩略图 ⇒ 两份互相 import，形成**模块循环**。
// ESM 能容忍一部分循环，但循环一旦踩到"某一边在初始化期就用到另一边的绑定"就是运行时报错，
// 而且这类错误只在特定加载顺序下才现形（dev 好、prod 炸那一类）。
// `imageMime` 是**纯函数、零依赖**，把它放到最底层是最小、最没有副作用的断环方式。
//
// 本文件是这一列的唯一出口：`filePreview.ts` 曾短暂 `export { imageMime }` 转出以省去改
// import 点，那层转出已删（它让"谁依赖谁"又变得看不出方向）。

/**
 * 扩展名 → MIME。
 *
 * ⚠️ **HEIC/HEIF 注意**：Chrome/Edge/Firefox **原生不支持渲染 HEIC**（只有 macOS Safari 16+ 支持），
 * 所以我们在发送端自动转 JPEG（见 mobile_picker.rs 的 UNSAFE_IMAGE_EXTS）。
 * 这里保留 heic/heif 的 MIME 映射只是**兜底** — 如果转码失败、或者历史消息里有 HEIC，
 * 至少前端不会把它当成 application/octet-stream 下载，而是尝试渲染（浏览器不支持时自然裂开，
 * 比偷偷下载要好）。
 */
export function imageMime(name: string): string {
  const ext = (name.split(".").pop() || "").toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "heic":
    case "heif":
      return "image/heic";
    case "avif":
      return "image/avif";
    case "bmp":
      return "image/bmp";
    default:
      return "application/octet-stream";
  }
}
