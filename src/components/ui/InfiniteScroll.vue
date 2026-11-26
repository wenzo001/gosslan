<script setup lang="ts">
/**
 * 无限滚动（naive-ui `InfiniteScroll` 的薄封装，2026-11-26）。
 *
 * 适用边界（写清楚免得被误接）：
 * - 它是**向下**触底加载：`distance` 是"距底多少 px 内触发 load"，官方只在向下滚时检查。
 * - 聊天消息流是**向上**加载历史（`VirtualList` 的 `loadMore`），语义相反，**不要**接这里。
 * - 目前仓库里没有"向下分页"的数据源，所以本组件暂无消费者；保留它是为了下一个
 *   长列表（文件/收藏/搜索结果）不必再自己造一套触底判定。
 *
 * 样式复用统一容器：根节点就是 naive 的 `.n-scrollbar`，带上 `.gosslan-os` 档位类后，
 * 滑块颜色、显隐、触屏隐藏全部走 `style.css` 那一套，不会出现第二种滚动条。
 * `trigger="none"` 让滑块常驻 DOM（显隐同样交给 `.is-scrolling` / `:hover`）。
 */
import { NInfiniteScroll } from "naive-ui";

withDefaults(
  defineProps<{
    /** 距底多少 px 内触发（官方默认 0，太贴边会"滚到底才加载"）。 */
    distance?: number;
    size?: "thin" | "normal" | "thick";
  }>(),
  { distance: 120, size: "normal" },
);

const emit = defineEmits<{ (e: "load"): void }>();

function onLoad() {
  emit("load");
}
</script>

<template>
  <NInfiniteScroll
    class="gosslan-os"
    :class="`gosslan-os--${size}`"
    :distance="distance"
    :on-load="onLoad"
    :scrollbar-props="{ trigger: 'none' }"
  >
    <slot />
  </NInfiniteScroll>
</template>
