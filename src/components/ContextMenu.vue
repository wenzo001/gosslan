<script setup lang="ts">
/* focus-ring-ok:file：菜单容器只用来把焦点接进来（`role="menu"` + `tabindex="-1"`），
   焦点指示由内部条目承担；给整块弹层画 2px 环只会变成噪声。按 `designGuards` ⑦ 的文件级口径声明。 */
/**
 * 右键/上下文菜单的**统一外壳**（用户需求 2026-09-12 晚 #4：「全局的右键菜单样式尽量保持统一」）。
 *
 * 弹层内核（贴边翻转、点外部/Esc 关闭、焦点移入/归还、↑↓/Home/End/首字母跳转）全部交给 Reka UI 的
 * DropdownMenu：它接受一个虚拟锚点 `reference`，所以「在鼠标坐标处弹出」不需要自建定位与键盘循环。
 * 本组件只保留业务侧的坐标入参、Gosslan 的 `.gosslan-menu*` 外观和关闭后的焦点归还。
 *
 * ⚠️ 菜单内容**不能**再写 `fixed`：定位层是 Reka 的 popper wrapper（它才量尺寸和做翻转/内收），
 * `fixed` 子元素不贡献父级尺寸 ⇒ wrapper 量到 0×0，贴边翻转会静默失效（实测踩过）。
 *
 * 条目必须由调用方写成 `<DropdownMenuItem class="gosslan-menu-item" @select="…">`（见各
 * `*ContextMenu.vue`）；说明文字/分隔线不进菜单集合，不参与键盘导航。
 */
import { nextTick, onMounted, ref } from "vue";
import {
  DropdownMenuContent,
  DropdownMenuPortal,
  DropdownMenuRoot,
} from "reka-ui";

const props = defineProps<{ x: number; y: number }>();

const emit = defineEmits<{ (e: "close"): void }>();

/** 鼠标位置作为零尺寸锚点：`side=bottom`/`align=start` 时菜单左上角落在 (x, y)。 */
const anchor = {
  getBoundingClientRect: () => ({
    width: 0,
    height: 0,
    x: props.x,
    y: props.y,
    left: props.x,
    right: props.x,
    top: props.y,
    bottom: props.y,
  }),
};

const contentRef = ref<{ $el?: Element } | null>(null);
/** 打开前的焦点位置：关闭后还回去，避免键盘用户"焦点丢失"（落到 body）。 */
let restoreFocus: HTMLElement | null = null;
let closing = false;

onMounted(() => {
  restoreFocus = document.activeElement as HTMLElement | null;
});

function close() {
  if (closing) return;
  closing = true;
  const back = restoreFocus;
  restoreFocus = null;
  const active = document.activeElement;
  const menu = contentRef.value?.$el;
  // 只在焦点还留在菜单里（键盘选择）或已经掉到 body 上（鼠标点条目）时归还，
  // 以免抢走用户用鼠标点到的其它元素。
  const stuck = active === document.body || (!!menu && menu.contains(active));
  emit("close");
  if (stuck && back && document.body.contains(back)) {
    nextTick(() => back.focus({ preventScroll: true }));
  }
}

function onOpenChange(open: boolean) {
  if (!open) close();
}
</script>

<template>
  <DropdownMenuRoot :open="true" :modal="false" @update:open="onOpenChange">
    <DropdownMenuPortal>
      <DropdownMenuContent
        ref="contentRef"
        :reference="anchor"
        side="bottom"
        align="start"
        :side-offset="0"
        :align-offset="0"
        :collision-padding="8"
        class="frost gosslan-menu z-[70] select-none outline-none"
        aria-orientation="vertical"
        @click.stop
        @contextmenu.prevent
      >
        <slot />
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>
