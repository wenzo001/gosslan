/**
 * 群文件面板「这一行能不能取消、按哪一侧取消」的唯一判据（纯函数，可单测）。
 *
 * 为什么需要它：群文件以前只能从聊天气泡的右键菜单取消（`MessageItem` 的 transfer 通道），
 * 面板里一行传输中的群文件没有任何取消入口 —— 用户看着转圈只能去聊天记录里翻那条消息。
 * 后端 `cancel_file_transfer` 本来就两侧都接（发送方整单 / 接收方本机停手，见
 * `commands/files.rs` 的 `cancel_group_receive_side` 与整单那一段），缺的只是入口与判据。
 *
 * 判据口径（与后端台账语义对齐，不在界面另推一套状态机）：
 * · 发送侧：`sender_id === myId` 且还有成员没送达（`delivered < total`）⇒ 整单可取消；
 *   全部送达＝没有可取消的字节（后端会回 `alreadyDone`，但入口不该先给用户希望）。
 * · 接收侧：`local_state === "receiving"`（字节正在进本机）⇒ 可取消本机这一份；
 *   `remote` / `failed` / `local` 都没有在途字节，取消没有对象。
 */
import type { GroupFileEntry } from "@/types";

export type GroupFileCancelSide = "send" | "receive";

export function groupFileCancelSide(
  f: GroupFileEntry,
  myId: string | null | undefined,
): GroupFileCancelSide | null {
  if (!myId) return null;
  if (f.sender_id === myId) return f.delivered < f.total ? "send" : null;
  return f.local_state === "receiving" ? "receive" : null;
}
