import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
