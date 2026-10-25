<script setup lang="ts">
import { t } from "@/i18n";
import { computed, onUnmounted, ref, watch } from "vue";
import { ImageIcon } from "lucide-vue-next";
import { ImageOff } from "@/components/ui/icons";
import { IMAGE_BUBBLE_HEIGHT, IMAGE_PLACEHOLDER_HEIGHT, imageBubbleHeight } from "@/utils/previewMetrics";

const props = withDefaults(
  defineProps<{
    src: string;
    mine?: boolean;
    /** 载荷里的真实像素尺寸（后端从本机文件头读出）；缺省 = 旧消息，回退 288。 */
    width?: number;
    height?: number;
  }>(),
  { mine: false, width: undefined, height: undefined },
);

/** 有真实尺寸就按比例预留；没有就沿用旧口径（上限 288）。 */
const reservedHeight = computed(() =>
  props.width && props.height ? imageBubbleHeight(props.width, props.height) : IMAGE_BUBBLE_HEIGHT,
);
const hasKnownSize = computed(() => !!(props.width && props.height));
/**
 * 失败态高度：**已知尺寸时保持预留高度**，不缩到 128。
 * 否则"图片加载失败"会再改一次行高，把下方内容推上去 —— 用户要的是"不跳"，
 * 一张永远不来的图占着预留位比整列抽动好。旧消息（无尺寸）仍退回紧凑占位。
 */
const placeholderHeight = computed(() =>
  state.value === "failed" && !hasKnownSize.value ? IMAGE_PLACEHOLDER_HEIGHT : reservedHeight.value,
);
const emit = defineEmits<{ (e: "open", src: string): void; (e: "refetch"): void }>();

/**
 * 加载失败时点一下。
 *
 * ⚠️ 「重新获取」是**收件方**的语义：它请对端按 cid 再发一份。自己发出去的那张图，
 * 文件本来就在本机 —— 对端是**接收方**，向它索取要么拿不到、要么拿到一份没意义的副本，
 * 而点了按钮的人真正想知道的是「为什么我看得见这条消息却看不见图」。所以 mine 那一支
 * 只做本地重取（换 key 让浏览器重新发起加载），不外发请求。（用户 2026-10-23）
 */
function onFailedClick() {
  retry();
  if (!props.mine) emit("refetch");
}

/**
 * 失败原因。这里能**诚实**说出口的只有两种，而且分界是看得见的：
 * `src` 为空 = 本机根本没有可加载的地址（文件被清理/移动/删除，或预览没做出来）；
 * `src` 有值却报错 = 地址在但读不出图（文件损坏、格式不支持、objectURL 随页面一起失效）。
 * 再细的原因（对端没发完、解密失败）这一层拿不到信号，就不编。
 */
const failReasonKey = computed(() => (props.src ? "msg.imageFailDecode" : "msg.imageFailNoLocal"));

/** 加载态：先撑出骨架占位，避免大图加载时气泡高度塌陷、列表跳动。 */
const state = ref<"loading" | "loaded" | "failed">("loading");
/**
 * 加载尝试次数与"防缓存"参数。
 *
 * 用户 2026-09-12 实测（收图侧）：「刚收到时显示『图片加载失败』，过一会儿图片才出来 ——
 * 中间到底在干什么？合理的逻辑是：能加载了才弹出来，或者给我一个『加载中』，
 * 而『加载失败』应该是**不可逆的最终结果**。」
 *
 * 根因：收到图片消息时**文件可能还在传输/落盘**，此时 `<img src>` 直接报 error，
 * 而 `@error` 把状态钉死成 failed（此前只在 `src` 变化时才重置）。
 * 现在：报错后先按退避重试（0.4s→0.8s→1.6s→…，总计约 10s），期间保持"加载中"，
 * 只有重试全部失败才显示"加载失败"（并且可以点一下手动重试）。
 */
const RETRY_DELAYS_MS = [400, 800, 1600, 2400, 3200];
const attempt = ref(0);
let timer: ReturnType<typeof setTimeout> | null = null;

function clearTimer() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

function onError() {
  if (attempt.value < RETRY_DELAYS_MS.length) {
    const delay = RETRY_DELAYS_MS[attempt.value];
    attempt.value += 1;
    // 状态保持 loading：绝不在"可能马上就好"的时候告诉用户失败
    state.value = "loading";
    clearTimer();
    timer = setTimeout(() => {
      // 换一个查询串强制重新请求（同 URL 的失败会被浏览器缓存/复用）
      loadKey.value = attempt.value;
    }, delay);
    return;
  }
  state.value = "failed";
}

/** 手动重试（点一下"加载失败"的气泡）。 */
function retry() {
  attempt.value = 0;
  state.value = "loading";
  loadKey.value += 1;
}

/**
 * "强制重新请求"换代计数。
 *
 * ⚠️ 它**绝不能**被拼成 URL 查询串（审计阶段 4 · 4.2 的原 bug）：这里的 `src` 只有
 * `blob:`（`filePreview` 的 objectURL）和 `data:` 两种形态，两类都不接受 query ——
 * 给 `blob:` 加 `?r=1` 直接是个无效地址，给 `data:` 加则是把 base64 载荷改坏。
 * 于是"失败后退避重试 5 次"每次都打在结构性无效的地址上 ⇒ **即使文件早就在本机、
 * 也必然停在「图片加载失败」**，手动同理。换 `<img>` 的 `:key` 才是与 URL 形态无关的
 * 强制重取（Vue 会重建元素，浏览器重新发起加载）。
 */
