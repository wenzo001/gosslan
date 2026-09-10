import { onUnmounted, ref } from "vue";
import {
  activePopupKey,
  claimPopup,
  releasePopup,
  subscribePopup,
} from "@/utils/popupRegistry";

/**
 * 让一个浮层参与「全局只展开一个」。
 *
 * 用法（组件 setup 内，`key` 在实例内固定且全局唯一）：
 * ```ts
 * const popup = useExclusivePopup(`menu:${msgKey}`);
 * watch(popup.isActive, (mine) => { if (!mine) 关闭自己(); });
 * // 打开时 popup.claim()；关闭时 popup.release()
 * ```
 * `isActive` 变为 false 即表示别的浮层抢占了展开权，此时必须收起自己
 * ——这样右键不同消息、或右键消息与好友菜单之间都不会出现两个浮层并存。
 */
export function useExclusivePopup(key: string) {
  const isActive = ref(activePopupKey() === key);
  const unsubscribe = subscribePopup(() => {
    isActive.value = activePopupKey() === key;
  });
  onUnmounted(unsubscribe);
  return {
    isActive,
    claim: () => claimPopup(key),
    release: () => releasePopup(key),
  };
}
