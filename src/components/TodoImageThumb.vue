<script setup lang="ts">
/**
 * 待办描述图片缩略图：按 sha256（= content store cid）找回本机已落盘的字节并渲染。
 *
 * 字节通过 `read_content_preview` 读回（与聊天图片同一套安全边界：只允许读 downloads 下文件、
 * 或本机自己发出的内容），转成 objectURL 显示。
 *
 * ⚠️ **字节是"后到"的**：任务定义（带图片元数据）先到，真实文件走群文件管线后到 ——
 * 所以第一次读不到很正常。这里用**退避重试**把后到的字节追回来（1.5s 起步、最长 30s），
 * 而不是失败一次就永远显示占位（用户 2026-09-17：「群任务的图片大概率打不开」）。
 * `loadContentPreview` 也配合改成"失败不缓存"。
 */
import { onBeforeUnmount, ref, watch } from "vue";
import { loadContentPreview, type PreviewResult } from "@/utils/filePreview";
import type { TodoImage } from "@/utils/todos";

const props = defineProps<{ image: TodoImage }>();

const url = ref<string | null>(null);
const loading = ref(true);
const failed = ref(false);

const RETRY_BASE_MS = 1500;
const RETRY_MAX_MS = 30_000;

let timer: number | null = null;
let delay = RETRY_BASE_MS;

function cancelRetry() {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
}

function scheduleRetry(cid: string, name: string) {
  cancelRetry();
  timer = window.setTimeout(() => {
    timer = null;
    void load(cid, name);
  }, delay);
  delay = Math.min(delay * 2, RETRY_MAX_MS);
}

async function load(cid: string, name: string) {
  loading.value = true;
  failed.value = false;
  try {
    const r: PreviewResult = await loadContentPreview(cid, name);
    if (r.url) {
      url.value = r.url;
      loading.value = false;
      return; // 成功 ⇒ 不再重试
    }
    failed.value = true;
  } catch {
    failed.value = true;
  }
  loading.value = false;
  scheduleRetry(cid, name);
}

watch(
  () => props.image.sha256,
  (cid) => {
    if (url.value) URL.revokeObjectURL(url.value);
    url.value = null;
    delay = RETRY_BASE_MS;
    if (cid) void load(cid, props.image.name);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  cancelRetry();
  if (url.value) URL.revokeObjectURL(url.value);
});
</script>

<template>
  <div
    class="relative h-20 w-20 shrink-0 overflow-hidden rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] bg-[var(--gosslan-bg)]"
    :title="image.name"
  >
    <img
      v-if="url"
      :src="url"
      :alt="image.name"
      class="h-full w-full object-cover"
      loading="lazy"
    />
    <div
      v-else
      class="flex h-full w-full items-center justify-center px-1 text-center text-[11px] text-[var(--gosslan-text-2)]"
    >
      {{ loading ? "…" : image.name }}
    </div>
  </div>
</template>
