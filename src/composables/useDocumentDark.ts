/**
 * 当前文档是否处于暗色主题（读 `<html class="dark">`）。
 *
 * 为什么不用 `useAppStore().dark`：独立窗口里 store 不一定要初始化（日志窗口完全没有 store），
 * 而这个信号是**跨窗口一致**的 —— `theme-boot.js` 在首帧按 localStorage 写入，`applyThemeNow()`
 * 在切主题时维护，`installDocumentDark` 之外没有第二份真相。
 *
 * 用 `MutationObserver` 观察 `<html>` 的 class：切主题时（同一窗口或别的窗口改了设置）自动跟上。
 */
import { onBeforeUnmount, ref, type Ref } from "vue";

export function useDocumentDark(): Ref<boolean> {
  const dark = ref(false);
  if (typeof document === "undefined") return dark;

  const el = document.documentElement;
  const read = () => {
    dark.value = el.classList.contains("dark");
  };
  read();

  const observer = new MutationObserver(read);
  observer.observe(el, { attributes: true, attributeFilter: ["class"] });
  onBeforeUnmount(() => observer.disconnect());

  return dark;
}
