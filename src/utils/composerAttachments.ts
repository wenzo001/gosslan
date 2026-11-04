/**
 * 粘贴图片「先入框」的纯判定（便于 node --test 单测）。
 *
 * 聊天输入框以前把剪贴板图片直接交给发送链路（`emit("send-image")`），
 * 用户 2026-11-04 要求改成：先作为**待发送附件**进输入框，可继续打字、可删，
 * 最后一起发送。这里只负责「这张图能不能收 / 为什么不能收」，DOM 与状态在
 * `MessageComposer.vue`。
 *
 * ⚠️ 支持的 MIME 必须与 Rust `save_outgoing_image` 的四个分支一致
 * （`src-tauri/src/commands/files.rs: image/png、image/jpeg、image/gif、image/webp`）。
 * 前端先拒掉不支持的格式，避免"先读成 data URL、跨 IPC、再被后端拒绝"的无用功，
 * 也避免用户按了 Ctrl+V 却什么提示都没有。
 */

export type PastedImageRejection = "unsupported" | "too-large";

/** 后端能落盘的图片格式（小写比较）。 */
export const SUPPORTED_PASTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/**
 * 判一张候选图片的归宿：
 * - `null` = 可以入框；
 * - `"unsupported"` = 格式不支持（如 SVG / HEIC / BMP）；
 * - `"too-large"` = 超过字节上限。
 */
export function pastedImageRejection(
  type: string,
  sizeBytes: number,
  maxBytes: number,
): PastedImageRejection | null {
  if (!SUPPORTED_PASTED_IMAGE_TYPES.has(type.toLowerCase())) return "unsupported";
  if (!Number.isFinite(sizeBytes) || sizeBytes > maxBytes) return "too-large";
  return null;
}
