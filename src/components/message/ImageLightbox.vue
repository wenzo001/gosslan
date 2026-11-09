<script setup lang="ts">
import Icon from "@/components/ui/Icon.vue";
/* focus-ring-ok:file：本组件的**容器**带 `outline-none`（`role="menu"` / `role="dialog"` +
   `tabindex="-1"`，只用于把焦点接进来），焦点指示由内部条目/控件承担；
   给整块容器画 2px 环在全屏遮罩/弹出菜单上只会变成噪声。
   ⇒ 按 `designGuards` ⑦ 的约定，用文件级逃生阀显式声明，而不是靠"没人发现"。 */
import { clampScale, pinchScale, swipeDirection } from "@/utils/lightboxGestures";
import { flipTransform, type ImageRect } from "@/utils/imageZoom";
import { t } from "@/i18n";
import Spinner from "@/components/ui/Spinner.vue";
import { computed, onUnmounted, ref, watch } from "vue";
import { useEventListener } from "@vueuse/core";
import { FocusScope, DropdownMenuItem } from "reka-ui";
import ContextMenu from "@/components/ContextMenu.vue";
import { useAppStore } from "@/stores/useAppStore";
import { loadContentPreview, loadFilePreview, type PreviewResult } from "@/utils/filePreview";
import { loadFavoritePreview } from "@/utils/favoritePreview";
import { PREVIEW_FAILURE_KEYS } from "@/utils/mediaAvailability";
import { api } from "@/api";
import { saveImageAs } from "@/utils/saveImageAs";
import { StaleGuard } from "@/utils/staleGuard";
import { useBackLayer } from "@/composables/useBackLayer";
import { animate, motion, useMotionValue, useReducedMotion } from "@/utils/motion";
import { motionEase, motionSeconds } from "@/utils/motionTokens";

/**
 * 相册里的一张图 —— 三种来源，按下面的优先级取字节：
 *  ① `dataSrc`：已经拿到的 data URL / objectURL（合并转发卡片、旧格式消息）；
 *  ② `cid`：待办描述图片（sha256 = content store cid，载荷里没有 msg_id）；
 *  ③ `msgId`：聊天消息（走 readFilePreview）；
 *  ④ `favoriteId`：收藏页（走 loadFavoritePreview）。
 *
 * 类型直接用 `@/types` 的 `PreviewImage`（与 api / store / 预览窗口是**同一份**线格式），
 * 别在这里再抄一遍 —— 抄出来的第二份迟早会漏字段（2026-11-06 就真漏了 `favoriteId`，
 * `vue-tsc` 才把它挡住）。
 */
import type { PreviewImage } from "@/types";

