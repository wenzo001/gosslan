<script setup lang="ts">
import { useAppStore } from "@/stores/useAppStore";
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
  <section>
    <h3 class="mb-3 text-[13px] font-semibold text-[var(--gosslan-text)]">外观</h3>
    <div class="space-y-3">
      <div class="flex items-center justify-between">
        <span class="text-sm">深色模式</span>
        <SettingsToggle :model-value="app.dark" size="md" @update:model-value="app.toggleDark()">
          <Sun v-if="app.dark" class="h-3 w-3 text-amber-500" />
          <Moon v-else class="h-3 w-3 text-[var(--gosslan-text-2)]" />
        </SettingsToggle>
      </div>
      <div>
        <div class="mb-1.5 text-sm">主题色</div>
        <div class="flex items-center gap-2">
          <button
            v-for="c in presets"
            :key="c"
            class="h-6 w-6 rounded-full transition"
            :style="{ background: c, outline: app.themeColor === c ? '2px solid var(--gosslan-text)' : 'none' }"
            @click="app.setThemeColor(c)"
          ></button>
          <input
            type="color"
            :value="app.themeColor"
            class="h-6 w-8 cursor-pointer rounded border-0 bg-transparent p-0"
            title="自定义颜色"
            @input="(e) => app.setThemeColor((e.target as HTMLInputElement).value)"
          />
        </div>
      </div>
      <div>
        <div class="mb-1.5 text-sm">字体</div>
        <select
          class="w-full rounded-lg bg-[var(--gosslan-bg)] px-3 py-2 text-sm outline-none"
          :value="app.fontFamily"
          @change="(e) => app.setFontFamily((e.target as HTMLSelectElement).value)"
        >
          <option v-for="f in fonts" :key="f.value" :value="f.value">{{ f.label }}</option>
        </select>
      </div>
    </div>
  </section>
</template>
