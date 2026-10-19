<script setup lang="ts">
import { computed } from "vue";
import { useAppStore, type AppearanceMode } from "@/stores/useAppStore";
import SettingsGroup from "@/components/settings/SettingsGroup.vue";
import SettingsRow from "@/components/settings/SettingsRow.vue";
import SegmentedControl from "@/components/ui/SegmentedControl.vue";
import SettingsSelect from "@/components/ui/SettingsSelect.vue";
import { t } from "@/i18n";

const app = useAppStore();

const presets = ["#3b82f6", "#00b578", "#ff6b35", "#8b5cf6", "#e53e3e", "#0ea5e9"];
/**
 * 默认档不能再用空串当 option value：Reka 的 `SelectItem` 不渲染空串值，
 * 菜单里会少掉「系统默认」，触发器也会因匹配不到选项而一片空白
 * （2026-10-19 真实 Tauri 下拉实测）。这里用非空哨兵，落库前再映射回空串。
 */
const SYSTEM_FONT = "__gosslan_system__";
/** label 存 i18n key，由模板 `t(f.label)` 翻译显示。 */
const fonts = [
  { value: SYSTEM_FONT, label: "settings.appearance.font.system" },
  {
    value: "-apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
    label: "settings.appearance.font.pingfang",
  },
  { value: "'Noto Sans SC', 'Source Han Sans SC', sans-serif", label: "settings.appearance.font.siyuan" },
  { value: "'JetBrains Mono', Consolas, monospace", label: "settings.appearance.font.mono" },
];
const fontModel = computed(() => (app.fontFamily === "" ? SYSTEM_FONT : app.fontFamily));
function onFont(value: string) {
  app.setFontFamily(value === SYSTEM_FONT ? "" : value);
}

/**
 * 外观三态。原来只有"深色模式"开关（二态），表达不出"跟随系统"——
 * 用户在 macOS / Android 上切换外观时 App 不跟随，是最容易被感知的"不像原生"之处
 * （见 2026-09-10 Apple HIG 审计 P0-2）。改为显式三选一，默认跟随系统。
 * 导航栏的太阳/月亮按钮仍保留为快捷开关（它总是切成显式的浅/深）。
 */
const appearanceOptions = computed(() => [
  { value: "system", label: t("settings.appearance.system") },
  { value: "light", label: t("settings.appearance.light") },
  { value: "dark", label: t("settings.appearance.dark") },
]);
const fontOptions = computed(() => fonts.map((f) => ({ value: f.value, label: t(f.label) })));
</script>

<template>
  <!-- 组标题用**条目名**「外观」而不是分组名「外观与通知」（`settings.group.appearance`）：
       本分区只有外观（显示模式 / 主题色 / 字体），通知在另一个分区里（`NotificationSection`）。
       桌面端导航项也读同一个键 ⇒ 「标签 = 内容」（settingsStructure 守卫钉住）。
       用户 2026-09-21：「桌面版的外观和通知里只有外观啊，为啥叫外观和通知」。 -->
  <SettingsGroup :title="t('settings.item.appearance')">
    <SettingsRow
      :label="t('settings.appearance.mode')"
      :description="t('settings.appearance.mode.desc')"
    >
      <SegmentedControl
        :model-value="app.appearance"
        :options="appearanceOptions"
        size="sm"
        :aria-label="t('settings.appearance.mode.aria')"
        @update:model-value="(v) => app.setAppearance(v as AppearanceMode)"
      />
    </SettingsRow>

    <SettingsRow
      :label="t('settings.appearance.themeColor')"
      :description="t('settings.appearance.themeColor.desc')"
    >
      <div class="flex items-center gap-2">
        <!-- aria-label：色板格子只有颜色没有文字，读屏下必须靠 label 才知道它是什么 -->
        <button
          v-for="c in presets"
          :key="c"
          class="tap-safe h-6 w-6 rounded-full transition hover:scale-110"
          :style="{ background: c, outline: app.themeColor === c ? '2px solid var(--gosslan-text)' : 'none', outlineOffset: '1px' }"
          :aria-label="t('settings.appearance.themeColor.aria', { color: c })"
          :aria-pressed="app.themeColor === c"
          @click="app.setThemeColor(c)"
        ></button>
        <input
          type="color"
          :value="app.themeColor"
          class="tap-safe h-6 w-7 cursor-pointer rounded-[var(--gosslan-radius-xs)] border border-transparent bg-transparent p-0 outline-none transition focus:border-transparent"
          :title="t('settings.appearance.customColor')"
          :aria-label="t('settings.appearance.customColor.aria')"
          @input="(e) => app.setThemeColor((e.target as HTMLInputElement).value, true)"
        />
      </div>
    </SettingsRow>

    <SettingsRow :label="t('settings.appearance.font')" last>
      <SettingsSelect
        :model-value="fontModel"
        :options="fontOptions"
        :select-label="t('settings.appearance.font.aria')"
        trigger-class="max-w-[180px]"
        @update:model-value="(v) => onFont(String(v))"
      />
    </SettingsRow>
  </SettingsGroup>
</template>
