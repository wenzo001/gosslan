<script setup lang="ts">
import Icon from "@/components/ui/Icon.vue";
import { t } from "@/i18n";
import type { OutgoingFriendRequest, PendingRequest } from "@/types";
import AvatarBox from "@/components/ui/AvatarBox.vue";
import { useNowMs } from "@/utils/nowTick";
import { outgoingRequestExpired } from "@/utils/friendRequests";

defineProps<{
  requests: PendingRequest[];
  /** 我发出的申请（等待对方同意 / 已撤回），同一块区域里按"我发出的"分组。 */
  outgoing: OutgoingFriendRequest[];
  /** 由通讯录头部铃铛控制展开/收起。 */
  open: boolean;
}>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "accept", r: PendingRequest): void;
  (e: "reject", r: PendingRequest): void;
  (e: "cancel", r: OutgoingFriendRequest): void;
  /** J1-3：失效行「重新申请」（后端作废旧申请、换全新 first_at）。 */
  (e: "restart", r: OutgoingFriendRequest): void;
  /** J1-3：移除（本地彻底清掉；已撤回确认行也用它）。 */
  (e: "remove", r: OutgoingFriendRequest): void;
}>();

/** 失效判定的"现在"：共享 tick（TICK_MS 粒度足够，7 天判定不需要更快）。 */
const now = useNowMs();
</script>

<template>
  <div v-if="open" class="mb-1">
    <div v-if="requests.length || outgoing.length" class="rounded-[var(--gosslan-radius-lg)]">
      <!-- 我发出的：等待对方同意（可取消）/ 已撤回（可分已确认/未确认） -->
      <div v-if="outgoing.length" class="mb-1">
        <div class="px-2 pb-1 pt-0.5 text-caption font-medium tracking-wide text-[var(--gosslan-text-2)]">
          {{ t("friend.request.outgoingTitle") }}
        </div>
        <div
          v-for="r in outgoing"
          :key="`out-${r.peer_id}`"
          class="flex h-14 items-center gap-2.5 px-3"
        >
          <AvatarBox class="h-9 w-9 shrink-0" :id="r.peer_id" :src="null" />
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm font-medium" :title="r.nickname">{{ r.nickname }}</div>
            <!-- J1-3（旅程走查 2026-11-20，用户拍板）：waiting 且首申请超 7 天 ⇒ 已失效。
                 判定在 utils/friendRequests（纯函数、可单测）；组件只管渲染。 -->
            <div class="text-xs text-[var(--gosslan-text-2)]">
              {{ r.status === "waiting"
                ? outgoingRequestExpired(r, now)
                  ? t("friend.request.expired")
                  : t("friend.request.waiting")
                : r.withdraw_confirmed
                  ? t("friend.request.withdrawn")
                  : t("friend.request.withdrawnUnconfirmed") }}
            </div>
          </div>
          <!-- 失效行：重新申请（作废旧申请换新 first_at）+ 移除 -->
          <template v-if="r.status === 'waiting' && outgoingRequestExpired(r, now)">
            <button
              class="tap-safe rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-primary-active)] px-2.5 py-1 text-xs font-medium text-[var(--gosslan-on-primary)] transition hover:bg-[var(--gosslan-primary-hover)]"
              @click="emit('restart', r)"
            >
              {{ t("friend.request.resend") }}
            </button>
            <button
              class="tap-safe rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] px-2.5 py-1 text-xs text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)]"
              @click="emit('remove', r)"
            >
              {{ t("friend.request.remove") }}
            </button>
          </template>
          <button
            v-else-if="r.status === 'waiting'"
            class="tap-safe rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] px-2.5 py-1 text-xs text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)]"
            @click="emit('cancel', r)"
          >
            {{ t("friend.request.cancel") }}
          </button>
          <!-- 已撤回（对端已确认）：这条申请已了结，给一个「移除」让用户清掉残行 -->
          <button
            v-else-if="r.withdraw_confirmed"
            class="tap-safe rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] px-2.5 py-1 text-xs text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)]"
            @click="emit('remove', r)"
          >
            {{ t("friend.request.remove") }}
          </button>
        </div>
      </div>
      <div
        class="flex items-center justify-between px-2 pb-1 pt-0.5 text-caption font-medium tracking-wide text-[var(--gosslan-text-2)]"
      >
        <span>{{ t("friend.request.title") }}</span>
        <button
          class="tap-safe flex items-center justify-center rounded-[var(--gosslan-radius-xs)] p-0.5 text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)]"
          :title="t('common.collapse')" :aria-label="t('common.collapse')"
          @click="emit('close')"
        >
          <Icon name="x" class="h-3.5 w-3.5" />
        </button>
      </div>
      <div v-for="r in requests" :key="r.from" class="flex h-16 items-center gap-2.5 px-3">
        <AvatarBox class="h-10 w-10 shrink-0" :id="r.from" :src="r.from_avatar" />
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm font-medium" :title="r.from_nickname">{{ r.from_nickname }}</div>
          <div class="text-xs text-[var(--gosslan-text-2)]">{{ t("friend.request.wantsToAdd") }}</div>
        </div>
        <button
          class="tap-safe flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--gosslan-avatar-radius)] bg-[var(--gosslan-primary-active)] text-[var(--gosslan-on-primary)] transition hover:bg-[var(--gosslan-primary-hover)]"
          :title="t('common.agree')" :aria-label="t('common.agree')"
          @click="emit('accept', r)"
        >
          <Icon name="check" class="h-4 w-4" />
        </button>
        <button
          class="tap-safe flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--gosslan-border)] text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)]"
          :title="t('common.reject')" :aria-label="t('common.reject')"
          @click="emit('reject', r)"
        >
          <Icon name="x" class="h-4 w-4" />
        </button>
      </div>
    </div>
    <div
      v-else
      class="flex items-center justify-between rounded-[var(--gosslan-radius-lg)] px-2 py-1.5 text-xs text-[var(--gosslan-text-2)]"
    >
      <span>{{ t("friend.request.empty") }}</span>
      <button
        class="flex items-center justify-center rounded-[var(--gosslan-radius-xs)] p-0.5 transition hover:bg-[var(--gosslan-hover)]"
        :title="t('common.collapse')" :aria-label="t('common.collapse')"
        @click="emit('close')"
      >
        <Icon name="x" class="h-3.5 w-3.5" />
      </button>
    </div>
  </div>
</template>
