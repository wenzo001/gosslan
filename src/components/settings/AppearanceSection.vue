<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useAppStore, type AppearanceMode } from "@/stores/useAppStore";
import SettingsGroup from "@/components/settings/SettingsGroup.vue";
import SettingsRow from "@/components/settings/SettingsRow.vue";
import SegmentedControl from "@/components/ui/SegmentedControl.vue";
import SettingsSelect from "@/components/ui/SettingsSelect.vue";
import { t } from "@/i18n";

const app = useAppStore();

const presets = ["#2f6bff", "#00b578", "#ff6b35", "#8b5cf6", "#e53e3e", "#0ea5e9"];
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
/** 当前色不在 6 个预设里 ⇒ 自定义入口是**唯二**的选中项之一（与预置色互斥）。 */
const isCustomThemeColor = computed(() => !presets.includes(app.themeColor));
/**
 * 自定义入口那次取色器的初值（用户 2026-11-09 报的 bug：自定义块跟着当前生效色变）。
 *
 * ⚠️ 绝不能绑 `app.themeColor`：点任一预置色时它会被一起改，看起来像"自定义也被选中"。
 * 这里只在**自定义色生效时**跟着当前色同步；选中预置色时停在最近一次自定义色上，
 * 只作为下次打开取色器的起点，界面上的填充色退回色轮图标（不显示当前生效色）。
 */
const customColorSeed = ref<string>(isCustomThemeColor.value ? app.themeColor : presets[0]);
watch(
  () => app.themeColor,
  (c) => {
    if (isCustomThemeColor.value) customColorSeed.value = c;
  },
);
const customPickerValue = computed(() =>
  isCustomThemeColor.value ? app.themeColor : customColorSeed.value,
);
const customColorPicker = ref<HTMLInputElement | null>(null);
/**
 * 独立入口的激活：键盘 Enter/Space 与指针点击都落到同一个原生取色器上。
 * 先 focus 再 click —— 即使某个内核拒绝由脚本 click 打开取色器，焦点也已经落在取色器上，
 * 再按一次 Enter/Space 仍能打开（Esc 关闭是原生取色器的行为）。
 */
function openCustomColorPicker() {
  customColorPicker.value?.focus({ preventScroll: true });
  customColorPicker.value?.click();
}
/** 连续拖色走 store 的按帧合并（同一入口，不另造状态）。 */
function onCustomColorInput(e: Event) {
  app.setThemeColor((e.target as HTMLInputElement).value, true);
}
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
/** 背景动效只有两档（开关 + 降级档），默认「缓慢流动」。 */
const ambientOptions = computed(() => [
  { value: "drift", label: t("settings.appearance.ambient.drift") },
  { value: "off", label: t("settings.appearance.ambient.off") },
]);
/**
 * 能力不支持时（系统关「透明效果」/ 内核没有 `backdrop-filter`），说明文字换成**原因**
 * 而不是原来的功能介绍 —— 否则用户看到"缓慢流动的柔和色雾"却选不了，会更困惑。
 * 判定只在 utils/ambientCapability.ts 一处（视图不碰 matchMedia / CSS.supports，护栏 ㉟）。
 */
const ambientDescription = computed(() => {
  const reason = app.ambientCapability.reason;
  if (reason === "reduced-transparency") return t("settings.appearance.ambient.unavailable.transparency");
  if (reason === "no-backdrop-filter") return t("settings.appearance.ambient.unavailable.backdropFilter");
  return t("settings.appearance.ambient.desc");
});
/**
 * 「减少透明效果」两档。WKWebView 不实现系统级 `prefers-reduced-transparency`，
 * 所以必须是应用内开关；默认跟随系统（读不到系统偏好 → 关闭），见 utils/reducedTransparency.ts。
 */
