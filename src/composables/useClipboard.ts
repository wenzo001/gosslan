import { ref } from "vue";
import { useClipboard as useVueClipboard } from "@vueuse/core";

export type CopyKey = string | null;

/**
 * 复制反馈：同一时刻只有一个按钮处于「已复制」态（1.5s 后自动复位）。
 * 剪贴板不可用时静默——不弹 toast 打扰发送。
 *
 * 写入交给 VueUse（`legacy: true` 会在非 secure context / 老 WebView 上回退 execCommand），
 * 本组合式只保留 Gosslan 的"按 key 复用同一枚已复制勾"这层业务语义。
 */
export function useClipboard(resetMs = 1500) {
  const copiedKey = ref<CopyKey>(null);
  const { copy } = useVueClipboard({ legacy: true });

  /**
   * 复制文本。**返回是否成功** —— 调用方需要据此给用户反馈：
   * 移动端「长按 → 底部操作面板」点完面板就关了，若没有额外提示，
   * 用户根本不知道复制成功没有（气泡上的"已复制"勾只在长文本操作条里渲染）。
   */
  async function copyContent(key: string, text: string): Promise<boolean> {
    // VueUse 的 copy 会自行捕获写失败并回退 legacy；它不返回布尔值（v14 返回 void）。
    // 这里保持"调用即视为已尝试"的旧语义，复制反馈不阻塞业务。
    await copy(text);
    copiedKey.value = key;
    setTimeout(() => {
      if (copiedKey.value === key) copiedKey.value = null;
    }, resetMs);
    return true;
  }

  return { copiedKey, copyContent };
}
