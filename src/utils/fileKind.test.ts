import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  FILE_KIND_COLORS,
  FILE_KIND_ICONS,
  extBadgeLabel,
  fileExt,
  fileKindOf,
  fileKindStyle,
} from "./fileKind.ts";

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

test("extBadgeLabel：无扩展名兜底、超长截断（收藏那处以前两样都不做）", () => {
  assert.equal(extBadgeLabel("report.PDF", "文件"), "PDF");
  // 真实缺陷：`fileExt(name).toUpperCase()` 在"没有扩展名"时渲染成空串，
  // 收藏详情里就剩下一个孤零零的「 · 大小」。
  assert.equal(extBadgeLabel("无扩展名", "文件"), "文件");
  assert.equal(extBadgeLabel(".gitignore", "文件"), "文件", "点开头的名字整段是文件名，不是扩展名");
  // 真实缺陷的另一半：不截断时一长串扩展名会把角标撑破。
  assert.equal(extBadgeLabel("archive.verylongext", "文件"), "VERY");
});

test("fileKindStyle：亮/暗各取对应强调色，底色是 12% 混底", () => {
  const light = fileKindStyle("a.pdf", false);
  assert.equal(light.color, FILE_KIND_COLORS.pdf.light);
  // #dc2626 = rgb(220, 38, 38)；0.12 是徽标底色的既有比例，改它等于改观感
  assert.equal(light.backgroundColor, "rgba(220, 38, 38, 0.12)");
  const dark = fileKindStyle("a.pdf", true);
  assert.equal(dark.color, FILE_KIND_COLORS.pdf.dark);
  assert.equal(dark.backgroundColor, "rgba(248, 113, 113, 0.12)");
});

test("fileKindStyle：未知扩展名落到 doc 那一档（不是凭空新颜色）", () => {
  assert.equal(fileKindStyle("x.zzz", false).color, FILE_KIND_COLORS.doc.light);
  assert.equal(fileKindStyle("x.zzz", true).color, FILE_KIND_COLORS.doc.dark);
});

test("徽标配色只有一份：群文件面板与收藏页都调 fileKindStyle，且不再各自混 0.12", () => {
  for (const rel of ["../components/GroupFilesPanel.vue", "../components/FavoritePanel.vue"]) {
    const src = readFileSync(new URL(rel, import.meta.url), "utf8");
    assert.match(src, /fileKindStyle\(/, `${rel} 必须用共享的徽标配色`);
    assert.doesNotMatch(src, /rgba\([^)]*0\.12\)/, `${rel} 里又手抄了一份 12% 混底`);
  }
});
