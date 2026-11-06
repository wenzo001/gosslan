<script setup lang="ts">
/**
 * 代码语言选择器（发送前 + 发送后共用一份）。
 *
 * 为什么自绘而不是原生 `<select>`：与 `TodoPickField` 同一个理由——原生弹层由系统绘制，
 * 深色主题下会出现"浅底 + 近白字"；这里统一吃 `.gosslan-menu` 的主题 token。
 *
 * 档位：
 * - `null`（自动识别）：交给 highlight.js 的 `highlightAuto`，识别不确定就落纯文本；
 * - `plaintext`：明确不高亮，但仍是代码块（保留等宽、内部滚动、复制）；
 * - 具体语言：按标记高亮。
 */
import { computed, nextTick, ref, watch } from "vue";
import { ChevronDown } from "lucide-vue-next";
import Spinner from "@/components/ui/Spinner.vue";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from "reka-ui";
import { t } from "@/i18n";
import {
  CODE_LANGUAGES,
  CODE_LANGUAGE_LABELS,
  PLAINTEXT,
  codeLanguageLabel,
  normalizeCodeLanguage,
} from "@/utils/codeLanguages";

const props = defineProps<{
  /** `null` = 自动识别；`plaintext` = 纯文本；其它为规范语言名。 */
  modelValue: string | null;
  /** 触发器上显示的文案（默认按当前值推导；自动识别命中时由父层传实际识别结果）。 */
  label?: string;
  disabled?: boolean;
  /** 切换进行中：保留旧语言显示，只转圈并禁用。 */
  loading?: boolean;
  ariaLabel?: string;
}>();

const emit = defineEmits<{ (e: "update:modelValue", value: string | null): void }>();

const open = ref(false);
const triggerEl = ref<HTMLElement | null>(null);
/**
 * 弹层的边界容器（2026-11-05 修"下拉跑出聊天区"）：
 * 从触发器往上找**第一个纵向可滚**的祖先 —— 消息流里是 VirtualList 的滚动区，
 * 全文弹窗里是 `max-h-[70vh] overflow-y-auto` 那一层。
 * 输入区（Composer）上方没有滚动容器（编辑器自己是兄弟节点），此时退到
 * `[data-lang-menu-boundary]` 标记的**聊天面板**，而不是整块视口：
 * 视口比面板高，用视口兜底等于让弹层重新盖到面板外（输入区就在面板底部）。
 *
 * 为什么不写死一个选择器：CodeLangMenu 有两个调用点（消息气泡头部、输入框工具条），
 * 让组件自己找"离它最近的聊天可见区"比给每个调用点传一个 ref 更不容易漏。
 */
const boundary = ref<HTMLElement | null>(null);
const SCROLLABLE_Y = new Set(["auto", "scroll", "overlay"]);
const MENU_MIN_WIDTH = 168;
const COLLISION_PADDING = 8;

function resolveBoundary(from: HTMLElement | null): HTMLElement | null {
  let el = from?.parentElement ?? null;
  while (el && el !== document.body) {
    const overflowY = getComputedStyle(el).overflowY;
    if (SCROLLABLE_Y.has(overflowY) && el.clientHeight > 0) return el;
    el = el.parentElement;
  }
  return from?.closest<HTMLElement>("[data-lang-menu-boundary]") ?? null;
}

/**
 * 极窄容器的横向压缩（2026-11-05）：容器比菜单默认 `min-width` 还窄时，
 * 把 min-width 压到 `min(可用宽, 触发器宽)` —— 弹层不会比触发器更宽；
 * 仍放不下就由 popper 的横向 shift 钉在容器内，配合选项文字的 truncate。
 * 只在确实放不下时才覆盖，正常窗口仍是 168px 的菜单宽度。
 */
const menuMinWidth = ref<number | null>(null);

function measureMinWidth(area: HTMLElement | null) {
  menuMinWidth.value = null;
  if (!area) return;
  const avail = area.getBoundingClientRect().width - COLLISION_PADDING * 2;
  if (avail >= MENU_MIN_WIDTH) return;
  const triggerW = triggerEl.value?.getBoundingClientRect().width ?? avail;
  menuMinWidth.value = Math.max(0, Math.round(Math.min(avail, triggerW)));
}

