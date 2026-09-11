/**
 * 剪贴板粘贴意图分类（纯逻辑，便于 node --test 单测，不依赖 DOM ClipboardEvent）。
 *
 * 被 MessageComposer.onPaste 用于决定「文件粘贴 / 图片粘贴 / 纯文本粘贴」三条分支。
 * 抽出来的原因：图片粘贴曾在 P1 后被 `types.includes("Files")` 门禁挡住而回归
 * （截图 / 网页「复制图片」的剪贴板 types 常是 image/png 而非 Files），
 * 这里把「是否图片必须独立看 items」这一关键判断固化成可测的纯函数。
 */

export interface ClipboardItemLike {
  kind: string;
  type: string;
}

/** 剪贴板里的文件项（File 只取 type 参与判断，保持纯函数可测）。 */
export interface ClipboardFileLike {
  type: string;
}

export type PasteAction = { kind: "files" } | { kind: "image" } | { kind: "text" };

/**
 * 分类优先级：图片位图（截图/复制图片）> 真实文件路径（资源管理器复制）> 纯文本。
 *
 * 图片必须排在最前：Windows 11 截图（Win+Shift+S）的剪贴板**同时**带一个临时文件引用
 * （CF_HDROP 指向 Temp 下的 PNG），若按「文件路径优先」会把截图误判成文件去发那个
 * 可能已被清理的临时路径，表现为"截图有时发得出去、有时发不出去"。
 *
 * 图片位图必须同时看 `files` 与 `items`：WKWebView/Safari 的 paste 事件里
 * `clipboardData.items` 可能为空，截图位图只经 `clipboardData.files` 暴露——
 * 只依赖 items 会把图片误判成文本（→ 无反应）。
 *
 * @param types       ClipboardEvent.clipboardData.types 的字符串数组
 * @param items       clipboardData.items 映射出的 {kind,type} 数组
 * @param files       clipboardData.files 的 {type} 数组（FileList）
 * @param hasFilePaths 是否从原生剪贴板读到真实文件路径（CF_HDROP）
 */
export function classifyPaste(
  types: readonly string[],
  items: readonly ClipboardItemLike[],
  files: readonly ClipboardFileLike[],
  hasFilePaths: boolean,
): PasteAction {
  if (
    files.some((f) => f.type.startsWith("image/")) ||
    items.some((i) => i.kind === "file" && i.type.startsWith("image/"))
  ) {
    return { kind: "image" };
  }
  if (types.includes("Files") && hasFilePaths) return { kind: "files" };
  return { kind: "text" };
}
