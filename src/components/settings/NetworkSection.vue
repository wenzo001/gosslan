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
  { value: "0.0.0.0", label: "settings.network.interface.auto" },
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
    app.toast(t("settings.network.toast.lanOff"), "info");
  } else {
    try {
      await app.startNetwork(selectedIp.value);
      app.toast(t("settings.network.toast.lanOn"), "success");
      await chat.refreshPeers();
    } catch (e) {
      app.toastError(e, t("settings.network.toast.lanFail"));
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
      app.toast(t("settings.network.toast.interfaceSwitched", { ip }), "success");
    } else {
      await app.startNetwork(ip);
      app.toast(t("settings.network.toast.lanOn"), "success");
    }
    await chat.refreshPeers();
  } catch (e) {
    app.toastError(e, t("settings.network.toast.interfaceFail"));
  }
  await loadChannels();
}

async function toggleBluetooth() {
  const cur = btStatus.value?.enabled ?? false;
  try {
    await api.setChannelEnabled("bluetooth", !cur);
    app.toast(cur ? t("settings.network.toast.btOff") : t("settings.network.toast.btOn"), cur ? "info" : "success");
  } catch (e) {
    app.toastError(e, t("settings.network.toast.btFail"));
  }
  await loadChannels();
}
</script>

<template>
  <SettingsGroup
    :title="t('settings.group.network')"
    :footer="t('settings.group.network.footer')"
  >
    <SettingsRow :label="t('settings.network.lan')" :description="t('settings.network.lan.desc')">
      <div class="flex items-center gap-2">
        <span class="text-xs" :class="app.online ? 'text-[var(--gosslan-success-ink)]' : 'text-[var(--gosslan-text-2)]'">
          {{ app.online ? t("settings.network.lan.peers", { n: lanStatus?.peers ?? 0 }) : t("settings.network.lan.off") }}
        </span>
        <SettingsToggle :label="t('settings.network.lan')" :model-value="app.online" @update:model-value="toggleLan" />
      </div>
    </SettingsRow>

    <SettingsRow :label="t('settings.network.interface')">
      <select
        v-model="selectedIp"
        class="max-w-[200px] rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-bg)] px-3 py-1.5 text-sm outline-none"
        @change="onInterfaceChange"
      >
        <option v-for="o in interfaceOptions" :key="o.value" :value="o.value">{{ t(o.label) }}</option>
      </select>
    </SettingsRow>

    <SettingsRow
      :label="t('settings.network.bluetooth')"
      :description="btStatus?.available ? undefined : t('settings.network.bluetooth.unavailable')"
      last
    >
      <div class="flex items-center gap-2">
        <span class="text-xs text-[var(--gosslan-text-2)]">
          {{ btStatus?.available ? (btStatus.enabled ? t("settings.network.bluetooth.on") : t("settings.network.bluetooth.off")) : t("settings.network.bluetooth.na") }}
        </span>
        <SettingsToggle
          :label="t('settings.network.bluetooth')"
          :model-value="!!btStatus?.enabled"
          :disabled="!btStatus?.available"
          @update:model-value="toggleBluetooth"
        />
      </div>
    </SettingsRow>
  </SettingsGroup>
</template>
