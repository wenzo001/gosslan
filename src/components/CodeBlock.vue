<script setup lang="ts">
import { t } from "@/i18n";
import { computed, ref, watch } from "vue";
import { useAppStore } from "@/stores/useAppStore";
import { CODE_SURFACE } from "@/utils/previewMetrics";
import { escHtml } from "@/utils/highlight";
import { peekHighlight, requestHighlight, type HighlightResult } from "@/utils/codeHighlight";
import { PLAINTEXT, codeLanguageLabel } from "@/utils/codeLanguages";
import CodeLangMenu from "@/components/CodeLangMenu.vue";

const app = useAppStore();

const props = defineProps<{
  code: string;
  /** 显式语言（围栏标签 / 发送前选择 / 发送后切换）；缺省 = 自动识别。 */
  language?: string | null;
  /**
   * 作为「气泡卡片的上半部分」使用（消息流里的代码气泡）：
   * - **不画描边**——描边会在卡片右缘与气泡尖角处露出一条竖线，尖角看着像"贴上去的"。
   * - **下圆角抹平**、上圆角保留——下方紧接操作条，两者拼成一整块圆角卡片。
   * 独立展示（全文弹窗）时保持默认值，仍有描边与四角圆角。
   */
  attached?: boolean;
  /** 发送方：头部语言标签可点开切换。非发送方永远只读。 */
  canSwitchLang?: boolean;
  /** 切换请求进行中：头部保留旧语言，只转圈并禁用菜单。 */
  switching?: boolean;
  /**
   * 代码区自己滚动（头部固定不动）。**只有全文弹窗**走这条；
   * 消息列表折叠态不许可滚（用户 2026-11-06），那是 `clipped`。
   */
  scrollable?: boolean;
  /**
   * 折叠态：撑满父层固定高度，但**不是滚动容器**（`overflow-y: hidden`）。
   * 超出部分裁掉，滚轮/触控事件冒泡给外层消息列表；与 `scrollable` 互斥。
   */
  clipped?: boolean;
  /** 撑满父容器的固定高度（气泡截断态：父层锁 CODE_CLAMP_HEIGHT）。 */
  fill?: boolean;
  /** 代码区最大高度（全文弹窗：把滚动留在代码区，外层不再滚）。 */
  maxHeight?: string;
  /**
   * 头部「· N 行」用的行数。缺省按 `code` 自己算。
   * 折叠态传的是**截断后**的预览（只有 8 行），头部必须显真实总行数，
   * 否则一条 681 行的消息会自称「8 行」，展开与否失去可发现信号。
   */
  totalLines?: number;
}>();

const emit = defineEmits<{ (e: "switch-language", value: string | null): void }>();

const lineCount = computed(() => props.totalLines ?? props.code.split("\n").length);

/**
 * 首帧只渲染**转义后的纯文本**，高亮在 Worker 里算完再回填。
 *
 * 冷跳纯代码区首帧 164ms → 现在首帧只做 escHtml（微秒级），主线程不再为 17 张卡
 * 同步跑 15 种语言的自动检测。`generation` 防串代：同一实例快速换内容时，
 * 旧请求晚到不许覆盖新内容。
 */
const rendered = ref<HighlightResult | null>(null);
let generation = 0;
function refresh() {
  const gen = ++generation;
  const hit = peekHighlight(props.code, props.language);
  if (hit) {
    rendered.value = hit;
    return;
  }
  rendered.value = null;
  void requestHighlight(props.code, props.language).then((r) => {
    if (gen === generation) rendered.value = r;
  });
}
refresh();
watch(() => [props.code, props.language], refresh);

const html = computed(() => rendered.value?.html ?? escHtml(props.code));
/**
 * 头部语言标签：显式语言优先（用户刚切完，不等 Worker 回包就该改口）；
 * 自动档在 Worker 回包前显示「自动识别」，回包后显示实际识别结果；
 * 自动识别不确定时显示「纯文本」——与代码区的真实渲染保持一致。
 */
const langLabel = computed(() => {
  const explicit = props.language;
  if (explicit) return explicit === PLAINTEXT ? t("code.plaintext") : codeLanguageLabel(explicit) || explicit;
  const detected = rendered.value?.lang;
  if (!detected) return t("code.auto");
  return detected === PLAINTEXT ? t("code.plaintext") : codeLanguageLabel(detected) || detected;
});

