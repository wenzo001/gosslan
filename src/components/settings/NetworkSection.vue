<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api } from "@/api";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";
import SettingsToggle from "@/components/settings/SettingsToggle.vue";
import { Bluetooth, Monitor, Network } from "lucide-vue-next";
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
      app.toast(String(e), "error");
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
    app.toast(String(e), "error");
  }
  await loadChannels();
}

async function toggleBluetooth() {
  const cur = btStatus.value?.enabled ?? false;
  try {
    await api.setChannelEnabled("bluetooth", !cur);
    app.toast(cur ? "蓝牙通道已关闭" : "蓝牙通道已开启", cur ? "info" : "success");
  } catch (e) {
    app.toast(String(e), "error");
  }
  await loadChannels();
}
</script>

<template>
  <section>
    <h3 class="mb-3 text-[13px] font-semibold text-[var(--gosslan-text)]">网络通道</h3>

    <!-- 局域网 -->
    <div class="rounded-xl border border-[var(--gosslan-border)] p-3">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <Network class="h-4 w-4 text-primary" />
          <span class="text-sm">局域网通道</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-xs" :class="app.online ? 'text-primary' : 'text-[var(--gosslan-text-2)]'">
            {{ app.online ? `${lanStatus?.peers ?? 0} 个节点在线` : "未开启" }}
          </span>
          <SettingsToggle :model-value="app.online" @update:model-value="toggleLan" />
        </div>
      </div>
      <div class="mt-3 flex items-center gap-2">
        <Monitor class="h-4 w-4 shrink-0 text-[var(--gosslan-text-2)]" />
        <select
          v-model="selectedIp"
          class="w-full rounded-lg bg-[var(--gosslan-bg)] px-3 py-2 text-sm outline-none"
          @change="onInterfaceChange"
        >
          <option v-for="o in interfaceOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </div>
      <p class="mt-1.5 text-[11px] leading-relaxed text-[var(--gosslan-text-2)]">
        选择网卡后即开启通道并扫描节点；通道开启时可随时切换网卡。
      </p>
    </div>

    <!-- 蓝牙 -->
    <div
      class="mt-2 flex items-center justify-between rounded-xl border border-[var(--gosslan-border)] p-3 opacity-60"
      :class="{ 'pointer-events-none': !btStatus?.available }"
    >
      <div class="flex items-center gap-2">
        <Bluetooth class="h-4 w-4 text-[var(--gosslan-text-2)]" />
        <span class="text-sm">蓝牙通道</span>
      </div>
      <div class="flex items-center gap-2">
        <span class="text-xs text-[var(--gosslan-text-2)]">
          {{ btStatus?.available ? (btStatus.enabled ? "已开启" : "已关闭") : "暂不可用" }}
        </span>
        <SettingsToggle
          :model-value="!!btStatus?.enabled"
          :disabled="!btStatus?.available"
          @update:model-value="toggleBluetooth"
        />
      </div>
    </div>
    <p v-if="!btStatus?.available" class="mt-1 text-[11px] text-[var(--gosslan-text-2)]">
      蓝牙后端尚未编译（当前版本暂不支持），将在后续版本提供。
    </p>
  </section>
</template>
