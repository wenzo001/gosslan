<script setup lang="ts">
import SettingsGroup from "@/components/settings/SettingsGroup.vue";
import SettingsRow from "@/components/settings/SettingsRow.vue";
import { Lock } from "lucide-vue-next";
import { t } from "@/i18n";
</script>

<template>
  <SettingsGroup :title="t('settings.group.security')">
    <SettingsRow
      :label="t('settings.security.e2ee')"
      :description="t('settings.security.e2ee.desc')"
      last
    >
      <span class="flex items-center gap-1 rounded-full bg-[var(--gosslan-success-soft)] px-2.5 py-1 text-[11px] text-[var(--gosslan-success-ink)]">
        <Lock class="h-3 w-3" />
        {{ t("settings.security.enabled") }}
      </span>
    </SettingsRow>
  </SettingsGroup>
</template>
