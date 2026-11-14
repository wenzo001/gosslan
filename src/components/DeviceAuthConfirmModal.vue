<script setup lang="ts">
/**
 * 外部应用设备认证的**强制确认页**（Phase 2）。深链到达时后端 emit `device-auth-request`，
 * 本组件订阅并弹出。设计文档 §5/§6：来源域取 metadata.issuer 规范化值（主要防钓鱼线索），
 * 不信任深链里的显示名；关闭/拒绝都 fail closed；昵称默认不共享（用户主动勾选才给）。
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import BaseModal from "@/components/BaseModal.vue";
import PrimaryBtn from "@/components/ui/PrimaryBtn.vue";
import SecondaryBtn from "@/components/ui/SecondaryBtn.vue";
import SettingsToggle from "@/components/settings/SettingsToggle.vue";
import { api } from "@/api";
import { useDeviceAuthStore } from "@/stores/useDeviceAuthStore";
import { useAppStore } from "@/stores/useAppStore";
import { deviceAuthClaimKey, deviceAuthSecondsLeft, disclosedClaims } from "@/utils/deviceAuth";
import { createInitScope } from "@/utils/initScope";
import { t } from "@/i18n";

const store = useDeviceAuthStore();
const app = useAppStore();
const allowNickname = ref(false);
const now = ref(Date.now());

// 订阅与定时器都交给 initScope 成对拆除（判据 ㊷：不许手工卸载句柄）。
const scope = createInitScope();
onMounted(() => {
  void api.onDeviceAuthRequest((p) => {
    allowNickname.value = false;
    store.setPending(p);
  }).then((un) => scope.onDispose(un));
  // 清数据（clearAllData / resetAfterDataCleared 经后端广播 data-cleared）一并清掉确认页（#8）：
  // 后端已清待确认事务与绑定，前端若留着旧确认页，用户会以为还能批准一个已不存在的事务。
  void api.onDataCleared(() => store.clear()).then((un) => scope.onDispose(un));
  const timer = window.setInterval(() => {
    now.value = Date.now();
  }, 1000);
  scope.onDispose(() => window.clearInterval(timer));
});
onUnmounted(() => scope.dispose());

// 新事务到达时向后端复核一次（过期/已消费则清掉确认页）；request_id 不变不会重复触发。
watch(
  () => store.pending?.request_id,
  (id) => {
    if (id) void store.refreshPending();
  },
);

const prompt = computed(() => store.pending);
// 恒发披露（#4）：device_subject/device_public_key 是绑定必需，即便 RP 只请求 nickname 也恒发，
// 确认页必须始终列出这两项，杜绝「只请求 nickname 却未披露恒发项」。
const disclosed = computed(() =>
  prompt.value ? disclosedClaims(prompt.value.requested_claims) : [],
);
const secondsLeft = computed(() =>
  prompt.value ? deviceAuthSecondsLeft(prompt.value.expires_at_ms, now.value) : 0,
);
const expired = computed(() => secondsLeft.value <= 0);
const actionLabel = computed(() =>
  prompt.value?.action === "authenticate" ? t("deviceAuth.authAction") : t("deviceAuth.linkAction"),
);

function claimLabel(c: string): string {
  return t(deviceAuthClaimKey(c));
}

async function onApprove() {
  try {
    const out = await store.approve(allowNickname.value);
    if (out) app.toast(t("deviceAuth.approved"), "success");
  } catch (e) {
    app.toastError(e, t("deviceAuth.approveFail"));
  }
}
async function onDeny() {
  try {
    await store.deny();
  } catch {
    // 事务可能已被消费/过期：本地仍清掉确认页（用户意图是拒绝）。
    store.clear();
  }
}
/** 关闭（遮罩/Esc）= 拒绝，fail closed。
 * 重试态（本机已拒绝、RP 未收到）下关闭 = 放弃重试：本机拒绝已成立，事务交给 TTL 终态，
 * 不再触发回写，也不把用户困在一个只会重试的弹窗里。 */
