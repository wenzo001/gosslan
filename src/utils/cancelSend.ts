/**
 * 「这条消息现在能不能取消发送、该走哪条通道」的唯一判据。
 *
 * 两条通道是两件事，别合并：
 *  · `transfer` —— 文件/群文件消息：停的是**正在写的字节**（`cancel_file_transfer`，
 *    对端由 `FileCancel` 帧通知）。判据看消息 id 前缀（`file-` / `gfile-`），因为
 *    那些消息的 transfer_id 就在前缀后面。
 *  · `message`  —— 文本族等走补发队列的消息：停的是**还没送出去的队列行**
 *    （后端删 outbox + 状态写 cancelled；对端还没收到，所以没有"通知"这一步）。
 *
 * 三个边界都是刻意的：
 *  1. 只给**自己发的**（别人发的没有"我取消"这件事），自聊不给（本机自己，没有送达可言）。
 *  2. 只给 `sending`：`sent`/`delivered`/`read` 已经出门了，那时能做的只有撤回（文本族、5 分钟内）。
 *  3. 群里的消息这一版**不给**：群的队列是"每个成员一行"，删多少行才算取消要单独的账，
 *     给一个"界面已取消、其余成员照样收到"的按钮比不给更糟（后端也拒绝）。
 */
export type CancelSendChannel = "transfer" | "message" | "none";

export interface CancelSendContext {
  msgId: string;
  kind: string;
  /** 消息状态（`sending` / `sent` / `delivered` / `read` / `failed` / `cancelled`）。 */
  status: string;
  /** 会话在群里（`group:` 前缀）。 */
  group: boolean;
  /** 自聊会话（conv_id === 本机 device_id）。 */
  selfChat: boolean;
  /** 这条是我发的。 */
  mine: boolean;
}

export function cancelSendChannelFor(ctx: CancelSendContext): CancelSendChannel {
  // `sent` 也算：群消息在**入队那一刻**就写 `sent`（`window.rs` 的群发送内核），
  // 1:1 则是"已经写进 writer 队列"。两者的共同点是**还没有 Ack 被处理**，
  // 后端 `cancel_message` 的判据也正是这个（只有 delivered/read/recalled 才拒绝）。
  // 代价与文件取消同一条：字节可能已在对方链路上、Ack 还在飞 —— 界面说"已取消"，
  // 但不承诺"对方没收到"。
  if (ctx.status !== "sending" && ctx.status !== "sent") return "none";
  // 群文件：**发送侧与接收侧都能取消**。接收侧那条就是 B3b —— 本机停手（摘接收器、删 `.part`）
  // 再通知发送方这一格停了；所以这里不能要求 `mine`（收到的群文件不是"我发的"）。
  if (ctx.msgId.startsWith("gfile-")) return "transfer";
  if (!ctx.mine || ctx.selfChat) return "none";
  if (ctx.msgId.startsWith("file-")) return "transfer";
  // 文件/图片的**真实**消息（后端 `send_file*` 造的那条，id 不是前缀形式）也只走传输通道；
  // 它们的取消入口在文件卡片上（`@cancel`），不在消息菜单里。
  if (ctx.kind === "file" || ctx.kind === "image") return "none";
  // 群消息也能取消（B4 后半）：判据是"还没有任何成员的 Ack 被处理过"，
  // 后端删的是**每个成员那一行** —— 只要没人确认过，删完之后迟到的 Ack 命中不到，
  // 状态停在 cancelled（与 1:1 同一条仲裁）。
  return "message";
}
