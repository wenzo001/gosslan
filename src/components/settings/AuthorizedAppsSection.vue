<script setup lang="ts">
/**
 * 设置 → 安全：已授权的外部应用清单 + 逐项撤销（Phase 2）。
 * 后端只回公钥面（无密钥）；撤销置本地撤销态，服务端解绑仍由 RP 账号页负责。
 */
import { onMounted, ref } from "vue";
import DangerBtn from "@/components/ui/DangerBtn.vue";
import PrimaryBtn from "@/components/ui/PrimaryBtn.vue";
import { useDeviceAuthStore } from "@/stores/useDeviceAuthStore";
import { useAppStore } from "@/stores/useAppStore";
import { useImeEnterGuard } from "@/composables/useImeEnterGuard";
import { t } from "@/i18n";

const store = useDeviceAuthStore();
const app = useAppStore();
const ime = useImeEnterGuard();
const linkDraft = ref("");
const linking = ref(false);

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

async function onRevoke(rpOrigin: string, clientId: string) {
  try {
    await store.revoke(rpOrigin, clientId);
    app.toast(t("deviceAuth.revoked"), "success");
  } catch (e) {
    app.toastError(e, t("deviceAuth.revokeFail"));
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
              {{ b.status === "active" ? t("deviceAuth.statusActive") : t("deviceAuth.statusRevoked") }}
            </span>
            <span v-if="b.last_used_at">{{ t("deviceAuth.lastUsed", { time: fmtTime(b.last_used_at) }) }}</span>
          </div>
        </div>
        <DangerBtn v-if="b.status === 'active'" size="xs" shrink @click="onRevoke(b.rp_origin, b.client_id)">
          {{ t("deviceAuth.revoke") }}
        </DangerBtn>
      </li>
    </ul>
  </section>
</template>