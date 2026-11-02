// 职责边界：`Version-Bump: none`（纯文档免提版）这一档的正反判据。
// 为什么单独成文件：它是**声明口径**，不属于任何业务。正向只证明"纯文档可以免提版"是不够的 ——
// 反向必须证明"混进代码/脚本/CI/依赖/版本清单就被拒"，否则这一档变成一个谁都能声称的空格
// （判据 4 的原话：装饰性声明比没有声明更糟）。
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
import assert from "node:assert/strict";
import {
  parseBumpTrailer,
  isPureDocPath,
  declaresNone,
  noneViolations,
  declaresBump,
  noBumpOwed,
  VERSION_FILES,
  isAppCodePath,
} from "./semver.mjs";

const DOCS = ["docs/notes/x.md", "README.md", "CHANGELOG.md", "docs/ARCHITECTURE-MAP.html"];
/**
 * 夹具必须**自洽**：`touchesCode` 由路径现算（生产侧 `buildRows` 就是这么来的）。
 * 第一版我手写了 `touchesCode: false` 却往 paths 里塞 `src/...`，于是这条提交先落进既有的
 * `[plan]` 零影响豁免 ⇒ 测出来的是"豁免生效"，不是"none 生效"（红的是夹具，不是判据）。
 * 标题也刻意**不带** `[plan]`：这样"算已声明"只可能由 `none` 这一档给出来。
 */
const row = (paths, trailer = "none") => ({
  subject: "docs(x): 台账订正",
  message: `docs(x): 台账订正\n\nVersion-Bump: ${trailer}`,
  level: "patch",
  paths,
  touchesCode: paths.some((x) => isAppCodePath(x)),
});

test("正向：纯文档 + none ⇒ 解析认这一档、算已声明、不欠版本号", () => {
  assert.equal(parseBumpTrailer("a\n\nVersion-Bump: none"), "none");
  const r = row(DOCS);
  assert.equal(declaresNone(r), true);
  assert.deepEqual(noneViolations(r), []);
  assert.equal(declaresBump(r), true);
  assert.equal(noBumpOwed(r), true, "成立的 none 不许再欠一位版本号（这就是这一档的全部意义）");
});

test("正向：patch/minor/major 三档不受影响，none 也不进版本清单要求", () => {
  assert.equal(parseBumpTrailer("x\n\nVersion-Bump: patch"), "patch");
  assert.equal(parseBumpTrailer("x\n\nVersion-Bump: minor"), "minor");
  // 写错的档位（none-s、NONE）不许被当成合法声明：正则锚整行。
  assert.equal(parseBumpTrailer("x\n\nVersion-Bump: none-s"), null);
  assert.equal(parseBumpTrailer("x\n\nVersion-Bump: NONE"), null);
});

test("反向①：混进应用码 / 脚本 / 测试 / CI ⇒ none 不成立，且既不豁免也不算已声明", () => {
  for (const smuggled of [
    "src/stores/useAppStore.ts",
    "src-tauri/src/db.rs",
    "scripts/verify.mjs",
    "tests/e2e.spec.ts",
    ".github/workflows/verify.yml",
    "docs/domains.data.mjs",
  ]) {
    const r = row([...DOCS, smuggled]);
    const bad = noneViolations(r);
    assert.equal(bad.length, 1, `${smuggled} 应被白名单拒绝，实际理由：${JSON.stringify(bad)}`);
    assert.match(bad[0], /不在纯文档白名单内/);
    assert.equal(declaresBump(r), false, "非法的 none 等于没声明 ⇒ 门禁会红");
    assert.equal(noBumpOwed(r), false, "不成立的 none 不豁免版本号（否则写个假 none 就免提版）");
  }
});

test("反向②：五个版本清单被点名时，理由是「改了版本清单」而不是「不在白名单」", () => {
  for (const manifest of VERSION_FILES) {
    const bad = noneViolations(row(["docs/a.md", manifest]));
    assert.equal(bad.length, 1, manifest);
    assert.match(bad[0], /^改了版本清单/, `${manifest} 应报版本清单那条理由，实际：${bad[0]}`);
  }
});

test("既有机制不回归：[plan] + 不动应用码 仍走零影响豁免（与 none 互不顶替）", () => {
  const plan = {
    subject: "docs(y): 改口 [plan]",
    message: "docs(y): 改口 [plan]",
    level: "patch",
    paths: DOCS,
    touchesCode: false,
  };
  assert.equal(declaresBump(plan), true, "不带 trailer 的 [plan] 纯文档提交照旧算已声明");
  assert.equal(noBumpOwed(plan), true);
  // 动应用码的 [plan] 不算豁免（否则一条标记就能免掉任何提交）
  assert.equal(
    declaresBump({ ...plan, paths: [...DOCS, "src/a.ts"], touchesCode: true }),
    false,
    "[plan] 不许替应用码改动免声明",
  );
});

test("反向③：白名单是点名的，新目录/新扩展默认拒绝（不许退化成黑名单）", () => {
  assert.equal(isPureDocPath("docs/notes/a.md"), true);
  assert.equal(isPureDocPath("docs/map.html"), true);
  assert.equal(isPureDocPath("README.md"), true);
  assert.equal(isPureDocPath("docs/x.exe"), false);
  assert.equal(isPureDocPath("docs/new-dir/a.md"), true, "docs 下的新子目录仍是文档");
  assert.equal(isPureDocPath("notes/a.md"), false, "不在白名单前缀里的 .md 不算（默认拒绝）");
  assert.equal(isPureDocPath("secrets.env"), false);
});

/**
 * 集成层的正反两面（判据 4 真的会拒）：单测只证明谓词，证明不了"门禁读得到这一档"。
 * 用两份独立 fixture + `--from-json`，不往既有 change-budget.json 里塞提交 ——
 * 那份被一堆护栏用例的退出码期望钉着，加提交会把它们的期望一起改掉（本仓实测过的坑）。
 */
test("集成：判据 4 接受合法 none（退 0）、拒绝混入代码的 none（退 1 且点名 none）", () => {
  const run = (file: string) =>
    spawnSync(process.execPath, ["scripts/check-change-budget.mjs", "--from-json", file], {
      cwd: ROOT,
      encoding: "utf8",
    });
  const ok = run("scripts/fixtures/change-budget-none.json");
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /Version-Bump: none/);

  const bad = run("scripts/fixtures/change-budget-none-bad.json");
  assert.equal(bad.status, 1, "混进 src/ 的 none 必须让门禁退 1");
  assert.match(bad.stdout + bad.stderr, /声明了 `Version-Bump: none` 但不成立/);
  assert.match(bad.stdout + bad.stderr, /不在纯文档白名单内/);
});
