/**
 * 统一后台任务中心的读模型（纯函数层）。
 *
 * ## 为什么要有这一层
 *
 * 负责人 2026-10-23 的原话是："所有有进度、有目标、有完成态的任务都可以看到，并可以取消；
 * 历史完成的默认不显示；状态归类成 排队 / 发送中 / 完成 / 已取消，让用户一眼看懂**卡在哪个
 * 交互节点**并且能自己打通。"
 *
 * 这些数据本来就都在库里/内存里，只是**散在四个地方、四套状态词**：
 *   · `chat.transfers`（`file_transfers`，status 6 取值 + 后端算好的 `blocked_reason`）
 *   · `chat.contentTransfers`（按 cid 取内容，status 6 取值，另有 attempts / nextAttemptAt）
 *   · `chat.messageOps`（还没送到对端的消息，后端只给事实：在不在队列、对方在不在线）
 *   · `chat.groupHistorySync`（群历史同步，phase + synced/total）
 * 界面若各自就地推导，就会长出第二套、第三套"什么算卡住"。这一层是**唯一**的归一处：
 * 输入四份真值 → 输出同一形状的 `OperationRow`，组件只负责画与下发动作。
 *
 * ## 三条边界（都是刻意的）
 *
 * 1. **只出未完成的任务**。`completed / cancelled / failed` 一律不列 —— 那三态由
 *    toast 与气泡上的回执说话；把它们留在列表里就等于"每传完一个文件多一行历史记录"，
 *    用户要看的"还有几件事没办完"会被淹掉。（要历史视图请另开一轮，不在这一层加开关。）
 * 2. **没有台账就不造任务**。 kinds 只有四种：文件、按 cid 取内容、消息补发、群历史。
 *    更新下载（B5）、待办图片、共享目录下载都还没有"进度 + 终态"的完整台账 ——
 *    等它们有了再进来，不在这里先画一个动不了的行。
 * 3. **动作只能是对已经存在的命令的引用**（见 `OperationAction` 那张表）。
 *    界面上一个点了什么都不会发生的按钮，比不给按钮更糟。
 *    （消息取消在 B4 落地后，`cancel_message` 已是一条真命令，消息行因此也有取消键。）
 */
import type { ContentTransfer, GroupHistoryProgress, TransferInfo } from "@/types";

/** 任务种类。取值稳定：日志、动作分发、i18n key 都读它，改名要一起改。 */
export type OperationKind =
  | "file_send"
  | "file_receive"
  | "content_fetch"
  | "message_send"
  | "group_history"
  | "update_download";

/** 归一后的状态：只有这三种会出现（终态不列，见文件头第 1 条边界）。 */
export type OperationState = "queued" | "running" | "blocked";

/**
 * 可执行动作 —— 每一个都对应一条**今天就有**的通道：
 *  · `cancel`            → `cancel_file_transfer`（文件）
 *  · `cancel_message`    → `cancel_message`（还没送出去的补发队列行；已送达会被后端拒绝）
 *  · `cancel_update`     → `updater_cancel`（更新下载）
 *  · `retry_content`     → `request_content_by_cid`（"点击重取"，已有；只给单聊接收行，理由见 `contentRow`）
 *  · `sync_history_now`  → `sync_group_history_now`（已有）
 *  · `open_conversation` → 纯前端跳转，只需要行带得出会话身份
 * 没有"重新连接"这一条：本仓没有对应命令，链路重建由发现/心跳自己走。
 */
export type OperationAction =
  | "cancel"
  | "cancel_message"
  | "cancel_update"
  | "retry_content"
  | "sync_history_now"
  | "open_conversation";

