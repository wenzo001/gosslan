/**
 * 群头像布局的判据（形状纯逻辑）。
 *
 * 钉住用户 2026-11-15 提的那件事：**群成员不足 4 人时不能留下空角**
 * （旧形状是 2×2 九宫格 ⇒ 1 人只有左上角一张脸、2 人上半张脸、3 人缺一角）。
 *
 * 判据方向：
 * - 「没有空角」用**几何**判（四个象限中心都被脸盖住 + 圆内覆盖率 ≥ 85%），
 *   不是靠肉眼；这两条在旧的 2×2 形状下都会红（1 人时覆盖率只有 ~25%），
 *   所以判据**非空转**；
 * - 「一眼是群」用**角标存在**判（一个人也能建群，单看一张脸分不出来）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { groupAvatarLayout, GROUP_AVATAR_MAX_FACES } from "./groupAvatar.ts";

/** 圆内的四个象限中心（比例坐标）——旧 2×2 形状的空角正是这里。 */
const QUADRANT_CENTERS = [
  [0.25, 0.25],
  [0.75, 0.25],
  [0.25, 0.75],
  [0.75, 0.75],
] as const;

type Slot = { size: number; left: number; top: number };

function hit(slots: Slot[], x: number, y: number): boolean {
  return slots.some((s) => {
    const r = s.size / 2;
    const mx = s.left + r;
    const my = s.top + r;
    return (x - mx) ** 2 + (y - my) ** 2 <= r * r + 1e-9;
  });
}

/** 四个象限中心里被脸盖住的数量。 */
function coveredQuadrants(slots: Slot[]): number {
  return QUADRANT_CENTERS.filter(([x, y]) => hit(slots, x, y)).length;
}

/** 圆内被脸盖住的面积占比（采样估算；容器本身是圆，方形角落不算）。 */
function circleCoverage(slots: Slot[]): number {
  const N = 240;
  let hitCount = 0;
  let total = 0;
  for (let i = 0; i < N; i += 1) {
    for (let j = 0; j < N; j += 1) {
      const x = (i + 0.5) / N;
      const y = (j + 0.5) / N;
      if ((x - 0.5) ** 2 + (y - 0.5) ** 2 > 0.25) continue; // 圆外
      total += 1;
      if (hit(slots, x, y)) hitCount += 1;
    }
  }
  return total === 0 ? 0 : hitCount / total;
}

/** 两张脸的矩形是否交叠（有公共面积）。 */
function overlaps(a: Slot, b: Slot): boolean {
  return (
    a.left < b.left + b.size &&
    b.left < a.left + a.size &&
    a.top < b.top + b.size &&
    b.top < a.top + a.size
  );
}

test("一个人：整块圆就是那一张脸 + 群标", () => {
  const { slots, chip } = groupAvatarLayout(1);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].size, 1, "一个人时脸要铺满（否则又是「一个角」）");
  assert.equal(slots[0].left, 0);
  assert.equal(slots[0].top, 0);
  assert.equal(coveredQuadrants(slots), 4, "一个人的群也不许留空角");
  assert.equal(circleCoverage(slots), 1, "一个人时整块圆都是脸");
  // 一张脸和单聊头像没区别 ⇒ 必须有群标。
  assert.ok(chip, "一个人的群也要挂群标，否则看不出这是群");
  assert.equal(chip.kind, "group");
});

test("两个人：两张脸沿对角线交叠，没有空角", () => {
  const { slots, chip } = groupAvatarLayout(2);
  assert.equal(slots.length, 2);
  assert.ok(
    overlaps(slots[0], slots[1]),
    "两张脸必须交叠（不交叠就是「上半个 + 下半个」，还是空角）",
  );
  assert.equal(
    coveredQuadrants(slots),
    4,
    "四个象限都要有脸（旧的 2×2 形状在这种布局下会空掉两个角）",
  );
  assert.ok(
    circleCoverage(slots) >= 0.85,
    `圆内覆盖率太低：${circleCoverage(slots).toFixed(3)}`,
  );
  assert.ok(chip);
});

test("三个人：三角形簇，没有空角", () => {
  const { slots, chip } = groupAvatarLayout(3);
  assert.equal(slots.length, 3);
  for (let i = 0; i < slots.length; i += 1) {
    for (let j = i + 1; j < slots.length; j += 1) {
      assert.ok(overlaps(slots[i], slots[j]), `第 ${i + 1} 与第 ${j + 1} 张脸必须交叠`);
    }
  }
  assert.equal(coveredQuadrants(slots), 4, "三角形簇不能留下空角");
  assert.ok(
    circleCoverage(slots) >= 0.85,
    `圆内覆盖率太低：${circleCoverage(slots).toFixed(3)}`,
  );
  assert.ok(chip);
});

test("四个人以上：最多画三张（画更多每张只剩一条边）", () => {
  const four = groupAvatarLayout(4);
  const many = groupAvatarLayout(37);
  assert.equal(four.slots.length, GROUP_AVATAR_MAX_FACES);
  assert.equal(many.slots.length, GROUP_AVATAR_MAX_FACES);
  // 人数变多不改变形状（否则同一个群会随人数换脸）。
  assert.deepEqual(many.slots, four.slots);
  assert.ok(many.chip);
});

test("没有人：不画脸也不挂角标（由调用点回落到普通头像）", () => {
  const { slots, chip } = groupAvatarLayout(0);
  assert.equal(slots.length, 0);
  assert.equal(chip, null);
});

test("负数/小数人数不炸（脏数据不许让渲染崩）", () => {
  assert.equal(groupAvatarLayout(-3).slots.length, 0);
  assert.equal(groupAvatarLayout(2.7).slots.length, 2, "小数向下取整");
});