const menuStyle = computed<Record<string, string> | undefined>(() =>
  menuMinWidth.value === null
    ? undefined
    : { "--gosslan-lang-menu-min": `${menuMinWidth.value}px` },
);

/**
 * 触发器被消息区滚出可视区时的"钉边"（2026-11-05）：
 * 用户要求不自动关菜单，但浮层也不能跟着触发器跑到聊天区外面去（实测顶边 −56px）。
 * 做法是把 popper 的 `reference` 临时换成一个贴在容器边缘的零高虚拟元素：
 * 触发器滚到容器上方 → 参考线取容器上沿，弹层从那里往下展开；滚到下方则反过来。
 * 触发器回到容器内就换回真触发器，弹层随之回到原位。
 */
const pinnedSide = ref<"top" | "bottom" | null>(null);

const pinnedReference = computed(() => {
  const side = pinnedSide.value;
  const area = boundary.value;
  const trigger = triggerEl.value;
  if (!side || !area || !trigger) return undefined;
  return {
    contextElement: trigger,
    getBoundingClientRect: () => {
      const a = area.getBoundingClientRect();
      const t = trigger.getBoundingClientRect();
      const width = Math.min(t.width, Math.max(0, a.width - COLLISION_PADDING * 2));
      const maxLeft = a.right - COLLISION_PADDING - width;
      const left = Math.min(Math.max(t.left, a.left + COLLISION_PADDING), Math.max(a.left + COLLISION_PADDING, maxLeft));
      const y = side === "top" ? a.top + COLLISION_PADDING : a.bottom - COLLISION_PADDING;
      return { x: left, y, width, height: 0, top: y, bottom: y, left, right: left + width };
    },
  };
});

function syncPin() {
  const area = boundary.value;
  const trigger = triggerEl.value;
  if (!area || !trigger) {
    pinnedSide.value = null;
    return;
  }
  const a = area.getBoundingClientRect();
  const t = trigger.getBoundingClientRect();
  if (t.bottom <= a.top) pinnedSide.value = "top";
  else if (t.top >= a.bottom) pinnedSide.value = "bottom";
  else pinnedSide.value = null;
}

let detachBoundaryScroll: (() => void) | null = null;

function watchBoundaryScroll() {
  detachBoundaryScroll?.();
  const area = boundary.value;
  if (!area) return;
  const onAreaScroll = () => syncPin();
  const onWindowScroll = () => syncPin();
  area.addEventListener("scroll", onAreaScroll, { passive: true });
  window.addEventListener("scroll", onWindowScroll, { capture: true });
  detachBoundaryScroll = () => {
    area.removeEventListener("scroll", onAreaScroll);
    window.removeEventListener("scroll", onWindowScroll, { capture: true });
    detachBoundaryScroll = null;
  };
}

/**
 * 打开时把边界定下来，再把**当前语言**滚进可见区。
 * `block: "nearest"` 只动弹层自己这层滚动，不会把消息列表/输入框带跑；
 * 先算边界再翻 open（同一个 tick 里），保证 popper 第一次测量用的就是聊天区。
 */
function setOpen(next: boolean) {
  if (next) {
    boundary.value = resolveBoundary(triggerEl.value);
    measureMinWidth(boundary.value);
    pinnedSide.value = null;
  }
  open.value = next;
}

