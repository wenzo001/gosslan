/**
 * 打开 / 另存**本机已有**的文件 —— 消息气泡（useMessageFile）与群文件面板
 * （GroupFilesPanel）共用的唯一路径。
 *
 * 平台的差异只能写一次：Android 上系统经常没有能"打开"某类文件的应用
 * （用户实测：除图片外基本都报错），而且应用私有目录里的文件即便被打开，
 * 也只是交给对方一个临时只读副本 —— 所以 Android 一律改走系统保存对话框（SAF）。
 * 这条规则若分散成两处，群文件面板会退化成"点了直接报错"。
 *
 * 返回值只描述**发生了什么**，文案与 toast 交给调用方：错误文案的上下文
 * （"打开失败" vs "保存失败"）只有调用方知道。
 */
import { save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api } from "@/api";
import { isApkName } from "@/utils/fileKind";
import { isAndroid, isIOS } from "@/utils/platform";
import { isDialogCancelled, saveDestinationOf } from "@/utils/saveDestination";

/**
 * `unsupported` 只出现在「在文件夹中显示」这条路上：移动端没有文件管理器定位
 * （`revealItemInDir` 在 Android/iOS 直接返回 UnsupportedPlatform），
 * 调用方据此静默收手，而不是给用户弹一句"打开失败"。
 */
export type LocalFileResult = "done" | "cancelled" | "unsupported";

/**
 * 用系统默认应用打开本地文件。
 * Android 上没有"打开"这一步，直接落到 `saveLocalFile`（见文件头说明）。
 * 例外：`.apk` 是安装包，交给系统安装器（`OpenWith` 的 package-archive MIME），
 * 不弹"另存为"。判断留在这一唯一入口，消息气泡与群文件面板不会各写一套。
 * `owner` = 消息 id：后端按它回绑传输台账，拒绝打开不属于这条消息的路径（SEC-01）；
 * 收藏入口没有消息归属，传 `null`。
 * @throws 后端/插件返回的真实错误（调用方负责提示）
 */
export async function openLocalFile(
  path: string,
  name: string,
  owner: string | null = null,
): Promise<LocalFileResult> {
  if (isAndroid) {
    if (isApkName(name) || isApkName(path)) {
      await api.openFileNative(path, owner);
      return "done";
    }
    return saveLocalFile(path, name);
  }
  // macOS 走 NSWorkspace（沙盒下 opener 的 /usr/bin/open 被拦），Windows/Linux 由后端回落 opener。
  // 文件不存在时后端返回明确错误。
  await api.openFileNative(path, owner);
  return "done";
}

/**
 * 在系统文件管理器里**定位并选中**这份文件（不是打开它）。
 *
 * 用户 2026-11-21 的口径：「就是单击右键，聊天里的文件，可以打开文件所在的文件夹，
 * 跟微信类似就行了」—— 微信 PC 的「在文件夹中显示」就是这件事，不是"另存为"。
 *
 * 平台差异同样只写这一处：
 * - 桌面：`@tauri-apps/plugin-opener` 的 `revealItemInDir`。macOS 那一支是
 *   `NSWorkspace.activateFileViewerSelectingURLs`（不 fork 子进程，沙盒可用 ——
 *   与 `open_path.rs` 里"打开目录"踩过的那个坑同源），Windows 是
 *   `SHOpenFolderAndSelectItems`（资源管理器里选中该文件）。
 * - Android / iOS：没有"文件管理器定位"这种东西，插件返回 UnsupportedPlatform。
 *   这里返回 `unsupported` 而不是抛错 —— 入口本来就会按平台隐藏（见各调用方的 `v-if`），
 *   走到这里说明是键盘/长按等旁路，静默收手比弹"打开失败"诚实。
 *
 * @throws 文件不存在 / 系统拒绝时的真实错误（调用方负责提示）
 */
export async function revealLocalFile(path: string): Promise<LocalFileResult> {
  if (isAndroid || isIOS) return "unsupported";
  await revealItemInDir(path);
  return "done";
}

/**
 * 另存为：桌面弹保存对话框后复制一份；Android 走 SAF。
 * 用户取消返回 `"cancelled"`（不是错误）。
 * @throws 复制/对话框的真实错误
 */
export async function saveLocalFile(
  path: string,
  name: string,
  msgId?: string,
): Promise<LocalFileResult> {
  try {
    // 桌面返回路径字符串；Android 的 SAF 返回 { file: content:// } 对象，先归一化。
    const picked: unknown = await save({ defaultPath: name });
    const destination = saveDestinationOf(picked);
    if (!destination) return "cancelled";
    await api.copyFile(path, destination, msgId);
    return "done";
  } catch (e) {
    // Android 取消是 reject 而不是返回 null
    if (isDialogCancelled(e)) return "cancelled";
    throw e;
  }
}
