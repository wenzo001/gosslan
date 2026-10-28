/**
 * 撤回窗口的唯一前端口径。
 *
 * Rust 侧 `protocol.rs::RECALL_WINDOW_MS` 是权威；`recall.test.ts` 直接读源码对账，
 * 不允许两边各写一个 5 分钟然后慢慢漂。
 */
export const RECALL_WINDOW_MS = 5 * 60 * 1000;

/** 消息是否还在可撤回窗口内（`ts=0` 的历史行不显示入口）。 */
export function isWithinRecallWindow(ts: number, now = Date.now()): boolean {
  if (!Number.isFinite(ts) || ts <= 0) return false;
  return now - ts <= RECALL_WINDOW_MS;
}

/**
 * **可撤回**的消息类型（与 Rust `protocol::RECALLABLE_KINDS` 同一份口径）。
 *
 * 2026-10-28 负责人改口径：「5 分钟内的消息必须能撤回，所有文件格式类型都要支持」。
 * 附件（`image` / `file`，覆盖视频/音频/文档等全部格式）也在内 —— 当初排除它们的理由
 * （撤回停不掉传输）已由后端 `cancel_transfer_for_recalled_message` 消掉：撤回前先取消传输。
 * 机器事件（pin / reaction / todo / announcement…）不是用户写的内容，仍然不在内。
 *
 * 两侧都要拦：老端可能没拦、直接发来一条对附件消息的撤回 ⇒ Rust 那侧还要再判一次。
 */
export const RECALLABLE_KINDS: readonly string[] = ["text", "code", "merge", "image", "file"];

/** 这种消息能不能撤回（唯一定义处，见上面的理由）。 */
export function isRecallableKind(kind: string | undefined | null): boolean {
  return !!kind && RECALLABLE_KINDS.includes(kind);
}

/**
 * **群主特权**可撤的行（与 Rust `protocol::CREATOR_RECALLABLE_KINDS` 同一份口径）。
 *
 * 负责人 2026-10-28：「群里群主可以随意撤回任何人的任何消息，不限制时间……所有的消息类型
 * 都可以撤回，主要是让群聊天列表里消失……任务的话在任务列表里还是可以看到」。
 * 所以在作者档之上**只加三张卡**（`announcement / todo / poll`）：撤回让那张卡离开时间线，
 * 卡片背后的本体（看板 / 公告栏 / 文件台账）是各自独立的真源，照旧可见。
 *
 * 两类**故意不开**，各自有实测理由，不是遗漏：
 * · 静默事件行（`pin / reaction / remind / todo_update / recall`）：它们本来就不显示在时间线上，
 *   撤它们不是"离链"而是"回滚那个动作"，而 `todo_update` 是状态微调、撤不动也不可见；
 * · `system` 提示行：它的 `msg_id` 是 `sys-<uuid4>`、**每台设备各自生成不广播**，
 *   拿它发撤回只有群主自己那台会消失 = 假同步。
 */
export const CREATOR_RECALLABLE_KINDS: readonly string[] = [
  ...RECALLABLE_KINDS,
  "announcement",
  "todo",
  "poll",
];

/** 群主能不能撤这一行。 */
export function isCreatorRecallableKind(kind: string | undefined | null): boolean {
  return !!kind && CREATOR_RECALLABLE_KINDS.includes(kind);
}

/**
 * 从一条 `kind === "recall"` 的静默事件行里取出"撤的是哪条"。
 * 载荷是 `{"target": "<msg_id>"}`（Rust `RecallPayload`）；解不出来按"没有"处理，
 * 不许猜（猜出来的 target 会把另一条消息标成已撤回）。
 */
export function recallTargetOf(content: string | undefined | null): string {
  if (!content) return "";
  try {
    const parsed = JSON.parse(content) as { target?: unknown };
    return typeof parsed.target === "string" ? parsed.target : "";
  } catch {
    return "";
  }
}

/**
 * 已撤回那一行该显示哪句话。
 *
 * 撤回者身份本来就写在事件行的 `sender_id` 里（墓碑表也存了 `recaller_id`），
 * 所以这里只做一次比较：**撤的人不是作者** ⇒ 那是群主替他撤的（接收侧只放这两档，
 * 见 Rust `protocol::recall_receive_allowed`）。
 * 索引缺失（老数据 / 撤回事件行不在已加载的窗口里）时退回通用文案，
 * 宁可少说一句也不骗人。
 */
export function recalledRowKey(
  recallerId: string | null | undefined,
  authorId: string,
): "msg.recalled" | "msg.recalledByOwner" {
  return recallerId && recallerId !== authorId ? "msg.recalledByOwner" : "msg.recalled";
}
