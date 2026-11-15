<script setup lang="ts">
/**
 * 设置 → 关于 → 安全：**手动粘贴一条分享链接**（兜底 + 自测入口）。
 *
 * 为什么需要这一块：分享的正门是深链（`gosslan://share?…`），而深链要靠系统协议注册才通。
 * 开发期构建、未签名包、以及没做协议注册的 Linux 桌面**拿不到注册** —— 没有这个入口，
 * 接入方在本地只能先打签名包才能验证分享，`docs/notes/external-integration-guide-*.md`
 * 的自测清单也就没法执行。
 *
 * 与设备认证的粘贴入口对称（`AuthorizedAppsSection.vue` 里那块），但**刻意分成两个组件**：
 * 登录与分享是两条互不相干的入口，混在一块会让人以为分享也要绑定外部应用。
 *
 * 边界：这里只是把字符串交给后端的**同一个** `begin_share`，限额/去重/排队全不变；
 * 面板由 `SharePanel.vue` 负责，本组件不发送任何消息。
 */
import { ref } from "vue";
import PrimaryBtn from "@/components/ui/PrimaryBtn.vue";
import { useShareStore } from "@/stores/useShareStore";
import { useAppStore } from "@/stores/useAppStore";
import { useImeEnterGuard } from "@/composables/useImeEnterGuard";
import { t } from "@/i18n";

const store = useShareStore();
const app = useAppStore();
const ime = useImeEnterGuard();
const draft = ref("");
const busy = ref(false);

async function onOpen() {
  const url = draft.value.trim();
  if (!url || busy.value) return;
  busy.value = true;
  try {
    await store.handleLink(url);
    draft.value = "";
  } catch (e) {
    // 失败要说清楚原因（链接不合法 / 内容为空 / 队列满），别只说「失败」。
    app.toastError(e, t("shareToChat.openFail"));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="space-y-2">
    <div>
      <h3 class="text-body font-medium text-[var(--gosslan-text)]">{{ t("shareToChat.linkSectionTitle") }}</h3>
      <p class="mt-0.5 text-meta leading-relaxed text-[var(--gosslan-text-2)]">{{ t("shareToChat.linkSectionHint") }}</p>
    </div>

    <div class="flex items-end gap-2">
      <label class="min-w-0 flex-1">
        <span class="mb-1 block text-caption text-[var(--gosslan-text-2)]">{{ t("shareToChat.linkLabel") }}</span>
        <input
          v-model="draft"
          type="text"
          class="gosslan-selectable h-10 w-full rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-field-border)] bg-[var(--gosslan-field)] px-3 text-sm outline-none transition focus:border-[var(--gosslan-primary)]"
          :placeholder="t('shareToChat.linkPlaceholder')"
          @keydown.enter.prevent="ime.enter(onOpen, $event)"
          @compositionstart="ime.onStart"
          @compositionend="ime.onEnd"
        />
      </label>
      <PrimaryBtn size="dense" shrink :disabled="busy || !draft.trim()" @click="onOpen">
        {{ t("shareToChat.linkSubmit") }}
      </PrimaryBtn>
    </div>
  </section>
</template>
