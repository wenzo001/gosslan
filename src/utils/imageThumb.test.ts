// `imageThumb` 决策层的单测。
//
// 这里钉的全是"最容易写错、且错了以后**看不出来**"的分支：GIF 被压成静图、
// 转码失败把图整个弄丢、小图被压反而更大 —— 这三类都不会报错，只会表现为
// "用着用着图不对了"。所以每一条都必须有判据。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fitThumbnailSize,
  isThumbnailExempt,
  shouldThumbnail,
  thumbnailBytes,
  THUMB_MAX_WIDTH,
  THUMB_MIN_SOURCE_BYTES,
  type Thumbnail,
} from "./imageThumb.ts";

/** 造一份指定字节数的假原图。 */
const bytesOf = (n: number) => new Uint8Array(n);

/** 一个"总是成功"的转码器：产出 `outSize` 字节。 */
const encoderTo = (outSize: number): ((b: Uint8Array, m: string) => Promise<Thumbnail | null>) =>
  async () => ({ bytes: new Uint8Array(outSize), mime: "image/jpeg" });

test("GIF 免压缩：压了就丢动画（canvas 只画第一帧）", () => {
  assert.equal(isThumbnailExempt("image/gif", "a.gif"), true);
  // 扩展名兜底：MIME 判错时（application/octet-stream）仍按 .gif 认出来
  assert.equal(isThumbnailExempt("application/octet-stream", "a.GIF"), true);
  assert.equal(
    shouldThumbnail({ bytes: bytesOf(5_000_000), mime: "image/gif", name: "a.gif" }),
    false,
    "GIF 再大也不压",
  );
});

test("SVG 免压缩：矢量缩放不省内存、光栅化掉质量", () => {
  assert.equal(isThumbnailExempt("image/svg+xml", "i.svg"), true);
});

test("普通大图要压；小图不压（收益抵不上转码成本与质量损失）", () => {
  assert.equal(
    shouldThumbnail({ bytes: bytesOf(5_000_000), mime: "image/jpeg", name: "a.jpg" }),
    true,
  );
  assert.equal(
    shouldThumbnail({ bytes: bytesOf(THUMB_MIN_SOURCE_BYTES), mime: "image/jpeg", name: "a.jpg" }),
    false,
    "正好等于阈值 ⇒ 不压（判据是 >）",
  );
  assert.equal(
    shouldThumbnail({ bytes: bytesOf(THUMB_MIN_SOURCE_BYTES + 1), mime: "image/jpeg", name: "a.jpg" }),
    true,
  );
});

test("非图片 / 空字节不压", () => {
  assert.equal(shouldThumbnail({ bytes: bytesOf(0), mime: "image/png", name: "a.png" }), false);
  assert.equal(
    shouldThumbnail({ bytes: bytesOf(5_000_000), mime: "application/octet-stream", name: "a.bin" }),
    false,
    "代码预览那条路径不带 image/* ⇒ 不该被卷进来",
  );
});

test("正常路径：压成功且更小 ⇒ 用缩略图", async () => {
  const src = bytesOf(1_000_000);
  const out = await thumbnailBytes(
    { bytes: src, mime: "image/png", name: "a.png" },
    encoderTo(50_000),
  );
  assert.equal(out.thumbnailed, true);
  assert.equal(out.bytes.length, 50_000);
  assert.equal(out.mime, "image/jpeg");
});

test("转码器返回 null ⇒ 回退原图（字节与 MIME 都不变）", async () => {
  const src = bytesOf(1_000_000);
  const out = await thumbnailBytes(
    { bytes: src, mime: "image/png", name: "a.png" },
    async () => null,
  );
  assert.equal(out.thumbnailed, false);
  assert.equal(out.bytes, src, "回退必须是**同一份**字节，不能拷贝也不能清空");
  assert.equal(out.mime, "image/png", "回退时 MIME 也要还原成原图的");
});

test("转码器抛异常 ⇒ 静默回退，绝不冒泡（缩略图不许挡住图片显示）", async () => {
  const src = bytesOf(1_000_000);
  const out = await thumbnailBytes({ bytes: src, mime: "image/png", name: "a.png" }, async () => {
    throw new Error("createImageBitmap 在这个环境不存在");
  });
  assert.equal(out.thumbnailed, false);
  assert.equal(out.bytes, src);
});

test("转码器产出空字节 ⇒ 当失败回退（空 Blob 渲染出来就是裂图）", async () => {
  const src = bytesOf(1_000_000);
  const out = await thumbnailBytes(
    { bytes: src, mime: "image/png", name: "a.png" },
    encoderTo(0),
  );
  assert.equal(out.thumbnailed, false);
  assert.equal(out.bytes, src);
});

test("压完反而更大 ⇒ 用原图（已高度压缩的 PNG 会这样）", async () => {
  const src = bytesOf(100_000);
  const out = await thumbnailBytes(
    { bytes: src, mime: "image/png", name: "a.png" },
    encoderTo(200_000),
  );
  assert.equal(out.thumbnailed, false, "变大就不是优化了");
  assert.equal(out.bytes, src);
});

test("GIF 绝不被叫进转码器（有些实现会成功地返回一张静图）", async () => {
  let called = 0;
  const out = await thumbnailBytes({ bytes: bytesOf(5_000_000), mime: "image/gif", name: "a.gif" }, async () => {
    called += 1;
    return { bytes: new Uint8Array(1000), mime: "image/jpeg" };
  });
  assert.equal(called, 0, "免压缩的输入连转码器都不该进");
  assert.equal(out.thumbnailed, false);
});

test("fitThumbnailSize：按宽缩、保持比例、四舍五入", () => {
  assert.deepEqual(fitThumbnailSize(1000, 500), { width: THUMB_MAX_WIDTH, height: 208 });
  assert.deepEqual(fitThumbnailSize(832, 1664), { width: THUMB_MAX_WIDTH, height: 832 });
});

test("fitThumbnailSize：小图不放大", () => {
  assert.deepEqual(fitThumbnailSize(100, 50), { width: 100, height: 50 });
  assert.deepEqual(fitThumbnailSize(THUMB_MAX_WIDTH, 10), { width: THUMB_MAX_WIDTH, height: 10 });
});

test("fitThumbnailSize：退化输入（0 / 负数）返回 0 而不是 NaN", () => {
  assert.deepEqual(fitThumbnailSize(0, 100), { width: 0, height: 0 });
  assert.deepEqual(fitThumbnailSize(100, 0), { width: 0, height: 0 });
  assert.deepEqual(fitThumbnailSize(-5, -5), { width: 0, height: 0 });
});

test("fitThumbnailSize：极扁的图高度至少 1px（不许算出 0 高的 canvas）", () => {
  const r = fitThumbnailSize(100000, 10);
  assert.equal(r.width, THUMB_MAX_WIDTH);
  assert.ok(r.height >= 1, `高度必须 ≥1，实际 ${r.height}`);
});
