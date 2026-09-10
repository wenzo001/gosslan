// 媒体「还在不在本机」的判定逻辑。
//
// 单独成文件的原因有两条：
// 1. 这里决定用户看到的是「已被清理」提示还是一个裂开的图片框，必须有单测；
// 2. `filePreview.ts` / `useMessageFile.ts` 都要引入 Tauri IPC，Node 侧跑不了
//   （测试用 `node --test`，不认 Vite 的 `@/` 别名），纯函数必须与它们分离。

export type PreviewResult = {
  url?: string;
  text?: string;
  note?: string;
  /** 本地媒体已被「存储清理」删除（不是坏文件，也不是对端没发）。 */
  missing?: boolean;
};

/** 后端 `read_file_preview` 的失败文案 → 前端预览结果。 */
export function previewFailureResult(err: string): PreviewResult {
  // ⚠️ 只有后端**确知文件已被删除**时才返回 `missing`（对应
  // `commands::resolve_media_path` 的 `Gone` 分支，文案固定为"文件不存在"）。
  // "消息不存在"/"元数据缺少路径"/"路径越权"都是"查不到"，属于未知而非已删除——
  // 在途消息会落到这些分支，误判会把正在发送的图片标成"已清理"。
  if (err.includes("文件不存在")) return { missing: true, note: "已被清理" };
  if (err.includes("TOO_LARGE")) return { note: "文件过大，无法预览" };
  return {};
}

/**
 * 该消息是否需要单独向后端探测"文件还在不在"。
 *
 * 图片 / 代码附件走"读预览"这条路径，读取失败本身就带回了可达性信号，不必重复探测；
 * 普通文件（subtype=file）没有预览读取，只能单独问一次。
 * 路径为空表示文件还没到本机（正在接收/等待），此时探测没有意义。
 */
export function shouldProbePresence(
  kind: string,
  meta: { subtype: string; path: string } | null | undefined,
): boolean {
  if (kind !== "file" || !meta?.path) return false;
  return meta.subtype !== "image" && meta.subtype !== "code";
}
