/**
 * 消息收发 / 乐观投影 / 撤回 / 渲染切换。
 *
 * 职责边界：批量入账、乐观上屏与回滚、1:1 撤回、表情回应、消息删除、渲染模式。
 * 会话摘要回滚的判据在 `@/utils/optimistic`（纯函数），这里只负责"调用哪一条"。
 *
 * ⚠️ 三分法判据与动作归类表仍只写在 `useChatStore.ts` 的入口注释块里 —— 那个是唯一真源，
 * 本文件不许另抄一份（否则改一处漏一处）。
 */
import { api } from "@/api";
import {
  applyIncomingToConversations,
  applyReplacements,
  existingIdsFor,
  furthestStatus,
  mergeMessages,
  freshMentionedConvs,
  findFirstMessageById,
  patchMessageInConv,
  pickMediaContent,
  replaceMessageAt,
  replaceOptimistic,
  previewText,
  sortConversations,
  statusSnapshotFor,
} from "@/utils/messages";
import {
  canApplyOptimisticFailure,
  findByMsgId,
  pendingRollbackIndex,
  recallRollbackTarget,
  summaryOwnedByProjection,
} from "@/utils/optimistic";
import {
  buildRemindAckPayload,
  buildRemindPayload,
  foldReminders,
  isNudgePayload,
} from "@/utils/reminders";
import { buildReactionPayload } from "@/utils/reactions";
import { createMsgConvIndex } from "@/utils/msgConvIndex";
import { shouldRunThrottled } from "@/utils/defer";
import { mergeIncomingTodoRows, todoMentionsMe } from "@/utils/todos";
import { t } from "@/i18n";
import type { MessageRecord } from "@/types";
import type { ChatContext } from "./runtime";

