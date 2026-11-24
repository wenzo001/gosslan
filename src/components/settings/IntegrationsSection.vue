<script setup lang="ts">
/**
 * 设置 → 第三方接入：所有「和外部应用打交道」的设置集中在这一页（用户 2026-11-17：
 * 「把设置里的三方使用的设置单独配置一个 tab，别全挤在关于里」）。
 *
 * 此前这三块挤在「关于」页里，用户看到「已授权应用 / 外部分享 / 密钥备份」却不知道
 * 它们和「版本 / 更新 / 设备指纹」有什么关系 —— 分类不符，正是 `settingsStructure`
 * 守卫一直钉的「标签即内容」问题。现在独立成一级 tab，三块内部一字未改。
 *
 * 只做**组合**，不含业务逻辑：三块组件各自管自己的状态与 i18n。
 */
import SettingsGroup from "@/components/settings/SettingsGroup.vue";
import Icon from "@/components/ui/Icon.vue";
import AuthorizedAppsSection from "@/components/settings/AuthorizedAppsSection.vue";
import ExternalShareSection from "@/components/settings/ExternalShareSection.vue";
import { t } from "@/i18n";

/** 外部应用接入指南（设备快捷认证 + 分享到会话）。 */
const INTEGRATION_DOC_URL =
  "https://github.com/wenzo001/gosslan/blob/main/docs/notes/external-integration-guide-2026-11-14.md";
/** 通知机器人接入文档，在独立的 relay-server 仓库。 */
const BOT_DOC_URL =
  "https://github.com/wenzo001/gosslan-relay-server/blob/main/README-v7-notify.md";
</script>

<template>
  <SettingsGroup :title="t('settings.item.integrations')" :footer="t('settings.group.integrations.footer')">
    <div class="settings-card-row">
      <div class="mt-0.5 text-meta leading-relaxed text-[var(--gosslan-text-2)]">
        {{ t("settings.integrations.intro") }}
      </div>
    </div>
    <!-- 两篇接入文档都放这里（用户 2026-11-17）：开发者找文档先来「第三方接入」，不用去「关于」翻。 -->
    <div class="settings-card-row mt-3">
      <div class="text-sm text-[var(--gosslan-text)]">{{ t("settings.integrations.integrationDoc") }}</div>
      <div class="mt-0.5 text-meta leading-relaxed text-[var(--gosslan-text-2)]">
        {{ t("settings.integrations.integrationDocHint") }}
      </div>
      <a
        class="mt-1 inline-flex items-center gap-1 break-all text-meta text-[var(--gosslan-accent-ink)] hover:underline"
        :href="INTEGRATION_DOC_URL"
        target="_blank"
        rel="noopener noreferrer"
      >
        <span class="font-mono">{{ INTEGRATION_DOC_URL }}</span>
        <Icon name="external-link" class="h-3 w-3 shrink-0" />
      </a>
    </div>
    <div class="settings-card-row mt-3">
      <div class="text-sm text-[var(--gosslan-text)]">{{ t("settings.integrations.botDoc") }}</div>
      <div class="mt-0.5 text-meta leading-relaxed text-[var(--gosslan-text-2)]">
        {{ t("settings.integrations.botDocHint") }}
      </div>
      <a
        class="mt-1 inline-flex items-center gap-1 break-all text-meta text-[var(--gosslan-accent-ink)] hover:underline"
        :href="BOT_DOC_URL"
        target="_blank"
        rel="noopener noreferrer"
      >
        <span class="font-mono">{{ BOT_DOC_URL }}</span>
        <Icon name="external-link" class="h-3 w-3 shrink-0" />
      </a>
    </div>
  </SettingsGroup>

  <div class="mt-[var(--gosslan-section-gap)] space-y-[var(--gosslan-section-gap)]">
    <AuthorizedAppsSection />
    <ExternalShareSection />
  </div>
</template>
