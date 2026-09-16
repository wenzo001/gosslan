import { test } from "node:test";
import assert from "node:assert/strict";
import { FILE_KIND_COLORS, FILE_KIND_ICONS, fileExt, fileKindOf } from "./fileKind.ts";

test("fileExt：常规扩展名取小写", () => {
  assert.equal(fileExt("report.PDF"), "pdf");
  assert.equal(fileExt("a.tar.gz"), "gz");
  assert.equal(fileExt("无扩展名"), "");
});

test("fileExt：隐藏文件视为无扩展名（.gitignore 不是 gitignore 类型）", () => {
  // 前导点不算扩展名分隔符，否则 .gitignore / .env 会被当成 "gitignore" / "env" 类型
  assert.equal(fileExt(".gitignore"), "");
  assert.equal(fileExt(".env"), "");
});

test("fileKindOf：各类扩展名归类", () => {
  assert.equal(fileKindOf("a.xlsx"), "sheet");
  assert.equal(fileKindOf("a.PNG"), "image");
  assert.equal(fileKindOf("a.zip"), "archive");
  assert.equal(fileKindOf("a.mp4"), "video");
  assert.equal(fileKindOf("a.flac"), "audio");
  assert.equal(fileKindOf("a.rs"), "code");
  assert.equal(fileKindOf("a.pdf"), "pdf");
});

test("fileKindOf：未知与无扩展名归 doc（通用文档图标）", () => {
  assert.equal(fileKindOf("report"), "doc");
  assert.equal(fileKindOf("a.unknownext"), "doc");
  assert.equal(fileKindOf(""), "doc");
});

test("配色与图标表覆盖全部文件类型（新增类型必须同时补两处）", () => {
  const kinds = new Set([
    fileKindOf("a.xlsx"),
    fileKindOf("a.png"),
    fileKindOf("a.zip"),
    fileKindOf("a.mp4"),
    fileKindOf("a.mp3"),
    fileKindOf("a.ts"),
    fileKindOf("a.pdf"),
    fileKindOf("a.txt"),
  ]);
  for (const k of kinds) {
    assert.ok(FILE_KIND_COLORS[k], `缺配色：${k}`);
    assert.ok(FILE_KIND_ICONS[k], `缺图标：${k}`);
  }
  assert.equal(kinds.size, Object.keys(FILE_KIND_COLORS).length);
  assert.equal(kinds.size, Object.keys(FILE_KIND_ICONS).length);
});

test("配色表每个类型都有明暗两档（深色模式不能缺档）", () => {
  for (const [k, c] of Object.entries(FILE_KIND_COLORS)) {
    assert.match(c.light, /^#[0-9a-f]{6}$/i, `${k}.light 不是 hex`);
    assert.match(c.dark, /^#[0-9a-f]{6}$/i, `${k}.dark 不是 hex`);
    assert.notEqual(c.light, c.dark, `${k} 明暗档相同，深色模式下会看不清`);
  }
});
