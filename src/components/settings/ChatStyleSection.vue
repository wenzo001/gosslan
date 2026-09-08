<script setup lang="ts">
import { useAppStore } from "@/stores/useAppStore";
import SettingsToggle from "@/components/settings/SettingsToggle.vue";
import { CHAT_FONT_SIZES, CHAT_PRESETS } from "@/utils/chatStyle";

const app = useAppStore();
</script>

<template>
  <section>
    <h3 class="mb-3 text-[13px] font-semibold text-[var(--gosslan-text)]">聊天显示</h3>
    <div class="space-y-3">
      <!-- 字体大小 -->
      <div>
        <div class="mb-1.5 text-sm">字体大小</div>
        <div class="flex gap-1 rounded-lg border border-[var(--gosslan-border)] p-0.5">
          <button
            v-for="f in CHAT_FONT_SIZES"
            :key="f.key"
            class="flex-1 rounded-md py-1.5 text-sm transition"
            :class="app.chatStyle.fontSize === f.key ? 'bg-primary text-white' : 'text-[var(--gosslan-text-2)] hover:bg-[var(--gosslan-hover)]'"
            @click="app.setChatStyle({ fontSize: f.key })"
          >
            {{ f.label }}
          </button>
        </div>
      </div>

      <!-- 气泡配色（可读性预设，双气泡预览） -->
      <div>
        <div class="mb-1.5 text-sm">气泡配色</div>
        <div class="grid grid-cols-3 gap-2">
          <button
            v-for="p in CHAT_PRESETS"
            :key="p.key"
            class="rounded-lg border p-2 transition hover:bg-[var(--gosslan-hover)]"
            :class="app.chatStyle.preset === p.key ? 'border-primary ring-1 ring-primary' : 'border-[var(--gosslan-border)]'"
            :title="p.label"
            @click="app.setChatStyle({ preset: p.key })"
          >
            <div class="mb-1 text-center text-[11px] text-[var(--gosslan-text-2)]">{{ p.label }}</div>
            <div class="flex items-center gap-1">
              <span class="h-4 flex-1 rounded" :style="{ background: p[app.dark ? 'dark' : 'light'].mineBubble }"></span>
              <span
                class="h-4 flex-1 rounded border border-[var(--gosslan-border)]"
                :style="{ background: p[app.dark ? 'dark' : 'light'].otherBubble }"
              ></span>
            </div>
          </button>
        </div>
        <p class="mt-1.5 text-[11px] leading-relaxed text-[var(--gosslan-text-2)]">
          我的消息用所选配色；对方也会按我的配色看到我发的消息（自动同步到已连接设备）。
        </p>
      </div>

      <!-- 紧凑模式 -->
      <div class="flex items-center justify-between rounded-lg border border-[var(--gosslan-border)] px-3 py-2">
        <div class="min-w-0">
          <div class="text-sm">消息合并显示</div>
          <div class="text-[11px] text-[var(--gosslan-text-2)]">连续消息省略头像与昵称（群聊推荐）</div>
        </div>
        <SettingsToggle
          :model-value="app.chatStyle.compact"
          @update:model-value="app.setChatStyle({ compact: $event })"
        />
      </div>
    </div>
  </section>
</template>
