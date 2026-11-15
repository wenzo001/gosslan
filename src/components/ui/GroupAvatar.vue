<script setup lang="ts">
/**
 * 群头像（会话列表那一格）。
 *
 * ## 形状为什么不是「2×2 九宫格」
 *
 * 见 `src/utils/groupAvatar.ts` 的文件头：旧形状在成员不足 4 人时会留下
 * 明显的空角（一个人 ⇒ 只有左上角一张脸），看着像渲染坏了。新形状是
 * **交叠的簇**：人少就把脸放大、交叠，整块圆被铺满，且一眼就是「好几个人」。
 *
 * ## 边界
 *
 * - **只做形状**：成员资料（头像图、昵称种子）由调用点准备好传进来；
 * - **脸仍旧走 `AvatarBox`**（全应用唯一的头像渲染处），本组件只管摆位置；
 * - 角标是「这是个群」的载体（一个人也能建群，单看一张脸分不出来）。
 */
import { computed } from "vue";

import AvatarBox from "@/components/ui/AvatarBox.vue";
import Icon from "@/components/ui/Icon.vue";
import { groupAvatarLayout, type GroupAvatarMember } from "@/utils/groupAvatar";

const props = withDefaults(
  defineProps<{
    /** 成员（按稳定顺序）。前 3 个会被画出来，其余不画（角标只说明「这是个群」）。 */
    members: GroupAvatarMember[];
    /** 容器边长（任何合法 CSS 长度）。默认跟会话列表头像同一档。 */
    size?: string;
  }>(),
  { size: "var(--gosslan-row-avatar)" },
);

const layout = computed(() => groupAvatarLayout(props.members.length));

/** 要画的脸（最多 3 张；成员更多时多出来的不画）。 */
const faces = computed(() => props.members.slice(0, layout.value.slots.length));
</script>

<template>
  <div
    class="relative shrink-0"
    :style="{ width: props.size, height: props.size }"
    data-group-avatar
  >
    <!-- 簇本体：整块圆被裁成一个圆，成员脸在里面交叠 ⇒ 没有空角。 -->
    <div
      class="absolute inset-0 overflow-hidden rounded-full bg-[var(--gosslan-divider)]"
    >
      <AvatarBox
        v-for="(slot, i) in layout.slots"
        :key="i"
        round="full"
        class="absolute"
        :id="faces[i]?.id"
        :src="faces[i]?.avatar ?? null"
        :style="{
          left: `${slot.left * 100}%`,
          top: `${slot.top * 100}%`,
          width: `${slot.size * 100}%`,
          height: `${slot.size * 100}%`,
          zIndex: slot.z,
        }"
      />
    </div>
    <!-- 角标：一个人的群也得让人看出「这是群」。徽标语言与未读徽标一致
         （`--gosslan-primary-active` 底 + `--gosslan-on-primary` 字）。 -->
    <span
      v-if="layout.chip"
      class="absolute -bottom-0.5 -right-0.5 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--gosslan-primary-active)] text-[var(--gosslan-on-primary)] shadow-[0_0_0_2px_var(--gosslan-list)]"
      aria-hidden="true"
    >
      <Icon name="users" class="h-3 w-3" />
    </span>
  </div>
</template>