const loadKey = ref(0);

watch(
  () => props.src,
  () => {
    clearTimer();
    attempt.value = 0;
    // src 换了（重新解析出一份新的 objectURL）⇒ 换代计数归零：上一代的失败与这一张无关。
    // 原实现只重置 attempt/state，loadKey 会一直挂着，把 ?r=N 一路带上新图。
    loadKey.value = 0;
    state.value = "loading";
  },
);
onUnmounted(clearTimer);
</script>

<template>
  <!-- 图片容器**定宽**（`w-52` = 13rem，与加载骨架同宽）。
       ⚠️ 这**不是**随手写的宽度：此处原先只有 `max-w-full`，图片宽度因此变成
       「父容器剩余宽度」的函数 —— 而群聊已读回执（头像列 + `+N`）是同一 flex 行的
       兄弟节点，回执一出现就占宽、把图片**压小**。用户 2026-09-12 反馈：
       「已读列表和已读的小头像会让图片稍微缩小一下，这是不应该的。图片发出来之后，
       大小应该是固定的。」⇒ 用**定宽**让图片尺寸与兄弟节点无关（`max-w-full`
       仅作为窄窗口下的安全下限保留）。
       代价（已知并接受）：竖长图会在 13rem 的框内左右留白，换来「发出后尺寸恒定」。 -->
  <!-- ⚠️ 这里刻意**不用** layoutId / layout 动画：缩略图高度会随图片解码从骨架高度
       变成真实高度，做 layout 补间就是「图片从底部往上拉伸」的来源。切会话时由
       ChatWindow 对整列做一次短淡入；单张图只瞬时落定，不参与补间。 -->
  <div
    class="relative w-52 max-w-full cursor-pointer overflow-hidden rounded-[var(--gosslan-bubble-radius)]"
    :data-img-state="state"
    :role="state === 'loaded' ? 'button' : undefined"
    :tabindex="state === 'loaded' ? 0 : undefined"
    :aria-label="state === 'loaded' ? t('msg.clickToOpen') : undefined"
    @click="state === 'loaded' ? emit('open', src) : state === 'failed' && onFailedClick()"
    @keydown.enter.prevent="state === 'loaded' && emit('open', src)"
    @keydown.space.prevent="state === 'loaded' && emit('open', src)"
  >
    <!-- 骨架按**载荷里的真实像素尺寸**预留（后端从本机文件头读出 w/h 写进 content）。
         有 w/h：预留 == 真实高 = min(288, 208 × h/w) ⇒ 解码完成零跳变；
         没有（旧消息/HEIC 等读不出）：回退 288 上限，横图完成时仍会收缩一次（已知残留）。
         失败态：已知尺寸时**保持预留高度**，不缩到 128 —— 为一张不会来的图撑住空间，
         比再改一次行高把下方内容推上去好；旧消息无尺寸时仍退回紧凑占位。
         ⚠️ 高度只从 previewMetrics 取，别再写回 h-* / max-h-* 字面量
         （由 designGuards ㉞ 与运行时探针 --only=imgskel 两段一起盯着）。 -->
    <div
      v-if="state !== 'loaded'"
      data-img-skeleton
      class="flex w-full items-center justify-center bg-[var(--gosslan-hover)]"
      :style="{ height: `${placeholderHeight}px` }"
    >
      <ImageOff v-if="state === 'failed'" class="size-6 opacity-50" />
      <ImageIcon v-else class="size-6 animate-pulse opacity-40" />
    </div>
    <div
      v-if="state === 'failed'"
      class="absolute inset-x-0 bottom-1 px-2 text-center text-caption leading-snug opacity-70"
    >
      <div>{{ t("msg.imageLoadFailed") }}</div>
      <!-- 用户 2026-10-23：「应该给用户讲为啥渲染失败」。原因只报这一层**真拿得到**的分界：
           有没有可加载的地址。再细的（对端没发完 / 解密失败）在这里没有信号，不编。 -->
      <div>{{ t(failReasonKey) }}</div>
      <div>{{ mine ? t("msg.imageFailHintMine") : t("msg.imageFailHintPeer") }}</div>
    </div>
    <!-- img-eager-ok：这张图必须 eager，不许加 loading="lazy"。
         它在自身 @load 触发前被 `hidden`（display:none）藏着，而懒加载只对"在视口附近、
         参与排版"的元素发请求 —— display:none 的懒加载图**永不发请求**（Chromium/WebKit/WebView2
         三引擎同形，2026-10-12 headless 实测：blob 有效、手动 new Image() 能解码，挂在这里
         12 秒 naturalWidth 仍是 0，资源计数 0）。⇒ @load 永不触发 ⇒ state 永不进 loaded ⇒
         图永远被藏住，退避 5 次后落「图片加载失败」，点击也只走重取而不开预览
         （6853680 给消息行统一补 lazy 时引入，v4.35.2 真机：自己发的和对方发的图全打不开）。
         虚拟列表只挂载视口附近的行，eager 不会把屏外图提前拉下来；异步解码仍由 decoding="async" 保留。 -->
    <img decoding="async" :alt="t('msg.imageMessage')"
      data-img-el
      :key="loadKey"
      :src="props.src"
      class="block w-full rounded-[var(--gosslan-bubble-radius)] object-contain"
      :style="{ maxHeight: `${reservedHeight}px`, height: hasKnownSize ? `${reservedHeight}px` : undefined }"
      :class="state === 'loaded' ? '' : 'hidden'"
      @load="clearTimer(); state = 'loaded'"
      @error="onError()"
    />
  </div>
</template>
