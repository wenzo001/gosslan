<script setup lang="ts">
import { useAppStore, type AppearanceMode } from "@/stores/useAppStore";
import SettingsGroup from "@/components/settings/SettingsGroup.vue";
import SettingsRow from "@/components/settings/SettingsRow.vue";

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

/**
 * 外观三态。原来只有"深色模式"开关（二态），表达不出"跟随系统"——
 * 用户在 macOS / Android 上切换外观时 App 不跟随，是最容易被感知的"不像原生"之处
 * （见 2026-09-10 Apple HIG 审计 P0-2）。改为显式三选一，默认跟随系统。
 * 导航栏的太阳/月亮按钮仍保留为快捷开关（它总是切成显式的浅/深）。
 */
const appearanceOptions: { value: AppearanceMode; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];
</script>

<template>
  <SettingsGroup title="外观">
    <SettingsRow label="外观" description="跟随系统，或固定为浅色 / 深色">
      <!-- 分段控件：外圆角 md(8) + p-0.5(2) → 内圆角取 sm(6)，符合同心公式（design-guidelines §1.3） -->
      <div
        role="radiogroup"
        aria-label="外观模式"
        class="flex items-center gap-0.5 rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-bg)] p-0.5"
      >
        <button
          v-for="m in appearanceOptions"
          :key="m.value"
          role="radio"
          :aria-checked="app.appearance === m.value"
          class="rounded-[var(--gosslan-radius-sm)] px-2.5 py-1 text-xs transition"
          :class="app.appearance === m.value
            ? 'bg-[var(--gosslan-panel)] font-medium text-[var(--gosslan-accent-ink)]'
            : 'text-[var(--gosslan-text-2)] hover:bg-[var(--gosslan-hover)]'"
          @click="app.setAppearance(m.value)"
        >
          {{ m.label }}
        </button>
      </div>
    </SettingsRow>

    <SettingsRow label="主题色" description="应用于按钮、选中态与强调色">
      <div class="flex items-center gap-1.5">
        <!-- aria-label：色板格子只有颜色没有文字，读屏下必须靠 label 才知道它是什么 -->
        <button
          v-for="c in presets"
          :key="c"
          class="h-6 w-6 rounded-full transition hover:scale-110"
          :style="{ background: c, outline: app.themeColor === c ? '2px solid var(--gosslan-text)' : 'none', outlineOffset: '1px' }"
          :aria-label="`主题色 ${c}`"
          :aria-pressed="app.themeColor === c"
          @click="app.setThemeColor(c)"
        ></button>
        <input
          type="color"
          :value="app.themeColor"
          class="h-6 w-7 cursor-pointer rounded-[var(--gosslan-radius-xs)] border-0 bg-transparent p-0"
          title="自定义颜色"
          aria-label="自定义主题色"
          @input="(e) => app.setThemeColor((e.target as HTMLInputElement).value)"
        />
      </div>
    </SettingsRow>

    <SettingsRow label="字体" last>
      <select
        aria-label="界面字体"
        class="max-w-[180px] rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-bg)] px-3 py-1.5 text-sm outline-none"
        :value="app.fontFamily"
        @change="(e) => app.setFontFamily((e.target as HTMLSelectElement).value)"
      >
        <option v-for="f in fonts" :key="f.value" :value="f.value">{{ f.label }}</option>
      </select>
    </SettingsRow>
  </SettingsGroup>
</template>
