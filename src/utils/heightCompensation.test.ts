import assert from "node:assert/strict";
import { test } from "node:test";
import { compensationFor, type HeightDelta } from "./heightCompensation.ts";

const D = (top: number, oldHeight: number, delta: number): HeightDelta => ({ top, oldHeight, delta });

test("贴底：同一帧多行变化必须全部累计，不能只补最后一次", () => {
  assert.equal(
    compensationFor([D(0, 100, 40), D(100, 100, 20)], {
      pinned: true, recentScrollUp: false, hold: false, scrollTop: 500,
    }),
    60,
  );
});

test("贴底但用户刚上滚：退回“只补上方行”，不把视口拽回底部", () => {
  assert.equal(
    compensationFor([D(0, 100, 40), D(480, 100, 20)], {
      pinned: true, recentScrollUp: true, hold: false, scrollTop: 500,
    }),
    40,
    "只有完全在视口上方的行被补偿",
  );
});

test("非贴底：视口上方的行补偿，视口内/下方的行不动", () => {
  assert.equal(
    compensationFor([D(0, 100, 40), D(450, 100, 30), D(560, 100, 99)], {
      pinned: false, recentScrollUp: false, hold: false, scrollTop: 500,
    }),
    40,
    "top+oldHeight=100 在视口上方；450+100=550 跨视口；560 在下方",
  );
});

test("刚好贴着视口顶边界的行也算“上方”（容差 0.5px）", () => {
  assert.equal(
    compensationFor([D(400, 100, 30)], {
      pinned: false, recentScrollUp: false, hold: false, scrollTop: 500,
    }),
    30,
  );
});

test("收敛窗口/静默期不补偿", () => {
  assert.equal(
    compensationFor([D(0, 100, 40)], {
      pinned: true, recentScrollUp: false, hold: true, scrollTop: 500,
    }),
    0,
  );
});

test("空 delta / 零 delta 返回 0", () => {
  assert.equal(compensationFor([], {
    pinned: true, recentScrollUp: false, hold: false, scrollTop: 0,
  }), 0);
  assert.equal(compensationFor([D(0, 100, 0)], {
    pinned: true, recentScrollUp: false, hold: false, scrollTop: 0,
  }), 0);
});