function onClose() {
  if (store.denyNeedsRetry) {
    store.clear();
    return;
  }
  void onDeny();
}
</script>

<template>
  <BaseModal :open="!!prompt" :title="t('deviceAuth.title')" width="max-w-md" @close="onClose">
    <div v-if="prompt" class="space-y-3">
      <!-- 来源域：主要防钓鱼线索，等宽大字号展示规范化 origin。 -->
      <div class="rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-hover)] px-3 py-2.5">
        <div class="text-caption text-[var(--gosslan-text-2)]">{{ t("deviceAuth.originLabel") }}</div>
        <div class="break-all font-mono text-body font-medium text-[var(--gosslan-text)]">{{ prompt.rp_origin }}</div>
        <div class="mt-0.5 text-meta text-[var(--gosslan-text-2)]">{{ prompt.display_name }}</div>
      </div>

      <div class="text-body font-medium text-[var(--gosslan-text)]">{{ actionLabel }}</div>

      <div class="text-meta text-[var(--gosslan-text-2)]">
        {{ t("deviceAuth.accountLabel") }}{{ prompt.account_hint || t("deviceAuth.noAccountHint") }}
      </div>

      <div>
        <div class="mb-1 text-caption text-[var(--gosslan-text-2)]">{{ t("deviceAuth.claimsLabel") }}</div>
        <ul class="space-y-1">
          <li
            v-for="c in disclosed"
            :key="c"
            class="flex items-center gap-2 text-meta text-[var(--gosslan-text)]"
          >
            <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--gosslan-success-solid)] text-[var(--gosslan-on-primary)]" aria-hidden="true"></span>
            {{ claimLabel(c) }}
          </li>
        </ul>
        <!-- 恒发披露（#4）：设备标识与公钥为绑定必需，批准即提供，与 RP 请求了哪些 claim 无关。 -->
        <p class="mt-1.5 text-meta leading-relaxed text-[var(--gosslan-text-2)]">{{ t("deviceAuth.identityDisclosure") }}</p>
        <div
          v-if="prompt.requested_claims.includes('nickname')"
          class="mt-2 flex items-center gap-2"
        >
          <SettingsToggle v-model="allowNickname" :label="t('deviceAuth.nicknameToggle')" size="sm" />
          <span class="text-meta text-[var(--gosslan-text-2)]">{{ t("deviceAuth.nicknameToggle") }}</span>
        </div>
      </div>

      <p class="text-caption leading-relaxed text-[var(--gosslan-text-2)]">{{ t("deviceAuth.warning") }}</p>

      <div
        class="text-caption tabular-nums"
        :class="expired ? 'text-[var(--gosslan-danger-ink)]' : 'text-[var(--gosslan-text-2)]'"
      >
        {{ expired ? t("deviceAuth.expired") : t("deviceAuth.expiresIn", { s: secondsLeft }) }}
      </div>

      <!-- 拒绝可观察（P1）：本机已拒绝但 RP 未收到 ⇒ 明示并保留确认页供重试，不静默当成功。 -->
      <p
        v-if="store.denyNeedsRetry"
        class="text-caption leading-relaxed text-[var(--gosslan-danger-ink)]"
      >
        {{ t("deviceAuth.denyNotNotified") }}
      </p>
    </div>

    <template #footer>
      <div class="flex items-center justify-end gap-2">
        <SecondaryBtn :disabled="store.busy" @click="onDeny">
          {{ store.denyNeedsRetry ? t("deviceAuth.denyRetry") : t("deviceAuth.deny") }}
        </SecondaryBtn>
        <!-- 重试态隐藏「批准」：用户意图已是拒绝，不允许被误点成批准一个自己要拒绝的事务。 -->
        <PrimaryBtn v-if="!store.denyNeedsRetry" :disabled="store.busy || expired" @click="onApprove">
          {{ t("deviceAuth.approve") }}
        </PrimaryBtn>
      </div>
    </template>
  </BaseModal>
</template>