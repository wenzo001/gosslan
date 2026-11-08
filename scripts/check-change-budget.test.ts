import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = join(import.meta.dirname, "..");

function runFixture(
  recentFixes: unknown[],
  commits: unknown[] = [{
    sha: "base",
    message: "fix(ui): baseline",
    files: [{ path: "src/stores/useChatStore.ts", add: 1, del: 1 }],
  }],
): { status: number | null; out: string } {
  const dir = mkdtempSync(join(ROOT, ".tmp-change-budget-"));
  const file = join(dir, "fixture.json");
  try {
    writeFileSync(
      file,
      JSON.stringify({ commits, recentFixes }, null, 2),
    );
    const r = spawnSync(
      process.execPath,
      ["scripts/check-change-budget.mjs", "--from-json", file],
      { cwd: ROOT, encoding: "utf8" },
    );
    return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const appFix = (sha: string) => ({
  sha,
  message: `fix(ui): ${sha}`,
  files: [{ path: "src/stores/useChatStore.ts", add: 10, del: 2 }],
});
const testOnlyFix = (sha: string) => ({
  sha,
  message: `fix(ui): ${sha} 只动测试`,
  files: [{ path: "src/utils/example.test.ts", add: 10, del: 2 }],
});

test("判据 3 的窗口不把纯测试提交算进分母（否则会挤掉更早的应用码 fix）", () => {
  // 未过滤时窗口前 5 条是 a1 + 4 条 test-only ⇒ 只有 1 次 presentation，误判为绿。
  // 过滤后窗口是 a1/a2/a3 ⇒ 3 次，必须红。
  const r = runFixture([
    appFix("a1"),
    testOnlyFix("t1"),
    testOnlyFix("t2"),
    testOnlyFix("t3"),
    testOnlyFix("t4"),
    testOnlyFix("t5"),
    appFix("a2"),
    appFix("a3"),
  ]);
  assert.equal(r.status, 1, `应因 3 次同领域修补红，实际退出 ${r.status}\n${r.out}`);
  assert.match(r.out, /presentation: 3 次/, "窗口应把三条应用码 fix 全部数进 presentation");
});

test("对照：只有两条应用码 fix + 多条测试提交时仍不误报", () => {
  const r = runFixture([
    appFix("a1"),
    testOnlyFix("t1"),
    testOnlyFix("t2"),
    testOnlyFix("t3"),
    appFix("a2"),
  ]);
  assert.equal(r.status, 0, `不应误报，实际退出 ${r.status}\n${r.out}`);
});

/**
 * 判据 4 的边界（2026-11-08 收口）：CI 侧与 commit-msg 钩子共用
 * `semver.mjs::bumpConsistencyProblems`，只有双向一致是硬判据。
 *
 * 这三条走 `--from-json`（CI 那一支的真实代码路径），钩子那一支在 `semverNone.test.ts`
 * 的临时仓库用例里。两边一起才证明"同一份谓词、同一套边界"。
 */
const MANIFESTS = ["package.json", "package-lock.json", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json"];
const manifestFiles = (names: string[]) => names.map((p) => ({ path: p, add: 1, del: 1 }));

test("判据 4 边界：只动 package.json 脚本、无声明 ⇒ 放行（不误伤）", () => {
  const r = runFixture([], [{ sha: "s1", message: "chore: 改 package.json 脚本", files: manifestFiles(["package.json"]) }]);
  assert.equal(r.status, 0, `不许要求这类提交补声明\n${r.out}`);
  assert.match(r.out, /版本文件 1\/4（未全动 ⇒ 不要求声明）/);
});

test("判据 4 边界：只动 3 个清单、无声明 ⇒ 放行", () => {
  const r = runFixture([], [
    { sha: "s1", message: "chore: 改三条清单", files: manifestFiles(MANIFESTS.slice(0, 3)) },
  ]);
  assert.equal(r.status, 0, `缺一条清单不构成"一次真 bump"\n${r.out}`);
});

test("判据 4 边界：四条齐了不声明 ⇒ 红；声明了却只带 2 条 ⇒ 红", () => {
  const unbumped = runFixture([], [
    { sha: "s1", message: "chore: 改版本号", files: manifestFiles(MANIFESTS) },
  ]);
  assert.equal(unbumped.status, 1);
  assert.match(unbumped.out, /动了全部 4 个版本清单文件（一次真 bump）却没声明/);

  const incomplete = runFixture([], [
    {
      sha: "s2",
      message: "chore: 提版\n\nVersion-Bump: patch",
      files: manifestFiles(MANIFESTS.slice(0, 2)),
    },
  ]);
  assert.equal(incomplete.status, 1);
  assert.match(incomplete.out, /2\/4 个版本清单文件没进这次提交/);
});

test("反空转：判据 4 的判定必须仍走 semver.mjs 的共用谓词（不许在两边各写一份）", () => {
  const src = readFileSync(join(ROOT, "scripts", "check-change-budget.mjs"), "utf8");
  assert.match(src, /bumpConsistencyProblems\(/, "钩子/CI 必须调用共用谓词");
  // 反例自证：旧的分支判定留下过 `const unbumped =` / `const noneBad =` 这类本地口径。
  // 谁把它们抄回来，那条断言就会红 —— 这条测试本身也就不会空转。
  assert.doesNotMatch(src, /const unbumped =/);
  assert.doesNotMatch(src, /const noneBad =/);
  const semver = readFileSync(join(ROOT, "scripts", "semver.mjs"), "utf8");
  assert.match(semver, /export function bumpConsistencyProblems\(/);
});