export interface OperationRow {
  /** 稳定 id：文件/内容 = transfer_id / cid，消息 = msg_id，群历史 = group:<gid>。 */
  id: string;
  kind: OperationKind;
  /** 目标名（文件名 / 消息正文截断）。没有可显示的原文时给空串 ⇒ 界面回落到 `fallbackTitleKey`。 */
  title: string;
  state: OperationState;
  /** 0..=1；没有可信进度时是 `null`（界面画"条"而不是画 0%）。 */
  progress: number | null;
  /** 卡住原因的**稳定短码**，翻译交给 `blockedReasonKey`（未知码返回 null，不上屏机器码）。 */
  blockedReason?: string;
  /** 已经重试了几次（内容取回与文件队列才有；给"为什么还不动"一个数）。 */
  attempts?: number;
  /** 群消息：还有几个成员没收到。 */
  waitingFor?: number;
  /** 群消息：已有成员确认收到，但队列里还有人（状态要说「部分成员已收到」）。 */
  someDelivered?: boolean;
  actions: OperationAction[];
  /** 会话身份：1:1 是对端 id、群是 `group:<id>`。拿不到就不给"打开会话"动作。 */
  convId?: string;
  /**
   * 打开会话后要定位的消息 id（拿得到才给）。
   * 1:1 文件行是 `file-<transfer_id>`；消息行就是 msg_id；内容行/群历史没有精确消息。
   */
  locateMsgId?: string;
  createdAt: number;
}

export interface OperationSources {
  transfers: readonly TransferInfo[];
  contentTransfers: readonly ContentTransfer[];
  messageOps?: readonly PendingMessageOpView[];
  groupHistory?: readonly GroupHistoryProgress[];
  /** 更新下载（B5）：后端 `UpdaterStatus` 的前端视图。只有 `downloading` 会变成任务行。 */
  updater?: UpdaterStatusView | null;
}

/** `UpdaterStatus` 的最小形状（只读模型需要的那几格）。 */
export interface UpdaterStatusView {
  phase: string;
  downloaded: number;
  total: number | null;
  version: string | null;
}

/** `db::PendingMessageOp` 的前端视图（Rust 侧不 `rename_all` ⇒ 线上就是 snake_case）。 */
export interface PendingMessageOpView {
  msg_id: string;
  kind: string;
  peer_id: string | null;
  group_id: string | null;
  waiting_for: number;
  created_at: number;
  preview: string | null;
  peer_offline: boolean;
  /** 后端与 `cancel_message` 同口径判出来的"这一行现在取消会不会成功"。 */
  can_cancel: boolean;
  /** 群消息：已有成员确认收下，但队列里还有人。 */
  some_delivered: boolean;
}

/**
 * "这条传输还在不在动"的**唯一**判据。
 *
 * ⚠️ 它刻意不等于 `transferDisplayKind`：后者是**气泡**的读法，那里把 `sent`
 * （字节已写出、对端未回执）算成完成 —— 气泡上不该再转圈；而任务中心问的是
 * "还有没有事没办完"，`sent` 正是"等对方确认"这一格。同一个 status 在两个地方
 * 有两种读法是语义，不是漂移；两处都只此一个函数，不许在组件里再推一遍。
 */
export function isLiveTransferStatus(status?: string | null): boolean {
  if (!status) return false;
  return status === "pending" || status === "active" || status === "sent";
}

/** 内容取回台账里"还没完"的取值（`complete/rejected` 都不列；`incomplete` 是"还能再取"）。 */
function isLiveContentStatus(status: ContentTransfer["status"]): boolean {
  return status === "queued" || status === "active" || status === "verifying" || status === "incomplete";
}

function ratio(received: number, total: number): number | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(received) || received <= 0) return 0;
  return Math.min(1, received / total);
}

function fileRow(t: TransferInfo): OperationRow {
  const kind: OperationKind = t.direction === "receive" ? "file_receive" : "file_send";
  const state: OperationState = t.blocked_reason
    ? "blocked"
    : t.status === "sent"
      ? "blocked"
      : t.status === "active"
        ? "running"
        : "queued";
  const actions: OperationAction[] = ["cancel"];
  if (t.peer_id) {
    actions.push("open_conversation");
  }
  return {
    id: t.id,
    kind,
    title: t.name ?? "",
    state,
    // `progress` 后端已经是 0..1 的"已写出链路"口径（v4.22.37 起不是入队量），
    // 这里只兜非法值；已经 100% 但没到终态的行照旧列出来（用户的原话：
    // "100% 但未终态仍可取消"）。
    progress: clamp01(t.progress),
    blockedReason: t.blocked_reason ?? (t.status === "sent" ? "waiting_ack" : undefined),
    convId: t.peer_id ? t.peer_id : undefined,
    // 1:1 文件气泡的消息 id 是 `file-<transfer_id>`（`finalize_file_failure` 同口径）；
    // 群文件不在 `file_transfers` 里，不会走到这一行。
    locateMsgId: t.id ? `file-${t.id}` : undefined,
    createdAt: t.created_at ?? 0,
    actions,
  };
}

