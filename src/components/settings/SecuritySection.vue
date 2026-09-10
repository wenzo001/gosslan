<script setup lang="ts">
import SettingsGroup from "@/components/settings/SettingsGroup.vue";
import SettingsRow from "@/components/settings/SettingsRow.vue";
import { Lock } from "lucide-vue-next";
import { t } from "@/i18n";
</script>

<template>
  <SettingsGroup :title="t('settings.group.security')">
    <SettingsRow
      label="端到端加密（E2EE）"
      description="所有单聊与群聊消息在发送前经 X25519 密钥交换 + ChaCha20-Poly1305 加密，中继节点只透传密文、无法查看内容；聊天窗口顶部的锁形标识实时显示该状态。发送前需获取对方公钥（对方上线后自动同步）。"
      last
    >
      <span class="flex items-center gap-1 rounded-full bg-[var(--gosslan-success-soft)] px-2.5 py-1 text-[11px] text-[var(--gosslan-success-ink)]">
        <Lock class="h-3 w-3" />
        已启用
      </span>
    </SettingsRow>
  </SettingsGroup>
</template>
