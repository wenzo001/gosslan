<script setup lang="ts">
/**
 * 设置 → 第三方接入：已授权的外部应用清单 + 逐项撤销（Phase 2）。
 * 后端只回公钥面（无密钥）；撤销置本地撤销态，服务端解绑仍由 RP 账号页负责。
 */
import { onMounted, ref } from "vue";
import DangerBtn from "@/components/ui/DangerBtn.vue";
import PrimaryBtn from "@/components/ui/PrimaryBtn.vue";
import SecondaryBtn from "@/components/ui/SecondaryBtn.vue";
import { useDeviceAuthStore } from "@/stores/useDeviceAuthStore";
import { useAppStore } from "@/stores/useAppStore";
import { useImeEnterGuard } from "@/composables/useImeEnterGuard";
import { deviceAuthStatusKey } from "@/utils/deviceAuth";
import { t } from "@/i18n";

const store = useDeviceAuthStore();
const app = useAppStore();
const ime = useImeEnterGuard();
const linkDraft = ref("");
const linking = ref(false);
/** 就地二次确认：记住当前等待确认移除的行（rp_origin + client_id），避免误触。 */
const pendingRemove = ref<string | null>(null);

onMounted(() => {
  void store.loadBindings().catch((e) => app.toastError(e, t("deviceAuth.appsLoadFail")));
});

/** 手动粘贴授权链接（浏览器未交接深链时的兜底）；后端校验后弹强制确认页。 */
async function onHandleLink() {
  const url = linkDraft.value.trim();
  if (!url || linking.value) return;
  linking.value = true;
  try {
    await store.handleLink(url);
    linkDraft.value = "";
  } catch (e) {
    app.toastError(e, t("deviceAuth.linkFail"));
  } finally {
    linking.value = false;
  }
}

/**
 * 撤销：本地立即生效，随后尽力通知 RP。
 *
 * 结局要分开说 —— 尤其「本机已撤销、但没通知到对方」：
 * 对方服务端可能还认这把公钥，只说"已撤销"会骗用户以为彻底解绑了。
 *
 * `wasRevoked` = 这一行本来就是撤销态 ⇒ 这是「重发通知」，不是新的撤销。
 */
async function onRevoke(rpOrigin: string, clientId: string, wasRevoked = false) {
  try {
    const out = await store.revoke(rpOrigin, clientId);
    if (!out.revoked) {
      app.toast(t("deviceAuth.revokeNotFound"), "info");
      return;
    }
    if (!out.rpNotified) {
      app.toast(t("deviceAuth.revokeLocalOnly"), "info");
      return;
    }
    app.toast(t(wasRevoked ? "deviceAuth.revokeRenotified" : "deviceAuth.revoked"), "success");
  } catch (e) {
    app.toastError(e, t("deviceAuth.revokeFail"));
  }
}

function removeKey(rpOrigin: string, clientId: string): string {
  return rpOrigin + "\u0000" + clientId;
}

/** 移除：第一次点击进入确认态，第二次点击才真正删除；切换行即取消。 */
async function onRemove(rpOrigin: string, clientId: string) {
  const key = removeKey(rpOrigin, clientId);
  if (pendingRemove.value !== key) {
    pendingRemove.value = key;
    app.toast(t("deviceAuth.removeConfirm"), "info");
    return;
  }
  pendingRemove.value = null;
  try {
    const removed = await store.remove(rpOrigin, clientId);
    app.toast(t(removed ? "deviceAuth.removed" : "deviceAuth.revokeNotFound"), removed ? "success" : "info");
  } catch (e) {
    app.toastError(e, t("deviceAuth.removeFail"));
  }
}

function fmtTime(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString() : "";
}
</script>

<template>
  <section class="space-y-2">
    <div>
      <h3 class="text-body font-medium text-[var(--gosslan-text)]">{{ t("deviceAuth.appsTitle") }}</h3>
      <p class="mt-0.5 text-meta leading-relaxed text-[var(--gosslan-text-2)]">{{ t("deviceAuth.appsHint") }}</p>
    </div>

    <!-- 手动粘贴授权链接：浏览器没有把深链交接给 Gosslan 时的兜底入口。 -->
    <div class="flex items-end gap-2">
      <label class="min-w-0 flex-1">
        <span class="mb-1 block text-caption text-[var(--gosslan-text-2)]">{{ t("deviceAuth.linkLabel") }}</span>
        <input
          v-model="linkDraft"
          type="text"
          class="gosslan-selectable h-10 w-full rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-field-border)] bg-[var(--gosslan-field)] px-3 text-sm outline-none transition focus:border-[var(--gosslan-primary)]"
          :placeholder="t('deviceAuth.linkPlaceholder')"
          @keydown.enter.prevent="ime.enter(onHandleLink, $event)"
          @compositionstart="ime.onStart"
          @compositionend="ime.onEnd"
        />
      </label>
      <PrimaryBtn size="dense" shrink :disabled="linking || !linkDraft.trim()" @click="onHandleLink">
        {{ t("deviceAuth.linkSubmit") }}
      </PrimaryBtn>
    </div>

    <p v-if="!store.bindings.length" class="text-meta text-[var(--gosslan-text-2)]">{{ t("deviceAuth.appsEmpty") }}</p>
    <ul v-else class="space-y-2">
      <li
        v-for="b in store.bindings"
        :key="b.rp_origin + b.client_id"
        class="flex items-center gap-3 rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] px-3 py-2"
      >
        <div class="min-w-0 flex-1">
          <div class="truncate text-meta font-medium text-[var(--gosslan-text)]" :title="b.display_name">{{ b.display_name }}</div>
          <div class="truncate font-mono text-caption text-[var(--gosslan-text-2)]" :title="b.rp_origin">{{ b.rp_origin }}</div>
          <div class="mt-0.5 flex flex-wrap items-center gap-x-2 text-caption text-[var(--gosslan-text-2)]">
            <span :class="b.status === 'active' ? 'text-[var(--gosslan-success-ink)]' : ''">
              {{ t(deviceAuthStatusKey(b.status)) }}
            </span>
            <span v-if="b.last_used_at">{{ t("deviceAuth.lastUsed", { time: fmtTime(b.last_used_at) }) }}</span>
          </div>
        </div>
        <DangerBtn v-if="b.status === 'active'" size="xs" shrink @click="onRevoke(b.rp_origin, b.client_id)">
          {{ t("deviceAuth.revoke") }}
        </DangerBtn>
        <!-- 撤销态也给「重发通知」：第一次通知可能因网络失败没送到，用户需要能补发一次。 -->
        <SecondaryBtn
          v-else-if="b.status === 'revoked'"
          size="xs"
          shrink
          @click="onRevoke(b.rp_origin, b.client_id, true)"
        >
          {{ t("deviceAuth.revokeRenotify") }}
        </SecondaryBtn>
        <!-- 「移除」对**所有状态**可见：中间态/失败态/脏值/撤销态都能彻底结束，
             让每个状态都有出口（active 行也允许直接移除，不经撤销通知）。二次确认防误触。 -->
        <SecondaryBtn
          size="xs"
          shrink
          @click="onRemove(b.rp_origin, b.client_id)"
        >
          {{ pendingRemove === removeKey(b.rp_origin, b.client_id) ? t("deviceAuth.remove") + "?" : t("deviceAuth.remove") }}
        </SecondaryBtn>
      </li>
    </ul>
  </section>
</template>