const codeBg = computed(() => (app.dark ? CODE_SURFACE.dark : CODE_SURFACE.light));
const codeFg = computed(() => (app.dark ? "#e6edf3" : "#24292e"));
const toolbarBg = computed(() => "var(--gosslan-hover)");
/** 工具栏文字（语言 · 行数，12px）：透明度是"白/黑蒙层的比例"，不是颜色本身，
 *  所以必须按两套底色分别验一遍对比度——亮色原为 0.4，实测只有 2.90（不达标），
 *  提到 0.55 后 ≈ 4.6；暗色 0.5 在 #161b22 上有 5.1，保持不变。 */
const toolbarFg = computed(() => "var(--gosslan-text-2)");
const borderStyle = computed(() => "border-[var(--gosslan-border)]");

</script>

<template>
  <!-- 结构约束：头部与 `pre` 是兄弟节点，`pre` 才是唯一的滚动容器。
       因此滚动时头部天然不动；不要在 `pre` 外面再套一层 overflow。 -->
  <div
    class="code-block flex min-w-0 max-w-full flex-col overflow-hidden text-left"
    :class="[
      attached ? 'rounded-t-[var(--gosslan-radius-sm)]' : ['rounded-[var(--gosslan-radius-md)]', borderStyle],
      fill ? 'h-full' : '',
    ]"
    :style="[{ borderWidth: attached ? '0px' : '1px' }, maxHeight ? { maxHeight } : {}]"
  >
    <div class="flex shrink-0 items-center justify-between px-3" style="height: 32px" :style="{ background: toolbarBg }">
      <div class="flex min-w-0 items-center gap-1">
        <CodeLangMenu
          v-if="canSwitchLang"
          :model-value="props.language ?? null"
          :label="langLabel"
          :loading="switching"
          :aria-label="t('code.lang')"
          @update:model-value="emit('switch-language', $event)"
        />
        <span v-else class="truncate text-xs" :style="{ color: toolbarFg }" :title="langLabel">{{ langLabel }}</span>
        <span class="shrink-0 text-xs" :style="{ color: toolbarFg }">· {{ t("common.lines", { n: lineCount }) }}</span>
      </div>
    </div>
    <pre
      class="code-pre gosslan-selectable"
      :class="[scrollable ? 'code-pre--scroll' : '', clipped ? 'code-pre--clip' : '']"
      :data-code-scroll="scrollable ? 'scroll' : clipped ? 'clip' : 'none'"
      :style="{ background: codeBg, color: codeFg }"
    ><code v-html="html"></code></pre>
  </div>
</template>

<style scoped>
/* 代码区：默认不滚（短代码随气泡撑高）。
   `--scroll`（**仅全文弹窗**）时它成为唯一滚动容器：
   - 头部在它外面，滚动时代码在下面走、语言/行数不动；
   - `overscroll-behavior: contain` 阻止滚到尽头后把滚动传给消息列表（避免"双层滚动"体感）；
   - `touch-action: pan-y` + `-webkit-overflow-scrolling: touch` 保证移动端触控滚动。
   `--clip`（消息列表折叠态）只是撑满固定高度并裁掉溢出，**不是滚动容器**：
   - 不写 `overflow-y: auto` ⇒ 滚轮/触控不会被这里吃掉，直接冒泡给外层消息列表；
   - `touch-action: auto`（默认）⇒ 触控纵向手势同样落到外层列表。
   横向永不滚动（长行用 pre-wrap 折行），所以不会出现横向滚动条把气泡撑破。 */
.code-pre {
  margin: 0;
  min-width: 0;
  padding: 12px 14px;
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: hidden;
  /* 不截断、不滚的短代码也**不是滚动容器**：单轴 `hidden` 会把另一轴的 `visible`
     计算成 `auto`（实测 computed overflow-y=auto），这里显式 `clip` 把它关死。
     兼容性兜底：老引擎不认 `clip` 时退回 visible → 仍计算成 auto，但短内容本来无滚动范围。 */
  overflow-y: clip;
}
.code-pre--scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  touch-action: pan-y;
}
/* 折叠态：撑满固定高度但**不可滚**（不是滚动容器）。
   `overflow: hidden` 同时管住横纵；不写 `overscroll-behavior: contain`，
   因为根本不存在"滚到尽头"这件事 —— 手势必须从第一像素就交给外层消息列表。 */
.code-pre--clip {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  /* 下内边距会让内容盒少 12px（实测只露 7.4 行）；折叠态要的是完整 8 行，故归零。 */
  padding-bottom: 0;
}
.code-pre code {
  font-family: "JetBrains Mono", "Fira Code", Consolas, Menlo, monospace;
}
</style>
