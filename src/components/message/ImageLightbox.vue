<script setup lang="ts">
/* focus-ring-ok:file：本组件的**容器**带 `outline-none`（`role="menu"` / `role="dialog"` +
   `tabindex="-1"`，只用于把焦点接进来），焦点指示由内部条目/控件承担；
   给整块容器画 2px 环在全屏遮罩/弹出菜单上只会变成噪声。
   ⇒ 按 `designGuards` ⑦ 的约定，用文件级逃生阀显式声明，而不是靠"没人发现"。 */
import { clampScale, pinchScale, swipeDirection } from "@/utils/lightboxGestures";
import { t } from "@/i18n";
import Spinner from "@/components/ui/Spinner.vue";
import { computed, ref, watch } from "vue";
import { useEventListener } from "@vueuse/core";
import { FocusScope } from "reka-ui";
import { ChevronLeft, ChevronRight, Save } from "lucide-vue-next";
import { RotateCcw, X } from "@/components/ui/icons";
import { useAppStore } from "@/stores/useAppStore";
import { loadContentPreview, loadFilePreview, type PreviewResult } from "@/utils/filePreview";
import { PREVIEW_FAILURE_KEYS } from "@/utils/mediaAvailability";
import { saveImageAs } from "@/utils/saveImageAs";
import { StaleGuard } from "@/utils/staleGuard";
import { useBackLayer } from "@/composables/useBackLayer";
import { animate, motion, useMotionValue, useReducedMotion } from "@/utils/motion";

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
const reducedMotion = useReducedMotion();

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
  note.value = r.failure ? t(PREVIEW_FAILURE_KEYS[r.failure]) : null;
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
/** 连续手势的变换走 MotionValue：拖动/缩放不经过 Vue 渲染周期；ref 只保留给 UI 判据（复位按钮/光标）。 */
const scaleMV = useMotionValue(1);
const txMV = useMotionValue(0);
const tyMV = useMotionValue(0);
function setScale(v: number) {
  scale.value = v;
  scaleMV.set(v);
}
function setTranslate(x: number, y: number) {
  tx.value = x;
  ty.value = y;
  txMV.set(x);
  tyMV.set(y);
}
let dragging = false;
let lastX = 0;
let lastY = 0;
/** 当前按下的指针（触屏才可能有多指）：id → 位置。 */
const pointers = new Map<number, { x: number; y: number }>();
/** 双指手势的起点：两指距离与当时的倍率。 */
let pinchStart: { distance: number; scale: number } | null = null;

function reset(instant = false) {
  pointers.clear();
  pinchStart = null;
  dragging = false;
  scale.value = 1;
  tx.value = 0;
  ty.value = 0;
  if (instant || reducedMotion.value) {
    scaleMV.set(1);
    txMV.set(0);
    tyMV.set(0);
    return;
  }
  // 双击/点复位键：弹性回到原位；手势本身仍是直接跟手。
  animate(scaleMV, 1, { type: "spring", stiffness: 420, damping: 40 });
  animate(txMV, 0, { duration: 0.18 });
  animate(tyMV, 0, { duration: 0.18 });
}

