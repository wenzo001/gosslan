<!--
  机器人详情：点会话里的机器人头像 / 群成员列表里的机器人 → 这里。

  看得见：名称 / 作用域 / 中转地址 / 状态 / 最近收到 / 失败数；
  做得到：免打扰开关、暂停/恢复、删除（删除 = 服务端撤销 ⇒ hook 立刻失效）。
  ℹ️ 发送链接（含 send token）在这里可随时复制 —— 它本就是给第三方 curl 用的入口，不是只能看一次的秘密；要换 token 走「撤销后重建」。
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api } from "@/api";
import { useAppStore } from "@/stores/useAppStore";
import { t } from "@/i18n";
import { MAX_BOT_NAME_CHARS } from "@/utils/validation";
import CharCounter from "@/components/ui/CharCounter.vue";
import type { BotView } from "@/types";
import BaseModal from "@/components/BaseModal.vue";
import SecondaryBtn from "@/components/ui/SecondaryBtn.vue";
import PrimaryBtn from "@/components/ui/PrimaryBtn.vue";
import AvatarBox from "@/components/ui/AvatarBox.vue";
import AvatarPresetDialog from "@/components/settings/AvatarPresetDialog.vue";
import {
  AVATAR_PAIRS,
  avatarPresetDataUrl,
  avatarSeedFor,
  parseAvatarPreset,
  type AvatarSeed,
} from "@/utils/avatarSeed";

const props = defineProps<{ open: boolean; bot: BotView | null }>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "deleted", botId: string): void;
  (e: "changed", bot: BotView): void;
}>();

const app = useAppStore();

/** 旧机器人创建时没存 publish_url ⇒ 打开详情时按 client_token 向服务端取回。 */
const fetchedUrl = ref("");
const publishUrl = computed(() => props.bot?.publishUrl || fetchedUrl.value);
/** 双保险：Tauri WebView 里 navigator.clipboard 常被拒 ⇒ 失败就走 textarea + execCommand。 */
async function copy(text: string) {
  let ok = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch { /* 落到下面的回退 */ }
  if (!ok) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    document.body.removeChild(ta);
  }
  if (ok) app.toast(t("bot.copyDone"), "success");
  else app.toastError(new Error("clipboard unavailable"), t("bot.copyFailed"));
}

// 用户可编辑名字 / 头像（2026-11-17）：名字落 BotRecord，头像落 SVG data URL；
// 个人机器人的会话行同步更新，列表里立刻看得见。
const editing = ref(false);
const editName = ref("");
const editAvatar = ref<string | null>(null);
const editServerUrl = ref("");
const avatarDialogOpen = ref(false);
const savingProfile = ref(false);
watch(
  () => props.bot,
  (b) => {
    editing.value = false;
    editName.value = b?.name ?? "";
    editAvatar.value = b?.avatar ?? null;
    editServerUrl.value = b?.serverUrl ?? "";
    fetchedUrl.value = "";
    if (b && !b.publishUrl) {
      void api.botGetPublishUrl(b.botId).then((u) => { fetchedUrl.value = u; }).catch((e) => {
        // 取不回要明确告诉用户（此前静默空白 ⇒ 用户以为没有发送链接）；失败仍保留空白，不假装成功。
        app.toastError(e, t("bot.pullUrlFailed"));
      });
    }
  },
  { immediate: true },
);
function currentSeed(): AvatarSeed {
  return (
    parseAvatarPreset(editAvatar.value) ??
    avatarSeedFor(props.bot?.botId ?? null) ??
    AVATAR_PAIRS[0]
  );
}
function applyAvatar(seed: AvatarSeed) {
  editAvatar.value = avatarPresetDataUrl(seed);
  avatarDialogOpen.value = false;
}
async function saveProfile() {
  if (!props.bot || savingProfile.value) return;
  savingProfile.value = true;
  try {
    const updated = await api.botSetProfile(
      props.bot.botId,
      editName.value,
      editAvatar.value,
      editServerUrl.value.trim() || null,
    );
    emit("changed", updated);
    editing.value = false;
    app.toast(t("bot.profileSaved"), "success");
  } catch (e) {
    app.toastError(e, t("bot.profileFailed"));
  } finally {
    savingProfile.value = false;
  }
}

