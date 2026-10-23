<script setup lang="ts">
withDefaults(
  defineProps<{
    label: string;
    description?: string;
    /** 是否最后一行（去掉底部分隔线） */
    last?: boolean;
    /**
     * 给说明文字**预留**几行（只加最小高度，不裁剪）。
     *
     * 为什么需要：状态型说明会在运行中在"短句"与"长句"之间切换（例如实时事件链路
     * 「正常」↔「已断开：新消息…都不会实时更新」）。行高跟着文案变 ⇒ 整张卡片在点击那一下
     * 长高/缩短，看起来就是中间那块"跳一下"（用户 2026-10-23）。预留固定行数后高度与文案无关。
     */
    descriptionMinLines?: number;
  }>(),
  { description: "", last: false, descriptionMinLines: 0 },
);
</script>

<template>
  <!-- 手机上控件（分段选择 / 长按钮）放不下时换到下一行，别把标题和说明挤成一条缝。
       basis-48 只约束换行时机，不改变桌面端原有的单行布局。 -->
  <div class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
    <div class="min-w-0 flex-1 basis-48">
      <div class="text-sm text-[var(--gosslan-text)]">{{ label }}</div>
      <p
        v-if="description"
        class="mt-0.5 text-caption leading-relaxed text-[var(--gosslan-text-2)]"
        :style="descriptionMinLines > 0 ? { minHeight: `${descriptionMinLines * 1.625}em` } : undefined"
      >
        {{ description }}
      </p>
    </div>
    <div class="shrink-0"><slot /></div>
  </div>
  <div v-if="!last" class="ml-4 h-px bg-[var(--gosslan-divider)]" />
</template>
