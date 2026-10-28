<script setup lang="ts">
/**
 * 局部错误边界（审计 P2 #34）。
 *
 * 为什么需要：全仓只有 `boot.ts` 的全局 `errorHandler` —— 子树在渲染/事件里抛出时，
 * Vue 会把那一整块**卸载**，用户看到的是一片空白区域，没有任何解释（真机上表现为
 * "消息列表突然空了、重启才好"）。这里把高价值子树包起来：接住异常、停掉冒泡
 * （不让它把整页交给全局处理）、就地给一块带「重试」的说明，重试即重建子树。
 *
 * 只接**渲染与生命周期**里的同步异常。异步 Promise 的 reject 不经过这里（那些
 * 各自有 .catch —— 不能因为加了边界就把它们的兜底拆掉）。
 */
import { onErrorCaptured, ref } from "vue";
import { t } from "@/i18n";
import StateBlock from "@/components/ui/StateBlock.vue";

const message = ref("");
/** 重试时改 key ⇒ 子树整体重建（清掉坏掉的内部状态）。 */
const gen = ref(0);

onErrorCaptured((e) => {
  message.value = e instanceof Error ? e.message : String(e);
  // 关键：返回 false 让人停在这里。否则全局 errorHandler 仍会收到，且 Vue 会卸载子树。
  return false;
});

function retry() {
  message.value = "";
  gen.value++;
}
</script>

<template>
  <div class="relative h-full min-h-0">
    <StateBlock
      v-if="message"
      kind="error"
      :title="t('errorBoundary.title')"
      :detail="message"
      :retry-label="t('common.retry')"
      @retry="retry"
    />
    <div v-else :key="gen" class="contents"><slot /></div>
  </div>
</template>
