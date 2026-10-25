<script setup lang="ts">
import { computed, ref } from "vue";
import BaseModal from "@/components/BaseModal.vue";
import Spinner from "@/components/ui/Spinner.vue";
import { api } from "@/api";
import { t } from "@/i18n";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";
import {
  FALLBACK_TITLE_KEYS,
  operationStatusText,
  type OperationAction,
  type OperationRow,
} from "@/utils/taskCenter";
import { clampProgress } from "@/utils/transferSummary";
import { blockedReasonKey } from "@/utils/transferState";
import { cancelOutcome, fileCancelKey, messageCancelNotice } from "@/utils/cancelFeedback";
import { sleep } from "@/utils/defer";

/**
 * 统一后台任务中心（负责人 2026-10-23 提的那件："所有有进度、有目标、有完成态的任务都能看见，
 * 并且都能取消；已完成的不显示；状态归一成 排队 / 进行 / 阻塞，让人一眼看懂卡在哪个交互节点，
 * 而且能自己打通"）。
 *
 * 它取代了原来那颗只管文件的「正在传输」药丸（`TransferCenter.vue`）：文件行还在，
 * 只是并进了四份真值同一张表 —— 判定与排序全在 `utils/taskCenter`，这里只画与下发动作。
 *
 * 三条刻意的边界：
 * - **只列未完成**（`completed/cancelled/failed` 由 toast 和气泡上的回执说话）。
 *   用户原话："已经完成的在这个列表里应该是不展示"。
 * - **只给今天就能动的按钮**。`utils/taskCenter` 的 `OperationAction` 每一项都对着一条已存在的
 *   命令；点了什么都不会发生的按钮比不给按钮更糟。
 * - **取消不加二次确认**：这条动作可逆（重新发送即可），而这一轮要的是"打断没有摩擦"。
 *
 * ⚠️ 2026-10-25：浮动药丸整颗移除。入口改为会话列表页脚的「小院儿」后面
 * （用户原话："总是在界面上有点挡住使用"）。开关状态住在 `useAppStore`，
 * 页脚与面板读同一个 store，不靠 props 透传。
 */
const app = useAppStore();
const chat = useChatStore();

const rows = computed(() => chat.operations);

function rowTitle(row: OperationRow): string {
  return row.title || t(FALLBACK_TITLE_KEYS[row.kind]);
}

/**
 * 目标（"给谁 / 从谁那儿"）。群历史与合并卡片里的内容没有会话身份时不给这一行 ——
 * 宁可不写，也不要显一个裸 device_id 当名字（成员名口径见 `utils/memberName`）。
 */
function rowTarget(row: OperationRow): string {
  const cid = row.convId;
  if (!cid) return "";
  const name = cid.startsWith("group:")
    ? (chat.groups.find((g) => g.id === cid.slice("group:".length))?.name ?? "")
    : chat.nicknameOf(cid);
  if (!name) return "";
  if (row.kind === "file_receive" || row.kind === "content_fetch") {
    return t("task.from", { name });
  }
  return t("task.to", { name });
}

function statusText(row: OperationRow): string {
  // 映射只此一份（`utils/taskCenter::operationStatusText`），组件不再自己推第二套。
  return operationStatusText(row, t);
}

/** 卡在哪一句 + 已经试过几次 + 还差几个人。三件都是"为什么还不动"的答案。 */
function detailText(row: OperationRow): string {
  const parts: string[] = [];
  const key = blockedReasonKey(row.blockedReason);
  if (key) parts.push(t(key));
  if (row.attempts && row.attempts > 0) parts.push(t("task.attempts", { n: row.attempts }));
  // 只剩 1 个成员也要说（"还有 1 个人没收到"），否则半送达的群消息行会没有目标。
  if (row.waitingFor && row.waitingFor > 0) parts.push(t("task.waitingFor", { n: row.waitingFor }));
  return parts.join(" · ");
}

const busy = ref<string | null>(null);
/** 打开会话的请求令牌：后点的动作作废旧结果（IPC 不能 abort，但 UI 必须有终态）。 */
let openSeq = 0;

/** 有界等待一个响应式条件成立（50ms 轮询）；超时返回 false，不抛。 */
async function waitUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (!check() && Date.now() < end) {
    await sleep(50);
  }
  return check();
}

