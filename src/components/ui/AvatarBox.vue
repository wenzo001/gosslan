<script setup lang="ts">
/**
 * 头像框的**唯一**渲染处（2026-10-29 审计 DUP-08：此前 13 个组件各写一遍
 * `gosslan-avatar-box` + `gosslan-avatar-emoji`，圆角漂成 3 种）。
 *
 * 这里收走的三件事，每一件原先都在多处各写一遍：
 * 1. **盒子形状**：`gosslan-avatar-box flex items-center justify-center overflow-hidden`
 *    —— 少一个 `overflow-hidden` 圆角就不裁图，少一个 `items-center` emoji 就偏下；
 * 2. **"有图显示图、没图显示默认脸"**：这句话在 10-07 那次是 `SelfAvatar` 的立身理由，
 *    但群成员/好友/会话/回执那些地方各自又写了一遍同样的 img-or-emoji 判断；
 * 3. **种子底色**：`avatarSeedFor(id)` 的 `.bg` 与 `.emoji` 必须来自**同一个 id**，
 *    分两处写就会出现"底色是 A 的脸是 B"。
 *
 * 尺寸**仍由调用点用 class 给**（`h-9 w-9` 这种层级本来就是一大一小的关系，写死只会逼
 * 调用点再套一层壳）；需要内联像素尺寸的（`MessageAvatar` 那种传 `size` 的）用 `:size`。
 *
 * 圆角只有三个档，且**默认那一档就是全站档**：`token` = `--gosslan-avatar-radius`。
 * `full` 留给 ≤24px 的小图（16px 上 6px 圆角与圆形几乎看不出差别，但视觉上圆形更稳），
 * `none` 只给"被父级裁切"的那种（会话列表的群头像九宫格 —— 圆角在外层 grid 上）。
 * 新增第四个写法之前先回到这里，不要在调用点补 `rounded-*`。
 *
 * `text-white` 一律带上：emoji 是彩色字形，文字色对它本来就不生效，
 * 而"没图 fallback 成一个字符"以外的内容（将来可能是首字母）需要一致的前景色。
 */
import { computed } from "vue";
import { avatarSeedFor } from "@/utils/avatarSeed";

const props = withDefaults(
  defineProps<{
    /** 种子键（一般是 device_id）；空/`null` 时没有底色与 emoji。 */
    id?: string | null;
    /** 头像图地址；没有（或空串）就落回默认脸。 */
    src?: string | null;
    /** 圆角档位，见文件头。 */
    round?: "token" | "full" | "none";
    /**
     * 内联尺寸（任何合法 CSS 长度，含 `var(...)`）。**内联而不是 class** 的理由沿用
     * `MessageAvatar` 那段：两个尺寸类挂在同一元素上时生效的是 Tailwind 里排后面的那个，
     * 而"这个尺寸说话算数"不能靠样式表排序。
     */
    size?: string | number | null;
    /** 显式底色（头像选择器的实时预览用）；不给就从 `id` 的种子推。 */
    bg?: string | null;
    /** 显式那张脸（同上）；不给就从 `id` 的种子推。 */
    emoji?: string | null;
  }>(),
  { id: null, src: null, round: "token", size: null, bg: null, emoji: null },
);

const seed = computed(() => avatarSeedFor(props.id));
const color = computed(() => props.bg ?? seed.value?.bg);
const face = computed(() => props.emoji ?? seed.value?.emoji);
const boxClass = computed(() =>
  props.round === "full"
    ? "rounded-full"
    : props.round === "token"
      ? "rounded-[var(--gosslan-avatar-radius)]"
      : "",
);
const boxStyle = computed(() => {
  const px = typeof props.size === "number" ? `${props.size}px` : props.size ?? "";
  return px
    ? { width: px, height: px, backgroundColor: color.value }
    : { backgroundColor: color.value };
});
</script>

<template>
  <div
    class="gosslan-avatar-box flex items-center justify-center overflow-hidden text-white"
    :class="boxClass"
    :style="boxStyle"
  >
    <img
      v-if="src"
      :src="src"
      alt=""
      loading="lazy"
      decoding="async"
      draggable="false"
      class="h-full w-full object-cover"
    />
    <span v-else class="gosslan-avatar-emoji" aria-hidden="true">{{ face }}</span>
  </div>
</template>
