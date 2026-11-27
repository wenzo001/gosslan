import assert from "node:assert/strict";
import test from "node:test";
import {
  beginComposerDraftTransition,
  completeComposerDraftTransition,
  isComposerDraftTransitionCurrent,
  saveComposerDraftIfOwned,
  type ComposerDraftOwnership,
} from "./composerDraftOwnership.ts";

test("A→B→C：旧 DOM 只保存给 A，迟到的 B 恢复不能覆盖 C", () => {
  let state: ComposerDraftOwnership = { owner: "A", generation: 1 };
  const saved: Array<[string | null, string]> = [];
  const b = beginComposerDraftTransition(state);
  state = b.state;
  assert.equal(b.saveFrom, "A");
  saveComposerDraftIfOwned({ owner: "A", generation: 1 }, "A", "draft-A", (id, html) => saved.push([id, html]));

  const c = beginComposerDraftTransition(state);
  state = c.state;
  assert.equal(c.saveFrom, null, "B 尚未恢复，不能把 A 的 DOM 再保存进 B");
  assert.equal(isComposerDraftTransitionCurrent(state, b.generation), false);
  state = completeComposerDraftTransition(state, b.generation, "B");
  assert.equal(state.owner, null, "迟到 B 不得夺取编辑器所有权");
  state = completeComposerDraftTransition(state, c.generation, "C");
  assert.equal(state.owner, "C");
  assert.deepEqual(saved, [["A", "draft-A"]]);
});

test("反例：旧会话输入/卸载保存不能写进新会话", () => {
  const saved: Array<[string | null, string]> = [];
  const state: ComposerDraftOwnership = { owner: "B", generation: 3 };
  assert.equal(saveComposerDraftIfOwned(state, "A", "old", (id, html) => saved.push([id, html])), false);
  assert.equal(saveComposerDraftIfOwned(state, "B", "new", (id, html) => saved.push([id, html])), true);
  assert.deepEqual(saved, [["B", "new"]]);
});