/** 给不可 abort 的 IPC 包一层超时：超时返回 "timeout"，底层结果被忽略。 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  return new Promise<T | "timeout">((resolve, reject) => {
    const timer = window.setTimeout(() => resolve("timeout"), ms);
    p.then(
      (v) => {
        window.clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        window.clearTimeout(timer);
        reject(e);
      },
    );
  });
}
const actionLabel: Record<OperationAction, string> = {
  cancel: "task.cancel",
  cancel_message: "task.cancel",
  cancel_update: "task.cancel",
  cancel_content: "task.cancel",
  retry_content: "task.retryNow",
  sync_history_now: "task.syncNow",
  cancel_history: "task.cancel",
  open_conversation: "task.openChat",
};

async function runAction(row: OperationRow, action: OperationAction) {
  if (busy.value) return;
  busy.value = `${row.id}|${action}`;
  try {
    if (action === "cancel") await cancelFile(row);
    else if (action === "cancel_message") await cancelMessage(row);
    else if (action === "cancel_update") await cancelUpdate();
    else if (action === "cancel_content") await cancelContent(row);
    else if (action === "retry_content") await retryContent(row);
    else if (action === "sync_history_now") await chat.syncGroupHistoryNow(row.id.slice("group:".length));
    else if (action === "cancel_history") await chat.cancelGroupHistory(row.id.slice("group:".length));
    else if (action === "open_conversation") await openConversation(row);
  } catch (e) {
    app.toastError(e, t("task.actionFail"));
  } finally {
    busy.value = null;
  }
}

/**
 * 取消一条**还没送出去的消息**（B4 的命令，2026-10-24 接进任务中心）。
 *
 * 2026-10-25：后端改成**结构化结果**（群消息可能只取消了剩余成员）。这里不再用
 * "cancelled / already_delivered" 两句二元判断 —— 文案映射只有一份，在
 * `utils/cancelFeedback.messageCancelNotice`，与气泡菜单共用。
 */
async function cancelMessage(row: OperationRow) {
  if (!row.convId) return;
  const res = await api.cancelMessage(row.convId, row.id);
  await chat.refreshTransfers();
  const notice = messageCancelNotice(res);
  app.toast(t(notice.key, notice.params ?? {}), notice.kind);
}

/**
 * 取消一条文件传输（发送与接收都走这条）。
 *
 * 后端返回的是**台账口径**：`alreadyDone` = 它已经到终态了（那一下没改成任何东西）。
 * 在这里说清楚而不是静默刷新 —— 用户点了"取消"却看到行还在，需要知道那是为什么。
 */
async function cancelFile(row: OperationRow) {
  // 先记下"点取消的那一刻是不是已经写出去了"：取消之后刷新的行会变成 cancelled，
  // 那时再读就永远是"没有 waiting_ack"——措辞会退化成一句"已取消"（用户 2026-10-25 指出的）。
  const wasSent = row.blockedReason === "waiting_ack";
  const res = await api.cancelFileTransfer(row.id);
  await chat.refreshTransfers();
  // 四个分支的唯一判据在 `utils/cancelFeedback`（同一个事实同一句话，不在这里另推一遍）。
  const outcome = cancelOutcome(res);
  app.toast(t(fileCancelKey(outcome, wasSent)), outcome === "notified" ? "success" : "info");
}

/**
 * 「立即重取」向那一个对端再要一份内容。入参取自内容台账本行（`peerId/cid/name/size`），
 * 不在界面上重算一遍 —— 台账在刷新后可能已经没有这条（刚刚传完了），那种情况只说"已经好了"。
 */
async function retryContent(row: OperationRow) {
  const src = chat.contentTransfers.find((c) => c.cid === row.id);
  if (!src) {
    await chat.refreshTransfers();
    app.toast(t("task.alreadyGone"), "info");
    return;
  }
  const ok = await api.requestContentByCid(src.peerId, src.cid, src.name, src.size);
  app.toast(t(ok ? "msg.refetchRequested" : "msg.refetchUnsupported"), ok ? "info" : "error");
  await chat.refreshTransfers();
}

