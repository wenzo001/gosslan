import { onScopeDispose, ref } from "vue";
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
  let timer = 0;
  // 连点两次要以后一次为准（旧表不摘会把新一次的"已复制"提前抹掉）。
  // 作用域销毁（组件卸载）时同样摘表 —— 原来那条裸 setTimeout 会在卸载后回写 ref。
  onScopeDispose(() => clearTimeout(timer));

  /**
   * 复制文本；成功与否**不承诺**（见下）。移动端「长按 → 底部操作面板」点完面板就关了，
   * 靠调用方补一句 toast，别指望这里返回值。
   *
   * ⚠️ 原先这里返回 `Promise<boolean>`，而实现恒为 `true` ⇒ 五个组件里
   *    `ok ? 已复制 : 复制失败` 的失败半边是**永远不会跑的分支**，
   *    真写不进剪贴板时界面照样说"已复制"。签名改成 `void` 后，编译器会把每一处
   *    假分支点出来（本仓数影响面一向按编译器数，不按"我觉得哪几个文件"）。
   *    为什么给不了真布尔：@vueuse/core 14.4.0 的 `copy()` 里 async 分支 `catch` 后
   *    直接转 legacy、`legacyCopy` 把 `execCommand("copy")` 的返回值丢掉，
   *    然后**无条件** `copied.value = true` —— 库里就没有这个信号。
   */
  async function copyContent(key: string, text: string): Promise<void> {
    await copy(text);
    copiedKey.value = key;
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (copiedKey.value === key) copiedKey.value = null;
    }, resetMs);
  }

  return { copiedKey, copyContent };
}
