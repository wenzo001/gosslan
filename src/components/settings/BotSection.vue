<script setup lang="ts">
/**
 * 设置 › 通知机器人（Webhook bot）：管理外部系统 → 本机的通知入口。
 *
 * ## 用户心智
 *
 * 「机器人」= 一个**外部消息入口**：外部系统拿 endpoint + 密钥，往这儿 POST 文字/图片，
 * 就进了「我的网络」。它不是 AI，也不代表外部发送者有 Gosslan 账号。
 *
 * ## 三条边界（别在实现里走样）
 *
 * 1. **发送密钥只显示一次**（创建那一刻）⇒ 列表里不再回显；
 * 2. **投递目标**只两种：本机收件箱 / 某个群（由本机代发；群成员**不必**连通知服务）；
 * 3. 撤销**不可逆** ⇒ 界面要说清。
 */
import { computed, onMounted, ref } from "vue";
import SettingsGroup from "@/components/settings/SettingsGroup.vue";
import PrimaryBtn from "@/components/ui/PrimaryBtn.vue";
import SecondaryBtn from "@/components/ui/SecondaryBtn.vue";
import StateBlock from "@/components/ui/StateBlock.vue";
import Icon from "@/components/ui/Icon.vue";
import { useQuery } from "@tanstack/vue-query";
import { api } from "@/api";
import { panelQueryOptions } from "@/utils/panelQuery";
import SettingsSelect from "@/components/ui/SettingsSelect.vue";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";
import { t } from "@/i18n";
import { renderBotMessage } from "@/utils/botMessage";
import type { BotCreatedView, BotInboxEntry, BotView } from "@/types";

const app = useAppStore();
const chat = useChatStore();

// 读侧交给 Query（策略见 `utils/panelQuery`）：机器人清单是**纯读快照**，
// 手写 loading/error 三件套只会被判据当成「又一份抄本」。
const botsQuery = useQuery(
  panelQueryOptions<BotView[]>("bots", "", () => api.botList()),
);
const bots = computed<BotView[]>(() => botsQuery.data.value ?? []);
const loading = computed(() => botsQuery.isFetching.value);
const loadError = computed<string | null>(() => {
  const e = botsQuery.error.value;
  return e ? String((e as Error)?.message ?? e) : null;
});
/** 写操作在飞（创建/暂停/删除/取件）。 */
const busy = ref(false);

/** 创建表单 */
const name = ref("");
const targetKind = ref<"inbox" | "group">("inbox");
const targetGroupId = ref("");
const serverUrl = ref("");
const clientToken = ref("");

/** 创建成功后的一次性展示（密钥只在这里出现） */
const created = ref<BotCreatedView | null>(null);
const inbox = ref<BotInboxEntry[]>([]);
const inboxBotId = ref<string | null>(null);

const groups = computed(() => chat.groups ?? []);
/** 空选项的提示文案（放在脚本里：i18n 守卫的「引用面」按脚本里的 t() 调用统计）。 */
const groupPlaceholder = t("bot.field.groupPlaceholder");

const targetOptions = computed(() => [
  { value: "inbox", label: t("bot.target.inbox") },
  { value: "group", label: t("bot.target.group") },
]);
const groupOptions = computed(() => [
  { value: "", label: groupPlaceholder },
  ...groups.value.map((g) => ({ value: g.id, label: g.name })),
]);

function onTargetPicked(v: unknown) {
  targetKind.value = v === "group" ? "group" : "inbox";
}
function onGroupPicked(v: unknown) {
  targetGroupId.value = String(v ?? "");
}

/** 重新拉清单（写操作之后）。 */
async function reload() {
  await botsQuery.refetch();
}

onMounted(() => {
  void botsQuery.refetch();
});

async function create() {
  if (busy.value) return;
  busy.value = true;
  try {
    created.value = await api.botCreate({
      name: name.value.trim(),
      targetKind: targetKind.value,
      targetGroupId: targetKind.value === "group" ? targetGroupId.value : null,
      targetGroupName:
        targetKind.value === "group"
          ? groups.value.find((g) => g.id === targetGroupId.value)?.name ?? null
          : null,
      serverUrl: serverUrl.value.trim(),
      clientToken: clientToken.value.trim(),
    });
    // 表单清空（密钥不在表单里留痕）。
    name.value = "";
    clientToken.value = "";
    serverUrl.value = "";
    await reload();
  } catch (e) {
    app.toastError(e, t("bot.createFailed"));
  } finally {
    busy.value = false;
  }
}

