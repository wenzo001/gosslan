<script setup lang="ts">
/**
 * 渲染一段 Markdown（更新说明用）。**唯一**的 `v-html` 落点，内容先过
 * `renderNotesMarkdown` 的白名单消毒（见 `utils/markdown.ts`）。
 *
 * 链接必须拦下来交给系统浏览器：说明里会指向仓库/发布页，让 `<a>` 在 WebView 里
 * 直接导航等于把应用窗口换成一张网页，且没有后退可回。
 *
 * ⚠️ 拦截用**原生委托**而不是模板 `@click`：容器本身不可交互（可点的只有里面的链接），
 * 给容器挂 `@click` 会让"可点击元素必须键盘可达"那条判据把它当成一个假按钮。
 * `v-html` 每次重渲染都会换掉里面的节点 ⇒ 重新绑一次（旧节点随之丢弃，不会泄漏）。
 */
import { computed, nextTick, ref, watch } from "vue";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isExternalLink, renderNotesMarkdown } from "@/utils/markdown";

const props = defineProps<{ source: string | null | undefined }>();

const html = computed(() => renderNotesMarkdown(props.source));
const root = ref<HTMLElement | null>(null);

function onAnchorClick(e: Event) {
  const anchor = (e.target as HTMLElement | null)?.closest("a");
  if (!anchor) return;
  e.preventDefault();
  const href = anchor.getAttribute("href");
  if (!isExternalLink(href)) return;
  void openUrl(href as string).catch(() => {
    /* 没有系统浏览器/被策略拦下：不弹错，链接本身仍然可见可复制 */
  });
}

watch(
  html,
  async () => {
    await nextTick();
    const el = root.value;
    if (!el) return;
    el.removeEventListener("click", onAnchorClick);
    el.addEventListener("click", onAnchorClick);
  },
  { immediate: true },
);
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- 唯一落点，内容已白名单消毒 -->
  <div ref="root" class="gosslan-md gosslan-selectable" v-html="html"></div>
</template>

<style scoped>
/* 只保留"能读"这一档样式：字号/行距跟面板一致，标题不放大到抢主体。 */
.gosslan-md :deep(p) {
  margin: 0.25rem 0;
}
.gosslan-md :deep(h1),
.gosslan-md :deep(h2),
.gosslan-md :deep(h3),
.gosslan-md :deep(h4),
.gosslan-md :deep(h5),
.gosslan-md :deep(h6) {
  margin: 0.4rem 0 0.2rem;
  font-weight: 600;
  color: var(--gosslan-text);
}
.gosslan-md :deep(ul),
.gosslan-md :deep(ol) {
  margin: 0.25rem 0;
  padding-left: 1.1rem;
  list-style: disc;
}
.gosslan-md :deep(ol) {
  list-style: decimal;
}
.gosslan-md :deep(li) {
  margin: 0.15rem 0;
}
.gosslan-md :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.95em;
  padding: 0 0.2em;
  border-radius: 3px;
  background: var(--gosslan-hover);
}
.gosslan-md :deep(pre) {
  margin: 0.3rem 0;
  padding: 0.4rem 0.5rem;
  overflow-x: auto;
  border-radius: var(--gosslan-radius-xs);
  background: var(--gosslan-hover);
}
.gosslan-md :deep(a) {
  color: var(--gosslan-primary);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.gosslan-md :deep(hr) {
  margin: 0.5rem 0;
  border: 0;
  border-top: 1px solid var(--gosslan-divider);
}
</style>
