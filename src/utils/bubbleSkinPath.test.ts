import { test } from "node:test";
import assert from "node:assert/strict";
import { bubbleSkinLinePath, bubbleSkinPath, TAIL_REACH, TAIL_RISE } from "./bubbleSkinPath.ts";

/**
 * 单填充皮肤路径的几何守卫（2026-11-05）。
 *
 * 判据只钉**契约**（底边落在 y=h、根部切线竖直、尖端伸出 reach、四角半径照抄），
 * 不钉具体像素 —— 气泡的 w/h/圆角是运行时现量的。
 */

const MINE = { w: 168, h: 36, tl: 18, tr: 18, bl: 18, br: 0 };

test("尾巴尖端落在底边 y=h 上，且伸出气泡边框 TAIL_REACH", () => {
  const d = bubbleSkinPath(MINE);
  assert.ok(d);
  // 叶形那一段（唯一的三次贝塞尔）终点必须是 (w+8, h)：0.5px 短边正是旧实现的缝
  const cubic = d.match(/C ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+)/);
  assert.ok(cubic, "皮肤路径里找不到叶形三次贝塞尔");
  assert.equal(cubic[5], String(MINE.w + TAIL_REACH), "尖端横向伸出量与旧叶形不一致");
  assert.equal(cubic[6], String(MINE.h), "尖端没有落在底边 y=h 上 ⇒ 与气泡底边仍是两段");
});

test("根部切线竖直：控制点 x 与右边框同为 w", () => {
  const d = bubbleSkinPath(MINE);
  assert.ok(d);
  const hinge = MINE.h - TAIL_RISE;
  const at = d.indexOf(`L ${MINE.w} ${hinge}`);
  assert.ok(at >= 0, "找不到根部（右侧边框应在 h-10 处接叶形）");
  const cubic = d.slice(at).match(/^L [^ ]+ [^ ]+ C ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+)/);
  assert.ok(cubic);
  assert.equal(cubic[1], String(MINE.w), "起手控制点不在右边框的竖线上 ⇒ 连接处会折一下");
  assert.ok(Number(cubic[2]) <= hinge + 1e-9 || Number(cubic[2]) > hinge,
    "第二个控制点必须在底边一侧（曲线向外鼓）");
});

test("四角半径照抄传入值；尾巴那一侧的下圆角为 0 ≠ 第二段圆角", () => {
  const d = bubbleSkinPath(MINE);
  assert.ok(d);
  assert.ok(d.startsWith("M 18 0"));
  assert.ok(d.includes(`A 18 18 0 0 1 168 18`), "右上角半径不是现读的 18px");
  // 右下角没有弧（尾巴侧被拉平为 0）—— 出现第二个右下圆角就会与叶形拼出两段
  assert.ok(!d.includes(`A 0 0 0 0 1 ${MINE.w} ${MINE.h - 18}`));
  assert.ok(d.includes("A 18 18 0 0 1 0 18"), "左下角半径丢了");
});

test("非法尺寸返回 null（调用方退回旧叶形）", () => {
  for (const bad of [{ w: 0, h: 36 }, { w: 168, h: 0 }, { w: NaN, h: 36 }, { w: -1, h: 36 }]) {
    assert.equal(bubbleSkinPath({ ...MINE, ...bad }), null, JSON.stringify(bad));
  }
});

test("圆角超过边长时按比例收缩（不会画出自我交叉的 A 弧）", () => {
  const d = bubbleSkinPath({ w: 20, h: 20, tl: 18, tr: 18, bl: 18, br: 0 });
  assert.ok(d);
  const arcs = [...d.matchAll(/A ([^ ]+) [^ ]+ 0 0 1/g)].map((m) => Number(m[1]));
  for (const r of arcs) assert.ok(r <= 10.001, "收缩后仍有半径超过一半边长");
});

test("描边层是开口路径，不产生第二个封闭填充", () => {
  const line = bubbleSkinLinePath(MINE);
  assert.ok(line);
  assert.ok(!line.includes("Z"), "描边层带了闭合指令 ⇒ 容易长出第二块填充");
  assert.match(line, new RegExp(`M ${MINE.w} ${MINE.h - TAIL_RISE} C`));
});
