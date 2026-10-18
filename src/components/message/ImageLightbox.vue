<script setup lang="ts">
/* focus-ring-ok:file：本组件的**容器**带 `outline-none`（`role="menu"` / `role="dialog"` +
   `tabindex="-1"`，只用于把焦点接进来），焦点指示由内部条目/控件承担；
   给整块容器画 2px 环在全屏遮罩/弹出菜单上只会变成噪声。
   ⇒ 按 `designGuards` ⑦ 的约定，用文件级逃生阀显式声明，而不是靠"没人发现"。 */
import { clampScale, pinchScale, swipeDirection } from "@/utils/lightboxGestures";
import { t } from "@/i18n";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ChevronLeft, ChevronRight, Save } from "lucide-vue-next";
import { RotateCcw, X } from "@/components/ui/icons";
import { useAppStore } from "@/stores/useAppStore";
import { loadContentPreview, loadFilePreview, type PreviewResult } from "@/utils/filePreview";
import { saveImageAs } from "@/utils/saveImageAs";
import { StaleGuard } from "@/utils/staleGuard";
import { useBackLayer } from "@/composables/useBackLayer";

/**
 * 相册里的一张图 —— 三种来源，按下面的优先级取字节：
 *  ① `dataSrc`：已经拿到的 data URL / objectURL（合并转发卡片、旧格式消息）；
 *  ② `cid`：待办描述图片（sha256 = content store cid，载荷里没有 msg_id）；
 *  ③ `msgId`：聊天消息（走 readFilePreview）。
 */
interface GalleryImage {
  name: string;
  dataSrc?: string | null;
  msgId?: string;
  cid?: string;
}

const props = defineProps<{
  images: GalleryImage[];
  index: number;
  open: boolean;
  /**
   * 覆盖层顶部要让出来的高度（一个 CSS 长度，默认 0 = 铺满整窗）。
   *
   * 为什么需要（用户 2026-09-24 要求"各个端都要能正常使用"）：独立预览窗口用的是
   * `decorations:false` + 自绘标题栏，而**那条 caption 是整扇窗唯一的拖拽区**（`startDragging`
   * 挂在它的 mousedown 上）与 ✕ 所在。本组件是 `fixed inset-0 z-[80]`，直接铺满就会把
   * 标题栏连按钮一起盖住 —— 窗口打不开也移不动，等于"功能没实现"。传 `var(--gosslan-title-h)`
   * 就把那一条让出来；主窗口与移动端不传，行为与以前逐字相同。
   */
  topInset?: string;
  /**
   * 隐藏组件内部那颗 ✕（用户 2026-09-29：「独立窗口调用图片预览时，隐藏预览组件内部的关闭按钮，
   * 避免和窗口外部关闭按钮重复；同一窗口内调用时可以显示」）。
   *
   * 为什么用入参而不是"检测自己是不是在预览窗口里"：本组件同时服务两个宿主 ——
   * 主窗口那份覆盖层（**唯一的关闭出口就是它**）和独立预览窗口（`AuxWindowShell` 的标题栏
   * 已经有 ✕，两颗叉同屏就是用户说的那处重复）。宿主是谁只有调用点知道，所以由调用点说。
   *
   * ⚠️ 关掉这颗叉**不减少任何出口**：窗口那条路仍有标题栏 ✕、Esc、⌘W 三条
   * （见 `PreviewWindow.vue` 把 `close-requested` 三条路都接上 `releaseAlbum` 的注释）。
   */
  hideClose?: boolean;
}>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "update:index", v: number): void;
}>();

const app = useAppStore();

const current = computed(() => props.images[props.index] ?? null);
const hasMultiple = computed(() => props.images.length > 1);

/**
 * 给图片预览自己注册返回栈层 —— 否则 Android 侧滑返回会把 ChatWindow 那层
 * （ResponsiveLayout 的 useBackLayer #1）先关掉，聊天回到列表了但预览页还挂着
 * （用户 2026-09-19：「预览页还在但背后聊天框回到列表了」）。
 *
 * ⚠️ 注册顺序：本组件在 ChatWindow 里 mount，而 ChatWindow 在 ResponsiveLayout 之后
 * render，所以这条 useBackLayer 自然排在 #1 之后 → 关闭顺序正确：先关预览 → 再关聊天。 */
useBackLayer(
  () => props.open,
  () => emit("close"),
);

const src = ref<string>("");
const note = ref<string | null>(null);
const resolving = ref(false);

function apply(r: PreviewResult) {
  src.value = r.url ?? "";
  note.value = r.note ?? null;
}

