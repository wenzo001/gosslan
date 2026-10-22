<script setup lang="ts">
/**
 * 统一的二次确认框：标题 + 正文/条目 + 取消/确认（危险动作实底红）。
 *
 * 存在的理由：2026-10-18 盘点发现 10 处 `BaseModal` 各自手写同一套页脚，
 * 尺寸、hover、取消键与危险键顺序逐处重复；这里把「怎么说」留给调用方（默认插槽可覆盖正文），
 * 「怎么确认」收成一份：busy 时两键都禁用，防止重复提交。
 */
import BaseModal from "@/components/BaseModal.vue";
import DangerBtn from "@/components/ui/DangerBtn.vue";
import PrimaryBtn from "@/components/ui/PrimaryBtn.vue";
import { t } from "@/i18n";
import Spinner from "@/components/ui/Spinner.vue";

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    confirmLabel: string;
    body?: string;
    items?: string[];
    note?: string;
    danger?: boolean;
    busy?: boolean;
    busyLabel?: string;
  }>(),
  { body: "", items: () => [], note: "", danger: true, busy: false, busyLabel: "" },
);

const emit = defineEmits<{ (e: "cancel"): void; (e: "confirm"): void }>();

function onCancel() {
  // busy 期间 Esc/返回/✕ 也不许把弹窗关掉：动作还在飞，关掉只会让用户以为取消了。
  if (!props.busy) emit("cancel");
}
</script>

<template>
  <BaseModal :open="open" :title="title" @close="onCancel">
    <div class="space-y-3">
      <slot>
        <p v-if="body" class="text-sm leading-relaxed text-[var(--gosslan-text)]">{{ body }}</p>
        <ul v-if="items.length" class="space-y-1 text-xs text-[var(--gosslan-text-2)]">
          <li v-for="(item, i) in items" :key="i">· {{ item }}</li>
        </ul>
        <p v-if="note" class="text-xs text-[var(--gosslan-text-2)]">{{ note }}</p>
      </slot>
      <div class="flex justify-end gap-2 pt-2">
        <button
          type="button"
          class="tap-safe rounded-[var(--gosslan-radius-md)] px-4 py-1.5 text-sm transition hover:bg-[var(--gosslan-hover)] disabled:opacity-50"
          :disabled="busy"
          @click="onCancel"
        >
          {{ t("common.cancel") }}
        </button>
        <DangerBtn v-if="danger" size="large" :disabled="busy" @click="emit('confirm')">
          <span class="inline-flex items-center gap-1.5">
            <Spinner v-if="busy" size-class="h-4 w-4" decorative />
            {{ busy && busyLabel ? busyLabel : confirmLabel }}
          </span>
        </DangerBtn>
        <PrimaryBtn v-else size="large" :disabled="busy" @click="emit('confirm')">
          <span class="inline-flex items-center gap-1.5">
            <Spinner v-if="busy" size-class="h-4 w-4" decorative />
            {{ busy && busyLabel ? busyLabel : confirmLabel }}
          </span>
        </PrimaryBtn>
      </div>
    </div>
  </BaseModal>
</template>