const transparencyOptions = computed(() => [
  { value: "false", label: t("settings.appearance.reducedTransparency.off") },
  { value: "true", label: t("settings.appearance.reducedTransparency.on") },
]);
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
      :label="t('settings.appearance.ambient')"
      :description="ambientDescription"
    >
      <SegmentedControl
        :model-value="app.ambientMotion"
        :options="ambientOptions"
        size="sm"
        :disabled="!app.ambientCapability.available"
        :aria-label="t('settings.appearance.ambient.aria')"
        @update:model-value="(v) => app.setAmbientMotion(v as 'off' | 'drift')"
      />
    </SettingsRow>

    <SettingsRow
      :label="t('settings.appearance.reducedTransparency')"
      :description="t('settings.appearance.reducedTransparency.desc')"
    >
      <SegmentedControl
        :model-value="app.reducedTransparency ? 'true' : 'false'"
        :options="transparencyOptions"
        size="sm"
        :aria-label="t('settings.appearance.reducedTransparency.aria')"
        @update:model-value="(v) => app.setReducedTransparency(v === 'true')"
      />
    </SettingsRow>

    <SettingsRow
      :label="t('settings.appearance.themeColor')"
      :description="t('settings.appearance.themeColor.desc')"
    >
      <div class="flex items-center gap-2" data-theme-color-picker>
        <!-- aria-label：色板格子只有颜色没有文字，读屏下必须靠 label 才知道它是什么 -->
        <button
          v-for="c in presets"
          :key="c"
          class="tap-safe h-6 w-6 rounded-full"
          :style="{ background: c, outline: app.themeColor === c ? '2px solid var(--gosslan-text)' : 'none', outlineOffset: '1px' }"
          :aria-label="t('settings.appearance.themeColor.aria', { color: c })"
          :aria-pressed="app.themeColor === c"
          :data-preset-color="c"
          @click="app.setThemeColor(c)"
        ></button>
        <!-- 分隔线：自定义是**另一类操作**，不是第 7 个色点（用户 2026-11-09 的原话）。 -->
        <span aria-hidden="true" class="mx-0.5 h-4 w-px shrink-0 bg-[var(--gosslan-divider)]"></span>
        <!-- 自定义入口：色轮图标 + 文字 + 胶囊边框。选中时才显示当前自定义色；
             选预置色时退回色轮（不跟随当前生效色），两者互斥。 -->
        <div
          class="custom-color-entry relative inline-flex h-6 shrink-0 items-center"
          data-custom-color-entry
          :data-selected="isCustomThemeColor ? 'true' : 'false'"
        >
          <button
            type="button"
            class="custom-color-surface tap-safe inline-flex h-6 items-center gap-1.5 rounded-full border border-[var(--gosslan-border)] bg-[var(--gosslan-bg)] pl-1.5 pr-2.5 text-caption text-[var(--gosslan-text-2)] transition-colors motion-reduce:transition-none"
            :aria-label="t('settings.appearance.customColor.aria')"
            :aria-pressed="isCustomThemeColor"
            @keydown.enter.prevent="openCustomColorPicker"
            @keydown.space.prevent="openCustomColorPicker"
            @click="openCustomColorPicker"
          >
            <span
              class="custom-color-wheel"
              :style="isCustomThemeColor ? { background: app.themeColor } : undefined"
              aria-hidden="true"
            ></span>
            <span class="custom-color-label">{{ t("settings.appearance.customColor") }}</span>
          </button>
          <input
            ref="customColorPicker"
            type="color"
            class="custom-color-input"
            :value="customPickerValue"
            tabindex="-1"
            aria-hidden="true"
            @input="onCustomColorInput"
          />
        </div>
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

<style scoped>
/* 自定义入口的色轮图标：未选中时是"取色器"，选中后由内联 style 换成当前自定义色。 */
.custom-color-wheel {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  border-radius: 9999px;
  background: conic-gradient(
    from 90deg,
    #e53e3e,
    #ff6b35,
    #eab308,
    #00b578,
    #0ea5e9,
    #2f6bff,
    #8b5cf6,
    #e53e3e
  );
  /* 内圈压暗 + 外圈提亮：自定义色恰好很暗（如 #123456）时，暗色底上仍能看到这个点的边界。 */
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.12), 0 0 0 1px rgb(255 255 255 / 0.22);
}
/* 选中态与盒模型都靠属性/伪类，不用内联 outline —— 内联样式会压过 :focus-visible，
   键盘用户就再也看不到焦点了。只画一道 2px 环，和 6 个预置点的选中态同一形状。 */
.custom-color-surface[aria-pressed="true"] {
  outline: 2px solid var(--gosslan-text);
  outline-offset: 1px;
  color: var(--gosslan-text);
}
.custom-color-surface:focus-visible {
  outline: 2px solid var(--gosslan-text);
  outline-offset: 1px;
}
.custom-color-entry:hover .custom-color-surface {
  background: var(--gosslan-hover);
}
/* 原生取色器铺满整个入口但完全透明：真实点击落在 input 上由内核直接打开系统取色器，
   Tab 只停在可见的 button（保持 aria-pressed 语义），Enter/Space 由 button 触发同一个 input。 */
.custom-color-input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  padding: 0;
  border: 0;
  opacity: 0;
  cursor: pointer;
  -webkit-appearance: none;
  appearance: none;
}
</style>
