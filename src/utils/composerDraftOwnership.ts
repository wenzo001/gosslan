/** contenteditable 草稿在会话切换期间的所有权状态。 */
export interface ComposerDraftOwnership {
  /** 当前 DOM 实际属于哪个会话；null = 切换中，尚无会话拥有编辑器。 */
  owner: string | null;
  /** 每次 A→B→C 切换都递增，迟到回调只能完成最新一次。 */
  generation: number;
}

export interface ComposerDraftTransition {
  state: ComposerDraftOwnership;
  generation: number;
  /** 切换前 DOM 的合法所有者；只允许保存一次。 */
  saveFrom: string | null;
}

export function beginComposerDraftTransition(
  state: ComposerDraftOwnership,
): ComposerDraftTransition {
  return {
    state: { owner: null, generation: state.generation + 1 },
    generation: state.generation + 1,
    saveFrom: state.owner,
  };
}

export function isComposerDraftTransitionCurrent(
  state: ComposerDraftOwnership,
  generation: number,
): boolean {
  return state.generation === generation && state.owner === null;
}

export function completeComposerDraftTransition(
  state: ComposerDraftOwnership,
  generation: number,
  convId: string | null,
): ComposerDraftOwnership {
  if (!isComposerDraftTransitionCurrent(state, generation)) return state;
  return { owner: convId, generation };
}

export function saveComposerDraftIfOwned(
  state: ComposerDraftOwnership,
  convId: string | null,
  html: string,
  save: (id: string | null, value: string) => void,
): boolean {
  if (state.owner !== convId) return false;
  save(convId, html);
  return true;
}
