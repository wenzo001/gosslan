/**
 * 「这条没发出去的消息，重新发送该走哪条通道」的唯一判据。
 *
 * ## 为什么要有这一册（这是一处真缺陷换来的）
 * 回执那颗「重发」以前只按 `kind !== "file"` 决定可不可点，而 `retrySend()` 里也只排除了 `file`
 * ⇒ **图片**漏在两处的缝里：失败/取消的图片消息被按普通文本通道重发了一次
 * （`chat.send(conv_id, msg.content, "image")`）。那条通道走 `send_message`，
 * 于是发出去的是一条**内容 = 那份 JSON 载荷**的 image 消息 —— 里面写着 `path`，
 * 而那个 path 只在本机存在 ⇒ 对端渲染出一张"有名字没有字节"的图，本机这条还转成绿色。
 * 用户看到的"重试成功"是假的。
 *
 * ## 三条通道与它们的真命令
 *  · `"message"`    → `chat.send(...)`（文本族与所有 payload 型 kind：poll / announcement / todo…）
 *  · `"file"`       → `chat.sendFileTo(convId, path)`（单聊，后端 `send_file_auto` 自己建台账与消息）
 *  · `"group-file"` → `chat.sendGroupFileTo(groupId, path)`（群，后端 `send_group_file`）
 *  · `null`         → 今天没有任何通道能把这条重新发出去 ⇒ **不给按钮**
 *     （界面上一颗点了什么都不会发生的按钮，比没有按钮更糟）。
 *
 * ## 文件/图片为什么必须有本机的文件才能重发
 * 两条文件通道都要一个真实路径。「存储清理」把附件删掉之后（`useMessageFile` 的
 * `attachmentMissing`，判据来自后端 `media_present`），本机已经没有那份字节了 ——
 * 那种行只能显示"已被清理"，不能假装还能发。
 *
 * ⚠️ 这一条今天只对 **subtype=file** 真正生效：失败的**图片**行拿不到可达性信号
 * （`previewSubtype` 在 `sendState === "failed"` 时直接返回 null，而 `shouldProbePresence`
 * 只给文件那份探测 ⇒ 两条路都不跑，`attachmentMissing` 恒为 false）。
 * 后果要说清，不许把它写成已收口：附件已被清理的失败图片仍会出现这颗按钮，
 * 但点下去**不会静默成功** —— 后端按不存在的路径报错，`sendFileTo` 那条失败 toast 会说话。
 * 要真正收掉这一格得动 `shouldProbePresence` 那条共享判据（它同时管预览），不在这里顺手改。
 */

export type ResendChannel = "message" | "file" | "group-file";

export interface ResendContext {
  /** 消息的 `kind`（线格式那一份）。 */
  kind: string;
  /** 这条落在群会话里（群消息或群文件行）。 */
  group: boolean;
  /** 本机还留着那份附件（有 path 且没被清理掉）。文件/图片通道的前提。 */
  hasLocalFile: boolean;
  /** 这条是我发的。别人发的消息没有"我再发一次"这件事。 */
  mine: boolean;
}

/**
 * 走文件通道的那两个 kind。
 *
 * ⚠️ 判据按"这条消息是谁造的"分，不按渲染形状分：图片与文件都是后端
 * `send_file*` 造出来的（发送时先落台账、消息记录由后端 emit），
 * 所以它们的"再发一次"必须回到同一条通道，而不是 `send_message`。
 */
const FILE_CHANNEL_KINDS = new Set(["file", "image"]);

export function resendChannelFor(ctx: ResendContext): ResendChannel | null {
  if (!ctx.mine) return null;
  if (FILE_CHANNEL_KINDS.has(ctx.kind)) {
    // 附件已经不在本机 ⇒ 没有可发的字节。此时给按钮只会再制造一次"点了没反应"。
    if (!ctx.hasLocalFile) return null;
    return ctx.group ? "group-file" : "file";
  }
  return "message";
}
