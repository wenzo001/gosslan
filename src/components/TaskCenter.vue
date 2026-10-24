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
  runningTextKey,
  type OperationAction,
  type OperationRow,
} from "@/utils/taskCenter";
import { clampProgress } from "@/utils/transferSummary";
import { blockedReasonKey } from "@/utils/transferState";
import { cancelOutcome } from "@/utils/cancelFeedback";
import { storageGet, storageSet } from "@/utils/safeStorage";
import {
  PILL_CORNER_KEY,
  clampDragBox,
  movedFar,
  nearestPillCorner,
  parsePillCorner,
  type PillCorner,
} from "@/utils/pillAnchor";

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
 *   命令；点了什么都不会发生的按钮比不给按钮更糟（消息的取消在 B4，所以消息行今天没有取消键）。
 * - **取消不加二次确认**：这条动作可逆（重新发送即可），而这一轮要的是"打断没有摩擦"。
 *
 * 药丸位置（"它一直挡在右下角，可能挡到发送界面"）：按住可拖，松手吸附到最近的那一角，
 * 四个角的位置持久化在 localStorage。几何判据在 `utils/pillAnchor`（可在 Node 单测）。
 */
const app = useAppStore();
const chat = useChatStore();
const open = ref(false);

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
  if (row.state === "queued") return t("send.queued");
  // `waiting_ack`：字节已经写出去了（所以进度是 100%），但对端还没回执 —— 这一行仍在
  // "未完成"里，状态必须说清是**等确认**，不能只写一个泛泛的"等待中"（用户 2026-10-24：
  // "百分之百的为什么没有过滤掉"）。
  if (row.blockedReason === "waiting_ack") return t("task.state.waitingAck");
  if (row.state === "blocked") return t("task.state.waiting");
  // 读不到 total 时不硬造一个 0%：进度是 null ⇒ 只说"进行中"。
  if (row.progress === null) return t("task.state.running");
  // 进度已到 1 但还没进终态：收尾（落盘 / 校验 / 等回执）。写"100%"会让人以为已经完成。
  if (row.progress >= 1) return t("task.state.finalizing");
  return t(runningTextKey(row.kind), { pct: Math.round(row.progress * 100) });
}

/** 卡在哪一句 + 已经试过几次 + 还差几个人。三件都是"为什么还不动"的答案。 */
function detailText(row: OperationRow): string {
  const parts: string[] = [];
  const key = blockedReasonKey(row.blockedReason);
  if (key) parts.push(t(key));
  if (row.attempts && row.attempts > 0) parts.push(t("task.attempts", { n: row.attempts }));
  if (row.waitingFor && row.waitingFor > 1) parts.push(t("task.waitingFor", { n: row.waitingFor }));
  return parts.join(" · ");
}

const busy = ref<string | null>(null);
const actionLabel: Record<OperationAction, string> = {
  cancel: "task.cancel",
  cancel_message: "task.cancel",
  cancel_update: "task.cancel",
  retry_content: "task.retryNow",
  sync_history_now: "task.syncNow",
  open_conversation: "task.openChat",
};

