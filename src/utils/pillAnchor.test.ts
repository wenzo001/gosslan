/**
 * 药丸拖到四角的几何判据（纯函数）。
 *
 * 守的是负责人那句"一拨它就可以往 4 个角移动"里能被数清楚的三件事：
 * 角算得对、点按不会误判成拖动、拖到屏外要夹回来。
 * 真机手感（触摸目标尺寸、跟随延迟）不在这里假称验过。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_PILL_CORNER,
  PILL_CORNER_KEY,
  clampDragBox,
  movedFar,
  nearestPillCorner,
  parsePillCorner,
} from "./pillAnchor.ts";

test("指针落在哪个象限就吸附那一角", () => {
  // 视口 1000×800，中线 500/400
  assert.equal(nearestPillCorner(100, 100, 1000, 800), "tl");
  assert.equal(nearestPillCorner(900, 100, 1000, 800), "tr");
  assert.equal(nearestPillCorner(100, 700, 1000, 800), "bl");
  assert.equal(nearestPillCorner(900, 700, 1000, 800), "br");
});

test("视口读数非法时回默认角，不算出假象限", () => {
  // visualViewport 在部分 WebView 上给 0；拿 0 去比大小会把每一发都判成左上。
  assert.equal(nearestPillCorner(900, 700, 0, 0), DEFAULT_PILL_CORNER);
  assert.equal(nearestPillCorner(NaN, 1, 1000, 800), DEFAULT_PILL_CORNER);
  assert.equal(nearestPillCorner(1, 1, 1000, NaN), DEFAULT_PILL_CORNER);
});

test("存储里只认那四个值，其余一律回默认角", () => {
  assert.equal(parsePillCorner("tl"), "tl");
  assert.equal(parsePillCorner("br"), "br");
  assert.equal(parsePillCorner("middle"), DEFAULT_PILL_CORNER, "脏值不能把药丸画到屏外");
  assert.equal(parsePillCorner(null), DEFAULT_PILL_CORNER, "第一次运行（没写过键）");
});

test("点按与拖动靠阈值分开：没越过阈值就不算拖", () => {
  assert.equal(movedFar(0, 0), false);
  assert.equal(movedFar(5, 5), false, "手抖级别的位移必须仍算点按，否则面板打不开");
  assert.equal(movedFar(7, 0), true);
  assert.equal(movedFar(0, 7), true);
  assert.equal(movedFar(NaN, 3), false, "读数坏了当没动，不要把药丸甩飞");
});

test("拖动途中夹在视口内（含 8px 边距）", () => {
  const box = { w: 224, h: 56 };
  const vp = { vw: 1000, vh: 800 };
  assert.deepEqual(clampDragBox(-500, -500, box.w, box.h, vp.vw, vp.vh), { left: 8, top: 8 });
  assert.deepEqual(clampDragBox(5000, 5000, box.w, box.h, vp.vw, vp.vh), {
    left: 1000 - box.w - 8,
    top: 800 - box.h - 8,
  });
  assert.deepEqual(clampDragBox(300, 300, box.w, box.h, vp.vw, vp.vh), { left: 300, top: 300 });
});

test("持久化键名固定：改名等于把所有人的药丸位置抹掉", () => {
  assert.equal(PILL_CORNER_KEY, "taskCenter.corner");
});
