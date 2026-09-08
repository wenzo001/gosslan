<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Save, X } from "lucide-vue-next";
import { useAppStore } from "@/stores/useAppStore";

const props = defineProps<{ src: string; open: boolean }>();
const emit = defineEmits<{ (e: "close"): void }>();

const app = useAppStore();

/** 保存图片：fetch 源(支持 dataURL 与 blob URL) → base64 → rust save_data_file 落盘 */
async function saveImage() {
  if (!props.src) return;
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { invoke } = await import("@tauri-apps/api/core");
    const destination = await save({ defaultPath: `图片-${Date.now()}.png` });
    if (!destination) return; // 用户取消
    const buf = new Uint8Array(await (await fetch(props.src)).arrayBuffer());
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < buf.length; i += chunk) {
      binary += String.fromCharCode(...buf.subarray(i, i + chunk));
    }
    await invoke("save_data_file", { base64Data: btoa(binary), destination });
    app.toast("图片已保存", "success");
  } catch (e) {
    app.toast(`保存图片失败：${e}`, "error");
  }
}

/** 缩放（滚轮，1~5 倍）与拖拽平移（放大后可拖动查看局部），双击复位。 */
const scale = ref(1);
const tx = ref(0);
const ty = ref(0);
let dragging = false;
let lastX = 0;
let lastY = 0;

function reset() {
  scale.value = 1;
  tx.value = 0;
  ty.value = 0;
}

function onWheel(e: WheelEvent) {
  e.preventDefault();
  const next = Math.min(5, Math.max(1, scale.value + (e.deltaY < 0 ? 0.2 : -0.2)));
  if (next === 1) {
    tx.value = 0;
    ty.value = 0;
  }
  scale.value = next;
}

function onPointerDown(e: PointerEvent) {
  if (scale.value <= 1) return;
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}
function onPointerMove(e: PointerEvent) {
  if (!dragging) return;
  tx.value += e.clientX - lastX;
  ty.value += e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;
}
function onPointerUp() {
  dragging = false;
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}

watch(
  () => props.open,
  (v) => {
    if (v) reset();
  },
);

onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="duration-150 ease-out"
      enter-from-class="opacity-0"
      leave-active-class="duration-100 ease-in"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        class="fixed inset-0 z-[80] flex items-center justify-center"
        style="background: rgba(0, 0, 0, 0.45); backdrop-filter: var(--gosslan-blur); -webkit-backdrop-filter: var(--gosslan-blur)"
        @click="emit('close')"
        @wheel="onWheel"
      >
        <!-- 右上操作区：保存 + 关闭（与其它弹窗一致的样式） -->
        <div class="absolute right-4 top-4 z-10 flex items-center gap-1">
          <button
            class="flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] text-white/85 transition hover:bg-white/15"
            title="保存图片"
            @click.stop="saveImage"
          >
            <Save class="h-4 w-4" />
            保存
          </button>
          <button
            class="flex h-9 w-9 items-center justify-center rounded-full text-white/85 transition hover:bg-white/15"
            title="关闭 (Esc)"
            @click.stop="emit('close')"
          >
            <X class="h-5 w-5" />
          </button>
        </div>
        <img
          :src="src"
          class="max-h-[85vh] max-w-[90vw] select-none rounded-xl shadow-2xl"
          :style="{
            transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
            cursor: scale > 1 ? (dragging ? 'grabbing' : 'grab') : 'zoom-in',
          }"
          draggable="false"
          @click.stop
          @dblclick="reset"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        />
        <div class="absolute bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-black/45 px-3 py-1 text-xs text-white/85">
          滚轮缩放 · 放大后拖动 · 双击复位 · Esc 关闭
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
