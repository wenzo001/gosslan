<script setup lang="ts">
import Icon from "@/components/ui/Icon.vue";
/**
 * 通讯录「我的机器人」行的右键菜单（用户 2026-11-18）。
 *
 * 只有一项：删除机器人。删除 = 服务端撤销 + 清本地记录 + 删会话（后端 `bot_delete`
 * 一条链路做完），因此走二次确认，与会话/好友删除同一口径（破坏性操作不许单击即删）。
 */
import { DropdownMenuItem } from "reka-ui";
import { t } from "@/i18n";
import ContextMenu from "@/components/ContextMenu.vue";

defineProps<{ x: number; y: number }>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "delete"): void;
}>();
</script>

<template>
  <ContextMenu :x="x" :y="y" @close="emit('close')">
    <DropdownMenuItem class="gosslan-menu-item gosslan-menu-item--danger" @select="emit('delete')">
      <Icon name="trash2" />
      {{ t("bot.action.delete") }}
    </DropdownMenuItem>
    <div class="gosslan-menu-hint">{{ t("bot.contact.deleteHint") }}</div>
  </ContextMenu>
</template>
