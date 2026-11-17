<!--
  通知机器人创建向导（v6，2026-11-16）。

  两个入口共用本组件：
    · 个人机器人 —— 通讯录「添加」弹窗里的「添加机器人」按钮；
    · 群机器人 —— 群成员面板里的「添加机器人」（只有群主/管理员看得到按钮，
      后端还会再挡一道）。

  ## 「配置简单」是怎么做到的

  外部接入方要的只有三样：endpoint / send token / 发什么。
  前两样由服务端创建时生成、本组件**一次性**展示并可复制（附 curl 示例）；
  用户这里只填：名字 + 中转服务地址 + 服务端级引导令牌（WEBHOOK_CLIENT_TOKEN）。
  群机器人连目标都不用选 —— scope 与目标群由入口传进来。

  ## 边界

  - 创建成功后**立刻**给出 endpoint + token（之后不再回显）⇒ 文案写死提醒复制；
  - 创建失败（连不上 / 权限不足）给可见提示，不静默；
  - 群机器人必须传 groupId，否则不渲染（fail-closed，不猜群）。
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api } from "@/api";
import { useAppStore } from "@/stores/useAppStore";
import { t } from "@/i18n";
import type { BotCreatedView } from "@/types";
import BaseModal from "@/components/BaseModal.vue";
import PrimaryBtn from "@/components/ui/PrimaryBtn.vue";
import SecondaryBtn from "@/components/ui/SecondaryBtn.vue";
import Icon from "@/components/ui/Icon.vue";

const props = withDefaults(
  defineProps<{
    open: boolean;
    /** personal | group */
    scope?: string;
    /** scope=group 时必填 */
    groupId?: string | null;
    groupName?: string | null;
  }>(),
  { scope: "personal", groupId: null, groupName: null },
);
const emit = defineEmits<{
  (e: "close"): void;
  (e: "created", bot: BotCreatedView): void;
}>();

const app = useAppStore();
const name = ref("");
const serverUrl = ref("");
const busy = ref(false);
const created = ref<BotCreatedView | null>(null);
const showToken = ref(true);

const isGroup = computed(() => props.scope === "group");
const canSubmit = computed(
  () =>
    !busy.value &&
    !!name.value.trim() &&
    !!serverUrl.value.trim() &&
    (!isGroup.value || !!props.groupId),
);

/** 切换会话/关闭时清空表单（避免上一次的密钥残留在界面上）。 */
watch(
  () => props.open,
  (v) => {
    if (v) return;
    name.value = "";
    serverUrl.value = "";
    created.value = null;
    showToken.value = true;
    busy.value = false;
  },
);

const endpoint = computed(() => created.value?.endpoint ?? "");
const sendToken = computed(() => created.value?.sendToken ?? "");
const curlExample = computed(() => {
  if (!created.value) return "";
  return (
    `curl -X POST ${endpoint.value} \\\n` +
    `  -H "Authorization: Bearer ${showToken.value ? sendToken.value : "<send-token>"}" \\\n` +
    `  -H "Idempotency-Key: $(uuidgen)" \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '{"text":"hello","format":"markdown"}'`
  );
});

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    app.toast(t("bot.copyDone"), "success");
  } catch (e) {
    app.toastError(e, t("bot.copyFailed"));
  }
}