/** 字节拿到了但浏览器解不出图（损坏 / 非图片）：清掉 src 走可见的错误出口，而不是留一张裂图。 */
function onImageError() {
  src.value = "";
  note.value = t("msg.cannotPreview");
  resolving.value = false;
}

/**
 * 预览解析的"只让最新一次落地"守卫（审计阶段 4 · 4.2）。
 *
 * `current` 一变就重解析，而 `loadContentPreview` / `loadFilePreview` 是异步的：
 * 缓存命中时**同步**返回、未命中时要跨 IPC。连按方向键翻图时，"先发起但后回来"的那次
 * 会把已经翻到的那张图覆盖成上一张（错图），或把它那张的空态覆盖掉（裂图/空图）。
 * `filePreview` 的缓存/in-flight 恰恰让这种交错更容易发生 —— 后发起的经常先回来。
 */
const resolveGuard = new StaleGuard();

/** 解析当前图片 src：dataSrc 直接用，否则按 cid（待办描述图）/ msg_id（聊天消息）读预览（带缓存，秒回）。 */
async function resolveCurrent() {
  const tok = resolveGuard.begin("current");
  const img = current.value;
  resolving.value = true;
  // 过了 await 之后的每一步都要问一句"我还是最新的那次吗"，是则 apply、否则整个丢弃
  const put = (r: PreviewResult) => {
    if (resolveGuard.isCurrent("current", tok)) apply(r);
  };
  try {
    if (!img) {
      // 同步分支也一律走 put：被更新的一次抢走后，"清空"同样不该执行
      put({});
      return;
    }
    if (img.dataSrc) {
      put({ url: img.dataSrc });
      return;
    }
    if (img.cid) {
      put(await loadContentPreview(img.cid, img.name));
      return;
    }
    if (img.msgId) {
      put(await loadFilePreview(img.msgId, "image", img.name));
      return;
    }
    put({});
  } finally {
    if (resolveGuard.isCurrent("current", tok)) resolving.value = false;
  }
}

watch(current, () => void resolveCurrent(), { immediate: true });

function go(delta: number) {
  if (props.images.length === 0) return;
  const next = (props.index + delta + props.images.length) % props.images.length;
  emit("update:index", next);
}

/** 保存当前图片：对话框 / 取字节 / 落盘收在 utils/saveImageAs（与 MessageItem 共用一份）。 */
async function saveImage() {
  if (!src.value) return;
  const item = current.value;
  const source = item?.msgId ? { msgId: item.msgId }
    : item?.cid ? { cid: item.cid }
      : undefined;
  try {
    if ((await saveImageAs(src.value, source)) === "saved") app.toast(t("msg.imageSaved"), "success");
  } catch (e) {
    app.toastError(e, t("msg.saveImageFail"));
  }
}

/**
 * 手势与缩放（HIG：查看大图要支持**双指缩放 + 左右滑动切图**，不是只有箭头按钮）。
 *
 * 三种手势共用一个指针表：
 *  · 单指 + 已放大 ⇒ 平移（看局部）；
 *  · 单指 + 原始尺寸 ⇒ 左右滑动切图（仅触屏；鼠标拖动不切图，避免误换图）；
 *  · 双指 ⇒ 按两指距离比例缩放（锚点不动，iOS 相册的手感）。
 * 判定阈值/主轴/边界全在 `utils/lightboxGestures.ts`（纯函数 + 单测）。
 */
const scale = ref(1);
const tx = ref(0);
const ty = ref(0);
let dragging = false;
let lastX = 0;
let lastY = 0;
/** 当前按下的指针（触屏才可能有多指）：id → 位置。 */
const pointers = new Map<number, { x: number; y: number }>();
/** 双指手势的起点：两指距离与当时的倍率。 */
let pinchStart: { distance: number; scale: number } | null = null;

function reset() {
  scale.value = 1;
  tx.value = 0;
  ty.value = 0;
  pointers.clear();
  pinchStart = null;
  dragging = false;
}

function onWheel(e: WheelEvent) {
  e.preventDefault();
  const next = clampScale(scale.value + (e.deltaY < 0 ? 0.2 : -0.2));
  if (next === 1) {
    tx.value = 0;
    ty.value = 0;
  }
  scale.value = next;
}

