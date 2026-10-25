<script setup lang="ts">
import { t } from "@/i18n";
import { computed, ref, watch } from "vue";
import { useAppStore } from "@/stores/useAppStore";
import { CODE_SURFACE } from "@/utils/previewMetrics";
import { escHtml } from "@/utils/highlight";
import { peekHighlight, requestHighlight, type HighlightResult } from "@/utils/codeHighlight";

const app = useAppStore();

const props = defineProps<{
  code: string;
  language?: string;
  /**
   * 作为「气泡卡片的上半部分」使用（消息流里的代码气泡）：
   * - **不画描边**——描边会在卡片右缘与气泡尖角处露出一条竖线，尖角看着像"贴上去的"。
   * - **下圆角抹平**、上圆角保留——下方紧接操作条，两者拼成一整块圆角卡片。
   * 独立展示（全文弹窗）时保持默认值，仍有描边与四角圆角。
   */
  attached?: boolean;
}>();

const lineCount = computed(() => props.code.split("\n").length);

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
const langLabel = computed(() => {
  const lang = rendered.value?.lang ?? (props.language || "text");
  return lang === "plaintext" ? "text" : lang;
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
  <div
    class="overflow-hidden text-left"
    :class="attached ? 'rounded-t-[var(--gosslan-radius-sm)]' : ['rounded-[var(--gosslan-radius-md)]', borderStyle]"
    :style="{ borderWidth: attached ? '0px' : '1px' }"
  >
    <div class="flex items-center justify-between px-3" style="height: 32px" :style="{ background: toolbarBg }">
      <span class="text-xs" :style="{ color: toolbarFg }">{{ langLabel }} · {{ t("common.lines", { n: lineCount }) }}</span>
    </div>
    <pre
      class="code-pre gosslan-selectable"
      :style="{ background: codeBg, color: codeFg }"
    ><code v-html="html"></code></pre>
  </div>
</template>

<style scoped>
/* 纯展示：不折叠、不自带滚动条。截断由 MessageItem 的固定高度容器负责，
   完整内容的滚动由外层 Modal 容器负责。 */
.code-pre {
  margin: 0;
  padding: 12px 14px;
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: hidden;
}
.code-pre code {
  font-family: "JetBrains Mono", "Fira Code", Consolas, Menlo, monospace;
}
</style>