async function setStatus(bot: BotView, status: string) {
  if (busy.value) return;
  busy.value = true;
  try {
    await api.botSetStatus(bot.botId, status);
    app.toast(t(status === "paused" ? "bot.paused" : "bot.resumed"), "success");
    await reload();
  } catch (e) {
    app.toastError(e, t("bot.statusFailed"));
  } finally {
    busy.value = false;
  }
}

async function remove(bot: BotView) {
  if (busy.value) return;
  busy.value = true;
  try {
    await api.botDelete(bot.botId);
    if (inboxBotId.value === bot.botId) inboxBotId.value = null;
    app.toast(t("bot.deleted"), "success");
    await reload();
  } catch (e) {
    app.toastError(e, t("bot.deleteFailed"));
  } finally {
    busy.value = false;
  }
}

async function pull(bot: BotView) {
  if (busy.value) return;
  busy.value = true;
  try {
    const r = await api.botPullOnce(bot.botId);
    app.toast(t("bot.pulled", { n: r.delivered }), "success");
    if (inboxBotId.value === bot.botId) await loadInbox(bot.botId);
    await reload();
  } catch (e) {
    app.toastError(e, t("bot.pullFailed"));
  } finally {
    busy.value = false;
  }
}

async function openInbox(bot: BotView) {
  inboxBotId.value = bot.botId;
  await loadInbox(bot.botId);
}

async function loadInbox(botId: string) {
  try {
    inbox.value = await api.botInbox(botId);
  } catch (e) {
    app.toastError(e, t("bot.inboxFailed"));
  }
}

function targetLabel(bot: BotView): string {
  if (bot.target.kind === "group") {
    return bot.target.groupName || bot.target.groupId || t("bot.target.group");
  }
  return t("bot.target.inbox");
}

function statusLabel(bot: BotView): string {
  if (bot.status === "paused") return t("bot.status.paused");
  if (bot.status === "revoked") return t("bot.status.revoked");
  return t("bot.status.active");
}

function timeText(ts?: number | null): string {
  if (!ts) return t("bot.never");
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 复制 endpoint / 密钥 / curl 示例。 */
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    app.toast(t("common.copied"), "success");
  } catch (e) {
    app.toastError(e, t("bot.copyFailed"));
  }
}

function curlExample(): string {
  if (!created.value) return "";
  return `curl -X POST ${created.value.endpoint} \\\n  -H "Authorization: Bearer <发送密钥>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"text":"构建完成 ✅"}'`;
}
</script>

