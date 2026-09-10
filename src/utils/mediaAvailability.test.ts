import { test } from "node:test";
import assert from "node:assert/strict";
import { previewFailureResult, shouldProbePresence } from "./mediaAvailability.ts";

// ---------------- 已被清理 vs 查不到：这组判定决定用户看到「已清理」还是裂开的图片框 ----------------

test("确定文件已删除时才标记 missing", () => {
  const r = previewFailureResult("文件不存在");
  assert.equal(r.missing, true);
  assert.equal(r.note, "已被清理");
});

test("「查不到」类失败绝不标记 missing", () => {
  // 乐观消息（尚未落库）会走到"消息不存在"；元数据缺失、路径越权同理。
  // 这些是"未知"，把它们当成"已删除"会把正在发送的图片误标成「已被清理」。
  for (const err of ["消息不存在", "元数据缺少路径", "路径越权", "非普通文件"]) {
    const r = previewFailureResult(err);
    assert.notEqual(r.missing, true, `${err} 不应被判为已清理`);
    assert.equal(r.note, undefined, `${err} 不应产生提示文案`);
  }
});

test("超大文件仍走「无法预览」，且不等于已清理", () => {
  const r = previewFailureResult("TOO_LARGE");
  assert.equal(r.note, "文件过大，无法预览");
  assert.notEqual(r.missing, true, "文件太大不代表文件被删了");
});

test("未知错误不产生任何提示（保持既有回退行为）", () => {
  assert.deepEqual(previewFailureResult(""), {});
  assert.deepEqual(previewFailureResult("EIO: read failed"), {});
});

test("错误文案被包装时仍能识别（Tauri reject 可能带前缀）", () => {
  // 用 includes 而非全等：后端文案改变包装方式时不该让判定悄悄失效。
  assert.equal(previewFailureResult("internal error: 文件不存在").missing, true);
  assert.equal(previewFailureResult("error: TOO_LARGE").note, "文件过大，无法预览");
});

// ---------------- 什么时候需要额外探测一次"文件还在不在" ----------------

test("普通文件才需要单独探测", () => {
  assert.equal(shouldProbePresence("file", { subtype: "file", path: "/d/a.pdf" }), true);
});

test("图片/代码附件由预览读取代劳，不重复探测", () => {
  assert.equal(shouldProbePresence("file", { subtype: "image", path: "/d/a.png" }), false);
  assert.equal(shouldProbePresence("file", { subtype: "code", path: "/d/a.ts" }), false);
});

test("路径为空表示还没到本机，探测无意义", () => {
  assert.equal(shouldProbePresence("file", { subtype: "file", path: "" }), false);
});

test("image 消息与缺失元数据不探测", () => {
  assert.equal(shouldProbePresence("image", { subtype: "image", path: "/d/a.png" }), false);
  assert.equal(shouldProbePresence("file", null), false);
  assert.equal(shouldProbePresence("file", undefined), false);
});
