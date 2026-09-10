<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api } from "@/api";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";
import SettingsGroup from "@/components/settings/SettingsGroup.vue";
import SettingsRow from "@/components/settings/SettingsRow.vue";
import SettingsToggle from "@/components/settings/SettingsToggle.vue";
import { t } from "@/i18n";
import type { ChannelStatus } from "@/types";

const props = defineProps<{ active: boolean; reloadToken?: number }>();

const app = useAppStore();
const chat = useChatStore();

const channels = ref<ChannelStatus[]>([]);
const selectedIp = ref("0.0.0.0");

const btStatus = computed(() => channels.value.find((c) => c.channel === "bluetooth"));
const lanStatus = computed(() => channels.value.find((c) => c.channel === "lan"));
const interfaceOptions = computed(() => [
  { value: "0.0.0.0", label: "自动（所有网卡）" },
  ...app.interfaces.map((i) => ({ value: i.ip, label: `${i.name}（${i.ip}）` })),
]);

async function loadChannels() {
  channels.value = await api.getChannelStatus();
}

watch(
  () => [props.active, props.reloadToken],
  async () => {
    if (!props.active) return;
    selectedIp.value = app.boundIp ?? app.preferredIp ?? "0.0.0.0";
    await app.refreshInterfaces();
    await loadChannels();
  },
  { immediate: true },
);

/** 局域网开关：与「网卡选择」联动，统一以 selectedIp 为绑定地址。 */
async function toggleLan() {
  if (app.online) {
    await app.stopNetwork();
    app.toast("局域网通道已关闭", "info");
  } else {
    try {
      await app.startNetwork(selectedIp.value);
      app.toast("局域网通道已开启，正在扫描节点…", "success");
      await chat.refreshPeers();
    } catch (e) {
      app.toastError(e, "切换局域网通道失败");
    }
  }
  await loadChannels();
}

/** 选择网卡：未开启 → 直接以该网卡开启并扫描；已开启 → 切换到新网卡重新扫描。 */
async function onInterfaceChange() {
  const ip = selectedIp.value;
  try {
    if (app.online) {
      if (app.boundIp === ip) return;
      await app.stopNetwork();
      await app.startNetwork(ip);
      app.toast(`已切换到网卡 ${ip}，正在重新扫描…`, "success");
    } else {
      await app.startNetwork(ip);
      app.toast("局域网通道已开启，正在扫描节点…", "success");
    }
    await chat.refreshPeers();
  } catch (e) {
    app.toastError(e, "切换网卡失败");
  }
  await loadChannels();
}

async function toggleBluetooth() {
  const cur = btStatus.value?.enabled ?? false;
  try {
    await api.setChannelEnabled("bluetooth", !cur);
    app.toast(cur ? "蓝牙通道已关闭" : "蓝牙通道已开启", cur ? "info" : "success");
  } catch (e) {
    app.toastError(e, "切换蓝牙通道失败");
  }
  await loadChannels();
}
</script>

<template>
  <SettingsGroup
    :title="t('settings.group.network')"
    :footer="t('settings.group.network.footer')"
  >
    <SettingsRow label="局域网通道" description="发现并连接同一局域网内的其他设备">
      <div class="flex items-center gap-2">
        <span class="text-xs" :class="app.online ? 'text-[var(--gosslan-success-ink)]' : 'text-[var(--gosslan-text-2)]'">
          {{ app.online ? `${lanStatus?.peers ?? 0} 个节点在线` : "未开启" }}
        </span>
        <SettingsToggle label="局域网通道" :model-value="app.online" @update:model-value="toggleLan" />
      </div>
    </SettingsRow>

    <SettingsRow label="网卡">
      <select
        v-model="selectedIp"
        class="max-w-[200px] rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-bg)] px-3 py-1.5 text-sm outline-none"
        @change="onInterfaceChange"
      >
        <option v-for="o in interfaceOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </SettingsRow>

    <SettingsRow
      label="蓝牙通道"
      :description="btStatus?.available ? undefined : '蓝牙后端尚未编译（当前版本暂不支持），将在后续版本提供'"
      last
    >
      <div class="flex items-center gap-2">
        <span class="text-xs text-[var(--gosslan-text-2)]">
          {{ btStatus?.available ? (btStatus.enabled ? "已开启" : "已关闭") : "暂不可用" }}
        </span>
        <SettingsToggle
          label="蓝牙通道"
          :model-value="!!btStatus?.enabled"
          :disabled="!btStatus?.available"
          @update:model-value="toggleBluetooth"
        />
      </div>
    </SettingsRow>
  </SettingsGroup>
</template>
