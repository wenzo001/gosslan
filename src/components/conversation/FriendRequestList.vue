<script setup lang="ts">
import { Check, X } from "lucide-vue-next";
import type { PendingRequest } from "@/types";

defineProps<{
  requests: PendingRequest[];
  /** 由通讯录头部铃铛控制展开/收起。 */
  open: boolean;
}>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "accept", r: PendingRequest): void;
  (e: "reject", r: PendingRequest): void;
}>();

function initials(name: string) {
  return name.slice(0, 1).toUpperCase();
}
</script>

<template>
  <div v-if="open" class="mb-1">
    <div v-if="requests.length" class="rounded-xl">
      <div
        class="flex items-center justify-between px-2 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-[var(--gosslan-text-2)]"
      >
        <span>好友申请</span>
        <button
          class="flex items-center justify-center rounded p-0.5 text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)]"
          title="收起"
          @click="emit('close')"
        >
          <X class="h-3.5 w-3.5" />
        </button>
      </div>
      <div v-for="r in requests" :key="r.from" class="flex h-16 items-center gap-2.5 px-3">
        <div class="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[var(--gosslan-avatar-radius)] bg-primary text-white">
          <img v-if="r.from_avatar" :src="r.from_avatar" class="h-full w-full object-cover" />
          <span v-else class="text-sm font-semibold">{{ initials(r.from_nickname) }}</span>
        </div>
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm font-medium">{{ r.from_nickname }}</div>
          <div class="text-xs text-[var(--gosslan-text-2)]">请求添加你为好友</div>
        </div>
        <button
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--gosslan-avatar-radius)] bg-primary text-white transition hover:bg-primary-hover"
          title="同意"
          @click="emit('accept', r)"
        >
          <Check class="h-4 w-4" />
        </button>
        <button
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--gosslan-border)] text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)]"
          title="拒绝"
          @click="emit('reject', r)"
        >
          <X class="h-4 w-4" />
        </button>
      </div>
    </div>
    <div
      v-else
      class="flex items-center justify-between rounded-xl px-2 py-1.5 text-xs text-[var(--gosslan-text-2)]"
    >
      <span>暂无好友申请</span>
      <button
        class="flex items-center justify-center rounded p-0.5 transition hover:bg-[var(--gosslan-hover)]"
        title="收起"
        @click="emit('close')"
      >
        <X class="h-3.5 w-3.5" />
      </button>
    </div>
  </div>
</template>
