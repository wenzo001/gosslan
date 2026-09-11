import { APP_ACTION } from "./appActions.ts";

/**
 * 应用级快捷键判定（纯函数，便于单测）。
 *
 * 规则与 useShortcuts 的键盘监听完全一致，抽出来是为了能覆盖这些边界：
 *   —— 只认「主修饰键 + 单个字符/符号」的组合，绝不动 ⌘C / ⌘V / ⌘A / ⌘X（系统编辑键）；
 *   —— alt / shift 任一按下即放行（避免抢系统/应用内的组合）；
 *   —— 输入法组合态（isComposing）放行，避免中文候选时误触发。
 */

export interface ShortcutInput {
  /** 主修饰键已按下：macOS = meta(⌘)，其余平台 = ctrl。 */
  mod: boolean;
  alt: boolean;
  shift: boolean;
  isComposing: boolean;
  /** 原始 e.key（如 "f"、"F"、"n"、","）；内部统一小写化。 */
  key: string;
}

/** 命中则返回应用级动作名，否则返回 null（不处理该按键）。 */
export function matchAppShortcut(input: ShortcutInput): string | null {
  if (input.isComposing) return null;
  if (!input.mod || input.alt || input.shift) return null;
  const key = input.key.toLowerCase();
  switch (key) {
    case ",":
      return APP_ACTION.openSettings;
    case "f":
      return APP_ACTION.focusSearch;
    case "n":
      return APP_ACTION.addFriend;
    default:
      return null;
  }
}
