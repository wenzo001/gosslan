/**
 * 归一化「另存为」对话框的返回值。
 *
 * 桌面端 `save()` 返回的是**路径字符串**；而 Android 的 SAF 实现返回
 * `{ file: "content://…" }` 对象（见 tauri-plugin-dialog 的 DialogPlugin.kt
 * `saveFileDialogResult`）。两种形状都必须认，否则 Android 上会把对象原样传给后端，
 * 报 "invalid args destination: invalid type: map"。
 *
 * 纯函数，便于单测；返回 null 表示用户取消 / 无法识别的形状。
 */
export function saveDestinationOf(picked: unknown): string | null {
  if (typeof picked === "string") {
    return picked.length > 0 ? picked : null;
  }
  if (picked && typeof picked === "object") {
    const file = (picked as { file?: unknown }).file;
    if (typeof file === "string" && file.length > 0) {
      return file;
    }
  }
  return null;
}

/**
 * 该错误是不是「用户在文件对话框里点了取消」。
 *
 * 为什么要单独判：桌面端取消时 `save()` 返回 null，而 Android 的插件在
 * `Activity.RESULT_CANCELED` 时是 **reject("File picker cancelled")**。
 * 若一律走错误提示，Android 用户每次取消保存都会看到一个「保存失败」的红条。
 */
export function isDialogCancelled(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return /cancel/i.test(message);
}
