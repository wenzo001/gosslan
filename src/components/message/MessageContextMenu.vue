<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue";
import { Copy, CornerUpLeft, Save, Share2 } from "lucide-vue-next";
import type { MsgKind } from "@/types";

const props = defineProps<{
  x: number;
  y: number;
  kind: MsgKind;
}>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "copy-text"): void;
  (e: "copy-image"): void;
  (e: "save-image"): void;
  (e: "quote"): void;
  (e: "forward"): void;
}>();

/** 转发支持：文本 / 代码 / 图片（文件与系统消息不提供）。 */
const forwardable = (k: MsgKind) => k === "text" || k === "code" || k === "image";

/** 菜单定位：贴近屏幕边缘时向内收，避免溢出。 */
const pos = computed(() => ({
  left: `${Math.max(8, Math.min(props.x, window.innerWidth - 160))}px`,
  top: `${Math.max(8, Math.min(props.y, window.innerHeight - 230))}px`,
}));

// 点击菜单外 / 按 Esc 关闭（菜单根节点 @click.stop，内部点击不受影响）
function onDocClick() {
  emit("close");
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}
onMounted(() => {
  document.addEventListener("click", onDocClick);
  window.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => {
  document.removeEventListener("click", onDocClick);
  window.removeEventListener("keydown", onKey);
});
</script>

<template>
  <Teleport to="body">
    <div
      class="frost fixed z-[70] min-w-[140px] select-none rounded-lg border border-[var(--gosslan-border)] p-1 shadow-xl"
      :style="pos"
      @click.stop
      @contextmenu.prevent
    >
      <button
        v-if="kind === 'text' || kind === 'code'"
        class="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-[13px] text-[var(--gosslan-text)] transition hover:bg-[var(--gosslan-hover)]"
        @click="emit('copy-text')"
      >
        <Copy class="h-4 w-4 text-[var(--gosslan-text-2)]" />
        复制
      </button>
      <template v-if="kind === 'image'">
        <button
          class="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-[13px] text-[var(--gosslan-text)] transition hover:bg-[var(--gosslan-hover)]"
          @click="emit('copy-image')"
        >
          <Copy class="h-4 w-4 text-[var(--gosslan-text-2)]" />
          复制图片
        </button>
        <button
          class="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-[13px] text-[var(--gosslan-text)] transition hover:bg-[var(--gosslan-hover)]"
          @click="emit('save-image')"
        >
          <Save class="h-4 w-4 text-[var(--gosslan-text-2)]" />
          保存图片
        </button>
      </template>
      <button
        class="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-[13px] text-[var(--gosslan-text)] transition hover:bg-[var(--gosslan-hover)]"
        @click="emit('quote')"
      >
        <CornerUpLeft class="h-4 w-4 text-[var(--gosslan-text-2)]" />
        引用
      </button>
      <button
        v-if="forwardable(kind)"
        class="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-[13px] text-[var(--gosslan-text)] transition hover:bg-[var(--gosslan-hover)]"
        @click="emit('forward')"
      >
        <Share2 class="h-4 w-4 text-[var(--gosslan-text-2)]" />
        转发
      </button>
    </div>
  </Teleport>
</template>