/**
 * 取消一单**按 cid 拉取的内容**（2026-10-25 Stage 4）。
 *
 * 与文件取消同一套口径：`alreadyDone` = 这一单已经收完/早判死（那一下什么都没改）；
 * `ledgerCommitted=false` = 本机停了手但台账没落地，刷新后它可能还挂在列表里 ——
 * 那时说"已取消"就是比事实更满。取消后内容是 `Rejected(Cancelled)` 终态，
 * 建链的自动重取**不会**再把它拉回来。
 */
async function cancelContent(row: OperationRow) {
  const res = await api.cancelContentFetch(row.id);
  await chat.refreshTransfers();
  if (res.alreadyDone || !res.cancelled) {
    app.toast(t("task.contentCancelDone"), "info");
    return;
  }
  if (!res.ledgerCommitted) {
    app.toast(t("transfer.cancelLedgerPending"), "info");
    return;
  }
  app.toast(t("task.contentCancelOk"), "success");
}

/**
 * 取消更新下载（B5）。与文件取消同一句口径："这一单现在算不算被取消了"由后端状态说话：
 * 取消之后立刻补拉 `updater_status` —— 事件也会来，但同一帧里补拉一次能让这一行**当场**
 * 消失/变成已取消，不必等下一帧。
 */
async function cancelUpdate() {
  await api.updaterCancel();
  await chat.refreshUpdaterStatus();
  app.toast(t("task.cancelDone"), "success");
}

/**
 * 跳到那个会话：移动端先翻回聊天那一屏，否则 `openConversation` 换了会话也看不见。
 *
 * 用户 2026-10-25：「任务气泡里的去会话，我也去不了某个会话」。旧实现的硬拦是
 * `conversations/friends/groups` 里必须已经有目标，否则直接 toast —— 而"会话行还没补建"
 * 恰恰是最常见的合法状态。现在分四种情况：
 *  · 会话行已存在（哪怕好友已删）→ 直接打开；
 *  · 单聊、无会话行、但仍是好友 → 由 `openConversation` 里的 `ensureConversation` 补建；
 *  · 单聊、无会话行、且已不是好友 → 明确提示，**不**补建幽灵会话；
 *  · 群、无群且无会话行 → 明确提示（已解散/已退出）。
 * 列表未加载完时不做"不存在"判定，先打开再核对。
 */
async function openConversation(row: OperationRow) {
  const cid = row.convId;
  if (!cid) {
    app.toast(t("task.openChatMissing"), "info");
    return;
  }
  const groupId = cid.startsWith("group:") ? cid.slice("group:".length) : null;
  const seq = ++openSeq;
  const readyNow = () =>
    groupId ? chat.groupsLoaded : chat.conversationsLoaded && chat.friendsLoaded;
  // 列表未加载完时**等**一会儿，而不是拿空数组判“不存在”。超时后仍然尝试打开。
  if (!readyNow()) await waitUntil(readyNow, 3000);
  if (seq !== openSeq) return;
  const convExists = chat.conversations.some((c) => c.id === cid);
  const listsReady = readyNow();
  if (listsReady) {
    if (groupId) {
      if (!convExists && !chat.groups.some((g) => g.id === groupId)) {
        app.toast(t("task.openChatMissing"), "info");
        return;
      }
    } else if (!convExists && !chat.friends.some((f) => f.device_id === cid)) {
      app.toast(t("task.openChatNotFriend"), "info");
      return;
    }
  }
  app.closeTaskCenter();
  if (app.isMobile) app.mobileView = "chat";
  // 打开本身有超时：IPC 不能被真正 abort，但 UI 必须有终态，不能无限转圈。
  const opened = await withTimeout(chat.openConversation(cid), 5000);
  if (seq !== openSeq) return;
  if (opened === "timeout") {
    app.toast(t("task.openChatTimeout"), "info");
    return;
  }
  // 核对"确实打开了"：只看 activeConv 不够（`openConversation` 会先写它），
  // 还要有可高亮的会话行 / 在册群 —— 否则界面看起来就是"点了没反应"。
  const rowVisible = chat.conversations.some((c) => c.id === cid);
  const groupVisible = groupId !== null && chat.groups.some((g) => g.id === groupId);
  if (chat.activeConv !== cid || (!rowVisible && !groupVisible)) {
    app.toast(t("task.openChatFail"), "error");
    return;
  }
  // 尽量定位到任务对应的那条消息（1:1 文件行是 `file-<transfer_id>`，消息行是 msg_id）。
  if (row.locateMsgId) {
    const located = await chat.locateInLoaded(cid, row.locateMsgId);
    if (seq !== openSeq) return;
    if (located === "not-found") app.toast(t("task.locateNotFound"), "info");
    else if (located === "error") app.toast(t("task.locateFail"), "error");
  }
}
</script>

