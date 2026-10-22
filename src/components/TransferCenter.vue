<script setup lang="ts">
import { computed, ref } from "vue";
import BaseModal from "@/components/BaseModal.vue";
import Spinner from "@/components/ui/Spinner.vue";
import { api } from "@/api";
import { t } from "@/i18n";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";
import { blockedReasonKey, transferDisplayKind } from "@/utils/transferState";
import { aggregateTransferProgress, clampProgress, sortLiveTransfers } from "@/utils/transferSummary";
import type { TransferInfo } from "@/types";

/**
 * 全局「正在传输」入口（UI 审计 D-18：该专项最大的空白）。
 *
 * 问题原话是「切到别的会话就完全看不到那个文件还在传」：`chat.transfers` 本来是全局的，
 * 但此前**只被消息气泡按 id 消费** —— 用户一旦离开那条会话，唯一的进度显示就消失了。
 *
 * 设计边界（刻意做小）：
 * - 只在**还有事在做**时出现（`active` / `queued`）。传完之后留一块悬浮物是噪声，
 *   结果已经写在气泡里了。判定与聚合都在 `utils/transferSummary`，这里只负责画。
 * - **不做「点行跳回会话」**：`TransferInfo` 只有 `peer_id`，没有 conv_id。
 *   群文件的 peer 是某个成员，按 peer 跳过去会跳到单聊、或者跳到错误的会话 ——
 *   让用户点了跳到错地方，比不提供这个入口更糟。要做这条得先在后端把 conv 带上。
 * - 桌面右下、移动端压在 TabBar 之上：两处高度都从既有 token 推，不新写魔法数。
 */
const app = useAppStore();
const chat = useChatStore();
const open = ref(false);

const rows = computed(() => sortLiveTransfers(chat.transfers));
const summary = computed(() => aggregateTransferProgress(chat.transfers));

function percentOf(progress: number | undefined | null): number {
  return Math.round(clampProgress(progress) * 100);
}

/**
 * 行内文案复用 `send.sendingPct` / `send.receivingPct` / `send.queued`：
 * 与气泡里说的是同一句话，用户不必学第二套措辞。
 */
function statusText(row: (typeof rows.value)[number]): string {
  if (transferDisplayKind(row.status) === "queued") return t("send.queued");
  return t(row.direction === "send" ? "send.sendingPct" : "send.receivingPct", {
    pct: percentOf(row.progress),
  });
}

/** 排队原因：后端只给稳定短码，未知码不上屏。 */
function blockedText(row: TransferInfo): string {
  const key = blockedReasonKey(row.blocked_reason);
  return key ? t(key) : "";
}

const cancelling = ref<string | null>(null);

/**
 * 取消一条仍在排队/发送中的文件。
 *
 * 复用 `cancel_file_transfer`（它会发在途取消信号、走终态出口并 emit），
 * 即使 `signalled=false` 也会把台账落 cancelled —— 用户按了取消，界面必须响应。
 */
async function cancelRow(row: TransferInfo) {
  if (cancelling.value) return;
  cancelling.value = row.id;
  try {
    await api.cancelFileTransfer(row.id);
    await chat.refreshTransfers();
    app.toast(t("transfer.cancelDone"), "success");
  } catch (e) {
    app.toastError(e, t("transfer.cancelFail"));
  } finally {
    cancelling.value = null;
  }
}
</script>

<template>
  <!--
    药丸本身就是入口：<button> 而不是 <div> + click，键盘 Tab / 回车原生可用。
    `aria-label` 带数量：读屏用户看不到进度条，但需要知道"还有几个"。
  -->
  <button
    v-if="summary.count > 0"
    type="button"
    class="fixed right-3 z-40 flex w-56 max-w-[calc(100vw-1.5rem)] flex-col gap-1.5 rounded-[var(--gosslan-radius-xl)] border border-[var(--gosslan-border)] bg-[var(--gosslan-panel)] px-3 py-2 text-left shadow-lg"
    :class="
      app.isMobile
        ? 'bottom-[calc(var(--gosslan-mobile-tabbar-h)+env(safe-area-inset-bottom)+0.75rem)]'
        : 'bottom-4 right-4'
    "
    :aria-label="t('transfer.open', { n: summary.count })"
    @click="open = true"
  >
    <span class="flex items-center gap-2">
      <Spinner size-class="h-4 w-4" decorative />
      <span class="min-w-0 flex-1 text-xs text-[var(--gosslan-text)]">
        {{ t("transfer.pill", { n: summary.count }) }}
      </span>
      <span class="shrink-0 text-xs font-semibold tabular-nums text-[var(--gosslan-text)]">
        {{ summary.percent }}%
      </span>
    </span>
    <!-- 进度用 scaleX 不用 width：改 width 会触发布局（与 S-5 同一条口径）。 -->
    <span class="block h-1 overflow-hidden rounded-full bg-[var(--gosslan-border)]">
      <span
        class="block h-full origin-left rounded-full bg-[var(--gosslan-primary)] transition-transform duration-200"
        :style="{ transform: `scaleX(${summary.percent / 100})` }"
      />
    </span>
  </button>

  <BaseModal :open="open" :title="t('transfer.title')" width="max-w-md" @close="open = false">
    <p v-if="rows.length === 0" class="py-6 text-center text-sm text-[var(--gosslan-text-2)]">
      {{ t("transfer.empty") }}
    </p>
    <ul v-else class="space-y-2">
      <li
        v-for="row in rows"
        :key="row.id"
        class="rounded-[var(--gosslan-radius-lg)] border border-[var(--gosslan-border)] px-3 py-2"
      >
        <div class="flex items-baseline justify-between gap-3">
          <span class="min-w-0 flex-1 truncate text-sm text-[var(--gosslan-text)]" :title="row.name">
            {{ row.name }}
          </span>
          <span class="shrink-0 text-xs tabular-nums text-[var(--gosslan-text-2)]">
            {{ statusText(row) }}
          </span>
        </div>
        <div class="mt-2 h-1 overflow-hidden rounded-full bg-[var(--gosslan-border)]">
          <div
            class="h-full origin-left rounded-full bg-[var(--gosslan-primary)] transition-transform duration-200"
            :style="{ transform: `scaleX(${clampProgress(row.progress)})` }"
          />
        </div>
        <p v-if="blockedText(row)" class="mt-1 text-meta leading-relaxed text-[var(--gosslan-text-2)]">
          {{ blockedText(row) }}
        </p>
        <div
          v-if="row.direction === 'send' && (row.status === 'pending' || row.status === 'active')"
          class="mt-2 flex justify-end"
        >
          <button
            class="tap-safe rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] px-2.5 py-1 text-meta text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)] disabled:opacity-50"
            :disabled="cancelling === row.id"
            @click="cancelRow(row)"
          >
            {{ t("transfer.cancel") }}
          </button>
        </div>
      </li>
    </ul>
    <p v-if="rows.length > 0" class="mt-3 text-xs text-[var(--gosslan-text-2)]">
      {{ t("transfer.note") }}
    </p>
  </BaseModal>
</template>
