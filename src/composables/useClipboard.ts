import { ref } from "vue";

export type CopyKey = string | null;

/**
 * 复制反馈：同一时刻只有一个按钮处于「已复制」态（1.5s 后自动复位）。
 * 剪贴板不可用时静默——不弹 toast 打扰发送。
 */
export function useClipboard(resetMs = 1500) {
  const copiedKey = ref<CopyKey>(null);

  function copyContent(key: string, text: string) {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        copiedKey.value = key;
        setTimeout(() => {
          if (copiedKey.value === key) copiedKey.value = null;
        }, resetMs);
      })
      .catch(() => {
        /* 静默 */
      });
  }

  return { copiedKey, copyContent };
}
