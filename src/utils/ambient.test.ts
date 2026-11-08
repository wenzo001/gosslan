import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readStoredAmbient, resolveAmbient } from "./ambient.ts";
import type { AmbientCapability } from "./ambientCapability.ts";

/**
 * 优先级（2026-11-08 定）：
 *   能力闸（系统「透明效果」/ backdrop-filter） > 软件显式（off / drift）
 *     > 系统 `prefers-reduced-motion` > 内置默认
 *
 * 能力那一层是"看得到看不到"的事实，不是偏好：用户选过「流动」但机器放不出来时，
 * 档位落 off、来源记 capability，设置页显示为关且不可选。**但存储里的显式值不许被改写**
 * —— 能力恢复后要能回到用户原来那一档（用户原话：别把两件事混为一谈）。
 */

const NO_CAP: AmbientCapability = { available: false, reason: "reduced-transparency" };

test("显式「流动」压过系统 reduce：动效仍在跑", () => {
  const r = resolveAmbient("drift", {}, true);
  assert.deepEqual(r, { mode: "drift", source: "software" });
});

test("从未设过 + 系统 reduce → 静态雾，来源是系统", () => {
  assert.deepEqual(resolveAmbient(null, {}, true), { mode: "static", source: "system" });
});

test("从未设过 + 系统正常 → 默认流动；低端机/窄屏降 static 但仍记默认", () => {
  assert.deepEqual(resolveAmbient(null, {}, false), { mode: "drift", source: "default" });
  assert.deepEqual(resolveAmbient(null, { coarse: true }, false), { mode: "static", source: "default" });
  assert.deepEqual(resolveAmbient(null, { narrow: true }, false), { mode: "static", source: "default" });
});

test("显式「关闭」永远关闭，与系统偏好、能力无关", () => {
  assert.deepEqual(resolveAmbient("off", {}, false), { mode: "off", source: "software" });
  assert.deepEqual(resolveAmbient("off", {}, true), { mode: "off", source: "software" });
  // 能力不可用时来源仍是软件：这一档是用户自己的选择，不是能力替他关的。
  assert.deepEqual(resolveAmbient("off", {}, false, NO_CAP), { mode: "off", source: "software" });
});

test("显式「流动」在低端机仍降 static，但来源仍是软件（不是默认）", () => {
  assert.deepEqual(resolveAmbient("drift", { coarse: true }, false), { mode: "static", source: "software" });
});

test("能力不可用：选过「流动」也落 off，来源是 capability（显示为关但不改写选择）", () => {
  assert.deepEqual(resolveAmbient("drift", {}, false, NO_CAP), { mode: "off", source: "capability" });
  assert.deepEqual(resolveAmbient(null, {}, false, NO_CAP), { mode: "off", source: "capability" });
  // 能力不可用同时系统 reduce：仍然是能力那条（谁先挡住就以谁为准）
  assert.deepEqual(resolveAmbient(null, {}, true, NO_CAP), { mode: "off", source: "capability" });
});

test("能力不可用：设置页显示值恒为「关闭」；backdrop-filter 那一档同样", () => {
  assert.equal(readStoredAmbient({ available: false, reason: "reduced-transparency" }), "off");
  assert.equal(readStoredAmbient({ available: false, reason: "no-backdrop-filter" }), "off");
  // 能力可用 + 从未设过 ⇒ 回到正常默认（这里只钉"不是恒 off"）
  assert.equal(readStoredAmbient({ available: true, reason: null }), "drift");
});

test("结构自证：能力只经 ambientCapability 进入，force 按实际模式写", () => {
  const src = readFileSync(join(import.meta.dirname, "ambient.ts"), "utf8");
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  // 直接拼透明查询 = 第二份能力判定（AM-13 盯着同一件事）。
  assert.doesNotMatch(code, /reducedTransparency|prefers-reduced-transparency/);
  assert.doesNotMatch(code, /setAmbientFrozen/);
  // 能力闸必须在，且"不支持"必须有自己的来源档位。
  assert.match(code, /readAmbientCapability\(/);
  assert.match(code, /source:\s*"capability"/);
  // force 只给真的在漂的档位，否则诊断面板会把"能力关掉"说成"软件压过系统"。
  assert.match(code, /dataset\.ambientMotion\s*=\s*res\.mode\s*===\s*"drift"\s*\?\s*"force"/);
});
