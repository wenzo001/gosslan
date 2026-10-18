<script setup lang="ts">
import { computed } from "vue";
import { SliderRange, SliderRoot, SliderThumb, SliderTrack } from "reka-ui";
import { useAppStore } from "@/stores/useAppStore";
import SettingsGroup from "@/components/settings/SettingsGroup.vue";
import { CHAT_FONT_SIZES, CHAT_PRESETS, fontPx, resolveChatColors, type ChatPreset } from "@/utils/chatStyle";
import { t } from "@/i18n";

const app = useAppStore();

/** 当前字号在 CHAT_FONT_SIZES 里的索引（0..4）。 */
const fontIndex = computed(() => CHAT_FONT_SIZES.findIndex((f) => f.key === app.chatStyle.fontSize));

/** 把索引映射回 key 存到 store。 */
function applyFontIndex(idx: number) {
  const clamped = Math.max(0, Math.min(CHAT_FONT_SIZES.length - 1, idx));
  const key = CHAT_FONT_SIZES[clamped]?.key ?? "md";
  app.setChatStyle({ fontSize: key });
}

/** Reka Slider 的值是数组（支持多 thumb）；这里只有一个 thumb，取第 0 项。 */
function onSliderValue(v: number[] | undefined) {
  applyFontIndex(v?.[0] ?? 0);
}

/** 当前字号的 px 值（供预览气泡实时用 inline style）。 */
const currentFontPx = computed(() => fontPx(app.chatStyle.fontSize));

/** 滑块的可读值：px + 档位名。 */
const fontSizeLabel = computed(
  () =>
    `${currentFontPx.value}px · ${t(CHAT_FONT_SIZES[fontIndex.value]?.label ?? "chatStyle.fontSize.md")}`,
);

/** 预览色："theme" 预设按当前主题色实时派生，其余取表明暗值。 */
function swatchOf(p: ChatPreset): { mineBubble: string; otherBubble: string } {
  const c = resolveChatColors(p.key, app.themeColor, app.dark);
  return { mineBubble: c.mineBubble, otherBubble: c.otherBubble };
}

/** 预览气泡用当前配色 + 当前字号（不跟随 clamped —— 预览里的短文本就是普通气泡）。 */
const previewMineStyle = computed(() => {
  const c = resolveChatColors(app.chatStyle.preset, app.themeColor, app.dark);
  return {
    background: c.mineBubble,
    color: c.mineText,
    fontSize: `${currentFontPx.value}px`,
    borderRadius: "var(--gosslan-bubble-radius, 4px)",
    border: "1px solid transparent",
    padding: "6px 10px",
    lineHeight: "1.45",
    maxWidth: "75%",
    "--bubble-bg": c.mineBubble,
  };
});
const previewOtherStyle = computed(() => {
  const c = resolveChatColors(app.chatStyle.preset, app.themeColor, app.dark);
  return {
    background: c.otherBubble,
    color: c.otherText,
    fontSize: `${currentFontPx.value}px`,
    borderRadius: "var(--gosslan-bubble-radius, 4px)",
    border: "1px solid var(--gosslan-border)",
    padding: "6px 10px",
    lineHeight: "1.45",
    maxWidth: "75%",
    "--bubble-bg": c.otherBubble,
  };
});
</script>

