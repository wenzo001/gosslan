import assert from "node:assert/strict";
import test from "node:test";
import { favoritePreviewCandidates, resetFavoritePreviewQueue } from "./favoritePreviewQueue.ts";

const row = (id: string) => ({ id });

test("收藏预览只从当前筛选 rows 入队", () => {
  const visible = [row("img-1"), row("img-2")];
  assert.deepEqual(
    favoritePreviewCandidates(visible, { "img-1": "blob:1" }, new Set(["img-2"])),
    [],
  );
  assert.deepEqual(favoritePreviewCandidates(visible, {}, new Set()), visible);
});

test("切筛选清未发队列并允许重新入队；在途 IPC 不假装归零", () => {
  const seen = new Set(["queued", "flying"]);
  const inFlight = new Set(["flying"]);
  const reset = resetFavoritePreviewQueue([row("queued")], seen, inFlight);
  assert.deepEqual(reset.queue, []);
  assert.equal(reset.seen.has("queued"), false);
  assert.equal(reset.seen.has("flying"), true);
  assert.equal(inFlight.size, 1);
  assert.deepEqual(favoritePreviewCandidates([row("queued"), row("flying")], {}, reset.seen), [row("queued")]);
});
