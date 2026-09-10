import { onBeforeUnmount, onMounted } from "vue";
import { emitAction } from "@/utils/appActions";
import { isMac } from "@/utils/platform";
import { matchAppShortcut } from "@/utils/shortcuts";

/**
 * 应用级键盘快捷键。
 *
 * 为什么需要：macOS 有原生菜单栏（src-tauri/src/menu.rs）负责 ⌘, / ⌘N / ⌘F 的可见性，
 * 但 Windows / Linux 用的是自绘标题栏、没有菜单栏 —— 快捷键在那里必须自己接。
 * 而且菜单属于"锦上添花"：它初始化失败时应用照常运行，此时快捷键仍应可用。
 *
 * 设计要点：
 *   —— 只处理**带修饰键**的组合，绝不动 ⌘C / ⌘V / ⌘A / ⌘X（那是系统的编辑键，
 *      且已由 macOS 的「编辑」菜单提供，抢过来只会破坏复制粘贴）；
 *   —— 触发的是**应用级动作**而不是直接改组件状态，与原生菜单走同一条路径；
 *   —— 命中判定抽成 `matchAppShortcut` 纯函数（见 utils/shortcuts.ts），
 *      这里只负责「翻译按键 → 动作」并 dispatch。
 */

export function useShortcuts() {
  function onKeydown(e: KeyboardEvent) {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const action = matchAppShortcut({
      mod,
      alt: e.altKey,
      shift: e.shiftKey,
      isComposing: e.isComposing,
      key: e.key,
    });
    if (!action) return;
    e.preventDefault();
    emitAction(action);
  }

  onMounted(() => window.addEventListener("keydown", onKeydown));
  onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
}
