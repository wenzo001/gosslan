<!--
  机器人详情：点会话里的机器人头像 / 群成员列表里的机器人 → 这里。

  看得见：名称 / 作用域 / 中转地址 / 状态 / 最近收到 / 失败数；
  做得到：免打扰开关、暂停/恢复、删除（删除 = 服务端撤销 ⇒ hook 立刻失效）。
  ⚠️ send token **不在这里回显**（只在创建时给一次）；要换就走「撤销后重建」。
-->
<script setup lang="ts">
import { computed } from "vue";
import { api } from "@/api";
import { useAppStore } from "@/stores/useAppStore";
import { t } from "@/i18n";
import type { BotView } from "@/types";
import BaseModal from "@/components/BaseModal.vue";
import SecondaryBtn from "@/components/ui/SecondaryBtn.vue";
import { ref } from "vue";

const props = defineProps<{ open: boolean; bot: BotView | null }>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "deleted", botId: string): void;
  (e: "changed", bot: BotView): void;
}>();

const app = useAppStore();
const pulling = ref(false);
async function pullNow() {
  if (!props.bot || pulling.value) return;
  pulling.value = true;
  try {
    const r = await api.botPullOnce(props.bot.botId);
    app.toast(t("bot.pulled", { n: r.delivered }), "success");
    emit("changed", await api.botSetDnd(props.bot.botId, props.bot.doNotDisturb));
  } catch (e) {
    app.toastError(e, t("bot.pullFailed"));
  } finally {
    pulling.value = false;
  }
}
const statusText = computed(() => {
  switch (props.bot?.status) {
    case "active": return t("bot.status.active");
    case "paused": return t("bot.status.paused");
    case "revoked": return t("bot.status.revoked");
    default: return t("bot.status.unknown"); // 未知状态不假装成已撤销（兜底）
  }
});

function timeText(ms?: number | null): string {
  if (!ms) return t("bot.never");
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

async function setDnd(enabled: boolean) {
  if (!props.bot) return;
  try {
    const next = await api.botSetDnd(props.bot.botId, enabled);
    emit("changed", next);
    app.toast(t(enabled ? "bot.dndOn" : "bot.dndOff"), "success");
  } catch (e) {
    app.toastError(e, t("bot.statusFailed"));
  }
}

async function setStatus(status: "active" | "paused") {
  if (!props.bot) return;
  try {
    const next = await api.botSetStatus(props.bot.botId, status);
    emit("changed", next);
    app.toast(t(status === "paused" ? "bot.paused" : "bot.resumed"), "success");
  } catch (e) {
    app.toastError(e, t("bot.statusFailed"));
  }
}

async function remove() {
  if (!props.bot) return;
  if (!window.confirm(t("bot.deleteConfirm"))) return;
  const id = props.bot.botId;
  try {
    await api.botDelete(id);
    emit("deleted", id);
    app.toast(t("bot.deleted"), "success");
  } catch (e) {
    app.toastError(e, t("bot.deleteFailed"));
  }
}
</script>

<template>
  <BaseModal :open="open" :title="t('bot.detail.title')" width="max-w-md" @close="emit('close')">
    <div v-if="bot" class="space-y-3">
      <div class="rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] bg-[var(--gosslan-panel)] p-[var(--gosslan-card-pad)]">
        <div class="truncate text-title font-medium" :title="bot.name">{{ bot.name }}</div>
        <div class="mt-0.5 truncate text-caption text-[var(--gosslan-text-2)]" :title="`${bot.scope} · ${bot.serverUrl}`">
          {{ bot.scope === "group" ? t("bot.target.group") : t("bot.target.inbox") }} · {{ statusText }}
        </div>
      </div>
      <dl class="space-y-1 text-caption">
        <div class="flex justify-between gap-3">
          <dt class="text-[var(--gosslan-text-2)]">{{ t("bot.field.server") }}</dt>
          <dd class="min-w-0 truncate" :title="bot.serverUrl">{{ bot.serverUrl }}</dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-[var(--gosslan-text-2)]">{{ t("bot.lastEvent") }}</dt>
          <dd>{{ timeText(bot.lastEventAt) }}</dd>
        </div>
        <div v-if="bot.failed" class="flex justify-between gap-3 text-[var(--gosslan-danger-ink)]">
          <dt>{{ t("bot.failedCount", { n: bot.failed }) }}</dt>
        </div>
      </dl>
      <!-- 最近失败原因：没有它用户只知道「没收到」，不知道为什么（审计 P2）。 -->
      <p
        v-if="bot.lastError"
        class="break-words rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-hover)] px-2.5 py-1.5 text-caption text-[var(--gosslan-text-2)]"
        :title="bot.lastError"
      >
        {{ t("bot.lastErrorLine", { err: bot.lastError }) }}
      </p>

      <label class="flex items-center justify-between gap-3 rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] px-3 py-2">
        <span class="text-body">{{ t("bot.dnd") }}</span>
        <input
          type="checkbox"
          :checked="bot.doNotDisturb"
          :aria-label="t('bot.dnd')"
          @change="setDnd(($event.target as HTMLInputElement).checked)"
        />
      </label>

      <div class="flex flex-wrap gap-2">
        <SecondaryBtn v-if="bot.status === 'active'" size="dense" :disabled="pulling" @click="pullNow">{{ t("bot.action.pull") }}</SecondaryBtn>
        <SecondaryBtn v-if="bot.status === 'active'" size="dense" @click="setStatus('paused')">{{ t("bot.action.pause") }}</SecondaryBtn>
        <SecondaryBtn v-else-if="bot.status === 'paused'" size="dense" @click="setStatus('active')">{{ t("bot.action.resume") }}</SecondaryBtn>
        <SecondaryBtn size="dense" class="text-[var(--gosslan-danger-ink)]" @click="remove">{{ t("bot.action.delete") }}</SecondaryBtn>
      </div>
    </div>
  </BaseModal>
</template>
