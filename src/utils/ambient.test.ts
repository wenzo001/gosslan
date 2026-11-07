import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAmbient } from "./ambient.ts";

/**
 * 三层优先级（2026-11-07 用户 Windows 读数定）：
 *   软件显式（off / drift） > 系统 `prefers-reduced-motion` > 内置默认
 *
 * 关键回归：「系统 `prefers-reduced-transparency: reduce`（Windows 关掉透明效果）」
 * 不许再把背景漂移一起关掉。这一点在结构上做不到"漏看"——`ambient.ts` 里根本没有
 * 透明相关的输入（下面第二条断言把它钉死）；这里再用行为断言证明显式 drift 会压过系统 reduce。
 */

test("显式「流动」压过系统 reduce：动效仍在跑（transparency 读数不影响）", () => {
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

test("显式「关闭」永远关闭，与系统偏好无关", () => {
  assert.deepEqual(resolveAmbient("off", {}, false), { mode: "off", source: "software" });
  assert.deepEqual(resolveAmbient("off", {}, true), { mode: "off", source: "software" });
});

test("显式「流动」在低端机仍降 static，但来源仍是软件（不是默认）", () => {
  assert.deepEqual(resolveAmbient("drift", { coarse: true }, false), { mode: "static", source: "software" });
});

test("结构自证：ambient.ts 不读 transparent，也没有被删掉的冻结开关", () => {
  const src = readFileSync(join(import.meta.dirname, "ambient.ts"), "utf8");
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  assert.doesNotMatch(code, /reducedTransparency|prefers-reduced-transparency/);
  assert.doesNotMatch(code, /setAmbientFrozen/);
  assert.match(code, /dataset\.ambientMotion\s*=\s*setting\s*===\s*"drift"\s*\?\s*"force"/);
});
