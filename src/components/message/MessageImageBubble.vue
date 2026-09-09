<script setup lang="ts">
import { ref, watch } from "vue";
import { ImageOff, ImageIcon } from "lucide-vue-next";

const props = defineProps<{ src: string }>();
const emit = defineEmits<{ (e: "open", src: string): void }>();

/** 加载态：先撑出骨架占位，避免大图加载时气泡高度塌陷、列表跳动。 */
const state = ref<"loading" | "loaded" | "failed">("loading");
watch(
  () => props.src,
  () => {
    state.value = "loading";
  },
);
</script>

<template>
  <div
    class="relative cursor-pointer overflow-hidden rounded-[var(--gosslan-bubble-radius)]"
    @click="state === 'loaded' && emit('open', src)"
  >
    <!-- 骨架：加载中占位，尺寸与常见截图相近，加载完成后被图片替换 -->
    <div
      v-if="state !== 'loaded'"
      class="flex h-32 w-52 items-center justify-center bg-black/5 dark:bg-white/5"
    >
      <ImageOff v-if="state === 'failed'" class="h-6 w-6 opacity-50" />
      <ImageIcon v-else class="h-6 w-6 animate-pulse opacity-40" />
    </div>
    <span v-if="state === 'failed'" class="absolute inset-x-0 bottom-1 text-center text-[11px] opacity-70">
      图片加载失败
    </span>
    <img
      :src="src"
      class="block max-h-72 max-w-full rounded-[var(--gosslan-bubble-radius)] object-contain"
      :class="state === 'loaded' ? '' : 'hidden'"
      @load="state = 'loaded'"
      @error="state = 'failed'"
    />
  </div>
</template>
