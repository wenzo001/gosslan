import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPaste } from "./clipboard.ts";

// 覆盖 P1 后「剪贴板图片无法发送」的回归：图片位图必须独立从 items 判断，
// 不能因为 types 里没有 "Files" 就落到纯文本分支。

const IMG: { kind: string; type: string } = { kind: "file", type: "image/png" };
const TEXT: { kind: string; type: string } = { kind: "string", type: "text/plain" };

test("截图/网页复制图片：types 只有 image/png（无 Files）→ 仍判为图片", () => {
  const action = classifyPaste(["image/png"], [IMG], false);
  assert.equal(action.kind, "image");
});

test("纯文本粘贴 → 判为文本", () => {
  const action = classifyPaste(["text/plain"], [TEXT], false);
  assert.equal(action.kind, "text");
});

test("图片粘贴绝不落入文本分支（不触发普通文本插入）", () => {
  const action = classifyPaste([], [IMG], false);
  assert.notEqual(action.kind, "text");
  assert.equal(action.kind, "image");
});

test("资源管理器复制文件（有真实路径）→ 优先按文件发送", () => {
  const action = classifyPaste(["Files"], [IMG], true);
  assert.equal(action.kind, "files");
});

test("剪贴板带 Files 但无真实文件路径（位图）→ 回退图片", () => {
  const action = classifyPaste(["Files"], [IMG], false);
  assert.equal(action.kind, "image");
});

test("空剪贴板 → 判为文本（不崩溃）", () => {
  const action = classifyPaste([], [], false);
  assert.equal(action.kind, "text");
});
