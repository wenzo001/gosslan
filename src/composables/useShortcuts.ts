import { onBeforeUnmount, onMounted } from "vue";
import { emitAction } from "@/utils/appActions";
import { isMac } from "@/utils/platform";
import { matchAppShortcut } from "@/utils/shortcuts";
import { useAppStore } from "@/stores/useAppStore";
import { CHAT_FONT_SIZES } from "@/utils/chatStyle";

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
 *      这里只负责「翻译按键 → 动作」并 dispatch；
 *   —— ⌘/Ctrl + "=" / "-" 调整消息字号（Dynamic Type 精神，三档 小/标准/大），
 *      直接改 store 而非走事件（它是连续微调、无需跨组件协作）。
 */

export function useShortcuts() {
  const app = useAppStore();

  /** 在 小/标准/大 三档间上下移动，返回新字号；到边界时原地不动。 */
  function shiftFontSize(dir: 1 | -1) {
    const keys = CHAT_FONT_SIZES.map((f) => f.key);
    const idx = keys.indexOf(app.chatStyle.fontSize);
    const next = keys[Math.min(keys.length - 1, Math.max(0, idx + dir))];
    if (next && next !== app.chatStyle.fontSize) app.setChatStyle({ fontSize: next });
  }

  function onKeydown(e: KeyboardEvent) {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (!mod || e.altKey || e.isComposing) return;

    // ⌘/Ctrl + "="（含 Shift 出的 "+"）放大、"-" 缩小消息字号
    if (!e.shiftKey && e.key === "=") {
      e.preventDefault();
      shiftFontSize(1);
      return;
    }
    if (!e.shiftKey && e.key === "-") {
      e.preventDefault();
      shiftFontSize(-1);
      return;
    }

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