watch(open, (isOpen) => {
  if (!isOpen) {
    detachBoundaryScroll?.();
    pinnedSide.value = null;
    return;
  }
  // 打开后才挂滚动监听：菜单关着时不必为消息流的每一次滚动付回调。
  watchBoundaryScroll();
  void nextTick(() => {
    requestAnimationFrame(() => {
      const menu = document.querySelector<HTMLElement>('[role="menu"].code-lang-menu');
      menu?.querySelector<HTMLElement>('[aria-current="true"]')
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  });
});

watch(
  () => [props.modelValue, props.disabled, props.loading],
  () => {
    if (props.disabled || props.loading) open.value = false;
  },
);

const options = computed(() => [
  { value: "", label: t("code.auto") },
  { value: PLAINTEXT, label: t("code.plaintext") },
  ...CODE_LANGUAGES.map((value) => ({ value, label: CODE_LANGUAGE_LABELS[value] ?? value })),
]);

const currentLabel = computed(() => {
  if (props.label) return props.label;
  const normalized = normalizeCodeLanguage(props.modelValue);
  if (!normalized) return t("code.auto");
  if (normalized === PLAINTEXT) return t("code.plaintext");
  return codeLanguageLabel(normalized) || normalized;
});

function pick(value: string) {
  open.value = false;
  emit("update:modelValue", value === "" ? null : value);
}
</script>

<template>
  <DropdownMenuRoot v-if="!disabled" :open="open" :modal="false" @update:open="setOpen">
    <DropdownMenuTrigger as-child>
      <button
        ref="triggerEl"
        type="button"
        class="code-lang-trigger tap-safe"
        :class="loading ? 'cursor-wait opacity-70' : ''"
        :title="ariaLabel ?? t('code.lang')"
        :aria-label="ariaLabel ?? t('code.lang')"
        :aria-busy="loading ? 'true' : undefined"
      >
        <Spinner v-if="loading" size-class="h-3 w-3" decorative />
        <span class="max-w-[9rem] truncate" :title="currentLabel">{{ currentLabel }}</span>
        <ChevronDown v-if="!loading" class="h-3 w-3 shrink-0" aria-hidden="true" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <!-- 边界约束（2026-11-05）：`collisionBoundary` 取**聊天区那个滚动容器**，
           而不是默认的空数组（= 视口）。用户截图里下拉被消息区底边裁掉、下半截选项点不到，
           根因就是只按视口避让：视口 900px 高时聊天区可能只有 300px，popper 以为空间足够。
           配 `collisionBoundary` + `sticky="always"`，让翻转/限位都发生在聊天区内；
           `collisionPadding` 留 8px 呼吸位。
           `max-height` 吃 Reka 在**同一份边界**上算出的 available-height ⇒ 限高与翻转口径一致；
           `overflow-y: auto` 让超出部分内部滚动，`scrollbar-gutter: stable` 保证滚动条不盖文字。 -->
      <!-- sticky="always"：默认的 "partial" 会装 limitShift()，消息区滚动把触发器带出
           容器后，限位器允许弹层跟着触发器跑到容器外（实测顶边 −56px）；去掉限位器后
           shift 会把弹层整体压回边界内。 -->
      <DropdownMenuContent
        align="end"
        :side-offset="4"
        :collision-padding="8"
        :collision-boundary="boundary ? [boundary] : []"
        :reference="pinnedReference"
        sticky="always"
        :style="menuStyle"
        class="gosslan-menu code-lang-menu frost z-[80]"
      >
        <DropdownMenuItem
          v-for="o in options"
          :key="o.value"
          class="gosslan-menu-item"
          :data-lang="o.value || 'auto'"
          :class="normalizeCodeLanguage(modelValue) === (o.value || null) ? 'font-medium text-[var(--gosslan-primary)]' : ''"
          :aria-current="normalizeCodeLanguage(modelValue) === (o.value || null) ? 'true' : undefined"
          @select="pick(o.value)"
        >
          <span class="min-w-0 truncate" :title="o.label">{{ o.label }}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
  <span v-else class="code-lang-trigger code-lang-trigger--static" aria-hidden="true">{{ currentLabel }}</span>
</template>

<style scoped>
.code-lang-trigger {
  display: inline-flex;
  min-width: 0;
  height: 22px;
  align-items: center;
  gap: 3px;
  padding: 0 6px;
  border-radius: var(--gosslan-radius-sm);
  font-size: 12px;
  line-height: 1;
  color: var(--gosslan-text-2);
  transition: background-color 120ms ease, opacity 120ms ease;
}
.code-lang-trigger:hover {
  background: var(--gosslan-hover);
}
.code-lang-trigger--static {
  padding-left: 0;
}
</style>