/** 只兜非法值：NaN / 负数 / 超过 1 都收进 [0,1]，读不到时给 0（**不是** null —— 文件行有进度）。 */
function clamp01(value: number | undefined | null): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 64 位 hex = 内容 id 本身。台账里 `name` 常常就是它（按 cid 取的东西没有原始文件名）。 */
const CID_LIKE = /^[0-9a-f]{64}$/i;

function contentRow(c: ContentTransfer): OperationRow {
  const blocked = c.status === "incomplete" || c.status === "queued";
  // 「立即重取」= 向**那一个对端**按 cid 再要一份（`request_content_by_cid`）。
  // 两个前提缺一不可：①方向是接收（发出去的那份不该由本机去"要"）；
  // ②单聊（群内容行的 `peerId` 存的是 group_id，把它当 device_id 发出去只会石沉大海 ——
  //   群那条今天靠建链时的自动重试收口，界面上不假称有个能用的按钮）。
  const actions: OperationAction[] =
    c.direction === "receive" && !c.groupId ? ["retry_content"] : [];
  if (c.peerId) actions.push("open_conversation");
  // ⚠️ 台账的 `name` 经常就是 64 位 cid（按 cid 取内容时没有原始文件名可带）。
  // 把机器码直接当标题上屏 = 界面上出现两行 `61d8d9df4a00a8…`，用户读不出那是哪件事
  // （10-23 用户截图里就是这两行）。所以这种行只说类型 + 一小段前缀。
  const rawName = c.name ?? "";
  const cidNamed = CID_LIKE.test(rawName);
  return {
    id: c.cid,
    kind: "content_fetch",
    title: cidNamed ? "" : rawName,
    // `blocked` 档刻意给"排队中"也用：内容取回在队列里等下一次投递，用户看到的
    // 是"还没动"，需要的是原因与"现在就试"这个动作。
    state: blocked ? "blocked" : c.status === "active" ? "running" : "queued",
    progress: ratio(c.received, c.size),
    blockedReason:
      c.status === "incomplete" ? "waiting_retry" : c.status === "queued" ? "queued_by_backend" : undefined,
    attempts: c.attempts > 0 ? c.attempts : undefined,
    convId: c.groupId ? `group:${c.groupId}` : c.peerId || undefined,
    createdAt: c.createdAt,
    actions,
  };
}

function messageRow(m: PendingMessageOpView): OperationRow {
  const offline = !!m.peer_id && m.peer_offline;
  const actions: OperationAction[] = [];
  // 补发队列里的行都是本机发出去的（`outbox` / `group_outbox`），但"能不能取消"要看后端：
  // 群消息只要**任一成员** Ack 过，取消就会被拒（already_delivered）。界面给一颗点了
  // 必然失败的按钮，用户看到的就是「还在排队却说已送达」（2026-10-25 实报）。
  const convId = m.group_id ? `group:${m.group_id}` : m.peer_id ?? undefined;
  if (convId && m.can_cancel) actions.push("cancel_message");
  if (convId) actions.push("open_conversation");
  return {
    id: m.msg_id,
    kind: "message_send",
    title: m.preview ?? "",
    state: offline ? "blocked" : "queued",
    progress: null,
    blockedReason: offline ? "peer_offline" : undefined,
    // 群消息只剩 1 个人也要说出来（以前只在 >1 时给，最后一格会变成没有目标的一行）。
    waitingFor: m.group_id && m.waiting_for > 0 ? m.waiting_for : undefined,
    someDelivered: m.some_delivered || undefined,
    convId,
    locateMsgId: m.msg_id,
    createdAt: m.created_at,
    actions,
  };
}