async function submit() {
  if (!canSubmit.value) return;
  busy.value = true;
  try {
    const result = await api.botCreate({
      name: name.value.trim(),
      scope: isGroup.value ? "group" : "personal",
      targetGroupId: isGroup.value ? props.groupId : null,
      targetGroupName: isGroup.value ? props.groupName : null,
      serverUrl: serverUrl.value.trim(),
      doNotDisturb: false,
    });
    created.value = result;
    emit("created", result);
  } catch (e) {
    app.toastError(e, t("bot.createFailed"));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <BaseModal
    :open="open"
    :title="t(isGroup ? 'bot.wizard.groupTitle' : 'bot.wizard.personalTitle')"
    width="max-w-lg"
    @close="emit('close')"
  >
    <!-- 创建成功：一次性给 endpoint + token + curl -->
    <div v-if="created" class="space-y-3">
      <div class="rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-primary)] bg-[var(--gosslan-panel)] p-[var(--gosslan-card-pad)]">
        <div class="text-title font-medium">{{ t("bot.wizard.doneTitle") }}</div>
        <p class="mt-1 text-meta leading-relaxed text-[var(--gosslan-warning-ink)]">
          {{ t("bot.wizard.onceHint") }}
        </p>
      </div>
      <div>
        <div class="mb-1 text-caption text-[var(--gosslan-text-2)]">{{ t("bot.endpoint") }}</div>
        <div class="flex items-center gap-2">
          <code class="min-w-0 flex-1 break-all rounded-[var(--gosslan-radius-sm)] bg-[var(--gosslan-hover)] px-2 py-1 font-mono text-meta" :title="endpoint">{{ endpoint }}</code>
          <SecondaryBtn size="dense" shrink :aria-label="t('bot.copyEndpoint')" @click="copy(endpoint)">
            <Icon name="copy" class="h-3.5 w-3.5" />
          </SecondaryBtn>
        </div>
      </div>
      <div>
        <div class="mb-1 flex items-center justify-between text-caption text-[var(--gosslan-text-2)]">
          <span>{{ t("bot.secret") }}</span>
          <button type="button" class="text-[var(--gosslan-primary)]" @click="showToken = !showToken">
            {{ showToken ? t("bot.hideToken") : t("bot.showToken") }}
          </button>
        </div>
        <div class="flex items-center gap-2">
          <code class="min-w-0 flex-1 break-all rounded-[var(--gosslan-radius-sm)] bg-[var(--gosslan-hover)] px-2 py-1 font-mono text-meta" :title="sendToken">{{ showToken ? sendToken : "••••••••" }}</code>
          <SecondaryBtn size="dense" shrink :aria-label="t('bot.copySecret')" @click="copy(sendToken)">
            <Icon name="copy" class="h-3.5 w-3.5" />
          </SecondaryBtn>
        </div>
      </div>
      <div>
        <div class="mb-1 text-caption text-[var(--gosslan-text-2)]">{{ t("bot.wizard.curlTitle") }}</div>
        <pre class="overflow-x-auto rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-hover)] p-2 font-mono text-meta leading-relaxed">{{ curlExample }}</pre>
        <SecondaryBtn size="dense" class="mt-1" @click="copy(curlExample)">{{ t("bot.copyCurl") }}</SecondaryBtn>
      </div>
      <div class="flex justify-end gap-2 pt-1">
        <PrimaryBtn @click="emit('close')">{{ t("common.confirm") }}</PrimaryBtn>
      </div>
    </div>

    <!-- 创建表单 -->
    <div v-else class="space-y-3">
      <p class="text-meta leading-relaxed text-[var(--gosslan-text-2)]">{{ t("bot.wizard.intro") }}</p>
      <p class="text-caption text-[var(--gosslan-primary)]">{{ t("bot.wizard.urlOnlyHint") }}</p>
      <div>
        <label class="mb-1 block text-caption text-[var(--gosslan-text-2)]" for="bot-name">{{ t("bot.field.name") }}</label>
        <input
          id="bot-name"
          v-model="name"
          class="h-10 w-full rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-field-border)] bg-[var(--gosslan-field)] px-2.5 text-body outline-none transition focus:border-[var(--gosslan-primary)]"
          :placeholder="t('bot.field.namePlaceholder')"
        />
      </div>
      <div v-if="isGroup" class="text-meta text-[var(--gosslan-text-2)]">
        {{ t("bot.wizard.groupTargetValue", { group: groupName || groupId || "" }) }}
      </div>
      <div>
        <label class="mb-1 block text-caption text-[var(--gosslan-text-2)]" for="bot-server">{{ t("bot.field.server") }}</label>
        <input
          id="bot-server"
          v-model="serverUrl"
          class="h-10 w-full rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-field-border)] bg-[var(--gosslan-field)] px-2.5 text-body outline-none transition focus:border-[var(--gosslan-primary)]"
          :placeholder="t('bot.field.serverPlaceholder')"
        />
      </div>
<div class="flex justify-end gap-2 pt-1">
        <SecondaryBtn @click="emit('close')">{{ t("common.cancel") }}</SecondaryBtn>
        <PrimaryBtn :disabled="!canSubmit" @click="submit">{{ t("bot.create") }}</PrimaryBtn>
      </div>
    </div>
  </BaseModal>
</template>
