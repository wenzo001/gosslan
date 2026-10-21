import { ref } from "vue";
import { isImeKey } from "@/utils/ime";

/**
 * 「输入框里的回车」必须让路给输入法 —— 可复用的守卫。
 *
 * 为什么需要：`MessageComposer` 已经修过这个真实缺陷（用户：「输入拼音/英文后按回车，
 * 英文没落下来，中文却发出去了」）。根因是**不能只信 `KeyboardEvent.isComposing`**：
 * macOS WKWebView 上用 Enter 提交候选的顺序是 `compositionend` → `keydown`，
 * keydown 那一刻 `isComposing` 已是 false。
 *
 * 只要某处"回车 = 触发一个动作"（发送、打开搜索、提交表单），就会踩同一个坑。
 * 把它收成一个 composable，调用方三行接完：
 *
 * ```vue
 * const ime = useImeEnterGuard();
 * function onEnter(e: KeyboardEvent) {
 *   if (ime.isIme(e)) return; // 交给输入法，别执行动作
 *   emit("submit");
 * }
 * ```
 * 模板上同时挂 `@compositionstart="ime.onStart"` 与 `@compositionend="ime.onEnd"`。
 * （注意：JSDoc 里不要写嵌套的块注释，前一个 `*／` 会提前结束注释。）
 */
export function useImeEnterGuard() {
  const composing = ref(false);
  /** 最近一次 `compositionend` 的时间戳（ms）；从未发生为 0。 */
  let endedAt = 0;

  return {
    onStart: () => {
      composing.value = true;
    },
    onEnd: () => {
      composing.value = false;
      endedAt = Date.now();
    },
    /** true ⇒ 这次按键属于输入法提交，调用方必须直接 return（不要执行动作）。 */
    isIme: (e: KeyboardEvent) => isImeKey(e, composing.value, endedAt, Date.now()),
    /**
     * 「回车 = 一个动作」的免接线版：把它直接挂到 `@keydown.enter` / `@keyup.enter` 上，
     * 输入法让路这件事就由这里管，调用方只写动作本身。
     *
     * 为什么要有这一格（2026-10-20）：`isIme` 那套管用是因为调用方**拿得到事件**，
     * 但全仓 12 处 Enter 提交里有 9 处的模板写成 `@keyup.enter="保存"`（零参数处理器），
     * 接线要各自再写一个包事件的函数 —— 实测同一缺陷正因为"每处自己接"才会漏。
     * 挂这一格后模板只剩一次 `ime.enter(fn)`，漏不漏由判据 53 数，不靠人记得。
     */
    enter: (fn: () => void) => (e: KeyboardEvent) => {
      if (isImeKey(e, composing.value, endedAt, Date.now())) return;
      fn();
    },
  };
}