async function runAction(row: OperationRow, action: OperationAction) {
  if (busy.value) return;
  busy.value = `${row.id}|${action}`;
  try {
    if (action === "cancel") await cancelFile(row);
    else if (action === "cancel_message") await cancelMessage(row);
    else if (action === "cancel_update") await cancelUpdate();
    else if (action === "retry_content") await retryContent(row);
    else if (action === "sync_history_now") await chat.syncGroupHistoryNow(row.id.slice("group:".length));
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
 * 与文件取消不同：这里没有"本机停了、对面还在跑"这种中间态 —— 后端删掉 outbox 行并写
 * `cancelled`，要么成功要么已经送达。`already_delivered` 必须如实说出口，
 * 否则用户点完看到行还没了/还在，只能猜。
 */
async function cancelMessage(row: OperationRow) {
  if (!row.convId) return;
  const res = await api.cancelMessage(row.convId, row.id);
  await chat.refreshTransfers();
  if (res === "already_delivered") {
    app.toast(t("task.cancelMessageDelivered"), "info");
    return;
  }
  app.toast(t("task.cancelDone"), "success");
}

/**
 * 取消一条文件传输（发送与接收都走这条）。
 *
 * 后端返回的是**台账口径**：`alreadyDone` = 它已经到终态了（那一下没改成任何东西）。
 * 在这里说清楚而不是静默刷新 —— 用户点了"取消"却看到行还在，需要知道那是为什么。
 */
async function cancelFile(row: OperationRow) {
  const res = await api.cancelFileTransfer(row.id);
  await chat.refreshTransfers();
  // 四个分支的唯一判据在 `utils/cancelFeedback`（同一个事实同一句话，不在这里另推一遍）。
  switch (cancelOutcome(res)) {
    case "already_done":
      app.toast(t("msg.cancelSend.alreadyDone"), "info");
      break;
    case "ledger_pending":
      // 台账事务回滚：本机确实停了手，但刷新后这一行还会显示在传 —— 界面不许说得比事实更满。
      app.toast(t("transfer.cancelLedgerPending"), "info");
      break;
    case "local_only":
      // 对面没收到通知（老端 / 离线）⇒ 它可能仍在继续：界面不许说得比事实更满。
      app.toast(t("transfer.cancelLocalOnly"), "info");
      break;
    default:
      app.toast(t("task.cancelDone"), "success");
  }
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
 * 为什么要有两道反馈（用户 2026-10-24：「点去会话好像也没有反应」）：
 *  · 行里带的会话身份可能已经不存在（群被解散/退出、成员被删）——`openConversation`
 *    照样会写 `activeConv`，但界面上没有任何那一项可高亮，看起来就是"点了没反应"。
 *    这一类在点之前就问一句，给 toast 而不是静默关面板；
 *  · 切换本身失败（列表还没加载完 / 会话在切换途中消失）——切完再对一次 `activeConv`，
 *    没切过去就报错，而不是让面板关掉了事。
 * ⚠️ 列表还没加载完时不判"不存在"：那时 `conversations/groups` 都是空数组，
 *    拿它判会把刚启动的正常会话误判成已删除。
 */
async function openConversation(row: OperationRow) {
  const cid = row.convId;
  if (!cid) {
    app.toast(t("task.openChatMissing"), "info");
    return;
  }
  const groupId = cid.startsWith("group:") ? cid.slice("group:".length) : null;
  const known = groupId
    ? chat.groups.some((g) => g.id === groupId)
    : chat.conversations.some((c) => c.id === cid) || chat.friends.some((f) => f.device_id === cid);
  const listsReady = groupId ? chat.groupsLoaded : chat.conversationsLoaded || chat.friendsLoaded;
  if (!known && listsReady) {
    app.toast(t("task.openChatMissing"), "info");
    return;
  }
  open.value = false;
  if (app.isMobile) app.mobileView = "chat";
  await chat.openConversation(cid);
  if (chat.activeConv !== cid) {
    app.toast(t("task.openChatFail"), "error");
  }
}

// ---------------- 药丸：按住拖到四个角 ----------------

/** 松手落在哪一角就吸哪一角。四个位置全部从既有 token 推，不新写魔法数：
 *  · 顶部让开「窗口安全区（桌面自绘 caption / 移动端刘海）+ 那一屏的页头」；
 *  · 移动端底部让开 TabBar + 底部安全区（与原来那颗药丸同一条算式）；
 *  · 桌面底部就是原来的 1rem 边距。 */
const cornerClass = computed(() => {
  const x = corner.value.endsWith("l") ? "left-3" : "right-3";
  if (corner.value.startsWith("t")) {
    return `${x} top-[calc(var(--gosslan-safe-top)+var(--gosslan-header-h)+0.5rem)]`;
  }
  return app.isMobile
    ? `${x} bottom-[calc(var(--gosslan-mobile-tabbar-h)+env(safe-area-inset-bottom)+0.75rem)]`
    : `${x} bottom-4`;
});

const corner = ref<PillCorner>(parsePillCorner(storageGet(PILL_CORNER_KEY)));
/** 非 null = 正在跟手，用内联坐标定位（`inset-auto` 先把四边的类名清掉）。 */
const dragBox = ref<{ left: number; top: number } | null>(null);
const dragging = ref(false);

let grab: { x: number; y: number; left: number; top: number; w: number; h: number } | null = null;
/** 拖动收尾那一下浏览器还会补一个 click；用它把"拖完了"和"点开了"分开。 */
let suppressClick = false;

function onPointerDown(e: PointerEvent) {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  const el = e.currentTarget as HTMLElement;
  const r = el.getBoundingClientRect();
  grab = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, w: r.width, h: r.height };
  // 捕获失败（非活跃指针等）只影响跟手性，不影响点开面板，所以不抛。
  try {
    el.setPointerCapture(e.pointerId);
  } catch {
    /* 忽略 */
  }
}

function onPointerMove(e: PointerEvent) {
  if (!grab) return;
  const dx = e.clientX - grab.x;
  const dy = e.clientY - grab.y;
  if (!dragging.value) {
    if (!movedFar(dx, dy)) return;
    dragging.value = true;
  }
  dragBox.value = clampDragBox(grab.left + dx, grab.top + dy, grab.w, grab.h, window.innerWidth, window.innerHeight);
}

function endGrab(e?: PointerEvent) {
  if (!grab) return;
  const el = e?.currentTarget as HTMLElement | undefined;
  try {
    if (el && e) el.releasePointerCapture(e.pointerId);
  } catch {
    /* 忽略：指针已经不在捕获状态 */
  }
  if (dragging.value && e) {
    corner.value = nearestPillCorner(e.clientX, e.clientY, window.innerWidth, window.innerHeight);
    storageSet(PILL_CORNER_KEY, corner.value);
    suppressClick = true;
  }
  grab = null;
  dragging.value = false;
  dragBox.value = null;
}

function onPointerUp(e: PointerEvent) {
  endGrab(e);
}

function onPointerCancel() {
  // 系统抢走手势（来电、滚动接管）⇒ 只放弃拖动，位置不写盘：半途而废不该覆盖上次那个角。
  endGrab();
}

function openPanel() {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  open.value = true;
}
</script>

<template>
  <!--
    药丸本身是入口，也是拖动手柄：<button> 而不是 <div>+click ⇒ 键盘 Tab / 回车原生可用。
    `aria-label` 带数量：读屏用户看不到那颗转圈，但需要知道"还有几件事没办完"。
    `touch-none` 是拖动的前提：不关掉触摸滚动，手指一动就被当成页面滚动，指针事件会断。
    ⚠️ 2026-10-24 用户口径：「进度条小胶囊的占位有点太大了，小小的一个圆形在转就可以了」：
    只留一颗小转圈 + 件数，去掉整句文案与那条通栏进度条（进度进面板里逐行看）。
    尺寸收成 content 宽、单行高 —— 它挡在右下角，越小越好。
  -->
  <button
    v-if="rows.length > 0"
    type="button"
    class="fixed z-40 flex touch-none items-center gap-1.5 rounded-full border border-[var(--gosslan-border)] bg-[var(--gosslan-panel)] px-2.5 py-1.5 text-left shadow-lg select-none"
    :class="[
      dragBox ? 'inset-auto' : cornerClass,
      dragging ? 'scale-[1.03] opacity-90' : 'transition-transform duration-200',
    ]"
    :style="dragBox ? { left: `${dragBox.left}px`, top: `${dragBox.top}px` } : undefined"
    :aria-label="t('task.open', { n: rows.length })"
    :title="`${t('task.pill', { n: rows.length })} · ${t('task.dragHint')}`"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @click="openPanel"
  >
    <Spinner size-class="h-3.5 w-3.5" decorative />
    <span class="text-xs font-semibold leading-none tabular-nums text-[var(--gosslan-text)]">
      {{ rows.length }}
    </span>
  </button>

  <BaseModal :open="open" :title="t('task.title')" width="max-w-md" @close="open = false">
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
</template>
