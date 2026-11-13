import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CALENDAR_COLS, calendarGridNext } from "./calendarGrid.ts";

/**
 * Todo 自绘月历的键盘导航判据（2026-11-13 组件复审 P1 跟进，ADR 决策 2 短期方案）。
 *
 * 两部分：① 导航索引数学是纯函数，逐键钉死（含夹取与行首/行尾）；② 组件真的把这套
 * 接上了（role=grid/gridcell/row + roving tabindex + @keydown），否则逻辑判据全绿
 * 而界面键盘导航永远不跑（本仓"接线判据"纪律）。
 */

const TOTAL = 42; // 6 行 × 7 列

test("左右键逐格移动，并在网格两端夹取", () => {
  assert.equal(calendarGridNext(0, "ArrowRight", TOTAL), 1);
  assert.equal(calendarGridNext(5, "ArrowLeft", TOTAL), 4);
  assert.equal(calendarGridNext(0, "ArrowLeft", TOTAL), 0, "左端不许越界成负");
  assert.equal(calendarGridNext(TOTAL - 1, "ArrowRight", TOTAL), TOTAL - 1, "右端不许越界");
});

test("上下键按整周（7 列）移动，并在上下端夹取", () => {
  assert.equal(calendarGridNext(0, "ArrowDown", TOTAL), 7);
  assert.equal(calendarGridNext(10, "ArrowUp", TOTAL), 3);
  assert.equal(calendarGridNext(3, "ArrowUp", TOTAL), 0, "上端夹取");
  assert.equal(calendarGridNext(35, "ArrowDown", TOTAL), 41, "下端夹取到最后一格");
});

test("Home/End 跳到本周首日/末日", () => {
  assert.equal(calendarGridNext(10, "Home", TOTAL), 7, "第 2 行行首");
  assert.equal(calendarGridNext(7, "Home", TOTAL), 7);
  assert.equal(calendarGridNext(7, "End", TOTAL), 13, "第 2 行行尾");
  assert.equal(calendarGridNext(10, "End", TOTAL), 13);
  assert.equal(calendarGridNext(41, "End", TOTAL), 41, "最后一行行尾不越界");
});

test("非导航键返回 null（不抢 Enter/Space/字符键）", () => {
  assert.equal(calendarGridNext(5, "Enter", TOTAL), null);
  assert.equal(calendarGridNext(5, " ", TOTAL), null);
  assert.equal(calendarGridNext(5, "a", TOTAL), null);
  assert.equal(calendarGridNext(5, "Escape", TOTAL), null);
});

test("列数可配（默认 7），数学随 cols 变化", () => {
  assert.equal(CALENDAR_COLS, 7);
  assert.equal(calendarGridNext(0, "ArrowDown", 30, 5), 5);
  assert.equal(calendarGridNext(8, "Home", 30, 5), 5);
  assert.equal(calendarGridNext(8, "End", 30, 5), 9);
});

test("组件真的接上了网格语义与键盘导航（接线判据，删掉即红）", () => {
  const src = readFileSync(join(import.meta.dirname, "../components/TodoAttrDateField.vue"), "utf8");
  assert.ok(src.includes('role="grid"'), "日历容器必须是 role=grid");
  assert.ok(src.includes('role="row"'), "周行必须是 role=row（grid 的行结构）");
  assert.ok(src.includes('role="gridcell"'), "日期格必须是 role=gridcell");
  assert.ok(src.includes(":tabindex="), "必须是 roving tabindex（只有一格可 Tab 到）");
  assert.ok(src.includes('@keydown="onGridKey"'), "网格必须挂键盘导航处理器");
  assert.ok(src.includes("calendarGridNext"), "导航必须走纯函数 calendarGridNext（不许在组件里再写一份索引数学）");
  assert.ok(src.includes(":aria-selected="), "日期格必须暴露选中态给读屏");
});