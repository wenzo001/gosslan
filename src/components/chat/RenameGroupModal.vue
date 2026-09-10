<script setup lang="ts">
import { ref, watch } from "vue";
import BaseModal from "@/components/BaseModal.vue";

const props = defineProps<{ open: boolean; currentName: string }>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "confirm", name: string): void;
}>();

const name = ref(props.currentName);
watch(
  () => props.open,
  (open) => {
    if (open) name.value = props.currentName;
  },
);
</script>

<template>
  <BaseModal :open="open" title="修改群名称" @close="emit('close')">
    <div class="space-y-3">
      <input
        v-model="name"
        maxlength="30"
        placeholder="请输入群名称"
        class="w-full rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-bg)] px-3 py-2 text-sm outline-none"
        @keydown.enter="name.trim() && emit('confirm', name.trim())"
      />
      <p class="text-xs text-[var(--gosslan-text-2)]">修改后会同步给所有群成员。</p>
      <div class="flex justify-end gap-2 pt-1">
        <button
          class="rounded-[var(--gosslan-radius-md)] px-4 py-1.5 text-sm transition hover:bg-[var(--gosslan-hover)]"
          @click="emit('close')"
        >取消</button>
        <button
          class="rounded-[var(--gosslan-radius-md)] bg-primary px-4 py-1.5 text-sm text-white transition hover:bg-primary-hover disabled:opacity-40"
          :disabled="!name.trim()"
          @click="emit('confirm', name.trim())"
        >保存</button>
      </div>
    </div>
  </BaseModal>
</template>
