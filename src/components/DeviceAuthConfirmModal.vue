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
import {
  deviceAuthClaimKey,
  deviceAuthScopeKey,
  deviceAuthSecondsLeft,
  disclosedClaims,
  grantedScopes,
  shouldResetChecksForPrompt,
} from "@/utils/deviceAuth";
import { createInitScope } from "@/utils/initScope";
import { errorCode } from "@/utils/errors";
import { t } from "@/i18n";

const store = useDeviceAuthStore();
const app = useAppStore();
const allowNickname = ref(false);
const now = ref(Date.now());
// 用户**实际勾选**的交付范围（scope）。
//
// 用户 2026-11-17 进一步要求「一键允许」⇒ 新事务到达时**请求的 scope 全勾**，
// 用户点一次「允许」即完成（清单在页面上明列，仍可逐项取消）。
// 此前是「默认全关 + 同 RP 记忆预勾」（2026-11-16），现按用户最新决定简化。
const scopeChecks = ref<string[]>([]);
/** 本次预勾了哪些（用来在页面上说明「沿用上次」）。 */
const preCheckedScopes = ref<string[]>([]);

// 订阅与定时器都交给 initScope 成对拆除（判据 ㊷：不许手工卸载句柄）。
const scope = createInitScope();
onMounted(() => {
  void api.onDeviceAuthRequest((p) => {
    // 同一 request_id 的重复事件（系统/浏览器重试、手动重复粘贴）：**不重置**用户正在
    // 修改的勾选与昵称开关。后端 emit 前已按 request_id 去重，这里再挡一层。
    if (shouldResetChecksForPrompt(store.pending, p)) {
      // 新事务 ⇒ 上一笔的勾选**不带过来**（scope 是本次事务的授权）。
      // 后端 prompt.nickname_default 是「同一 RP 上次的选择」记忆值；首次为 false。
      // 用户 2026-11-17：「一键允许」⇒ 请求的 scope 默认全勾，点一次「允许」即完成，
      // 清单在页面上明列、仍可逐项取消（一键是默认值不是强制）。
      allowNickname.value = p.nickname_default;
      preCheckedScopes.value = [...p.requested_scopes];
      scopeChecks.value = [...p.requested_scopes];
    }
    store.setPending(p);
  }).then((un) => scope.onDispose(un));
  // 清数据（clearAllData / resetAfterDataCleared 经后端广播 data-cleared）一并清掉确认页（#8）：
  // 后端已清待确认事务与绑定，前端若留着旧确认页，用户会以为还能批准一个已不存在的事务。
  void api.onDataCleared(() => store.clear()).then((un) => scope.onDispose(un));
  // 快捷授权（2026-11-23）：同设备同应用 24h 内批准过且范围没变大 ⇒ 后端自动批准，
  // 不出确认页，只在这里给一条 toast（用户能看到「刚才那次不用点」是设计不是丢事件）。
  void api
    .onDeviceAuthAutoApproved((info) => {
      app.toast(t("deviceAuth.autoApproved", { name: info.display_name }), "success");
    })
    .then((un) => scope.onDispose(un));
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
const actionLabel = computed(() => {
  if (prompt.value?.action === "authenticate") return t("deviceAuth.authAction");
  if (prompt.value?.action === "sync") return t("deviceAuth.syncAction");
  return t("deviceAuth.linkAction");
});
/** 本次事务请求的交付范围（RP 声明要什么）。 */
const requestedScopes = computed(() => prompt.value?.requested_scopes ?? []);
/** 用户勾选后**实际**会交付的那部分（请求 ∩ 勾选 ∩ allowlist）。 */
const granted = computed(() => grantedScopes(requestedScopes.value, scopeChecks.value));

function scopeLabel(sc: string): string {
  return t(deviceAuthScopeKey(sc));
}
function onScopeToggle(sc: string, on: boolean) {
  scopeChecks.value = on
    ? [...scopeChecks.value, sc]
    : scopeChecks.value.filter((x) => x !== sc);
}

function claimLabel(c: string): string {
  return t(deviceAuthClaimKey(c));
}

async function onApprove() {
  try {
    const out = await store.approve(allowNickname.value, granted.value);
    if (out) app.toast(t("deviceAuth.approved"), "success");
  } catch (e) {
    // 先登录后绑定：无绑定会自动首绑，但首绑后要等 RP 回调才 active。若在等待期间再次
    // 登录，后端报 NO_BINDING（未完成登记）—— 给可操作提示，而不是一句"批准失败"。
    if (errorCode(String(e)) === "DEVICE_AUTH_NO_BINDING" || String(e).includes("DEVICE_AUTH_NO_BINDING")) {
      app.toast(t("deviceAuth.bindingPending"), "info");
      return;
    }
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

      <!-- 交付范围（scope）：默认全勾（一键允许），用户仍可逐项取消。 -->
      <div v-if="requestedScopes.length">
        <div class="mb-1 text-caption text-[var(--gosslan-text-2)]">{{ t("deviceAuth.scopesLabel") }}</div>
        <div
          v-for="sc in requestedScopes"
          :key="sc"
          class="mb-1 flex items-center gap-2"
        >
          <SettingsToggle
            :model-value="scopeChecks.includes(sc)"
            :label="scopeLabel(sc)"
            size="sm"
            @update:model-value="onScopeToggle(sc, $event)"
          />
          <span class="text-meta text-[var(--gosslan-text-2)]">{{ scopeLabel(sc) }}</span>
        </div>
        <p class="mt-1 text-meta leading-relaxed text-[var(--gosslan-text-2)]">
          {{ t("deviceAuth.scopeHintOneClick") }}
        </p>
        <!-- 一键允许说明：默认全勾，用户仍可逐项取消（用户 2026-11-17 决定）。 -->
        <p
          v-if="preCheckedScopes.length"
          class="mt-1 text-meta leading-relaxed text-[var(--gosslan-text-2)]"
          data-device-auth-oneclick
        >
          {{ t("deviceAuth.scopeHintOneClick") }}
        </p>
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