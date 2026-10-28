import { isDialogCancelled, saveDestinationOf } from "./saveDestination.ts";
import { MAX_PASTED_IMAGE_BYTES } from "./imageBytes.ts";

/** 另存图片的两种终态；取消不是错误，不抛。 */
export type SaveImageOutcome = "saved" | "cancelled";

/** 图片在本机的来源：聊天消息（msg_id）或 content store（cid）。 */
export interface ImageSource {
  msgId?: string;
  cid?: string;
}

export interface SaveImageDeps {
  /** 默认文件名（含扩展名），由调用方按当前语言生成。 */
  defaultName(): string;
  /** 打开系统保存对话框；返回值形状由 saveDestinationOf 归一化。 */
  pickDestination(defaultPath: string): Promise<unknown>;
  /** 取图片字节并转 base64（支持 dataURL / blob URL）。 */
  toBase64(url: string): Promise<string>;
  /** 落盘（Rust save_data_file）。 */
  saveDataFile(base64Data: string, destination: string): Promise<void>;
  /** 后端按来源直接拷贝（不经 base64 IPC）；失败时回退到上面的字节路径。 */
  saveMedia?(source: ImageSource, destination: string): Promise<void>;
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
  source?: ImageSource,
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
  if (source && deps.saveMedia) {
    try {
      await deps.saveMedia(source, destination);
      return "saved";
    } catch {
      // 源路径可能已清理 / 乐观消息尚未落库 —— 退回字节路径，让用户仍能保存。
    }
  }
  const base64Data = await deps.toBase64(url);
  // 前置体积判断（审计 P1 #10）：省掉一次几百 MB 的 base64 IPC。上限与后端同一常量
  // （`imageBytes.ts` 的注释钉着"必须等于 Rust MAX_OUTGOING_IMAGE_BYTES"）。
  // base64 字符数 × 3/4 ≈ 解码字节数（含 padding 只会略高估，不会漏拦）。
  const approxBytes = Math.floor((base64Data.length * 3) / 4);
  if (approxBytes > MAX_PASTED_IMAGE_BYTES) {
    throw new Error(`IMAGE_TOO_LARGE:${approxBytes}`);
  }
  await deps.saveDataFile(base64Data, destination);
  return "saved";
}
