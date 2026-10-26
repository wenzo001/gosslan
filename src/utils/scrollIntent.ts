/**
 * `props.items` 变化到底是「追加 / 前插 / 整会话替换 / 只是内容更新」——只此一处判定。
 *
 * 为什么必须拆开：2026-10-25 的 P0 是「末尾追加一条」被当成了「切换会话」，
 * 于是列表无条件 `pinned = true` 并 `scrollTop = scrollHeight` —— 用户正在读历史时，
 * 来一条新消息会被一帧拽出 70,702px。首尾 key 是否变化不足以区分：
 *   追加   = 首 key 还在、末 key 变了；
 *   前插   = 末 key 还在、首 key 变了；
 *   整替换 = 首尾 key 都不在了。
 * 这个函数只做键数组上的比较，不依赖 Vue / 列表实现，便于跑真值表。
 */
export type ItemsChangeKind =
  | "initial" // 空 → 有
  | "none" // 键序完全没变（内容原地更新）
  | "append" // 只在末尾加/删
  | "prepend" // 只在开头加/删
  | "both" // 头尾同时变化（翻历史的同时来了新消息）
  | "replace" // 只有一端还能找到旧键：局部替换/删除
  | "swap"; // 旧的首尾键都找不到：整会话替换（或清空）

export interface ItemsChange {
  kind: ItemsChangeKind;
  /** 旧首键在新数组里的下标（-1 = 找不到） */
  firstIdx: number;
  /** 旧末键在新数组里的下标（-1 = 找不到） */
  lastIdx: number;
}

export function classifyItemsChange(
  prev: { first: string; last: string } | null,
  keys: readonly string[],
): ItemsChange {
  if (!prev) return { kind: "initial", firstIdx: -1, lastIdx: -1 };
  if (keys.length === 0) return { kind: "swap", firstIdx: -1, lastIdx: -1 };
  const firstIdx = keys.indexOf(prev.first);
  const lastIdx = keys.indexOf(prev.last);
  if (firstIdx < 0 && lastIdx < 0) return { kind: "swap", firstIdx, lastIdx };
  if (firstIdx < 0 || lastIdx < 0) return { kind: "replace", firstIdx, lastIdx };
  const prepended = firstIdx > 0;
  const appended = lastIdx < keys.length - 1;
  if (prepended && appended) return { kind: "both", firstIdx, lastIdx };
  if (appended) return { kind: "append", firstIdx, lastIdx };
  if (prepended) return { kind: "prepend", firstIdx, lastIdx };
  return { kind: "none", firstIdx, lastIdx };
}