const pulling = ref(false);
async function pullNow() {
  if (!props.bot || pulling.value) return;
  pulling.value = true;
  try {
    const r = await api.botPullOnce(props.bot.botId);
    app.toast(t("bot.pulled", { n: r.delivered }), "success");
    // 刷新视图（借 botSetDnd 回读 BotView）失败不该把「取件成功」报成「取件失败」：
    // 取件已经完成，刷新只影响计数显示，单独兜住。
    try {
      emit("changed", await api.botSetDnd(props.bot.botId, props.bot.doNotDisturb));
    } catch { /* 视图刷新失败：下次打开详情会重新读到，不影响已取到的消息 */ }
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
      <div class="flex items-center gap-3">
        <AvatarBox class="h-12 w-12 shrink-0 ring-2 ring-[var(--gosslan-primary)]" :id="`bot:${bot.botId}`" :src="bot.avatar" />
        <div class="min-w-0 flex-1">
          <div class="truncate text-title font-medium" :title="bot.name">{{ bot.name }}</div>
          <div class="mt-0.5 truncate text-caption text-[var(--gosslan-text-2)]" :title="`${bot.scope} · ${bot.serverUrl}`">
            {{ bot.scope === "group" ? t("bot.target.group") : t("bot.target.inbox") }} · {{ statusText }}
          </div>
        </div>
        <SecondaryBtn v-if="!editing" size="dense" @click="editing = true">{{ t("bot.action.editProfile") }}</SecondaryBtn>
      </div>
      <!-- 唯一 ID：创建时生成、之后不可改（改名/头像/地址都不动它）—— 会话与去重都靠它。 -->
      <div class="mt-3 space-y-1.5 border-t border-[var(--gosslan-divider)] pt-2">
        <div class="flex flex-nowrap items-center gap-2">
          <code class="min-w-0 flex-1 select-text truncate font-mono text-caption" :title="bot.botId">{{ t("bot.idLine", { id: bot.botId }) }}</code>
          <SecondaryBtn size="dense" shrink :aria-label="t('bot.copyEndpoint')" @click="copy(bot.botId)">{{ t("bot.copyShort") }}</SecondaryBtn>
        </div>
        <div class="flex flex-nowrap items-center gap-2">
          <code class="min-w-0 flex-1 truncate font-mono text-meta text-[var(--gosslan-text-2)]" :title="publishUrl">{{ publishUrl }}</code>
          <SecondaryBtn size="dense" shrink :aria-label="t('bot.copyEndpoint')" @click="copy(publishUrl)">{{ t("bot.copyShort") }}</SecondaryBtn>
        </div>
      </div>
      </div>

      <!-- 名字 / 头像编辑（用户 2026-11-17）：不改 server / token，不涉及线格式。 -->
      <div v-if="editing" class="space-y-2 rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] p-[var(--gosslan-card-pad)]">
        <label class="block">
          <span class="text-caption text-[var(--gosslan-text-2)]">{{ t("bot.field.name") }}</span>
          <input
            v-model="editName"
            type="text"
            :maxlength="MAX_BOT_NAME_CHARS"
            class="mt-1 h-10 w-full rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] bg-[var(--gosslan-bg)] px-3 text-body text-[var(--gosslan-text)]"
            :aria-label="t('bot.field.name')"
          />
          <CharCounter :text="editName" :max="MAX_BOT_NAME_CHARS" />
        </label>
        <label class="block">
          <span class="text-caption text-[var(--gosslan-text-2)]">{{ t("bot.field.server") }}</span>
          <input
            v-model="editServerUrl"
            type="url"
            class="mt-1 h-10 w-full rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] bg-[var(--gosslan-bg)] px-3 text-body text-[var(--gosslan-text)]"
            :aria-label="t('bot.field.server')"
          />
        </label>
        <div class="flex items-center gap-2">
          <AvatarBox class="h-10 w-10 shrink-0" :id="`bot:${bot.botId}`" :src="editAvatar" />
          <SecondaryBtn size="dense" @click="avatarDialogOpen = true">{{ t("bot.action.pickAvatar") }}</SecondaryBtn>
        </div>
        <div class="flex flex-wrap gap-2">
          <PrimaryBtn size="dense" :disabled="savingProfile || !editName.trim()" @click="saveProfile">{{ t("common.save") }}</PrimaryBtn>
          <SecondaryBtn size="dense" @click="editing = false">{{ t("common.cancel") }}</SecondaryBtn>
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
    <AvatarPresetDialog
      :open="avatarDialogOpen"
      :initial="currentSeed()"
      @close="avatarDialogOpen = false"
      @apply="applyAvatar"
    />
  </BaseModal>
</template>
