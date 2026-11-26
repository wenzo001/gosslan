import { defineComponent, h, onBeforeUnmount, onMounted, ref } from "vue";
import { NConfigProvider, darkTheme } from "naive-ui";
import { naiveThemeOverrides } from "./naiveTheme";

/**
 * naive-ui 的全局 Provider（每个窗口一份，挂在 `boot.createWindowApp` 里）。
 *
 * 为什么用 `html.dark` 而不是 `useAppStore().dark` 当判据：
 * 亮/暗的唯一来源已经是 `documentElement` 上的 `class="dark"`（store 的 watch 负责 toggle，
 * `theme-boot.js` 首帧也写它）。naive 的 `darkTheme` 跟着同一个 class 走，
 * 就不会出现「CSS 已暗、naive 组件还亮」的半暗状态；也避免 boot → store 的依赖环。
 *
 * `abstract: true`：不渲染额外包裹元素。窗口根节点的布局（flex / 100% 高度）由各入口
 * 自己决定，Provider 只负责下发 token，不许插一层盒子把所有 `h-full` 打回原形。
 */
export default defineComponent({
  name: "GosslanNaiveRoot",
  setup(_, { slots }) {
    const isDark = ref(
      typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
    );
    let mo: MutationObserver | null = null;
    const sync = () => {
      isDark.value = document.documentElement.classList.contains("dark");
    };
    onMounted(() => {
      sync();
      if (typeof MutationObserver === "undefined") return;
      mo = new MutationObserver(sync);
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    });
    onBeforeUnmount(() => {
      mo?.disconnect();
      mo = null;
    });
    return () =>
      h(
        NConfigProvider,
        {
          abstract: true,
          theme: isDark.value ? darkTheme : null,
          themeOverrides: naiveThemeOverrides,
        },
        { default: () => slots.default?.() },
      );
  },
});
