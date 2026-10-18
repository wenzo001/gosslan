import assert from "node:assert/strict";
import test from "node:test";
import {
  INITIAL_PREVIEW_VIEW,
  PREVIEW_PULL_TIMEOUT_MS,
  reducePreviewGallery,
  withTimeout,
} from "./previewGalleryState.ts";

const img = (name: string) => ({ name, msgId: `m-${name}` });

test("初始进入 loading；loaded 后 ready 且下标夹到合法范围", () => {
  const loading = reducePreviewGallery(INITIAL_PREVIEW_VIEW, { kind: "begin" });
  assert.equal(loading.status, "loading");
  const ready = reducePreviewGallery(loading, {
    kind: "loaded",
    gallery: { items: [img("a"), img("b")], index: 9 },
  });
  assert.equal(ready.status, "ready");
  assert.equal(ready.index, 1);
  assert.equal(ready.images.length, 2);
});

test("空相册进入 empty，不再留一个空白 open=false 的窗口", () => {
  const empty = reducePreviewGallery(INITIAL_PREVIEW_VIEW, {
    kind: "loaded",
    gallery: { items: [], index: 0 },
  });
  assert.equal(empty.status, "empty");
  assert.equal(empty.images.length, 0);
});

test("没有旧内容时失败进入 error；有旧内容时保留图片并只记错误", () => {
  const failed = reducePreviewGallery(INITIAL_PREVIEW_VIEW, {
    kind: "failed",
    message: "ipc down",
  });
  assert.equal(failed.status, "error");
  assert.equal(failed.error, "ipc down");

  const ready = reducePreviewGallery(failed, {
    kind: "loaded",
    gallery: { items: [img("a")], index: 0 },
  });
  const refreshFailed = reducePreviewGallery(ready, { kind: "failed", message: "boom" });
  assert.equal(refreshFailed.status, "ready");
  assert.equal(refreshFailed.images.length, 1);
  assert.equal(refreshFailed.error, "boom");
});

test("begin 在有内容时不回退到 loading（避免重开窗口闪白）", () => {
  const ready = reducePreviewGallery(INITIAL_PREVIEW_VIEW, {
    kind: "loaded",
    gallery: { items: [img("a")], index: 0 },
  });
  const again = reducePreviewGallery(ready, { kind: "begin" });
  assert.equal(again.status, "ready");
  assert.equal(again.images.length, 1);
});

test("released 清空图片并回到 loading，供隐藏窗口复用", () => {
  const ready = reducePreviewGallery(INITIAL_PREVIEW_VIEW, {
    kind: "loaded",
    gallery: { items: [img("a")], index: 0 },
  });
  const released = reducePreviewGallery(ready, { kind: "released" });
  assert.equal(released.status, "loading");
  assert.equal(released.images.length, 0);
  assert.equal(released.index, 0);
});

test("withTimeout 正常返回时不误杀；超时抛出给定文案", async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 50, "timeout"), 7);
  await assert.rejects(
    withTimeout(new Promise<never>(() => {}), 20, "预览加载超时"),
    /预览加载超时/,
  );
  assert.ok(PREVIEW_PULL_TIMEOUT_MS >= 3000, "超时预算不能短到正常慢盘也判死");
});