<template>
  <SettingsGroup
    :title="t('settings.group.chatStyle')"
    :footer="t('settings.group.chatStyle.footer')"
  >
    <!-- 字体大小：预览气泡 + 滑块（仿微信"字体"设置）。
         上面摆一对方向相反的预览气泡（你/对方），字号实时跟随滑块变；
         下面一个 5 档离散滑块（step=1，min=0，max=4），两端 A 字标小/大。 -->
    <div class="px-4 py-3">
      <div class="mb-2 flex items-baseline justify-between">
        <div class="text-sm text-[var(--gosslan-text)]">{{ t("settings.chatStyle.fontSize") }}</div>
        <div class="text-[11px] text-[var(--gosslan-text-2)]">
          {{ currentFontPx }}px · {{ t(CHAT_FONT_SIZES[fontIndex]?.label ?? "chatStyle.fontSize.md") }}
        </div>
      </div>

      <!-- 预览气泡（两个反方向摆）。尖角位置和真实聊天一致——你发的右对齐、尖角朝右；对方左对齐、尖角朝左。
           但我们复用真实气泡的样式：background/color/fontSize 全部从当前主题实时算。 -->
      <div
        class="mb-3 flex flex-col gap-2 rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-bg)] px-3 py-3"
      >
        <!-- 对方气泡（左对齐）。 -->
        <div class="flex">
          <span class="relative inline-block" :style="previewOtherStyle">
            {{ t("settings.chatStyle.fontSize.preview") }}
          </span>
        </div>
        <!-- 我的气泡（右对齐）。 -->
        <div class="flex justify-end">
          <span class="relative inline-block" :style="previewMineStyle">
            {{ t("settings.chatStyle.fontSize.preview") }}
          </span>
        </div>
      </div>

      <!-- 字体档位滑块：行为交给 Reka Slider（方向键/Home/End/PageUp/PageDown、
           指针拖拽、触摸与禁用态），本组件只保留微信同款的 5 个刻度点 + 主题色 thumb 外观。 -->
      <div class="flex items-center gap-3">
        <span class="font-medium text-[var(--gosslan-text-2)]" style="font-size: 11px;">A</span>
        <SliderRoot
          :model-value="[fontIndex]"
          :min="0"
          :max="CHAT_FONT_SIZES.length - 1"
          :step="1"
          class="font-size-slider"
          @update:model-value="onSliderValue"
        >
          <SliderTrack class="font-size-slider-track">
            <span
              v-for="i in CHAT_FONT_SIZES.length"
              :key="i"
              class="font-size-slider-dot"
              :class="{ active: i - 1 === fontIndex }"
            />
            <SliderRange class="font-size-slider-range" />
          </SliderTrack>
          <SliderThumb
            class="font-size-slider-thumb"
            :aria-label="t('settings.chatStyle.fontSize')"
            :aria-valuetext="fontSizeLabel"
          />
        </SliderRoot>
        <span class="font-medium text-[var(--gosslan-text-2)]" style="font-size: 18px;">A</span>
      </div>
    </div>

    <div class="ml-4 h-px bg-[var(--gosslan-divider)]" />

    <!-- 气泡配色 -->
    <div class="px-4 py-3">
      <div class="mb-2 text-sm text-[var(--gosslan-text)]">{{ t("settings.chatStyle.bubble") }}</div>
      <div class="grid grid-cols-3 gap-2">
        <button
          v-for="p in CHAT_PRESETS"
          :key="p.key"
          class="rounded-[var(--gosslan-radius-md)] border p-2 transition hover:bg-[var(--gosslan-hover)]"
          :class="app.chatStyle.preset === p.key ? 'border-[var(--gosslan-primary)] ring-1 ring-[var(--gosslan-primary-ring)]' : 'border-[var(--gosslan-border)]'"
          :title="t(p.label)"
          :aria-pressed="app.chatStyle.preset === p.key"
          @click="app.setChatStyle({ preset: p.key })"
        >
          <div class="mb-1 text-center text-[11px] text-[var(--gosslan-text-2)]">{{ t(p.label) }}</div>
          <div class="flex items-center gap-1">
            <span class="h-4 flex-1 rounded-[var(--gosslan-radius-xs)]" :style="{ background: swatchOf(p).mineBubble }"></span>
            <span
              class="h-4 flex-1 rounded-[var(--gosslan-radius-xs)] border border-[var(--gosslan-border)]"
              :style="{ background: swatchOf(p).otherBubble }"
            ></span>
          </div>
        </button>
      </div>
    </div>
  </SettingsGroup>
</template>

<style scoped>
/**
 * 字号滑块的**外观**（行为由 Reka Slider 提供：方向键/Home/End/PageUp/PageDown、
 * 指针拖拽、触摸、禁用态与 aria-valuenow/min/max）。
 *
 * 结构（Reka 负责布局与事件）：
 *   SliderRoot.font-size-slider
 *     SliderTrack.font-size-slider-track  → 5 个刻度点 + SliderRange（隐藏）
 *     SliderThumb.font-size-slider-thumb  → 主题色圆点
 *
 * 不再自己写 pointerdown/move/up 与 x→档位换算：那套逻辑此前在 WebKit 触摸、
 * pointer capture 释放失败等边界上都要单独兜底，现在交给库。
 */

/* 滑块容器：relative + 固定高度。左右留白由 Reka 的 thumbAlignment="contain" 处理
   （0%/100% 时 thumb 会内收半个宽度），所以这里不再自己加 padding。
   touch-action: none —— 移动端触摸不触发页面滚动 / 缩放 / 点击高亮。 */
.font-size-slider {
  position: relative;
  flex: 1;
  height: 24px;
  display: block;
  cursor: pointer;
  outline: none;
  touch-action: none;
  -webkit-user-select: none;
  user-select: none;
}

/* 轨道：一条 4px 圆角灰条，绝对铺满容器中心。 */
.font-size-slider-track {
  position: absolute;
  left: 0;
  right: 0;
  top: 10px;
  height: 4px;
  border-radius: 2px;
  background: var(--gosslan-border);
  /* 5 个刻度圆点等间距分布；左右 8px 让首尾点与 thumb 中心对齐。 */
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 8px;
  box-sizing: border-box;
  z-index: 0;
}
/* 本设计只用“点 + thumb”表达档位，不画填充段。 */
.font-size-slider-range {
  display: none;
}
.font-size-slider-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  /* 用 color-mix 往黑色方向压 40% —— 比 border 深一档，和轨道（#e2e8f0）有明显对比。
     不用 transparent 混：transparent 在某些浏览器上会让 color-mix 输出半透明色，
     半透明圆叠在同色轨道上=看不见。直接混 black 出实色。 */
  background: color-mix(in srgb, var(--gosslan-border) 60%, black 40%);
  flex-shrink: 0;
  transition: background 120ms;
}
/* 选中档位对应的刻度点用主题色填充。 */
.font-size-slider-dot.active {
  background: var(--gosslan-primary);
}

/* thumb：主题色实心圆。position/left/transform 由 Reka 内联写，这里只负责大小与颜色。 */
.font-size-slider-thumb {
  top: 4px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--gosslan-primary);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
  transition: box-shadow 120ms;
  z-index: 1;
}
.font-size-slider:hover .font-size-slider-thumb {
  box-shadow: 0 0 0 4px var(--gosslan-primary-ring);
}
.font-size-slider:active .font-size-slider-thumb {
  box-shadow: 0 0 0 6px var(--gosslan-primary-ring);
}
.font-size-slider-thumb:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--gosslan-primary-ring);
}
</style>
