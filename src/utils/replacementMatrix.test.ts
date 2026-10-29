/**
 * 替换矩阵的**防复发护栏**（2026-10-29 全仓审计 DUP Part A 的元发现）。
 *
 * 那次核验的 43 行里 3 行结论已反转、11 行过期 —— 全部来自"矩阵写完之后又有新提交"，
 * 而矩阵的更新纪律跟不上提交节奏。最便宜的护栏是钉**依赖面**：`package.json` 里每个
 * 生产依赖都必须在这份矩阵里出现过（新引入依赖 ⇒ 矩阵必须登记它，否则这一步红）。
 *
 * 边界（诚实）：它只保证"依赖被提到过"，不保证那一行的判定今天仍然成立。
 * 判定正确性仍要靠每批次人工复核（审计报告的 Part A 就是那么做的）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

test("替换矩阵：每个生产依赖都必须在矩阵里登记过（新增依赖要入表）", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const deps = Object.keys(pkg.dependencies ?? {});
  assert.ok(deps.length >= 15, `只读到 ${deps.length} 个生产依赖 ⇒ 读的不是真 package.json`);

  const doc = readFileSync(join(root, "docs/architecture/open-source-replacement-matrix.md"), "utf8");
  const missing = deps.filter((d) => !doc.includes(d));
  assert.deepEqual(
    missing,
    [],
    `这些生产依赖在替换矩阵里一个字都没出现（新引入的依赖要在 §3 登记并写清判定）：${missing.join(", ")}`,
  );
});
