<script setup lang="ts">
/**
 * 拖拽发送的确认框（两个落点共用：聊天面板、左侧会话列表）。
 *
 * 只做呈现：要不要弹由 `pending` 决定，正文/条目来自 `useDropSend`（拖进来那一刻冻住的快照）。
 */
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import { t } from "@/i18n";

defineProps<{
  open: boolean;
  body: string;
  items: string[];
}>();
defineEmits<{ (e: "cancel"): void; (e: "confirm"): void }>();
</script>

<template>
  <ConfirmDialog
    :open="open"
    :title="t('chat.dropConfirmTitle')"
    :confirm-label="t('chat.dropConfirmSend')"
    :body="body"
    :items="items"
    :note="t('chat.dropConfirmNote')"
    :danger="false"
    @cancel="$emit('cancel')"
    @confirm="$emit('confirm')"
  />
</template>
