import { isDialogCancelled, saveDestinationOf } from "./saveDestination.ts";

/** 另存图片的两种终态；取消不是错误，不抛。 */
export type SaveImageOutcome = "saved" | "cancelled";

export interface SaveImageDeps {
  /** 默认文件名（含扩展名），由调用方按当前语言生成。 */
  defaultName(): string;
  /** 打开系统保存对话框；返回值形状由 saveDestinationOf 归一化。 */
  pickDestination(defaultPath: string): Promise<unknown>;
  /** 取图片字节并转 base64（支持 dataURL / blob URL）。 */
  toBase64(url: string): Promise<string>;
  /** 落盘（Rust save_data_file）。 */
  saveDataFile(base64Data: string, destination: string): Promise<void>;
}

/**
 * 「另存图片」的唯一状态机：选目的地 → 取字节 → 落盘。
 *
 * 取消的两种平台形状在这里归一化：桌面返回 null，Android 是 reject
 * "File picker cancelled"。两者都返回 `cancelled`，调用方不必各写一遍。
 * 其它错误原样抛出，由调用方决定提示文案。
 */
export async function saveImageWith(
  url: string,
  deps: SaveImageDeps,
): Promise<SaveImageOutcome> {
  let picked: unknown;
  try {
    picked = await deps.pickDestination(deps.defaultName());
  } catch (e) {
    if (isDialogCancelled(e)) return "cancelled";
    throw e;
  }
  const destination = saveDestinationOf(picked);
  if (!destination) return "cancelled";
  const base64Data = await deps.toBase64(url);
  await deps.saveDataFile(base64Data, destination);
  return "saved";
}
