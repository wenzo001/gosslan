<script setup lang="ts">
import AvatarBox from "@/components/ui/AvatarBox.vue";

/** 消息头像：连续消息合并时由父组件渲染等宽占位，组件本身不感知合并规则。 */
defineProps<{
  /**
   * 种子用**设备 id / 群 id**，不是昵称：昵称可改（改一次换一张脸）、也能撞名
   * （两个人同昵称就同一张脸），而这张脸的要求是"稳定 + 不撞脸"。
   * 缺 id 时才退回昵称兜底 —— 调用点漏传由 designGuards 的 `:id` 判据拦。
   */
  id?: string | null;
  name: string;
  avatar?: string | null;
  /**
   * 边长（任何合法的 CSS 长度，含 `var(...)`）。**缺省时保持 36px**（下面那对 `h-9 w-9`）。
   *
   * 为什么要这个 prop 而不是直接改类名：消息行要的是 `--gosslan-msg-avatar`（30px，
   * 设计规范里群聊头像 28~32 的档），而会话搜索、成员列表这些地方要的是原来的 36px。
   * ⚠️ 这里用**内联样式**而不是"父层传 class"：`h-9` 与 `h-8` 是同一个属性，
   *   两个 class 同时挂在一颗元素上时生效的是 Tailwind 里排后面的那一个（本仓实测踩过两次），
   *   而内联压过样式表是无条件的 —— 尺寸这种"必须说话算数"的量不能靠样式表排序。
   */
  size?: string;
}>();

</script>

<template>
  <AvatarBox class="h-9 w-9 shrink-0" :id="id || name" :src="avatar" :size="size ?? null" />
</template>