/**
 * 更新下载（B5）。
 *
 * 只把 `downloading` 当任务：`ready` 是"下完了"（下载这件事的完成态，安装按钮在设置页里），
 * `installing` 刻意**不可取消**（字节已交给安装器，取消只会留下半装的现场），
 * `checking` 是不带字节的短动作、`cancelled`/`failed` 是终态 —— 都不进任务中心。
 * 这条边界就是 B5 之前任务中心不列更新的原因；现在列的是"正在下"这一段。
 */
function updaterRow(u: UpdaterStatusView): OperationRow {
  const total = u.total ?? 0;
  return {
    id: "updater",
    kind: "update_download",
    // 新版本号就是这一行的目标（"更新到 5.5.33"比"更新下载"更说明问题）；没有就回落到类型文案。
    title: u.version ? `v${u.version}` : "",
    state: "running",
    progress: total > 0 ? ratio(u.downloaded, total) : null,
    actions: ["cancel_update"],
    createdAt: 0,
  };
}

function historyRow(h: GroupHistoryProgress): OperationRow {
  const blocked = h.phase === "failed";
  return {
    id: `group:${h.group_id}`,
    kind: "group_history",
    title: "",
    state: blocked ? "blocked" : "running",
    progress: ratio(h.synced, h.total),
    blockedReason: blocked ? (h.reason ?? "no_source") : undefined,
    convId: `group:${h.group_id}`,
    createdAt: 0,
    actions: ["sync_history_now", "open_conversation"],
  };
}

/** 四份真值 → 一张统一的任务表（只含未完成）。 */
export function deriveOperations(src: OperationSources): OperationRow[] {
  const rows: OperationRow[] = [];
  for (const t of src.transfers) {
    if (isLiveTransferStatus(t.status)) rows.push(fileRow(t));
  }
  for (const c of src.contentTransfers) {
    if (isLiveContentStatus(c.status)) rows.push(contentRow(c));
  }
  for (const m of src.messageOps ?? []) {
    rows.push(messageRow(m));
  }
  for (const h of src.groupHistory ?? []) {
    if (h.phase === "running" || h.phase === "failed") rows.push(historyRow(h));
  }
  if (src.updater && src.updater.phase === "downloading") {
    const total = src.updater.total ?? 0;
    // 字节已下满 = 下载这件事没有后台工作了：任务中心不再保留“100% 收尾中”的行。
    // 安装入口在设置页；Rust 在 download future 完成后会把 phase 翻成 ready。
    if (!(total > 0 && src.updater.downloaded >= total)) rows.push(updaterRow(src.updater));
  }
  return rows;
}

const STATE_RANK: Record<OperationState, number> = { blocked: 0, running: 1, queued: 2 };

/**
 * 一行**没有可读标题**时用来顶替的那句类型文案（按 kind 回落）。
 *
 * 为什么由读模型给、而不是组件里自己摆一张 map：`OperationKind` 是这一层定义的，
 * 用 `Record<OperationKind, string>` 让编译器数全覆盖 —— 加一种任务而忘了文案，
 * 编不过就在这里被拦住，而不是界面上出现一个空白行。
 * ⚠️ 消息行常常落到这里：后端只给 text/code 的正文截断，其它 kind 的 `content` 是 JSON 载荷，
 * 上屏就是让用户读一串 `{"items":[…]}`（那种行宁可只说"一条消息"）。
 */
export const FALLBACK_TITLE_KEYS: Record<OperationKind, string> = {
  file_send: "task.kind.fileSend",
  file_receive: "task.kind.fileReceive",
  content_fetch: "task.kind.contentFetch",
  message_send: "task.kind.messageSend",
  group_history: "task.kind.groupHistory",
  update_download: "task.kind.updateDownload",
};

