<script setup lang="ts">
import { useAppStore } from "@/stores/useAppStore";
import SettingsGroup from "@/components/settings/SettingsGroup.vue";
import SettingsRow from "@/components/settings/SettingsRow.vue";
import SettingsToggle from "@/components/settings/SettingsToggle.vue";
import { Moon, Sun } from "lucide-vue-next";

const app = useAppStore();

const presets = ["#3b82f6", "#00b578", "#ff6b35", "#8b5cf6", "#e53e3e", "#0ea5e9"];
const fonts = [
  { value: "", label: "系统默认" },
  {
    value: "-apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
    label: "苹方 / 微软雅黑",
  },
  { value: "'Noto Sans SC', 'Source Han Sans SC', sans-serif", label: "思源黑体" },
  { value: "'JetBrains Mono', Consolas, monospace", label: "等宽字体" },
];
</script>

<template>
  <SettingsGroup title="外观">
    <SettingsRow label="深色模式" description="开启后使用深色主题界面">
      <SettingsToggle :model-value="app.dark" size="md" @update:model-value="app.toggleDark()">
        <Sun v-if="app.dark" class="h-3 w-3 text-amber-500" />
        <Moon v-else class="h-3 w-3 text-[var(--gosslan-text-2)]" />
      </SettingsToggle>
    </SettingsRow>

    <SettingsRow label="主题色" description="应用于按钮、选中态与强调色">
      <div class="flex items-center gap-1.5">
        <button
          v-for="c in presets"
          :key="c"
          class="h-6 w-6 rounded-full transition hover:scale-110"
          :style="{ background: c, outline: app.themeColor === c ? '2px solid var(--gosslan-text)' : 'none', outlineOffset: '1px' }"
          @click="app.setThemeColor(c)"
        ></button>
        <input
          type="color"
          :value="app.themeColor"
          class="h-6 w-7 cursor-pointer rounded border-0 bg-transparent p-0"
          title="自定义颜色"
          @input="(e) => app.setThemeColor((e.target as HTMLInputElement).value)"
        />
      </div>
    </SettingsRow>

    <SettingsRow label="字体" last>
      <select
        class="max-w-[180px] rounded-lg bg-[var(--gosslan-bg)] px-3 py-1.5 text-sm outline-none"
        :value="app.fontFamily"
        @change="(e) => app.setFontFamily((e.target as HTMLSelectElement).value)"
      >
        <option v-for="f in fonts" :key="f.value" :value="f.value">{{ f.label }}</option>
      </select>
    </SettingsRow>
  </SettingsGroup>
</template>