function twoPointerDistance(): number | null {
  if (pointers.size < 2) return null;
  const [a, b] = [...pointers.values()];
  if (!a || !b) return null;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function onPointerDown(e: PointerEvent) {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  if (pointers.size === 2) {
    // 进入双指：记下起点，随后按距离比例缩放
    pinchStart = { distance: twoPointerDistance() ?? 0, scale: scale.value };
    dragging = false;
    return;
  }
  if (scale.value > 1) {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
  }
}

function onPointerMove(e: PointerEvent) {
  const prev = pointers.get(e.pointerId);
  if (!prev) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  // ① 双指缩放
  if (pointers.size >= 2 && pinchStart) {
    const d = twoPointerDistance();
    if (d !== null) scale.value = pinchScale(pinchStart.distance, d, pinchStart.scale);
    // 缩回原始尺寸时把位移归零，否则图会停在屏幕外
    if (scale.value <= 1) {
      tx.value = 0;
      ty.value = 0;
    }
    return;
  }
  // ② 单指：已放大 ⇒ 平移
  if (dragging) {
    tx.value += e.clientX - lastX;
    ty.value += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    return;
  }
  // ③ 单指（仅触屏）在原始尺寸下的横向滑动留给 pointerup 判定（这里只累积，不做事），
  //    避免边滑边切图（手指还没抬起来就换图会很突兀）。
}

function onPointerUp(e: PointerEvent) {
  const start = pointers.get(e.pointerId);
  pointers.delete(e.pointerId);
  if (pointers.size === 0) pinchStart = null;
  if (!start) return;
  // 触屏滑动切图：只有"原始尺寸 + 单指 + 触屏"才判（鼠标拖动不换图）
  if (e.pointerType === "touch" && !dragging && scale.value <= 1) {
    const dir = swipeDirection(
      e.clientX - start.x,
      e.clientY - start.y,
      scale.value,
      props.index,
      props.images.length,
    );
    if (dir !== null) go(dir);
  }
  dragging = false;
}

function onKey(e: KeyboardEvent) {
  if (!props.open) return;
  if (e.key === "Escape") {
    emit("close");
    return;
  }
  if (e.key === "ArrowLeft") {
    go(-1);
    return;
  }
  if (e.key === "ArrowRight") {
    go(1);
    return;
  }
}

// 打开 / 关闭 / 切图时复位缩放与位移
watch(
  () => [props.open, props.index] as const,
  () => reset(),
);

/**
 * 打开时把焦点移进浮层（HIG：模态浮层要有 dialog 语义且焦点在其中）。
 * 本组件没有引入 headlessui Dialog（它是自绘的全屏预览），所以至少做到：
 * `role="dialog" aria-modal="true"` + 打开即聚焦容器（Tab 之后在浮层内流转），
 * 关闭后把焦点还给触发元素。
 */
const dialogRef = ref<HTMLElement | null>(null);
let restoreFocus: HTMLElement | null = null;
watch(
  () => props.open,
  (open) => {
    if (open) {
      restoreFocus = document.activeElement as HTMLElement | null;
      void nextTick(() => dialogRef.value?.focus());
    } else {
      restoreFocus?.focus?.();
      restoreFocus = null;
    }
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
        ref="dialogRef"
        tabindex="-1"
        class="glass fixed inset-x-0 bottom-0 top-[var(--gosslan-window-safe-top,0px)] z-[80] flex items-center justify-center outline-none"
        :style="{
          background: 'rgba(0, 0, 0, 0.45)',
          // 让开自绘 caption。**两层口径**，不要只留一层：
          //  · class 里那句 `top-[var(--gosslan-window-safe-top)]` 是**默认**（主窗那条路径）——
          //    主窗那个全局实例（`ResponsiveLayout.vue`）从来不传 `topInset`，改造前它整层
          //    滑到 caption（z-[85]）底下，右上角保存/关闭被压住；
          //  · 这里再让显式的 `topInset` prop（独立预览窗 `PreviewWindow.vue` 在传）
          //    优先覆盖默认值 —— 那条既有口径不动。
          // 移动端该变量为 0 ⇒ 与改造前逐字相同。
          ...(topInset ? { top: topInset } : {}),
        }"
        role="dialog"
        aria-modal="true"
        :aria-label="t('common.image')"
        @click="emit('close')"
        @wheel="onWheel"
      >
        <!-- 右上操作区：保存 + 关闭（与其它弹窗一致的样式） -->
        <!-- 移动端让开状态栏/挖孔（`safe-area-inset-top`）：用户 2026-09-12 实测
             「安卓端图片预览右上角的保存和叉叉与状态栏重叠」。
             ⚠️ **桌面端不能只靠 `topInset` prop**（2026-10-12 修）：那个 prop 只有独立预览窗
             （`PreviewWindow.vue`）在传，而**主窗**那个全局实例（`ResponsiveLayout.vue`）
             一个都没传 ⇒ 桌面端 `env()` 恒为 0，操作区落在 `top: 1rem`，被自绘 caption
             （z-[85]，Win 38px / macOS 28px）**压住** —— 用户要的"所有窗口统一做好显示安全区"
             漏的就是这一格。现在统一读 `--gosslan-window-safe-top`：
             桌面 = caption 高度、移动端 = 0，且 `env()` 那半照旧保留（真机上两者可能同时不为 0）。
             写成相加而不是取其一：移动端这个变量是 0 ⇒ 结果与改造前逐字相同（零回归）。 -->
        <div
          class="absolute right-4 z-10 flex items-center gap-1"
          :style="{ top: 'calc(var(--gosslan-window-safe-top, 0px) + env(safe-area-inset-top, 0px) + 1rem)' }"
        >
          <!-- 加 drop-shadow 让白字在白色图片上也可见（问题修复：白背景白字→隐形） -->
          <button
            class="flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] text-white/90 transition hover:bg-white/15"
            style="text-shadow: 0 1px 2px rgba(0,0,0,0.55); filter: drop-shadow(0 1px 2px rgba(0,0,0,0.35));"
            :title="t('common.saveImage')"
            @click.stop="saveImage"
          >
            <Save class="h-4 w-4" />
            {{ t("common.save") }}
          </button>
          <!-- 还原到自适应尺寸：双击图片也会触发 reset，但全屏遮罩上显式放个按钮
               更符合"放大后总要缩回去"的直觉（用户 2026-09-19）。只在 scale≠1 时显示，
               否则跟关闭按钮堆成一团显得多余。 -->
          <button
            v-if="scale !== 1"
            class="tap-safe flex h-9 w-9 items-center justify-center rounded-full text-white/90 transition hover:bg-white/15"
            style="text-shadow: 0 1px 2px rgba(0,0,0,0.55); filter: drop-shadow(0 1px 2px rgba(0,0,0,0.35));"
            :title="t('common.resetZoom')" :aria-label="t('common.resetZoom')"
            @click.stop="reset"
          >
            <RotateCcw class="h-4 w-4" />
          </button>
          <button
            v-if="!hideClose"
            class="tap-safe flex h-9 w-9 items-center justify-center rounded-full text-white/90 transition hover:bg-white/15"
            style="text-shadow: 0 1px 2px rgba(0,0,0,0.55); filter: drop-shadow(0 1px 2px rgba(0,0,0,0.35));"
            :title="t('common.closeEsc')" :aria-label="t('common.closeEsc')"
            @click.stop="emit('close')"
          >
            <X class="h-5 w-5" />
          </button>
        </div>

        <!-- 上一张 -->
        <button
          v-if="hasMultiple"
          class="absolute left-4 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white/90 transition hover:bg-white/20"
          :title="t('common.prev')" :aria-label="t('common.prev')"
          @click.stop="go(-1)"
        >
          <ChevronLeft class="h-6 w-6" />
        </button>

        <!-- 下一张 -->
        <button
          v-if="hasMultiple"
          class="absolute right-4 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white/90 transition hover:bg-white/20"
          :title="t('common.next')" :aria-label="t('common.next')"
          @click.stop="go(1)"
        >
          <ChevronRight class="h-6 w-6" />
        </button>

        <!-- 图片主体 -->
        <!-- img-eager-ok：这一支是用户**主动点开**、占满屏幕中央的那一张，不在虚拟列表里 ⇒
             懒加载只会让它更晚出现。designGuards ㉜ 靠这句标记整份跳过（例外写在该例外的旁边）。 -->
        <template v-if="src">
          <img :alt="current?.name || t('msg.imagePreview')"
            :src="src"
            class="max-h-[85vh] max-w-[88vw] touch-none select-none rounded-[var(--gosslan-radius-lg)] shadow-2xl"
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
            @error="onImageError"
          />
        </template>
        <div
          v-else
          class="flex h-48 flex-col items-center justify-center gap-3 px-8 text-center text-sm text-white/70"
        >
          <template v-if="resolving">
            <span class="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white/80"></span>
            {{ t("msg.lightbox.loading") }}
          </template>
          <template v-else>
            <span>{{ note ?? t("msg.cannotPreview") }}</span>
            <button
              v-if="current?.msgId || current?.cid"
              type="button"
              class="tap-safe rounded-[var(--gosslan-radius-md)] bg-white/15 px-3 py-1.5 text-xs text-white transition hover:bg-white/25"
              @click.stop="resolveCurrent()"
            >
              {{ t("common.retry") }}
            </button>
          </template>
        </div>

        <!-- 底部提示：计数 + 操作说明 -->
        <div
          class="absolute left-1/2 -translate-x-1/2 rounded-full bg-black/45 px-3 py-1 text-xs text-white/85"
          :style="{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 1.25rem)' }"
        >
          <template v-if="hasMultiple">{{ t("msg.lightbox.multiHint", { i: index + 1, n: images.length }) }}</template>
          <template v-else>{{ t("msg.lightbox.singleHint") }}</template>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