export function createMessagingModule(ctx: ChatContext) {
  const {
    app,
    messages,
    renderLangs,
    conversations,
    activeConv,
    mentionedConvs,
    myDeviceId,
    groupTodoRows,
  } = ctx.state;
  const {
    touchCacheOrder,
    enforceMessageCacheBound,
    chatViewerLooking,
    refreshConversations,
    refreshOpenTodos,
    refreshTransfers,
    showOptimisticOp,
    dropOptimisticOp,
    optimisticOpRow,
    showNudgeNotice,
  } = ctx.api;

  // ---------------- 消息合并（同步） ----------------
  // 说明：曾用 Web Worker 后台合并，但 Tauri 生产构建（WKWebView 自定义协议）下
  // Worker 可能加载失败——mergeInWorker 的 Promise 永不 resolve，导致发送/接收的
  // 消息全部卡在合并步骤不刷新（需重开会话走查库路径才能恢复）。
  // 合并本身是 O(n) Set 去重 + 排序（单会话缓存 ≤300 条，微秒级），不值得为它
  // 冒 Worker 失效风险，改为主线程同步合并；rAF 批量节流保留。

  // ---------------- 密集广播批量队列 ----------------
  let pending: MessageRecord[] = [];
  let flushScheduled = false;
  // 乐观记录还在队列里未落地时到达的「真实记录」：tmp msg_id → 后端记录
  const pendingReplace = new Map<string, MessageRecord>();
  // Ack 先于乐观→真实替换到达：msg_id 已知但 store 里还没有该条目。
  // ⚠️ 必须有容量上限（审计阶段 4 · 4.2）：`found` 只扫 `messages.value`（LRU 保留 4 个会话），
  // 所以「会话被淘汰 / 文件回执 / outbox 补投」这三类 Ack 永远命中不了消费点，条目
  // 只会加不会删 ⇒ 跟着运行时长单调增长。这里用 FIFO 兜住最坏情况；真正的删除
  // 仍由 `send()` 消费时做（下面 `pendingAcks.delete`），淘汰只清那些本来就没人要的。
  const pendingAcks = new Set<string>();
  const PENDING_ACKS_MAX = 512;

  /**
   * `msg_id → conv_id` 反查表（审计 P2 #30）：`msg_id` 全局唯一且消息不会换会话，
   * 所以这张表**不需要失效**。Ack 到达时先查它，命中就只在那一个会话里找，
   * 不再遍历所有缓存会话（批量文件回执时原来是 O(会话×消息)）。
   *
   * 表里查不到时退回全量扫描，并在扫描过程中顺手把见到的 id 都记进来 ——
   * 第一条 Ack 之后的平均成本就降到 O(该会话消息数)。
   *
   * ⚠️ 必须有容量上限（审计 2026-11-04 · 只增不减）：`messages` 本身按会话封顶
   * （`PAGE_SIZE × MAX_PAGES = 1000` 条/会话、`MAX_CACHED_CONVS = 8` 个会话整块逐出），
   * 但这张表是**跨会话生命周期**的：会话被淘汰后它里面那些 id 没有删除点，
   * 用户切过的会话越多、跑得越久，条目就越多。上界取 8 × 1000 + 余量 = 8192 ——
   * 它只需要装得下当前 8 个缓存会话的全部 id，超出的本来就查得到也走回退扫描，
   * 淘汰最旧的不会改变正确性（`convIdOfMessage` 未命中时仍会全量扫描重建）。
   *
   * ✅ 口径已定（用户拍板 2026-11-05）：**8192 不再调整**，也**不是待办**。
   * 最坏情况是"会话早被淘汰 + 消息早被逐出"的老消息在搜索里点跳转时命中不到索引，
   * 走到既有的「找不到该消息」提示即止，不会崩、也不会阻塞其它会话的搜索。
   */
  const CONV_ID_BY_MSG_MAX = 8192;
  const convIdByMsgId = createMsgConvIndex(CONV_ID_BY_MSG_MAX);

  function convIdOfMessage(msgId: string): string | null {
    const known = convIdByMsgId.get(msgId);
    if (known) {
      const list = messages.value[known];
      if (list && list.some((m) => m.msg_id === msgId)) return known;
    }
    for (const [convId, list] of Object.entries(messages.value)) {
      // 逐会话收一次：在一次全量扫描中途就把表压回上界，避免"扫描过程中先涨到 N 倍"。
      convIdByMsgId.remember(convId, list);
      if (list.some((m) => m.msg_id === msgId)) return convId;
    }
    return null;
  }

  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    // 后台/遮挡窗口的 requestAnimationFrame 会被浏览器暂停，导致消息滞留不渲染；
    // 窗口不可见时退回 setTimeout，保证任何状态下都能入列渲染。
    if (!document.hidden && typeof requestAnimationFrame === "function") {
      requestAnimationFrame(flushNow);
      // 安全网（2026-09-23 审计 1.7）：rAF 回调可能在个别平台行为下丢失（既不投递
      // 也不报错），flushScheduled 一旦卡在 true，后续所有 enqueueMessage 都被
      // 开头的守卫挡回 —— 消息永久不渲染且无恢复手段、pending 无上限堆积。
      // 1s 后仍未落地就强制冲刷；rAF 正常时这里是幂等 no-op（flag 已被置回）。
      setTimeout(() => {
        if (flushScheduled) flushNow();
      }, 1000);
    } else {
      setTimeout(flushNow, 0);
    }
  }

  /** 立即冲刷批量队列（幂等：无挂起项时只复位 flag）。 */
  function flushNow() {
    flushScheduled = false;
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    void applyIncoming(batch);
  }

  async function applyIncoming(raw: MessageRecord[]) {
    if (raw.length === 0) return;
    // 这两份快照只统计**这一批涉及的会话**。以前它们每批遍历一次全部缓存会话的全部消息
    //（缓存上限内约合每帧上万次 Map/Set 写入，而事件风暴、传文件回填时这个函数每帧跑一次），
    // 换来的信息全部落在批外。判据见 utils/messages.test.ts 那几条真值表。
    const touched = new Set(raw.map((m) => m.conv_id));
    // 快照当前各条目的送达状态，供 applyReplacements 做 furthestStatus 比较
    const curStatus = statusSnapshotFor(messages.value, touched);
    const batch = applyReplacements(raw, pendingReplace, curStatus);
    const byConv = new Map<string, MessageRecord[]>();
    for (const m of batch) {
      const list = byConv.get(m.conv_id) ?? [];
      list.push(m);
      byConv.set(m.conv_id, list);
    }
    // 未读增量只统计「本地真正新增」的消息：后端对同一条业务消息可能经多条投递路径
    // （直连 / outbox 补发 / Gossip 转发）反复 emit `message-received`，若按整批长度累加，
    // 重复投递会一次次 +1，导致「发几条、数字却几十」——未读数虚高的根因。
    // 按 msg_id 与内存已有消息比对后，再据此累加 unread。
    const existingIdsByConv = existingIdsFor(messages.value, touched);
    const newByConv = new Map<string, MessageRecord[]>();
    for (const [cid, list] of byConv) {
      const known = existingIdsByConv.get(cid) ?? new Set<string>();
      const fresh: MessageRecord[] = [];
      for (const item of list) {
        if (known.has(item.msg_id)) continue; // 重复投递：不计入未读
        known.add(item.msg_id);
        fresh.push(item);
      }
      if (fresh.length) newByConv.set(cid, fresh);
    }
    // 任务行同时落进看板那一份源（同一个家）：只写已加载的会话，同 msg_id 是刷新 ——
    // 见 utils/todos::mergeIncomingTodoRows。
    const mergedRows = mergeIncomingTodoRows(groupTodoRows.value, batch);
    if (mergedRows !== groupTodoRows.value) groupTodoRows.value = mergedRows;
    // 被 @ 检测（微信式 [有人@我]）的规则整体搬进 `messages.ts::freshMentionedConvs` ——
    // 三条规则（只群聊 / 非自己发的 / 当前没开着这个会话）与"与未读同源、重复投递不反复触发"都在那里，
    // 并且**有单测**（`messages.test.ts` 那 7 条）。搬走而不是再判一遍：这段原先长在 store 里，
    // 判不到也测不到，2026-09-28 拿真无障碍树读数时因此分不清"该亮没亮"与"正开着所以不算"。
    const myName = app.device?.nickname ?? "";
    const myId = myDeviceId.value;
    for (const cid of freshMentionedConvs(newByConv, activeConv.value, { id: myId, name: myName },
      { alsoMentionsMe: (rec) => todoMentionsMe(rec, myId), activeVisible: chatViewerLooking() })) {
      mentionedConvs.value.add(cid);
    }
    // 会话列表中不存在的会话（新好友 / 后端新创建）：本地合并不了，直接从后端拉取
    const knownIds = new Set(conversations.value.map((c) => c.id));
    const missing = [...byConv.keys()].filter((id) => !knownIds.has(id));
    for (const [convId, incoming] of byConv) {
      // ⚠️ 这里曾是「已有 msg_id 一律丢弃」——但后端对同一条消息存在**回填式重发**：
      // 群文件 Done 之后会再 emit 一条带本地 path 的 gfile 记录（transport 完成回填段），
      // 丢弃它等于气泡永远停在无 path 形态 → 群图片预览打不开（真机 2026-09-19）。
      // 改成 upsert：同 msg_id 以本轮记录刷新内容（DB 是真相），送达状态仍只前进不回退。
      const existing = messages.value[convId] ?? [];
      const indexOf = new Map(existing.map((m, i) => [m.msg_id, i] as const));
      const next = [...existing];
      for (const m of incoming) {
        const i = indexOf.get(m.msg_id);
        if (i === undefined) {
          indexOf.set(m.msg_id, next.length);
          next.push(m);
        } else {
          const prev = next[i];
          // content 不能一律取新的：群文件的 path 是收完才回填的，回填前的后到记录
          // 会把已回填的 path 擦掉 ⇒ 预览请求根本不发出去（空白气泡）。见 pickMediaContent。
          next[i] = {
            ...m,
            content: pickMediaContent(prev, m),
            status: furthestStatus(prev.status, m.status),
          };
        }
      }
      messages.value[convId] = mergeMessages([], next);
      touchCacheOrder(convId);
    }
    // 收完一批就收缩一次缓存（本轮可能让若干非活跃会话的缓存变冷）
    enforceMessageCacheBound();
    if (missing.length > 0) {
      // 新会话：以 DB 为准拉全量（DB 已按新消息 +1），前端不再自行叠加
      await refreshConversations();
    } else {
      conversations.value = applyIncomingToConversations(
        conversations.value,
        activeConv.value,
        newByConv,
        myDeviceId.value,
      );
    }
    // 这批里出现了任务行 ⇒ 徽标要跟着动。这一条同时覆盖了三种来源：
    // 收到别人的任务、自己创建/改任务（`createTodo` 走 `enqueueMessage` → 这里）、
    // 以及 #82 之后本端收到的自己那份 emit。
    if (batch.some((m) => m.kind === "todo" || m.kind === "todo_update")) void refreshOpenTodos();
  }

  /** 批量队列堆积到这个量级就值得说一句（审计 1.7 的软上限）。 */
  const BACKLOG_WARN_AT = 5000;
  /** 同一件事 60s 内只说一次（日志同 key 每 60s 最多 1 行那条规矩，toast 更得守）。 */
  const BACKLOG_NOTICE_MS = 60_000;
  let lastBacklogNoticeAt = 0;

  function enqueueMessage(rec: MessageRecord) {
    pending.push(rec);
    // 批量队列软上限（审计 1.7）：正常情况下 rAF 一帧内就会清空；堆积到这个量级
    // 说明 flush 调度已经失灵（或事件风暴），必须留痕 —— 无告警时它只是安静地吃内存。
    //
    // 判据从 `=== 5000` 改成 `>= 5000`：等值只在那一刻恰好被第 5000 次入队命中才响，
    // 而这条链上没有任何东西保证不会一次推进多行（重连补投那一类）。
    // 配上 60s 限流之后，风暴期也不会变成每帧一行的日志。
    if (pending.length >= BACKLOG_WARN_AT) {
      const now = Date.now();
      if (shouldRunThrottled(now, lastBacklogNoticeAt, BACKLOG_NOTICE_MS)) {
        lastBacklogNoticeAt = now;
        console.error(`[chat] 消息批量队列堆积 ${pending.length} 条：flush 调度疑似失灵`, {
          flushScheduled,
          hidden: document.hidden,
        });
        // 原来只有 `console.error` ⇒ 桌面端用户看不见（devtools 一般是关着的），
        // 症状是"新消息要切一下会话才出来"而没有任何解释（10-22 审计 D-24）。
        // 说一句就够：这一格限流与上面那条日志共用同一个时间戳，不会各说各的。
        app.toast(t("chat.batchBacklog"), "error");
      }
    }
    scheduleFlush();
  }

  // ---------------- 乐观投影的落定 / 回滚（5.16.91） ----------------

  /** 会话摘要的投影前值（只在 1:1 发送时用；群摘要归群成员台账）。 */
  interface SummaryBefore {
    last_msg: string | null;
    last_ts: number | null;
  }

  function captureSummary(convId: string): SummaryBefore | null {
    const c = conversations.value.find((x) => x.id === convId);
    return c ? { last_msg: c.last_msg, last_ts: c.last_ts } : null;
  }

  /**
   * 回滚会话摘要：**只在当前摘要仍归这次投影**时收回。
   * 期间若来了更新的消息，摘要已经易主 —— 覆盖它会把新消息挤下去（比不回滚更糟）。
   */
  function restoreSummaryIfOurs(convId: string, projectedTs: number, before: SummaryBefore | null) {
    if (!before) return;
    const conv = conversations.value.find((x) => x.id === convId);
    if (!conv || !summaryOwnedByProjection(conv.last_ts ?? undefined, projectedTs)) return;
    conv.last_msg = before.last_msg;
    conv.last_ts = before.last_ts;
    conversations.value = sortConversations(conversations.value);
  }

  /**
   * 把乐观消息落成失败态（保留内容供重发）。
   *
   * ⚠️ 两道顺序守卫，缺一就是"UI 回退成错误状态"：
   *  ① 还在待落地批次里 → 只改那一格（`applyIncoming` 已过滤 failed，不会顶摘要）；
   *  ② 已在列表里 → 必须是**同一条** `msg_id` 且仍是 `sending`；真实结果先到（已 `sent` /
   *     已被真实行替换）时**丢弃**这次迟到失败——不许按 `local_id` 命中真实行再改掉它的 id。
   *
   * @returns 是否真的落了失败态（`false` = 真实结果已先到，调用方不必再回滚摘要）
   */
  function failOptimistic(convId: string, msgId: string): boolean {
    const p = pendingRollbackIndex(pending, msgId);
    if (p >= 0) {
      pending[p] = { ...pending[p], status: "failed" };
      return true;
    }
    const row = findByMsgId(messages.value[convId], msgId);
    if (!canApplyOptimisticFailure(row, msgId)) return false;
    const hit = patchMessageInConv(messages.value, convId, msgId, (m) =>
      canApplyOptimisticFailure(m, msgId) ? { ...m, status: "failed" } : m,
    );
    if (!hit) return false;
    messages.value = hit.lists;
    return true;
  }

  /** 整条收回一条还没落地的乐观投影（文件被拒时用：库里没有行，留下就是幽灵）。 */
  function dropOptimistic(convId: string, msgId: string) {
    pending = pending.filter((m) => m.msg_id !== msgId);
    pendingReplace.delete(msgId);
    const list = messages.value[convId];
    if (list) messages.value = { ...messages.value, [convId]: list.filter((m) => m.msg_id !== msgId) };
  }
  /**
   * 统一发送（单聊/群聊）。乐观上屏：先显示 sending，invoke 成功后替换为真实记录。
   *
   * `mentionIds` 只有群文本消息有用：**这条消息 @ 的是哪些人（设备 id）**。
   * 传 `undefined`（非选择器输入的发送路径都这样）= 随老格式发出去，
   * 接收端按昵称兜底判 —— 新字段只让"带上了 id 的那些"更准，不会让别的入口变暗。
   *
   * `retryOfMsgId` = **重发**时那条 failed 气泡的 `msg_id`（见 `retrySend`）。
   * 传它就**不再新建乐观气泡**，而是把那条 failed 原地转回 sending ——
   * 否则列表里会同时留着"发送失败的原文"和"重发中的原文"两条，而 failed 那条
   * **永远不会被删**（全库无删除路径，且 `appendLocalOnly` 每次重开会话都会把
   * `tmp-*` 重新追加到快照尾部）。
   *
   * ⚠️ 为什么不能字面复用同一 msg_id（INV-001 在本项目做不到"客户端指定"那一半）：
   * 后端 msg_id = `SHA-256(sender_id + nonce + payload)`（`protocol.rs::compute_message_id`），
   * nonce 每条新消息都不同 ⇒ 重发**必然**是新 msg_id；且 `send_message` 只有
   * `(friend_id, content, kind)` 三个参数，压根没有 msg_id 可传。所以 INV-001 的
   * "重试复用同一 msg_id"在本项目落在**接收侧幂等**（`message_exists` 按 msg_id 去重），
   * 前端这一侧改成"**旧气泡原地复用**"—— 逻辑消息在界面上仍是同一条。
   */
  async function send(
    convId: string,
    content: string,
    kind: string,
    mentionIds?: string[],
    retryOfMsgId?: string,
    /** 代码消息的显式语言（围栏标签/发送前选择）；null/缺省 = 自动识别。 */
    lang?: string | null,
  ): Promise<MessageRecord> {
    const myId = app.device?.device_id ?? "";

    // ---- 重发：把那条 failed 气泡原地转回 sending，不再新建乐观记录 ----
    // 找不到（切了会话 / 已被快照吞掉）就退回新建 —— 宁可多一条也不静默丢消息。
    if (retryOfMsgId) {
      const revertedHit = patchMessageInConv(messages.value, convId, retryOfMsgId, (m) => ({
        ...m,
        status: "sending" as const,
      }));
      if (revertedHit) {
        messages.value = revertedHit.lists;
        try {
          const rec = await sendToBackend(convId, content, kind, mentionIds, undefined, lang);
          if (kind === "code" && lang) setRenderLang(rec.msg_id, lang);
          // Ack 可能已在 await 期间到达 ⇒ 直接提升到 delivered（与下面新建路径同一处理）
          const acked = pendingAcks.delete(rec.msg_id);
          replaceMessage(
            convId,
            retryOfMsgId,
            acked ? { ...rec, status: furthestStatus(rec.status, "delivered") } : rec,
          );
          // 任务中心那一行来自补发队列快照：发送动作本身不会产生事件（离线时后端只入队），
          // 不在这里补拉，用户就只能在"关窗重开/等下一次别的刷新"时才看到它（2026-10-25 实报）。
          void refreshTransfers();
          return rec;
        } catch (e) {
          // 只有真实结果还没到（仍 sending）才落失败态；已先到的成功不许被迟到失败盖掉。
          failOptimistic(convId, retryOfMsgId);
          void refreshTransfers();
          throw e;
        }
      }
    }

    // 乐观消息先占一个很大的逻辑序号，保证它出现在会话底部；后端返回真实记录后会替换为权威 seq。
    // `local_id` 是**持久本地身份**：传给后端落库，真实记录返回同一个值 ⇒ 列表 key 不换。
    const localId = crypto.randomUUID();
    const optimistic: MessageRecord = {
      id: -1,
      msg_id: `tmp-${localId}`,
      local_id: localId,
      conv_id: convId,
      sender_id: myId,
      receiver_id: convId,
      kind: kind as MessageRecord["kind"],
      content,
      ts: Date.now(),
      seq: Number.MAX_SAFE_INTEGER,
      status: "sending",
    };
    enqueueMessage(optimistic);
    // 静默 / 队列可见的两类动作（强提醒、合并转发）在任务中心先占一行：
    // `remind`（含抖动）不进时间线，任务中心是它唯一的可见处；`merge` 虽另有气泡投影，
    // 同样需要"排队中/判死"在任务中心可查。临时行只认 `tmp-<localId>`，真实快照到达后
    // 由 `refreshTransfers` 整表接管（迟到回滚摘不到真实行，见 `dropByMsgId`）。
    const optimisticOpId =
      kind === "remind" || kind === "merge" ? optimistic.msg_id : null;
    if (optimisticOpId) {
      showOptimisticOp(
        optimisticOpRow(
          optimisticOpId,
          convId,
          kind,
          kind === "remind" && isNudgePayload(content),
        ),
      );
    }
    // 1:1 才捕获摘要：群摘要由群成员台账/后端快照驱动，本批不改群行为。
    const summaryBefore = convId.startsWith("group:") ? null : captureSummary(convId);
    try {
      const rec = await sendToBackend(convId, content, kind, mentionIds, localId, lang);
      if (kind === "code" && lang) setRenderLang(rec.msg_id, lang);
      // 如果 Ack 已在 await 期间到达：直接把 real record 提升到 delivered，
      // 然后一次性替换 optimistic → real（不再二次 replaceMessage）。
      const acked = pendingAcks.delete(rec.msg_id);
      const next = acked
        ? { ...rec, status: furthestStatus(rec.status, "delivered") }
        : rec;
      replaceMessage(convId, optimistic.msg_id, next);
      if (optimisticOpId) dropOptimisticOp(optimisticOpId);
      void refreshTransfers();
      return rec;
    } catch (e) {
      // 发送失败：把投影落成失败态（保留内容，用户可重发）；若它已经把会话摘要顶上去，
      // 一并收回（失败的行不许继续冒充"最新消息"）。真实结果已先到时 `failOptimistic`
      // 返回 false，此时摘要属于真实消息，不能回滚。
      if (optimisticOpId) dropOptimisticOp(optimisticOpId);
      if (failOptimistic(convId, optimistic.msg_id)) {
        restoreSummaryIfOurs(convId, optimistic.ts, summaryBefore);
      }
      // 任务中心那一行以**后端快照为准**：本地没入队时不存在；入队后判死的那一行由快照补回。
      // 强提醒 / 合并转发的临时行已在上面摘掉（真实结果先到时它本来就不在，重复摘是幂等的）。
      void refreshTransfers();
      throw e;
    }
  }

  /**
   * 重发一条**本端判失败 / 已取消**的 1:1 消息（复用原 `msg_id`，计划 D1）。
   *
   * 为什么不复用 `send()` 的重发分支：那条走 `send_message` ⇒ 新 msg_id、新 seq，
   * 用户按一次"重发"就等于又发了一条新消息（对端半开链路上最需要幂等时恰恰没有）。
   * 这里后端原地复活同一条消息，前端也只把**同一个 msg_id** 的气泡换回 sending/sent。
   */
  async function resend(convId: string, msgId: string): Promise<MessageRecord> {
    const rec = await api.resendMessage(convId, msgId);
    // Ack 可能已在 await 期间到达 ⇒ 与首次发送同一条处理：提升到 delivered 再落盘到缓存。
    const acked = pendingAcks.delete(msgId);
    const next = acked ? { ...rec, status: furthestStatus(rec.status, "delivered") } : rec;
    replaceMessage(convId, msgId, next);
    void refreshTransfers();
    return rec;
  }

  /** 单聊/群聊的 invoke 分流（重发与首次发送共用，避免两份实现漂移）。 */
  async function sendToBackend(
    convId: string,
    content: string,
    kind: string,
    mentionIds?: string[],
    localId?: string,
    lang?: string | null,
  ): Promise<MessageRecord> {
    if (convId.startsWith("group:")) {
      return api.sendGroupMessage(convId.slice(6), content, kind, mentionIds, localId, lang);
    }
    return api.sendMessage(convId, content, kind, localId, lang);
  }

  /**
   * 发起强提醒：对 `targetMsgId` 发一条 kind=remind。
   * 群聊必须带显式 actors 名单（第一版不默认全群）；私聊名单为空（默认对方）。
   * 复用普通 send 链路（乐观气泡/outbox/Ack），不另造传输。
   *
   * 5.16.93：`remind` 是静默 kind —— 乐观投影落在任务中心（`send()` 建的临时行），
   * 气泡不进时间线。后端先入队、建链后协商；对端亲口不支持时返回 `failed`，
   * 这里按具名码抛出，交给调用点的 `toastError` 翻人话（任务中心同时保留那一行供重发）。
   */
  async function sendReminder(
    convId: string,
    targetMsgId: string,
    actors: string[] = [],
    shake = false,
  ) {
    const rec = await send(convId, buildRemindPayload(targetMsgId, actors, shake), "remind");
    if (rec.status === "failed") {
      throw new Error(`code=${rec.fail_code ?? "SEND_KIND_UNSUPPORTED"}`);
    }
  }

  /**
   * 工具栏「抖动」按钮（仿 QQ 窗口抖动）：**独立事件**，不锚定任何消息、不发强提醒。
   * 复用 `remind` 帧的可靠管道（`nudge=true`），接收端只抖 + 灰字；旧端由能力位挡住。
   *
   * 5.16.93：**发送成功才出「已向对方发送」灰字**。判死（对端声明不支持）时改为抛具名码 +
   * 任务中心留一行 —— 否则本机抖了提示、对方窗口毫无反应，用户只会当成功能坏了。
   */
  async function shakeConversation(convId: string): Promise<void> {
    if (!convId || convId.startsWith("group:")) return;
    const rec = await send(convId, buildRemindPayload("", [], true, true), "remind");
    if (rec.status === "failed") {
      throw new Error(`code=${rec.fail_code ?? "SEND_KIND_UNSUPPORTED"}`);
    }
    showNudgeNotice(convId, app.device?.device_id ?? "");
  }

  /**
   * 「我知道了」：找到以 targetMsgId 为目标的那条 remind，回 stage=confirmed。
   * 没折叠出对应 remind（消息已被清/还没加载）时如实抛错，不静默。
   */
  async function confirmReminder(convId: string, targetMsgId: string) {
    const list = messages.value[convId] ?? [];
    const state2 = foldReminders(list).get(targetMsgId);
    if (!state2) throw new Error("reminder-not-found");
    await send(convId, buildRemindAckPayload(state2.remindId, "confirmed"), "remind_ack");
  }

  /**
   * 替换会话内指定 msg_id 的消息（乐观记录 → 真实记录 / 状态变更）。
   *
   * ⚠️ 必须走 `replaceOptimistic`（按 `msg_id` 认，不按位置换）：群发送的真实记录有**两条**
   * 到达路径 —— 后端为跨窗口同步加的自 emit（`commands/window.rs::send_group_payload`）
   * 与 `invoke` 的返回值。自 emit 先到时列表里已经有那一条，再 splice 一次就是
   * "同一条消息显示两条"（而切一次会话从库里重读又变回一条 —— 用户 2026-09-28 报的正是这个）。
   */
  function replaceMessage(convId: string, msgId: string, next: MessageRecord) {
    const list = messages.value[convId];
    if (list) {
      const replaced = replaceOptimistic(list, msgId, next);
      if (replaced) {
        messages.value[convId] = replaced;
        return;
      }
    }
    // 乐观记录还压在批量队列里（invoke 先于 rAF 落地返回）：挂起等批次落地时替换。
    // 直接丢弃真实记录 = 气泡永远停在「发送中」，而后端库里早已是 delivered/read。
    if (pending.some((m) => m.msg_id === msgId)) pendingReplace.set(msgId, next);
  }
  /**
   * 撤回一条消息（群聊传 `group:<gid>`，单聊传 peer id；5.16.93 起 1:1 走乐观投影）。
   *
   * 乐观层只改**前端投影**（内存里的 kind + 会话摘要），后端仍然是唯一写入口；
   * 失败时按 `recallRollbackTarget` 的判据还原 —— 「真实事件先到 / 已回滚过 / 目标换人」
   * 三种情况都不动，避免把对方已经认账的撤回又翻回来。
   * 群聊撤回仍走旧路径（本轮范围是 1:1，群侧台账与可见性另行处理）。
   */
  async function recallMessage(convId: string, msgId: string) {
    if (convId.startsWith("group:")) {
      await api.recallGroupMessage(convId.slice(6), msgId);
      return;
    }
    const hit = findFirstMessageById(messages.value, [msgId]);
    const before = hit && hit.convId === convId ? hit.rec : undefined;
    const localId = crypto.randomUUID();
    const tempOpId = `tmp-${localId}`;
    let projection: RecallProjection | null = null;
    if (before && hit && before.kind !== "recalled" && before.status !== "failed" && before.status !== "cancelled") {
      const conv = conversations.value.find((c) => c.id === convId);
      const preview = previewText(before);
      const ownsPreview =
        !!conv?.last_msg &&
        !!before.content &&
        (conv.last_msg === preview || conv.last_msg === preview.slice(0, 30));
      const proj: RecallProjection = {
        before,
        convId,
        previewBefore: ownsPreview ? (conv!.last_msg ?? undefined) : undefined,
        settled: false,
      };
      projection = proj;
      messages.value = replaceMessageAt(messages.value, convId, hit.index, {
        ...before,
        kind: "recalled",
        content: "",
      });
      if (ownsPreview) {
        conversations.value = conversations.value.map((c) =>
          c.id === convId ? { ...c, last_msg: t("msg.recalled") } : c,
        );
      }
      optimisticRecalls.set(msgId, proj);
      showOptimisticOp(optimisticOpRow(tempOpId, convId, "recall"));
    }
    try {
      await api.recallDirectMessage(convId, msgId);
    } catch (e) {
      // 同步失败（含后端把队列行判死并交回具名码）：只还原**仍是这次投影**的那一条。
      // 用最新的位置重找一次：await 期间列表可能已经重排/重读，旧的 index 会改到别人身上。
      const now = findFirstMessageById(messages.value, [msgId]);
      const restored =
        projection && now && now.convId === convId
          ? recallRollbackTarget(now.rec, projection.before, projection.settled)
          : null;
      if (restored && now) {
        messages.value = replaceMessageAt(messages.value, convId, now.index, restored);
        if (projection!.previewBefore !== undefined) {
          conversations.value = conversations.value.map((c) =>
            c.id === convId ? { ...c, last_msg: projection!.previewBefore! } : c,
          );
        }
      }
      if (projection) optimisticRecalls.delete(msgId);
      dropOptimisticOp(tempOpId);
      void refreshTransfers();
      throw e;
    }
    if (projection) optimisticRecalls.delete(msgId);
    dropOptimisticOp(tempOpId);
    void refreshTransfers();
  }

  /** 尚在等待真实结果的撤回投影（key = 被撤回消息的 msg_id）。 */
  type RecallProjection = {
    before: MessageRecord;
    convId: string;
    /** 乐观投影前该会话的预览文本；没改过摘要时是 undefined（回滚也不碰它）。 */
    previewBefore: string | undefined;
    /** 真实 `message-recalled` 事件是否先到；到了就不再回滚。 */
    settled: boolean;
  };
  const optimisticRecalls = new Map<string, RecallProjection>();

  /**
   * 切换自己发的代码/文本消息渲染（可带显式代码语言）。
   *
   * `await` 成功才改本地显示：后端在 LWW 未应用时返回具名错误（`RENDER_SUPERSEDED`），
   * 非法语言返回 `RENDER_INVALID_LANG`，所以这里不会出现「看起来切了其实没切」。
   */
  async function setMessageRender(
    convId: string,
    msgId: string,
    mode: "code" | "text",
    lang?: string | null,
  ) {
    await api.setMessageRender(convId, msgId, mode, lang ?? null);
    setRenderLang(msgId, mode === "code" ? (lang ?? null) : null);
  }

  /** 显式语言（缺省/空 = 自动识别）。 */
  function getRenderLang(msgId: string): string | null {
    return renderLangs.value[msgId] ?? null;
  }

  function setRenderLang(msgId: string, lang: string | null) {
    const next = { ...renderLangs.value };
    if (lang) next[msgId] = lang;
    else delete next[msgId];
    renderLangs.value = next;
  }

  /** 冷加载后补齐历史消息的显式语言；失败静默（旧库/旧数据本来就没有 lang）。 */
  async function hydrateRenderLangs(convId: string) {
    try {
      const map = await api.getMessageRenderLangs(convId);
      if (Object.keys(map).length) renderLangs.value = { ...renderLangs.value, ...map };
    } catch {
      /* 读不到就全部按自动识别，与旧行为一致 */
    }
  }
  async function deleteMessages(convId: string, msgIds: string[]): Promise<number> {
    if (msgIds.length === 0) return 0;
    const set = new Set(msgIds);
    const current = messages.value[convId] ?? [];
    const removed = current.filter((m) => set.has(m.msg_id));
    messages.value = { ...messages.value, [convId]: current.filter((m) => !set.has(m.msg_id)) };
    try {
      const n = await api.deleteMessages(msgIds);
      await refreshConversations();
      return n;
    } catch (e) {
      // 按项逆操作（审计 P2）：把移除的消息加回**当前**会话列表（保留并发期间新增的消息），
      // 不整份恢复快照。conversations 未被本操作乐观修改，无需整份回滚（避免盖掉并发变更）。
      const now = messages.value[convId] ?? [];
      const nowIds = new Set(now.map((m) => m.msg_id));
      const restore = removed.filter((m) => !nowIds.has(m.msg_id));
      if (restore.length > 0) {
        messages.value = { ...messages.value, [convId]: [...now, ...restore] };
      }
      throw e;
    }
  }

  /**
   * 发一条表情回应（群聊）。
   *
   * 走与普通消息**完全相同**的可靠管道（E2EE + outbox + GroupAck + 去重 + 离线补发），
   * 只是接收端会按 kind 归类为静默事件。本地**不做乐观上屏**：回应是幂等的状态事件，
   * 折叠逻辑已经能正确处理重复，等服务端回执再合并反而更简单、也不会出现
   * "点了没反应但本地已高亮"的错觉。
   */
  async function sendReaction(groupId: string, target: string, emoji: string, add: boolean) {
    const rec = await api.sendGroupReaction(groupId, target, emoji, add);
    enqueueMessage(rec);
  }

  /**
   * 1:1 表情回应（5.16.93 起乐观投影）。
   *
   * 走普通 `send_message`，kind = "reaction"：回应是**状态事件**，而 `send_message` 已经是
   * "把一条带 kind 的消息可靠投递给一个好友"的唯一通路（outbox / E2EE / ack 全在那条上）。
   * 再加一条命令就是第二个家，而它管的那一半（可靠投递）会先腐烂。
   *
   * 5.16.92 起**能力不足不再当场 Err**：先写本地行与补发队列（`status` 仍是 `sending`），
   * 对端能力未知时留在队列等上线，只有对端**亲口声明**不支持才落 `failed` +
   * `SEND_KIND_UNSUPPORTED`。所以这里拿到的 `rec` 可能是 `sending`，也可能已经是
   * `failed` —— 两种都要入账：静默 kind 不进时间线，任务中心才是它的可见处与重发入口。
   *
   * 5.16.93 起投影先行：门控改成先入队之后，点下去必然会写队列，不必等后端往返才上屏。
   * `foldReactions` 会跳过 `failed/cancelled/recalled`，所以判死那一行不会继续冒充"已点"；
   * 任务中心那一行由乐观行 → 后端快照接管，失败时只摘临时行。
   * 只有真正的本地失败（写库失败 / 公钥缺失）才是 Err，交给调用点的 toast。
   */
  async function sendDmReaction(friendId: string, target: string, emoji: string, add: boolean) {
    const myId = myDeviceId.value;
    if (!myId) throw new Error("device id missing");
    const localId = crypto.randomUUID();
    const msgId = `tmp-${localId}`;
    const content = buildReactionPayload(target, emoji, add);
    const optimistic: MessageRecord = {
      id: -1,
      msg_id: msgId,
      local_id: localId,
      conv_id: friendId,
      sender_id: myId,
      receiver_id: friendId,
      kind: "reaction",
      content,
      ts: Date.now(),
      seq: Number.MAX_SAFE_INTEGER,
      status: "sending",
    };
    enqueueMessage(optimistic);
    showOptimisticOp(optimisticOpRow(msgId, friendId, "reaction"));
    try {
      const rec = await api.sendMessage(friendId, content, "reaction", localId);
      replaceMessage(friendId, msgId, rec);
      dropOptimisticOp(msgId);
      void refreshTransfers();
      // 判死（对端亲口声明缺位）：投影随之退出折叠，任务中心那行会带着具名码出现。
      // 抛给调用方是为了让人话原因当场可见，而不是只留在面板里等用户去找。
      if (rec.status === "failed" && rec.fail_code) {
        throw new Error(`code=${rec.fail_code}`);
      }
      return rec;
    } catch (e) {
      // 同步失败：库里没有这一行，投影整条收回；真实结果先到时 `dropOptimistic` 找不到临时行。
      dropOptimistic(friendId, msgId);
      dropOptimisticOp(msgId);
      void refreshTransfers();
      throw e;
    }
  }
  /**
   * 收到撤回事件：把本地那一行改成「已撤回」形态。
   *
   * 与后端的物化视图保持一致：`kind` 改 `recalled`、`content` 清空 ——
   * 这样搜索、预览、复制等所有读 content 的地方**一处都不用改**就自动正确。
   */
  /**
   * 渲染切换：改 kind 与显式语言；虚拟列表由 ResizeObserver 重测高度。
   *
   * 注意不能像旧实现那样在 `kind` 相同时提前 return —— 只切换语言时 kind 仍是 code，
   * 早退会把语言更新吞掉（就是"看起来切了其实没切"）。
   */
  function onMessageRenderChanged(msgId: string, kind: "code" | "text", lang: string | null) {
    setRenderLang(msgId, kind === "code" ? lang : null);
    const hit = findFirstMessageById(messages.value, [msgId]);
    if (!hit || hit.rec.kind === kind) return;
    messages.value = replaceMessageAt(messages.value, hit.convId, hit.index, { ...hit.rec, kind });
  }

  function onMessageRecalled(msgId: string) {
    // 真实事件先于调用方 await 回来：标记这次乐观投影已经"落定"，
    // 之后哪怕调用报错也不再回滚（否则会把对方已经认账的撤回翻回去）。
    const pendingProjection = optimisticRecalls.get(msgId);
    if (pendingProjection) pendingProjection.settled = true;
    const hit = findFirstMessageById(messages.value, [msgId]);
    if (!hit) return;
    const { convId, rec } = hit;
    if (rec.kind === "recalled") return; // 幂等：重复事件不再改动
    messages.value = replaceMessageAt(messages.value, convId, hit.index, {
      ...rec,
      kind: "recalled",
      content: "",
    });
    // 会话列表的预览若正是这条，也要跟着清掉（否则左侧仍显示已被撤回的正文）
    const conv = conversations.value.find((c) => c.id === convId);
    if (conv && conv.last_msg && rec.content) {
      const preview = previewText(rec);
      if (conv.last_msg === preview || conv.last_msg === preview.slice(0, 30)) {
        conversations.value = conversations.value.map((c) =>
          c.id === convId ? { ...c, last_msg: t("msg.recalled") } : c,
        );
      }
    }
  }

  /** 换实例 / 清空数据时把补发队列与乐观投影的过渡态一并复位。 */
  function resetMessagePipelineState() {
    pending = [];
    flushScheduled = false;
    pendingReplace.clear();
    pendingAcks.clear();
    convIdByMsgId.clear();
    optimisticRecalls.clear();
    lastBacklogNoticeAt = 0;
  }

  /** 补发批次是会被整体替换的数组，跨模块只能通过 getter 读当前值。 */
  function getPending(): MessageRecord[] {
    return pending;
  }

  /** 只清补发批次（`resetAfterDataCleared` 的原始语义，别顺手多清）。 */
  function clearPendingBatch() {
    pending = [];
  }

  /** 只清补发替换表与待确认回执（`resetAfterDataCleared` / `clearAllData` 的原始语义）。 */
  function clearPendingReplaceAndAcks() {
    pendingReplace.clear();
    pendingAcks.clear();
  }

  return {
    convIdOfMessage,
    scheduleFlush,
    flushNow,
    applyIncoming,
    enqueueMessage,
    captureSummary,
    restoreSummaryIfOurs,
    failOptimistic,
    dropOptimistic,
    send,
    resend,
    sendToBackend,
    sendReminder,
    shakeConversation,
    confirmReminder,
    replaceMessage,
    recallMessage,
    setMessageRender,
    getRenderLang,
    hydrateRenderLangs,
    sendReaction,
    sendDmReaction,
    deleteMessages,
    onMessageRecalled,
    onMessageRenderChanged,
    resetMessagePipelineState,
    clearPendingBatch,
    clearPendingReplaceAndAcks,
    PENDING_ACKS_MAX,
    getPending,
    pendingReplace,
    pendingAcks,
    convIdByMsgId,
    optimisticRecalls,
  };
}