const props = defineProps<{
  images: PreviewImage[];
  index: number;
  open: boolean;
  /**
   * 这次打开时被点中的缩略图矩形（client 坐标）。有它才做"从这里放大"的 FLIP；
   * 没有（键盘/菜单打开、其他入口）就退化为**居中放大**（只缩放、位移恒 0），不乱飞。
   * 关闭时用它作为缩回终点。
   */
  origin?: ImageRect | null;
  /**
   * 隐藏组件自带的 ✕（独立预览窗口用）。
   *
   * 那扇窗已经有标题栏的关闭按钮 + Esc，再画一颗 ✕ 会变成"两个关同一扇窗的按钮"；
   * 而窗口里的"关闭"必须走 `getCurrentWindow().close()`（销毁窗口），不是收起一份覆盖层。
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
  () => requestClose(),
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
    // 同步分支也一律走 put：被更新的一次抢走后，"清空"同样不该执行
    put(await loadImageSrc(img));
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

/**
 * 顶栏的**元数据**：当前图的原图尺寸（自然像素）与缩放读数。
 * 尺寸只在图片真正解码后才有（`onImageLoad` 里从 naturalWidth/Height 取），
 * 不额外请求任何东西；缩放百分比读的就是手势那一份 `scale`，不是第二份状态。
 * ⚠️ 这两项**只在顶栏出现一次**（用户 2026-11-08：底部再写一遍既重复又压图）。
 */
const naturalSize = ref<{ w: number; h: number } | null>(null);
const zoomPct = computed(() => Math.round(scale.value * 100));
/** 尺寸文案只在这里拼一次：顶栏是它唯一的消费点。 */
const sizeText = computed(() => (naturalSize.value
  ? t("msg.lightbox.originalSize", { w: naturalSize.value.w, h: naturalSize.value.h })
  : ""));

/**
 * 底部缩略图条只给"当前这张前后各 6 张"取字节。
 *
 * 相册可能是整段会话的全部图片（`ChatWindow` 会把已加载消息里的图收进来），全量取字节
 * 会把 IPC 打满；`loadFilePreview` 的并发闸只有 3，排队反而让当前这张更慢。
 * 翻到别处时窗口跟着滚过去，旧缓存留着（回翻不用再取）。
 */
const THUMB_WINDOW = 6;
const thumbSrc = ref<Record<number, string>>({});
let thumbGen = 0;

/** 三种来源（dataSrc / cid / msgId / favoriteId）共用同一份取字节口径，灯箱本体与缩略图都走它。 */
function loadImageSrc(img: PreviewImage | null): Promise<PreviewResult> {
  if (!img) return Promise.resolve({});
  if (img.dataSrc) return Promise.resolve({ url: img.dataSrc });
  if (img.cid) return loadContentPreview(img.cid, img.name);
  if (img.msgId) return loadFilePreview(img.msgId, "image", img.name);
  if (img.favoriteId) return loadFavoritePreview(img.favoriteId, img.name);
  return Promise.resolve({});
}

// 换了一整个相册（独立窗口被替换内容 / 灯箱换入口）：旧索引的缩略图与尺寸都作废。
// 注册顺序在下面的加载 watcher 之前 ⇒ 同一轮里先清空再取新的。
watch(() => props.images, () => {
  thumbSrc.value = {};
  naturalSize.value = null;
});

watch(() => props.index, () => {
  naturalSize.value = null;
});

watch([() => props.images, () => props.index], async () => {
  const gen = ++thumbGen;
  const from = Math.max(0, props.index - THUMB_WINDOW);
  const to = Math.min(props.images.length, props.index + THUMB_WINDOW + 1);
  for (let i = from; i < to; i += 1) {
    if (thumbSrc.value[i]) continue;
    const src = (await loadImageSrc(props.images[i] ?? null)).url;
    if (gen !== thumbGen) return;
    if (src) thumbSrc.value = { ...thumbSrc.value, [i]: src };
  }
}, { immediate: true });

/**
 * 打开/关闭的 FLIP 缩放（用户 2026-11-05：「点图片应该放大缩小，现在只有一下位移感」）。
 *
 * 只在**从无到有**时播一次：第一帧用 `flipTransform` 把图片矩形精确映射到缩略图矩形，
 * 再把四个变换分量收回恒等。翻到下一张（状态切换）**不重播**缩放，避免"每翻一张都先缩一下"。
 * `prefers-reduced-motion` 下直接切换，不缩放。
 * 纯 transform，不碰 left/top/width/height —— 不重排，也就没有横向滑动感。
 *
 * 时长与曲线全部来自令牌：打开用 `--gosslan-duration`（桌面 240 / 移动 280），
 * 收起用 `--gosslan-duration-exit`（180 / 200，短于入场，满足"出场不长于入场"）；
 * 曲线统一 `--gosslan-ease`，不再写 `easeOut` / `easeIn` 两条系统曲线。
 * 组件里出现字面毫秒会被 `motionSystem.test.ts` 判红。
 */
const flipTween = (direction: "open" | "close") => ({
  duration: motionSeconds(direction === "open" ? "--gosslan-duration" : "--gosslan-duration-exit"),
  ease: motionEase(),
});
/**
 * 没有源矩形时的退化档（键盘/菜单打开）：**居中放大**。
 * 只改 scale、位移恒为 0，因此不可能出现任何横向滑动；
 * 起点取 0.92 而不是 0（查看器里的图已经占满大半屏，从 0 长出来会像"炸开"）。
 */
const CENTER_ZOOM_FROM = 0.92;
/** 收场动画播完后再留一小段，让"缩回原图位置"真的被看见（而不是最后一帧还没到位就撤浮层）。 */
const CLOSE_HOLD_MS = 60;
const flipScaleX = useMotionValue(1);
const flipScaleY = useMotionValue(1);
/** 开始 FLIP 的那次打开：只有它为真时才隐藏图片等尺寸落定。 */
const pendingFlip = ref(false);
/** 没有源矩形时走居中放大（键盘/菜单打开）；与 `pendingFlip` 互斥。 */
const pendingCenter = ref(false);
/** 图片要先量到"落定后的矩形"再显示，避免先以终态闪一帧再缩小。 */
const imgReady = ref(true);
const closing = ref(false);
/** 终态矩形（恒等变换下），关闭时用它反算回缩目标。 */
const flipBaseRect = ref<ImageRect | null>(null);
let flipAnims: ReturnType<typeof animate>[] = [];
let flipTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

function stopFlipAnims() {
  for (const a of flipAnims) {
    try { a.stop(); } catch { /* 已经停下就算了 */ }
  }
  flipAnims = [];
}
function clearFlipTimer() {
  if (flipTimer !== null) clearTimeout(flipTimer);
  flipTimer = null;
}
function clearCloseTimer() {
  if (closeTimer !== null) clearTimeout(closeTimer);
  closeTimer = null;
}

/** 量终态矩形。⚠️ 必须在**恒等变换**下量：`getBoundingClientRect` 会把当前 transform 算进去。 */
function measure(el: HTMLElement): ImageRect | null {
  const r = el.getBoundingClientRect();
  if (!(r.width > 0) || !(r.height > 0)) return null;
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/** 把 FLIP 分量归位（不经过动画）。 */
function resetFlip() {
  stopFlipAnims();
  clearFlipTimer();
  flipScaleX.set(1);
  flipScaleY.set(1);
  flipBaseRect.value = null;
  pendingFlip.value = false;
  pendingCenter.value = false;
}

/**
 * 图片解码完成：这一刻才知道它在查看器里的最终矩形。
 * 有起点矩形就把四个变换先**瞬时**摆到起点（此时图片还透明），下一帧再显示并收回恒等。
 * 没有起点矩形（键盘/菜单打开）则退化为**居中放大**：只缩到 0.92，位移恒 0。
 */
function onImageLoad(e?: Event) {
  const target = e?.currentTarget;
  const el = target instanceof HTMLImageElement
    ? target
    : (dialogRef.value?.querySelector<HTMLImageElement>("[data-lightbox-img]") ?? null);
  if (!el || !props.open || closing.value) return;
  // 顶栏/底栏显示的"原图 · W × H"就取这一次解码后的自然尺寸，不另发请求。
  if (el.naturalWidth > 0 && el.naturalHeight > 0) {
    naturalSize.value = { w: el.naturalWidth, h: el.naturalHeight };
  }
  stopFlipAnims();
  clearFlipTimer();
  flipScaleX.set(1);
  flipScaleY.set(1);
  const base = measure(el);
  flipBaseRect.value = base;
  const o = props.origin;
  const flip = pendingFlip.value && !!base && !!o && !reducedMotion.value;
  const center = pendingCenter.value && !!base && !o && !reducedMotion.value;
  if (!flip && !center) {
    pendingFlip.value = false;
    pendingCenter.value = false;
    imgReady.value = true;
    setTranslate(0, 0);
    return;
  }
  if (flip && base && o) {
    const start = flipTransform(base, o);
    flipScaleX.set(start.scaleX);
    flipScaleY.set(start.scaleY);
    setTranslate(start.x, start.y);
  } else {
    flipScaleX.set(CENTER_ZOOM_FROM);
    flipScaleY.set(CENTER_ZOOM_FROM);
    setTranslate(0, 0);
  }
  const tween = flipTween("open");
  requestAnimationFrame(() => {
    if (!props.open || closing.value) return;
    // 先让图片以**起点姿态**显示出来（此时 transform 已写到 DOM），再在下一帧开始收回恒等：
    // 同一个 rAF 里立刻起动画的话，第一帧可能还是终态尺寸，会闪一下。
    imgReady.value = true;
    requestAnimationFrame(() => {
      if (!props.open || closing.value) return;
      flipAnims = [
        animate(flipScaleX, 1, tween),
        animate(flipScaleY, 1, tween),
        animate(txMV, 0, tween),
        animate(tyMV, 0, tween),
      ];
      flipTimer = setTimeout(() => {
        flipTimer = null;
        // 归位到恒等（动画终点本来就该是它，这里顺手把 ref 同步给手势判据）
        flipScaleX.set(1);
        flipScaleY.set(1);
        setTranslate(0, 0);
        pendingFlip.value = false;
        pendingCenter.value = false;
      }, 260);
    });
  });
}

/**
 * 唯一的关闭出口：先把图片缩回原图位置，动画结束后才真的 `emit("close")`。
 * 有源矩形 ⇒ FLIP 缩回缩略图；没有源矩形（键盘/菜单打开）⇒ 反向缩回 0.92，
 * **位移恒为 0**（只有缩放，不可能出现横向滑动）。reduce 档或没量到矩形时立刻关。
 * `closing` 期间所有手势与二次关闭都忽略 ⇒ 连点不会重复收窗。
 */
function requestClose() {
  if (!props.open || closing.value) return;
  menu.value = null;
  const o = props.origin;
  const base = flipBaseRect.value;
  if (reducedMotion.value || !base) {
    emit("close");
    return;
  }
  closing.value = true;
  stopFlipAnims();
  clearFlipTimer();
  const tween = flipTween("close");
  const back = o ? flipTransform(base, o) : null;
  const toX = back ? back.scaleX : CENTER_ZOOM_FROM;
  const toY = back ? back.scaleY : CENTER_ZOOM_FROM;
  const toTx = back ? back.x : 0;
  const toTy = back ? back.y : 0;
  flipAnims = [
    animate(flipScaleX, toX, tween),
    animate(flipScaleY, toY, tween),
    animate(scaleMV, 1, tween),
    animate(txMV, toTx, tween),
    animate(tyMV, toTy, tween),
  ];
  closeTimer = setTimeout(() => {
    closeTimer = null;
    // 动画播完再钉一次终值：帧采样的最后一帧可能落在曲线收尾的几毫秒里（差几像素）。
    // 钉完之后还留 `CLOSE_HOLD_MS`，让用户真的看见图缩回了原图位置。
    flipScaleX.set(toX);
    flipScaleY.set(toY);
    setTranslate(toTx, toTy);
    closeTimer = setTimeout(() => {
      closeTimer = null;
      // 缩到原图大小；隐藏它，让退场只剩下遮罩淡出，不在原位留下一张图。
      imgReady.value = false;
      emit("close");
    }, CLOSE_HOLD_MS);
  }, tween.duration * 1000);
}

onUnmounted(() => {
  stopFlipAnims();
  clearFlipTimer();
  clearCloseTimer();
  stopResetAnims();
});
function setScale(v: number) {
  stopResetAnims();
  scale.value = v;
  scaleMV.set(v);
}
function setTranslate(x: number, y: number) {
  stopResetAnims();
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

/** 复位（复位键 / `0` 键 / 滚轮缩到 1 以下）的弹性动画句柄。 */
let resetAnims: ReturnType<typeof animate>[] = [];
/**
 * 停掉尚未落定的复位弹性。
 *
 * 归位是 `animate(scaleMV, 1, spring)`：它会**每帧继续写** motion 值。若用户在这个弹簧还在跑的时候
 * 滚轮/按 +/- 缩放，`scaleMV.set(1.2)` 会被下一帧的弹簧覆盖回 1 —— 表现为"滚轮完全没反应"
 * （2026-11-05 探针实测：`0` 后 220ms 再滚轮，读数仍是 1.001）。手势接手前先收掉它。
 */
function stopResetAnims() {
  for (const a of resetAnims) {
    try { a.stop(); } catch { /* 已停下就算了 */ }
  }
  resetAnims = [];
}

function reset(instant = false) {
  pointers.clear();
  pinchStart = null;
  dragging = false;
  scale.value = 1;
  tx.value = 0;
  ty.value = 0;
  stopResetAnims();
  if (instant || reducedMotion.value) {
    scaleMV.set(1);
    txMV.set(0);
    tyMV.set(0);
    return;
  }
  // 点复位键：走同一套令牌（高频直接操作，用 fast 档），不再用弹簧。
  const resetTween = { duration: motionSeconds("--gosslan-duration-fast"), ease: motionEase() };
  resetAnims = [
    animate(scaleMV, 1, resetTween),
    animate(txMV, 0, resetTween),
    animate(tyMV, 0, resetTween),
  ];
}

/**
 * 双击 = **全屏切换**（进入 / 退出）。用户 2026-11-09：
 * 「双击那个查看图片的窗口可以全屏切换」「双击只用于最大化/全屏切换，不加第二个含义」。
 *
 * 一个手势只给一个含义：原来双击是"缩放复位"，现在统一成全屏；缩放仍在滚轮 /
 * − / % / + / 适应 / 双指上，不再有第二套双击语义。
 * 退出全屏由系统还原窗口 frame ⇒ 回到双击前的尺寸，不需要我们 `setInnerSize`
 * （那条补间 2026-11-05 已否决）。
 */
async function toggleFullscreen() {
  try {
    await api.windowToggleFullscreen();
  } catch {
    /* 移动端窗口本身就是全屏（命令返回 false）；失败不该影响看图 */
  }
}

function zoomBy(delta: number) {
  const next = clampScale(scale.value + delta);
  if (next === 1) setTranslate(0, 0);
  setScale(next);
}

function onWheel(e: WheelEvent) {
  e.preventDefault();
  zoomBy(e.deltaY < 0 ? 0.2 : -0.2);
}

/**
 * 右键菜单（桌面端）：查看器在独立窗口里时，保存只能靠右上角那颗按钮；
 * 覆盖层统一后补一个与别处一致的右键入口。层级必须压过 z-80 的遮罩，故传 z-[90]。
 */
const menu = ref<{ x: number; y: number } | null>(null);
function openMenu(e: MouseEvent) {
  e.preventDefault();
  menu.value = { x: e.clientX, y: e.clientY };
}
function closeMenu() {
  menu.value = null;
}

function twoPointerDistance(): number | null {
  if (pointers.size < 2) return null;
  const [a, b] = [...pointers.values()];
  if (!a || !b) return null;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * 单指滑动的**起点**（与 `pointers` 分开存）。
 *
 * 用户 2026-11-09：「多图片预览模式，左右滑动图片没法上一张下一张」。
 * 真因不是手指落点（图片外黑边也一样），而是 `pointers` 在 `pointermove` 里被持续改写成
 * **当前位置**，`pointerup` 又拿它当起点 ⇒ `dx` 恒为 0，`swipeDirection` 永远返回 null。
 * 只有"按下就抬起"（无 move）的手势碰巧能切图 —— 这也是"偶发能切"的来源。
 */
let swipeStart: { x: number; y: number } | null = null;

function onPointerDown(e: PointerEvent) {
  // 开场 FLIP / 收场回缩期间不接受手势：否则手势与动画同时写 transform，图会抖。
  if (closing.value || pendingFlip.value) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    // 进入双指：记下起点，随后按距离比例缩放
    pinchStart = { distance: twoPointerDistance() ?? 0, scale: scale.value };
    swipeStart = null;
    dragging = false;
    return;
  }
  swipeStart = { x: e.clientX, y: e.clientY };
  if (scale.value > 1) {
    // 只在**放大拖动**时显式捕获：捕获会把后续 click/dblclick 的目标改成捕获元素，
    // 而手势已挂到图片区域容器上 —— 原始尺寸的双击必须仍然落在 img 上（复位判据）。
    // 触屏的指针本来就有隐式捕获，滑动不依赖这一句。
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
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
  // 系统取消（滚动接管 / 边缘返回 / 来电）不是「用户抬指」：绝不能拿半程位移去切图。
  // 只清手势状态并退出；`dragging` 也要复位，否则下一次原始尺寸滑动会被当平移吃掉。
  if (e.type === "pointercancel") {
    pointers.delete(e.pointerId);
    if (pointers.size === 0) {
      pinchStart = null;
      swipeStart = null;
    }
    dragging = false;
    return;
  }
  // 起点用 `swipeStart`：`pointers` 里的坐标已在 move 时被改成当前位置（见上）。
  const start = swipeStart;
  pointers.delete(e.pointerId);
  if (pointers.size === 0) {
    pinchStart = null;
    swipeStart = null;
  }
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
  if (closing.value) return;
  if (e.target instanceof Element && e.target.closest("button, a, input, textarea, select, [role='button']")) return;
  if (e.target !== lastPointerDownTarget) return;
  requestClose();
}

function onKey(e: KeyboardEvent) {
  if (!props.open || closing.value) return;
  if (e.key === "Escape") {
    requestClose();
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
  // 桌面键位：`+`/`=` 放大、`-` 缩小、`0` 复位（与滚轮同一套 clampScale）。
  if (e.key === "+" || e.key === "=") {
    zoomBy(0.2);
    return;
  }
  if (e.key === "-" || e.key === "_") {
    zoomBy(-0.2);
    return;
  }
  if (e.key === "0") {
    reset();
  }
}

/**
 * 打开 / 切图时的变换复位。
 * `open` 从关到开 ⇒ 准备一次 FLIP（有起点矩形且不是 reduce 档）；翻图（状态切换）⇒ 只复位，
 * **不重播**缩放 —— 否则每翻一张都会先缩回原图再放大一次。
 */
watch(
  () => props.open,
  (open) => {
    closing.value = false;
    clearCloseTimer();
    if (!open) {
      menu.value = null;
      // ⚠️ 这里**不**把 scaleX/scaleY 复位：收场已经把图钉在原图大小，
      // Transition 退场那 100ms 保持这个姿态淡出。复位成 1 会让图先跳回终态大小
      // （平移还停在收场起点，看起来就是"关掉后突然又冒出一张大图"）。
      stopFlipAnims();
      clearFlipTimer();
      clearCloseTimer();
      pendingFlip.value = false;
      pendingCenter.value = false;
      imgReady.value = false;
      return;
    }
    reset(true);
    flipScaleX.set(1);
    flipScaleY.set(1);
    flipBaseRect.value = null;
    pendingFlip.value = !!props.origin && !reducedMotion.value;
    // 没有源矩形（键盘 / 右键菜单打开）⇒ 居中放大，而不是"什么都不播"。
    pendingCenter.value = !props.origin && !reducedMotion.value;
    imgReady.value = !(pendingFlip.value || pendingCenter.value);
  },
  { immediate: true },
);

watch(
  () => props.index,
  () => {
    if (!props.open) return;
    // ⚠️ 开场 FLIP 还没落定时**不算切图**：`openGallery()` 是一次性把 `index` 与 `open`
    // 一起改掉的（从上次的旧下标换成这次点中的那张），两个 watcher 会在同一批里先后跑。
    // 若这里照常 `resetFlip()`，会把刚摆好的起点姿势抹成恒等 ⇒ 用户看到的是"没有放大"。
    if (pendingFlip.value || pendingCenter.value) return;
    reset(true);
    resetFlip();
    imgReady.value = true;
  },
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

/** 函数式模板 ref：`as-child` 克隆子 vnode 时，字符串 ref 在有的时序下没落到 `dialogRef` 上（2026-11-08 实测）。 */
function setDialogRef(el: unknown) {
  dialogRef.value = el instanceof HTMLElement ? el : null;
}

function onMountAutoFocus(event: Event) {
  event.preventDefault();
  dialogRef.value?.focus();
}

useEventListener(window, "keydown", onKey);
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="duration-[var(--gosslan-duration-fast)] ease-[var(--gosslan-ease)] motion-reduce:transition-none"
      enter-from-class="opacity-0"
      leave-active-class="duration-[var(--gosslan-duration-exit-fast)] ease-[var(--gosslan-ease)] motion-reduce:transition-none"
      leave-to-class="opacity-0"
    >
      <!-- 移动端手势不能穿透到底下的聊天列表（用户 2026-11-06：
           "别点了滑动 是下面在滑，上面不滑"）。
           · `touch-action: none`：这一层把浏览器原生平移/缩放整段禁掉 —— 图片的拖动/捏合
             本来就是 pointer 事件实现的，禁掉原生手势不影响它们，只影响"页面跟着一起滚"；
           · `overscroll-behavior: contain`：桌面触控板/滚轮越界时不把滚动链传给 body。
           两处都**不碰** `document.body.overflow`：全局锁滚动是最容易漏恢复的做法
           （用户要求"关闭后立刻可滚"），按层禁手势不存在恢复问题。
           ⚠️ 这段说明只能写在 HTML 注释里：`:style` 的 JS 表达式里出现块注释会让
           Vue 模板编译器报 `Unterminated comment`（2026-11-06 真实红过一次）。 -->
      <div
        v-if="open"
        class="glass fixed inset-x-0 bottom-0 top-[var(--gosslan-safe-top,0px)] z-[80] outline-none"
        :style="{ background: 'rgba(0, 0, 0, 0.45)', touchAction: 'none', overscrollBehavior: 'contain', '--lb-top-h': '56px', '--lb-bottom-h': hasMultiple ? '78px' : '0px' }"
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
        <!-- 图片主体只占顶栏与底栏之间的那块（安全区）：两侧都按 --lb-*-h 让位，
             所以放大后的图不会钻到顶栏/缩略图条底下。 -->
        <FocusScope :trapped="open" loop as-child @mount-auto-focus="onMountAutoFocus">
        <div
          :ref="setDialogRef"
          tabindex="-1"
          class="flex h-full w-full items-center justify-center outline-none"
          :style="{
            paddingTop: 'calc(var(--lb-top-h) + 8px)',
            paddingBottom: 'calc(var(--lb-bottom-h) + var(--gosslan-inset-bottom, 0px) + 8px)',
          }"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        >
        <!-- 深色顶栏（画板 DesktopPreviewWindow）：文件名 / 原图尺寸 / 计数在左，工具在右。
             ⚠️ 这些信息与缩放**只在这里出现一次**（用户 2026-11-08：底部再写一遍既重复又压图）。
             工具区并进顶栏这一行 ⇒ 不占图片可用高度；顶栏高 56px 已算进 `--lb-top-h`。 -->
        <div
          class="absolute inset-x-0 top-0 z-[5] flex h-14 items-center gap-3 bg-black/45 px-4 backdrop-blur-sm"
          data-lightbox-topbar
          @pointerdown.stop
          @click.stop
        >
          <div class="min-w-0 flex-1">
            <div class="truncate text-body font-semibold text-white" :title="current?.name">
              {{ current?.name }}
            </div>
            <div class="mt-0.5 h-[13px] truncate text-caption text-white/65" data-lightbox-dim :title="sizeText">
              {{ sizeText }}
            </div>
          </div>
          <span
            v-if="hasMultiple"
            class="shrink-0 rounded-full bg-white/10 px-2 py-0.5 font-mono text-caption text-white/80"
            data-lightbox-counter
          >
            {{ index + 1 }} / {{ images.length }}
          </span>
          <!-- 右上操作区：缩放 + 保存 + 关闭。
               ⚠️ 工具条竖直方向**只由顶栏这一行决定**（不再是独立 absolute 层加 top:1rem）：
               2026-09-12 安卓状态栏、2026-10-12 桌面 caption 两次"让位算两遍"都是在独立层上叠出来的；
               现在外壳已经让开 `--gosslan-safe-top`，这一层只负责在 56px 里居中。
               缩放组在小屏隐藏（<sm）：移动端以双指缩放为主（双击已统一改作全屏切换，
               不再承担缩放），顶栏要留给文件名与保存。 -->
          <div class="flex shrink-0 items-center gap-1" data-lightbox-tools>
            <div class="hidden items-center gap-0.5 rounded-full bg-black/35 p-0.5 ring-1 ring-white/25 sm:flex">
              <button
                type="button"
                class="tap-safe flex h-7 w-7 items-center justify-center rounded-full text-white/85 transition-colors hover:bg-white/15 disabled:opacity-35"
                :title="t('msg.lightbox.zoomOut')"
                :aria-label="t('msg.lightbox.zoomOut')"
                :disabled="scale <= 1"
                @click.stop="zoomBy(-0.2)"
              >
                <Icon name="minus" class="h-3.5 w-3.5" />
              </button>
              <span class="min-w-[42px] text-center font-mono text-caption text-white/85" data-lightbox-zoom>
                {{ zoomPct }}%
              </span>
              <button
                type="button"
                class="tap-safe flex h-7 w-7 items-center justify-center rounded-full text-white/85 transition-colors hover:bg-white/15"
                :title="t('msg.lightbox.zoomIn')"
                :aria-label="t('msg.lightbox.zoomIn')"
                @click.stop="zoomBy(0.2)"
              >
                <Icon name="plus" class="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                class="tap-safe rounded-full px-2 py-1 text-caption text-white/85 transition-colors hover:bg-white/15"
                :title="t('common.resetZoom')"
                @click.stop="reset()"
              >
                {{ t("msg.lightbox.zoomFit") }}
              </button>
            </div>
            <!-- 保存按钮既有样式不动（白字在白色图片上靠 ring 描边兜底）。 -->
            <button
              class="flex h-9 items-center gap-1.5 rounded-full bg-black/35 px-3 text-body text-white ring-1 ring-white/25 transition hover:bg-black/55"
              style="text-shadow: 0 1px 2px rgba(0,0,0,0.55); filter: drop-shadow(0 1px 2px rgba(0,0,0,0.35));"
              :title="t('common.saveImage')"
              @click.stop="saveImage"
            >
              <Icon name="save" class="h-4 w-4" />
              {{ t("common.save") }}
            </button>
            <button
              v-if="!props.hideClose"
              class="tap-safe flex h-9 w-9 items-center justify-center rounded-full bg-black/35 text-white ring-1 ring-white/25 transition hover:bg-black/55"
              style="text-shadow: 0 1px 2px rgba(0,0,0,0.55); filter: drop-shadow(0 1px 2px rgba(0,0,0,0.35));"
              :title="t('common.closeEsc')" :aria-label="t('common.closeEsc')"
              @click.stop="requestClose"
            >
              <Icon name="x" class="h-5 w-5" />
            </button>
          </div>
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
            <Icon name="chevron-left" class="h-6 w-6" />
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
            <Icon name="chevron-right" class="h-6 w-6" />
          </button>
        </div>

        <!-- 图片主体 -->
        <!-- img-eager-ok：这一支是用户**主动点开**、占满屏幕中央的那一张，不在虚拟列表里 ⇒
             懒加载只会让它更晚出现。designGuards ㉜ 靠这句标记整份跳过（例外写在该例外的旁边）。 -->
        <template v-if="src">
          <!-- 手势的 x/y/scale 走 MotionValue（在 Vue 渲染周期外执行）。
               ⚠️ 不再挂 layoutId：缩略图侧已经不做 layout 补间，单边保留只是一段死契约。 -->
          <div class="flex items-center justify-center" data-lightbox-stage>
            <div class="relative">
            <!-- 打开/关闭的缩放是**纯 transform**（scaleX/scaleY + 中心对齐平移），
                 不写 left/top/width/height：布局位移会重排，也会把"一路向右滑"的观感带回来。
                 `opacity` 只在开场量尺寸那一帧藏住图片，避免先闪一帧终态再缩小。

                 ⚠️ 预览态**绝对不许切割图片**（用户 2026-11-07：预览图四角是黑的）：
                 · 不写圆角 → 显式 `rounded-none`（源码锚点，防止将来有人为了"好看"补圆角）；
                 · 不写 `overflow-hidden`（任何祖先都不许），图片外框贴着内容；
                 · 必须 `object-contain`：`cover` 会把长图/宽图裁掉上下或左右；
                 · 安全边距由 max-h/max-w 给（不是靠裁剪），且 max-h 现在按**顶栏 + 缩略图条
                   之后**的可用高度算（`100dvh - 外壳让位 - 两条 chrome`），不是旧的 85vh ——
                   否则图会钻到那两条底下。
                 `data-lightbox-stage` 是探针锚点：它和 img 之间不许出现裁切祖先。 -->
            <motion.img :alt="current?.name || t('msg.imagePreview')"
              data-lightbox-img
              :src="src"
              class="rounded-none object-contain max-w-[88vw] touch-none select-none shadow-2xl"
              :style="{
                x: txMV,
                y: tyMV,
                scale: scaleMV,
                scaleX: flipScaleX,
                scaleY: flipScaleY,
                opacity: imgReady ? 1 : 0,
                maxHeight: 'calc(100dvh - var(--gosslan-safe-top, 0px) - var(--lb-top-h) - var(--lb-bottom-h) - 16px)',
                cursor: scale > 1 ? (dragging ? 'grabbing' : 'grab') : 'default',
              }"
              draggable="false"
              @load="onImageLoad"
              @click.stop
              @contextmenu="openMenu"
              @dblclick="toggleFullscreen"
              @error="onImageError"
            />
            </div>
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
              v-if="current?.msgId || current?.cid || current?.favoriteId"
              type="button"
              class="tap-safe rounded-[var(--gosslan-radius-md)] bg-white/20 px-3 py-1.5 text-xs text-white ring-1 ring-white/30 transition hover:bg-white/30"
              @click.stop="resolveCurrent()"
            >
              {{ t("common.retry") }}
            </button>
          </template>
        </div>

        <!-- 底部：**只留缩略图条**（画板 DesktopPreviewWindow）。
             ⚠️ 文件名 / 原图尺寸 / 计数 / 缩放读数已经全部在顶栏出现（用户 2026-11-08：
             "我标红的两块其实上面已经有了……底下放大缩小有点影响看图"）——
             一个状态只在顶栏出现一次，这里不再复制第二份，也不放任何浮层压图。
             单图时整条不渲染（没有"缩略图"这个概念），外壳的 `--lb-bottom-h` 同步为 0。
             缩略图统一 86×58（画板 `.thumb` 的尺寸，≈1.48:1）并 `object-cover` 填满：
             按各自原图比例显示会让条带高低不齐、选中框跟着跳。
             ⚠️ 大图仍是 `object-contain`（TH-01 绝不裁切）—— 裁切只发生在这条缩略图里。
             同心圆角：外框 --gosslan-radius-md (10px) + p-0.5 (2px)，内图 --gosslan-radius-sm (8px)，
             10 − 2 = 8。hover 与选中**共用同一个 ring 属性**（ring-1 ↔ ring-2），
             不会叠成两层描边；切换只改颜色/宽度，不缩放、不改圆角比例（否则边缘缺角）。 -->
        <div
          v-if="hasMultiple"
          class="absolute inset-x-0 bottom-0 z-[6] flex items-center gap-2 overflow-x-auto px-4 pt-1"
          :style="{ paddingBottom: 'calc(var(--gosslan-inset-bottom, 0px) + 0.75rem)' }"
          data-lightbox-bottom
          @pointerdown.stop
          @click.stop
        >
          <button
            v-for="(img, i) in images"
            :key="i"
            type="button"
            class="tap-safe flex h-[62px] w-[90px] shrink-0 items-center justify-center rounded-[var(--gosslan-radius-md)] bg-black/40 p-0.5 transition-colors"
            :class="i === index
              ? 'ring-2 ring-[var(--gosslan-primary)]'
              : 'ring-1 ring-white/15 hover:ring-white/45'"
            :title="img?.name"
            :aria-label="t('msg.lightbox.thumbLabel', { i: i + 1 })"
            :aria-current="i === index ? 'true' : undefined"
            data-lightbox-thumb
            @click.stop="emit('update:index', i)"
          >
            <img
              v-if="thumbSrc[i]"
              :src="thumbSrc[i]"
              class="h-full w-full rounded-[var(--gosslan-radius-sm)] object-cover"
              alt=""
              loading="lazy"
              decoding="async"
              draggable="false"
              data-lightbox-thumb-img
            />
            <span v-else class="font-mono text-caption text-white/55">{{ i + 1 }}</span>
          </button>
        </div>
        </div>
        </FocusScope>

        <!-- 右键菜单：保存 / 关闭（Reka 负责贴边翻转、键盘导航与点外部关闭）。 -->
        <ContextMenu v-if="menu" :x="menu.x" :y="menu.y" z-class="z-[84]" @close="closeMenu">
          <DropdownMenuItem class="gosslan-menu-item" @select="saveImage">
            {{ t("common.saveImage") }}
          </DropdownMenuItem>
          <DropdownMenuItem class="gosslan-menu-item" @select="requestClose">
            {{ t("common.close") }}
          </DropdownMenuItem>
        </ContextMenu>
      </div>
    </Transition>
  </Teleport>
</template>