<template>
  <SettingsGroup :title="t('bot.title')" :footer="t('bot.footer')">
    <!-- 隐私说明：通知服务会看到明文并暂存 —— 放在最显眼处。 -->
    <p class="mb-2 text-meta leading-relaxed text-[var(--gosslan-text-2)]">
      {{ t("bot.privacy") }}
    </p>

    <!-- 列表 -->
    <div v-if="loading" class="py-2 text-center text-caption text-[var(--gosslan-text-2)]">
      {{ t("bot.loading") }}
    </div>
    <StateBlock
      v-else-if="loadError"
      kind="error"
      compact
      :title="loadError"
      :retry-label="t('common.retry')"
      @retry="reload"
    />
    <p v-else-if="bots.length === 0" class="py-2 text-center text-caption text-[var(--gosslan-text-2)]">
      {{ t("bot.empty") }}
    </p>
    <ul v-else class="mb-3 flex flex-col gap-2">
      <li
        v-for="bot in bots"
        :key="bot.botId"
        class="rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] bg-[var(--gosslan-panel)] px-3 py-2"
      >
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="truncate text-body font-medium" :title="bot.name">{{ bot.name }}</div>
            <div
              class="truncate text-caption text-[var(--gosslan-text-2)]"
              :title="`${targetLabel(bot)} · ${statusLabel(bot)} · ${t('bot.lastEvent', { time: timeText(bot.lastEventAt) })}`"
            >
              {{ targetLabel(bot) }} · {{ statusLabel(bot) }} · {{ t("bot.lastEvent", { time: timeText(bot.lastEventAt) }) }}
            </div>
            <div
              v-if="bot.failed"
              class="truncate text-caption text-[var(--gosslan-danger-ink)]"
              :title="t('bot.failedCount', { n: bot.failed })"
            >
              {{ t("bot.failedCount", { n: bot.failed }) }}
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <button
              type="button"
              class="tap-safe flex h-8 w-8 items-center justify-center rounded-[var(--gosslan-radius-md)] text-[var(--gosslan-text-2)] hover:bg-[var(--gosslan-hover)]"
              :aria-label="t('bot.action.inbox')"
              :title="t('bot.action.inbox')"
              @click="openInbox(bot)"
            >
              <Icon name="message-square" class="h-4 w-4" />
            </button>
            <button
              type="button"
              class="tap-safe flex h-8 w-8 items-center justify-center rounded-[var(--gosslan-radius-md)] text-[var(--gosslan-text-2)] hover:bg-[var(--gosslan-hover)]"
              :aria-label="t('bot.action.pull')"
              :title="t('bot.action.pull')"
              :disabled="busy"
              @click="pull(bot)"
            >
              <Icon name="refresh-cw" class="h-4 w-4" />
            </button>
            <button
              v-if="bot.status === 'active'"
              type="button"
              class="tap-safe flex h-8 w-8 items-center justify-center rounded-[var(--gosslan-radius-md)] text-[var(--gosslan-text-2)] hover:bg-[var(--gosslan-hover)]"
              :aria-label="t('bot.action.pause')"
              :title="t('bot.action.pause')"
              :disabled="busy"
              @click="setStatus(bot, 'paused')"
            >
              <Icon name="stop-circle" class="h-4 w-4" />
            </button>
            <button
              v-else-if="bot.status === 'paused'"
              type="button"
              class="tap-safe flex h-8 w-8 items-center justify-center rounded-[var(--gosslan-radius-md)] text-[var(--gosslan-text-2)] hover:bg-[var(--gosslan-hover)]"
              :aria-label="t('bot.action.resume')"
              :title="t('bot.action.resume')"
              :disabled="busy"
              @click="setStatus(bot, 'active')"
            >
              <Icon name="check-circle2" class="h-4 w-4" />
            </button>
            <button
              type="button"
              class="tap-safe flex h-8 w-8 items-center justify-center rounded-[var(--gosslan-radius-md)] text-[var(--gosslan-danger-ink)] hover:bg-[var(--gosslan-hover)]"
              :aria-label="t('bot.action.delete')"
              :title="t('bot.action.delete')"
              :disabled="busy"
              @click="remove(bot)"
            >
              <Icon name="trash2" class="h-4 w-4" />
            </button>
          </div>
        </div>
      </li>
    </ul>

    <!-- 收件箱 -->
    <div v-if="inboxBotId" class="mb-3 rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] bg-[var(--gosslan-panel)] p-[var(--gosslan-card-pad)]">
      <div class="mb-2 flex items-center justify-between">
        <span class="text-body font-medium">{{ t("bot.inboxTitle") }}</span>
        <button
          type="button"
          class="tap-safe flex h-8 w-8 items-center justify-center rounded-[var(--gosslan-radius-md)] text-[var(--gosslan-text-2)] hover:bg-[var(--gosslan-hover)]"
          :aria-label="t('common.close')"
          @click="inboxBotId = null"
        >
          <Icon name="x" class="h-4 w-4" />
        </button>
      </div>
      <p v-if="inbox.length === 0" class="py-2 text-center text-caption text-[var(--gosslan-text-2)]">
        {{ t("bot.inboxEmpty") }}
      </p>
      <ul v-else class="flex flex-col gap-2">
        <li
          v-for="m in inbox"
          :key="m.eventId"
          class="rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-hover)] px-2.5 py-2"
        >
          <!-- 正文：纯文本按纯文本显示；Markdown 按 Markdown 渲染（外部内容，已消毒）。 -->
          <div
            v-if="m.format === 'markdown'"
            class="prose-invert max-w-full break-words text-body"
            v-html="renderBotMessage(m.text, 'markdown')"
          ></div>
          <p v-else class="whitespace-pre-wrap break-words text-body">{{ m.text }}</p>
          <div class="mt-1 flex items-center gap-2 text-caption text-[var(--gosslan-text-2)]">
            <span v-if="m.source" class="truncate" :title="m.source">{{ m.source }}</span>
            <span>{{ timeText(m.receivedAt) }}</span>
          </div>
        </li>
      </ul>
    </div>

    <!-- 创建后的一次性密钥展示 -->
    <div
      v-if="created"
      class="mb-3 rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-primary)] bg-[var(--gosslan-panel)] p-[var(--gosslan-card-pad)]"
    >
      <div class="mb-1 text-body font-medium">{{ t("bot.createdTitle") }}</div>
      <p class="mb-2 text-meta leading-relaxed text-[var(--gosslan-text-2)]">
        {{ t("bot.createdHint") }}
      </p>
      <div class="mb-1 text-caption text-[var(--gosslan-text-2)]">{{ t("bot.endpoint") }}</div>
      <div class="mb-2 flex items-center gap-2">
        <code class="min-w-0 flex-1 truncate rounded-[var(--gosslan-radius-sm)] bg-[var(--gosslan-hover)] px-2 py-1 font-mono text-meta" :title="created.endpoint">
          {{ created.endpoint }}
        </code>
        <SecondaryBtn size="dense" @click="copy(created.endpoint)">{{ t("common.copy") }}</SecondaryBtn>
      </div>
      <div class="mb-1 text-caption text-[var(--gosslan-text-2)]">{{ t("bot.secret") }}</div>
      <div class="mb-2 flex items-center gap-2">
        <code class="min-w-0 flex-1 truncate rounded-[var(--gosslan-radius-sm)] bg-[var(--gosslan-hover)] px-2 py-1 font-mono text-meta" :title="created.sendSecret">
          {{ created.sendSecret }}
        </code>
        <SecondaryBtn size="dense" @click="copy(created.sendSecret)">{{ t("common.copy") }}</SecondaryBtn>
      </div>
      <pre class="mb-2 overflow-x-auto rounded-[var(--gosslan-radius-sm)] bg-[var(--gosslan-hover)] p-2 font-mono text-meta">{{ curlExample() }}</pre>
      <SecondaryBtn size="dense" @click="copy(curlExample())">{{ t("bot.copyCurl") }}</SecondaryBtn>
    </div>

    <!-- 创建表单 -->
    <div class="flex flex-col gap-2">
      <label class="text-caption text-[var(--gosslan-text-2)]" for="bot-name">{{ t("bot.field.name") }}</label>
      <input
        id="bot-name"
        v-model="name"
        class="h-9 w-full rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-field-border)] bg-[var(--gosslan-panel)] px-2.5 text-body outline-none focus:border-[var(--gosslan-primary)]"
        :placeholder="t('bot.field.namePlaceholder')"
      />

      <label class="text-caption text-[var(--gosslan-text-2)]" for="bot-target">{{ t("bot.field.target") }}</label>
      <SettingsSelect
        :model-value="targetKind"
        :options="targetOptions"
        :select-label="t('bot.field.target')"
        trigger-class="w-full"
        @update:model-value="onTargetPicked"
      />

      <template v-if="targetKind === 'group'">
        <label class="text-caption text-[var(--gosslan-text-2)]" for="bot-group">{{ t("bot.field.group") }}</label>
        <SettingsSelect
          :model-value="targetGroupId"
          :options="groupOptions"
          :select-label="t('bot.field.group')"
          trigger-class="w-full"
          @update:model-value="onGroupPicked"
        />
      </template>

      <label class="text-caption text-[var(--gosslan-text-2)]" for="bot-server">{{ t("bot.field.server") }}</label>
      <input
        id="bot-server"
        v-model="serverUrl"
        class="h-9 w-full rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-field-border)] bg-[var(--gosslan-panel)] px-2.5 font-mono text-body outline-none focus:border-[var(--gosslan-primary)]"
        :placeholder="t('bot.field.serverPlaceholder')"
      />

      <label class="text-caption text-[var(--gosslan-text-2)]" for="bot-token">{{ t("bot.field.token") }}</label>
      <input
        id="bot-token"
        v-model="clientToken"
        type="password"
        autocomplete="off"
        class="h-9 w-full rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-field-border)] bg-[var(--gosslan-panel)] px-2.5 font-mono text-body outline-none focus:border-[var(--gosslan-primary)]"
        :placeholder="t('bot.field.tokenPlaceholder')"
      />

      <PrimaryBtn :disabled="busy" @click="create">{{ t("bot.create") }}</PrimaryBtn>
    </div>
  </SettingsGroup>
</template>