function onWheel(e: WheelEvent) {
  e.preventDefault();
  const next = clampScale(scale.value + (e.deltaY < 0 ? 0.2 : -0.2));
  if (next === 1) setTranslate(0, 0);
  setScale(next);
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
    if (d !== null) setScale(pinchScale(pinchStart.distance, d, pinchStart.scale));
    // 缩回原始尺寸时把位移归零，否则图会停在屏幕外
    if (scale.value <= 1) setTranslate(0, 0);
    return;
  }
  // ② 单指：已放大 ⇒ 平移
  if (dragging) {
    setTranslate(tx.value + e.clientX - lastX, ty.value + e.clientY - lastY);
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

/**
 * 点击遮罩关窗：只认**按下与点击落在同一个元素**的那一次。
 *
 * 用户 2026-10-23：「上一张/下一张按钮按靠上的地方会把这个图关掉」。根因是那两颗按钮原先
 * 用 `-translate-y-1/2` 定位，而全局按压规则 `button:active { transform: scale(.97) }`
 * 与它**同优先级、在样式表里更靠后** ⇒ 按下瞬间整颗按钮下移 22px。按在顶部那半时，
 * pointerup 已经落到遮罩上，浏览器把 click 派发到二者的共同祖先（= 遮罩）⇒ 直接关窗。
 *
 * 定位改成不占 transform 的居中后按钮不再移动；这里再加两条与实现无关的守卫：
 *  ① 控件上的点击（按钮/链接/输入）一律不关窗 —— 它们自己的 `@click.stop` 已经拦住了，
 *     这条兜住"将来某个控件漏了 `.stop`"的漏网路径；
 *  ② 按下与点击**必须是同一个目标** —— 按下在按钮/图片、抬起落到遮罩时，浏览器会把 click
 *     派发到二者共同祖先（遮罩）；这种手势不是"点遮罩"，不许关窗。
 */
let lastPointerDownTarget: EventTarget | null = null;
function onShadePointerDown(e: PointerEvent) {
  lastPointerDownTarget = e.target;
}
function onShadeClick(e: MouseEvent) {
  if (e.target instanceof Element && e.target.closest("button, a, input, textarea, select, [role='button']")) return;
  if (e.target !== lastPointerDownTarget) return;
  emit("close");
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
  () => reset(true),
);

/**
 * 打开时把焦点接进浮层，关闭后还给触发元素 —— 这两件（连同 Tab 环、焦点逃逸拉回）
 * 都交给 Reka `FocusScope`，本组件只保留图片预览自己的手势与业务出口。
 *
 * 为什么 mount 时阻止默认：FocusScope 默认聚焦第一颗可 Tab 元素（保存按钮），
 * 预览一打开就出现按钮焦点环；旧行为聚焦容器（`outline-none`），这里保持逐字一致。
 * 容器拿到焦点后 FocusScope 仍会记录 lastFocused，Tab 仍从容器流向第一颗按钮。
 */
const dialogRef = ref<HTMLElement | null>(null);

function onMountAutoFocus(event: Event) {
  event.preventDefault();
  dialogRef.value?.focus();
}

useEventListener(window, "keydown", onKey);
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="duration-150 ease-out motion-reduce:transition-none"
      enter-from-class="opacity-0"
      leave-active-class="duration-100 ease-in motion-reduce:transition-none"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        class="glass fixed inset-x-0 bottom-0 top-[var(--gosslan-safe-top,0px)] z-[80] outline-none"
        :style="{ background: 'rgba(0, 0, 0, 0.45)' }"
        role="dialog"
        aria-modal="true"
        :aria-label="t('common.image')"
        @pointerdown="onShadePointerDown"
        @click="onShadeClick"
        @wheel="onWheel"
      >
        <!-- FocusScope 只包**内容层**（全屏命中与遮罩仍是外面那一层 fixed 外壳，
             这样「Teleport 根节点是 fixed」的判据与几何都不动）：
             `as-child` 把容器落在下一颗 div 上（不新增包装层），`loop` + `trapped`
             负责 Tab 环与焦点逃逸拉回；关闭卸载时由它把焦点还给打开前的元素。 -->
        <FocusScope :trapped="open" loop as-child @mount-auto-focus="onMountAutoFocus">
        <div ref="dialogRef" tabindex="-1" class="flex h-full w-full items-center justify-center outline-none">
        <!-- 右上操作区：保存 + 关闭（与其它弹窗一致的样式） -->
        <!-- 右上操作区的竖直位置：**让位只由外壳那一层做**，这一层只留自己 1rem 的视觉边距。
             历史三步都在这里加码，所以把它写清楚免得有人再加回来：
             · 2026-09-12 用户实测「安卓端图片预览右上角的保存和叉叉与状态栏重叠」⇒ 这里加了
               `env(safe-area-inset-top)`；
             · 2026-10-12 桌面主窗那一份没让开自绘 caption ⇒ 这里又加了 `--gosslan-window-safe-top`
               （同一天外壳也加了让位，两处就叠成了两遍）；
             · 2026-10-20 把「谁让开顶部」收成一个出口 `--gosslan-safe-top`（桌面=caption、移动端=
               刘海/状态栏，取 max 不是相加）挂在**外壳**上，这一层的两个补丁一起删。
             真浏览器量过：钉 44px 时旧写法 delta=60（44+16），现在 delta=16。
             ⚠️ 那颗 ✕ 是否在，由宿主决定（`hideClose`），与本条无关。 -->
        <div
          class="absolute right-4 z-10 flex items-center gap-1"
          :style="{ top: '1rem' }"
        >
          <!-- 加 drop-shadow 让白字在白色图片上也可见（问题修复：白背景白字→隐形）。
               用户 2026-10-23 追加：一律再加一圈 ring 描边 —— 阴影在纯白图 + 浅色遮罩下
               仍然会糊掉，描边是几何边界，不依赖对比度。 -->
          <button
            class="flex h-9 items-center gap-1.5 rounded-full bg-black/35 px-3 text-body text-white ring-1 ring-white/25 transition hover:bg-black/55"
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
            class="tap-safe flex h-9 w-9 items-center justify-center rounded-full bg-black/35 text-white ring-1 ring-white/25 transition hover:bg-black/55"
            style="text-shadow: 0 1px 2px rgba(0,0,0,0.55); filter: drop-shadow(0 1px 2px rgba(0,0,0,0.35));"
            :title="t('common.resetZoom')" :aria-label="t('common.resetZoom')"
            @click.stop="reset()"
          >
            <RotateCcw class="h-4 w-4" />
          </button>
          <button
            v-if="!hideClose"
            class="tap-safe flex h-9 w-9 items-center justify-center rounded-full bg-black/35 text-white ring-1 ring-white/25 transition hover:bg-black/55"
            style="text-shadow: 0 1px 2px rgba(0,0,0,0.55); filter: drop-shadow(0 1px 2px rgba(0,0,0,0.35));"
            :title="t('common.closeEsc')" :aria-label="t('common.closeEsc')"
            @click.stop="emit('close')"
          >
            <X class="h-5 w-5" />
          </button>
        </div>

        <!-- 上一张。⚠️ 控件底必须是**实色/深色**，不是 white/10：白图放大时
             `bg-white/10` 完全看不见（用户 2026-10-23：「白色图片放大看不清」）。
             ⚠️ 竖向居中交给**外层 div** 的 `-translate-y-1/2`，按钮自己不带定位 transform：
             全局按压规则会写 `button:active { transform: scale(.97) }`（同优先级、更靠后），
             写在按钮上会把 `-translate-y-1/2` 整个顶掉 ⇒ 按下时按钮下移 22px、顶部的点击
             落到遮罩上直接关窗（用户 2026-10-23 实测）。按钮只负责缩小反馈。 -->
        <div v-if="hasMultiple" class="absolute left-4 top-1/2 z-10 -translate-y-1/2">
          <button
            class="flex h-11 w-11 items-center justify-center rounded-full bg-black/55 text-white shadow-lg ring-1 ring-white/30 transition hover:bg-black/70"
            style="filter: drop-shadow(0 2px 6px rgba(0,0,0,0.55));"
            :title="t('common.prev')" :aria-label="t('common.prev')"
            @click.stop="go(-1)"
          >
            <ChevronLeft class="h-6 w-6" />
          </button>
        </div>

        <!-- 下一张 -->
        <div v-if="hasMultiple" class="absolute right-4 top-1/2 z-10 -translate-y-1/2">
          <button
            class="flex h-11 w-11 items-center justify-center rounded-full bg-black/55 text-white shadow-lg ring-1 ring-white/30 transition hover:bg-black/70"
            style="filter: drop-shadow(0 2px 6px rgba(0,0,0,0.55));"
            :title="t('common.next')" :aria-label="t('common.next')"
            @click.stop="go(1)"
          >
            <ChevronRight class="h-6 w-6" />
          </button>
        </div>

        <!-- 图片主体 -->
        <!-- img-eager-ok：这一支是用户**主动点开**、占满屏幕中央的那一张，不在虚拟列表里 ⇒
             懒加载只会让它更晚出现。designGuards ㉜ 靠这句标记整份跳过（例外写在该例外的旁边）。 -->
        <template v-if="src">
          <!-- 手势的 x/y/scale 走 MotionValue（在 Vue 渲染周期外执行）。
               ⚠️ 不再挂 layoutId：缩略图侧已经不做 layout 补间，单边保留只是一段死契约。 -->
          <div class="flex items-center justify-center">
            <motion.img :alt="current?.name || t('msg.imagePreview')"
              :src="src"
              class="max-h-[85vh] max-w-[88vw] touch-none select-none shadow-2xl"
              :style="{
                x: txMV,
                y: tyMV,
                scale: scaleMV,
                cursor: scale > 1 ? (dragging ? 'grabbing' : 'grab') : 'zoom-in',
              }"
              draggable="false"
              @click.stop
              @dblclick="reset()"
              @pointerdown="onPointerDown"
              @pointermove="onPointerMove"
              @pointerup="onPointerUp"
              @pointercancel="onPointerUp"
              @error="onImageError"
            />
          </div>
        </template>
        <div
          v-else
          class="flex h-48 flex-col items-center justify-center gap-3 rounded-[var(--gosslan-radius-md)] bg-black/45 px-8 text-center text-sm text-white/90 ring-1 ring-white/15"
          style="text-shadow: 0 1px 2px rgba(0,0,0,0.55);"
        >
          <template v-if="resolving">
            <Spinner size-class="h-4 w-4" class="text-white/80" decorative />
            {{ t("msg.lightbox.loading") }}
          </template>
          <template v-else>
            <span>{{ note ?? t("msg.cannotPreview") }}</span>
            <button
              v-if="current?.msgId || current?.cid"
              type="button"
              class="tap-safe rounded-[var(--gosslan-radius-md)] bg-white/20 px-3 py-1.5 text-xs text-white ring-1 ring-white/30 transition hover:bg-white/30"
              @click.stop="resolveCurrent()"
            >
              {{ t("common.retry") }}
            </button>
          </template>
        </div>

        <!-- 底部提示：计数 + 操作说明 -->
        <div
          class="absolute left-1/2 -translate-x-1/2 rounded-full bg-black/55 px-3 py-1 text-xs text-white/95 shadow-lg ring-1 ring-white/20"
          :style="{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 1.25rem)', textShadow: '0 1px 2px rgba(0,0,0,0.6)' }"
        >
          <template v-if="hasMultiple">{{ t("msg.lightbox.multiHint", { i: index + 1, n: images.length }) }}</template>
          <template v-else>{{ t("msg.lightbox.singleHint") }}</template>
        </div>
        </div>
        </FocusScope>
      </div>
    </Transition>
  </Teleport>
</template>
