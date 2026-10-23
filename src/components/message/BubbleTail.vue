<script setup lang="ts">
/**
 * 聊天气泡的「小尾巴」—— 指向头像的那枚叶形。
 *
 * ## 为什么是一个组件而不是每处内联一段 SVG
 *
 * 用户 2026-10-23 两轮反馈：① 尾巴吊在气泡底部、跟头像不搭；② 尾巴**上边不够丝滑**，
 * 而且「气泡有边框、尾巴没有」⇒ 接缝处两条线对不上，hover 时还能看出它是贴上去的一块。
 * 用 border 拼三角形/圆角在 12px 这个尺寸上怎么调都有折点；而"和气囊共用一条轮廓线"
 * 需要**同一支描边** —— 只有路径能同时给出曲率连续的外缘和沿边界的 1px 线。
 *
 * 所以这里收成**一个家**（形状只有这一份；五个气泡组件都用它，见 `designGuards` 的
 * "内联 svg 的家" 与 "气泡尖角位置只有一个家" 两条判据）。
 *
 * ## 几何契约（改一个必须同时改另一个）
 *
 * - 盒子 14×14；`style.css` 的 `.bubble-tail` 负责定位与颜色，这里只管形状。
 * - 朝左（对方消息）那一支：气泡**外框**在盒子 x=10；朝右（自己）在 x=4。
 *   对应 `.tail-other{left:-11px}` / `.tail-mine{right:-11px}` —— 那两个常数就是从这里来的。
 * - 填充层（`tail-fill`）从气泡内部 3px 处起笔：把气泡左/右边缘**那一段边框盖掉**，
 *   于是接缝处不会出现"气泡有线、尾巴没线"的台阶。
 * - 描边层（`tail-line`）是一条**开口**路径：从气泡顶边（或中间某点）出发，绕外缘一圈，
 *   再接回气泡边缘 —— 与气泡自己的 1px 边框首尾相接，看上去是同一条线。
 * - 描边色取 `--bubble-line`（由 `useMessageDisplay` 按这条消息的边框色给出），
 *   自己的消息边框透明 ⇒ 描边也透明，只留填充。
 */
withDefaults(defineProps<{ mine?: boolean }>(), { mine: false });
</script>

<template>
  <span aria-hidden="true" class="bubble-tail" :class="mine ? 'tail-mine' : 'tail-other'">
    <svg viewBox="0 0 14 14">
      <!-- 对方消息：尾巴在气泡左侧 -->
      <path class="tail-fill tail-fill-other" d="M14 0H10C4 1 2 4 2 7c0 3 3 5 8 5h4z" />
      <path class="tail-line tail-line-other" d="M10 0C4 1 2 4 2 7c0 3 3 5 8 5" />
      <!-- 自己的消息：镜像到右侧 -->
      <path class="tail-fill tail-fill-mine" d="M0 0h4c6 1 8 4 8 7 0 3-3 5-8 5H0z" />
      <path class="tail-line tail-line-mine" d="M4 0c6 1 8 4 8 7 0 3-3 5-8 5" />
    </svg>
  </span>
</template>