<template>
  <!-- 入口已迁到会话列表页脚（`ConversationList.vue` 的「小院儿」后面），
       这里只剩面板本身：不再有浮动药丸、拖动或四角吸附。
       `data-task-open` 是探针锚点：先证明组件读到的是同一份 store，再判弹窗。 -->
  <div data-task-open :data-open="String(app.taskCenterOpen)">
    <BaseModal :open="app.taskCenterOpen" :title="t('task.title')" width="max-w-md" @close="app.closeTaskCenter()">
    <p v-if="rows.length === 0" class="py-6 text-center text-sm text-[var(--gosslan-text-2)]">
      {{ t("task.empty") }}
    </p>
    <ul v-else class="max-h-[55vh] space-y-2 overflow-y-auto pr-0.5">
      <li
        v-for="row in rows"
        :key="row.id"
        class="rounded-[var(--gosslan-radius-lg)] border border-[var(--gosslan-border)] px-3 py-2"
      >
        <div class="flex items-baseline justify-between gap-3">
          <span class="min-w-0 flex-1 truncate text-sm text-[var(--gosslan-text)]" :title="rowTitle(row)">
            {{ rowTitle(row) }}
          </span>
          <span
            class="shrink-0 text-xs tabular-nums"
            :class="
              row.state === 'blocked'
                ? 'text-[var(--gosslan-warning-ink)]'
                : 'text-[var(--gosslan-text-2)]'
            "
          >
            {{ statusText(row) }}
          </span>
        </div>
        <p
          v-if="rowTarget(row)"
          class="mt-1 truncate text-meta text-[var(--gosslan-text-2)]"
          :title="rowTarget(row)"
        >
          {{ rowTarget(row) }}
        </p>
        <!-- 进度条：读不到总数时画一条**没有刻度的**脉冲条，而不是 0%（把"不知道"
             画成 0% 是谎）。 -->
        <div class="mt-2 h-1 overflow-hidden rounded-full bg-[var(--gosslan-border)]">
          <div
            v-if="row.progress !== null"
            class="h-full origin-left rounded-full bg-[var(--gosslan-primary)] transition-transform duration-200"
            :style="{ transform: `scaleX(${clampProgress(row.progress)})` }"
          />
          <div
            v-else
            class="h-full w-1/3 animate-pulse rounded-full bg-[var(--gosslan-primary)] opacity-50 motion-reduce:animate-none"
          />
        </div>
        <p
          v-if="detailText(row)"
          class="mt-1 text-meta leading-relaxed text-[var(--gosslan-text-2)]"
        >
          {{ detailText(row) }}
        </p>
        <div v-if="row.actions.length > 0" class="mt-2 flex flex-wrap justify-end gap-2">
          <button
            v-for="act in row.actions"
            :key="act"
            type="button"
            class="tap-safe rounded-[var(--gosslan-radius-md)] border px-2.5 py-1 text-meta transition"
            :class="
              act === 'cancel' || act === 'cancel_message' || act === 'cancel_update'
                ? 'border-[var(--gosslan-border)] text-[var(--gosslan-danger-ink)] hover:bg-[var(--gosslan-hover)]'
                : 'border-[var(--gosslan-border)] text-[var(--gosslan-text-2)] hover:bg-[var(--gosslan-hover)]'
            "
            :disabled="busy === `${row.id}|${act}`"
            :aria-label="`${t(actionLabel[act])}：${rowTitle(row)}`"
            @click="runAction(row, act)"
          >
            <span v-if="busy === `${row.id}|${act}`" class="inline-flex items-center gap-1">
              <Spinner size-class="h-3 w-3" decorative />
            </span>
            {{ t(actionLabel[act]) }}
          </button>
        </div>
      </li>
    </ul>
    <p v-if="rows.length > 0" class="mt-3 text-xs leading-relaxed text-[var(--gosslan-text-2)]">
      {{ t("task.note") }}
    </p>
  </BaseModal>
  </div>
</template>