/**
 * running 档那句"正在做"的文案 key —— 都带 `{pct}` 插值（读不到进度时界面走
 * `task.state.running` 那句不带数的）。
 *
 * `file_send` / `file_receive` / `content_fetch` 直接复用气泡那三条现成文案：
 * 同一个"发送中 62%"在气泡和任务中心是同一句话，用户不必学第二套措辞。
 * `message_send` 那一格今天走不到（消息行只有排队/阻塞两种），留着是为了
 * 以后给消息加"正在重发"时不会漏了文案这一件事。
 */
export function runningTextKey(kind: OperationKind): string {
  switch (kind) {
    case "file_send":
      return "send.sendingPct";
    case "file_receive":
    case "content_fetch":
      return "send.receivingPct";
    case "group_history":
      return "task.state.syncing";
    case "update_download":
      return "task.state.downloading";
    case "message_send":
      return "task.state.resending";
  }
}

/**
 * 一行右上角那句状态 —— **纯函数**，组件只负责把 `t` 传进来。
 *
 * 2026-10-25 用户反馈：「有些任务在收尾中，看不太懂，明明已经 100%」。根因不是进度算错，
 * 而是所有"100% 但未终态"都共用一句泛称。这里按 kind 给出能解释原因的说法：
 *  - 更新下载 100% = 字节下完、等安装器，写「下载完成，准备安装」；
 *  - 内容取回 100% = 在算校验和，写「校验中」；
 *  - 群历史 100% = 还有落库/收尾，写「历史同步收尾中」；
 *  - 其余 100% 才落到「正在收尾」。
 *
 * ⚠️ 顺序是语义：`waiting_ack` 必须排在 100% 之前 —— 文件"字节已写出、等对方确认"
 * 也是 100%，但那句话比「正在收尾」更能解释用户看到的事实。
 */
export function operationStatusText(
  row: OperationRow,
  tr: (key: string, params?: Record<string, string | number>) => string,
): string {
  // 群消息：已有成员确认收下、其余人还在队列里。两句话都会让用户误判
  // （2026-10-25：「为什么还在排队却说已送达不能取消」）。
  if (row.someDelivered) return tr("task.state.partial");
  if (row.state === "queued") return tr("send.queued");
  if (row.blockedReason === "waiting_ack") return tr("task.state.waitingAck");
  if (row.state === "blocked") return tr("task.state.waiting");
  // 读不到 total 时不硬造一个 0%：进度是 null ⇒ 只说"进行中"。
  if (row.progress === null) return tr("task.state.running");
  // 进度已到 1 但还没进终态：按 kind 说清在做什么，不再一律「收尾中」。
  if (row.progress >= 1) {
    switch (row.kind) {
      case "content_fetch":
        return tr("task.state.verifying");
      case "group_history":
        return tr("task.state.historyFinalizing");
      default:
        return tr("task.state.finalizing");
    }
  }
  return tr(runningTextKey(row.kind), { pct: Math.round(row.progress * 100) });
}

/**
 * 排序：**要人处理的排最前**（blocked → running → queued），同档按最近发生的在前。
 * 这一条是"一眼看懂卡在哪"的全部：用户打开面板看到的第一行就是需要他动手的那件。
 */
export function sortOperations(rows: readonly OperationRow[]): OperationRow[] {
  return [...rows].sort((a, b) => {
    const byState = STATE_RANK[a.state] - STATE_RANK[b.state];
    if (byState !== 0) return byState;
    return b.createdAt - a.createdAt || a.id.localeCompare(b.id);
  });
}

/** 药丸上的数：还在等着办的事有几件（含"要用户动手"的那些）。 */
export function countOperations(rows: readonly OperationRow[]): number {
  return rows.length;
}

/**
 * 转发给调用方与判据夹具用的输入类型。`export type` 是纯类型再导出 ⇒ 运行时零依赖，
 * 所以 `taskCenter.test.ts` 能在 `node --test`（没有 `@/` 别名解析）下 import 这一份。
 * （`PendingMessageOpView` 是本文件自己导出的，不在这里重导一遍 —— 重导会与本地声明冲突。）
 */
export type { ContentTransfer, GroupHistoryProgress, TransferInfo };
