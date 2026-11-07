import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

/**
 * Change Budget 的「范围为空」口径（2026-11-07 事故回归）。
 *
 * 事故形状：`de4d1773` 把 trailer 写成 `Version-Bump: 5.18.77`（判据 4 只认
 * `patch|minor|major|none`），CI 红了；而本地跑 verify 时 `origin/main..HEAD` 已为空，
 * 脚本报"零覆盖"（旧退出码 2），verify.mjs 把它记成 ⚠️ 非红 ⇒ **本地绿、CI 红**。
 *
 * 现在的口径：本地候选范围全空时**退回判 HEAD 这一笔**；仍判不到才退出 1（不可通过）。
 * 这条测试在一个临时 git 仓库里重放"已推送后重跑"——它同时是反向自证：
 * 把 `"HEAD~1..HEAD"` 这个候选删掉（旧行为），同一场景就会变成"未覆盖、0 个 commit"。
 */

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "check-change-budget.mjs");

/** 判据 4 盯的四个清单文件（Cargo.lock 不参与判定）。 */
const VERSION_FILES = [
  "package.json",
  "package-lock.json",
  "src-tauri/Cargo.toml",
  "src-tauri/tauri.conf.json",
];

function writeVersion(dir: string, v: string) {
  mkdirSync(join(dir, "src-tauri"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: v }, null, 2));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "fixture", version: v }, null, 2));
  writeFileSync(join(dir, "src-tauri/Cargo.toml"), `[package]\nname = "fixture"\nversion = "${v}"\n`);
  writeFileSync(join(dir, "src-tauri/tauri.conf.json"), JSON.stringify({ version: v }, null, 2));
}

/**
 * 临时仓库：基线提交（1.0.0）→ 第二个提交（bump 到 1.0.1 + 改一行应用码）。
 * `pushAll` 为真时把 `refs/remotes/origin/main` 指到 HEAD，模拟"这条已经推上去了"。
 */
function makeRepo(trailer: string, opts: { pushAll: boolean; legacy?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "gosslan-budget-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

  git("init", "-q", "-b", "main");
  git("config", "user.email", "fixture@example.com");
  git("config", "user.name", "fixture");
  git("config", "commit.gpgsign", "false");

  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "docs"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  for (const rel of ["scripts/check-change-budget.mjs", "scripts/semver.mjs", "docs/domains.data.mjs"]) {
    cpSync(join(ROOT, rel), join(dir, rel));
  }
  if (opts.legacy) {
    // 旧行为：候选里没有 HEAD~1..HEAD（本地"全部已推送"⇒ 零覆盖）。
    const p = join(dir, "scripts", "check-change-budget.mjs");
    const src = readFileSync(p, "utf8");
    const patched = src.replace(/\s*"HEAD~1\.\.HEAD",\n/, "\n");
    assert.notEqual(patched, src, "反例构造失败：找不到候选行，删除等于空转");
    writeFileSync(p, patched);
  }

  writeVersion(dir, "1.0.0");
  writeFileSync(join(dir, "src", "app.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "chore: 建立基线");

  writeVersion(dir, "1.0.1");
  writeFileSync(join(dir, "src", "app.ts"), "export const a = 2;\n");
  git("add", "-A");
  git("commit", "-q", "-m", `fix(ui): 栅格对齐\n\n${trailer}`);

  if (opts.pushAll) git("update-ref", "refs/remotes/origin/main", "HEAD");
  else git("update-ref", "refs/remotes/origin/main", "HEAD~1");
  return dir;
}

function runBudget(dir: string) {
  const env = { ...process.env, GOSSLAN_BUDGET_STRICT: "" } as Record<string, string>;
  delete env.GITHUB_EVENT_NAME;
  delete env.GITHUB_ACTIONS;
  return spawnSync(process.execPath, [join(dir, "scripts", "check-change-budget.mjs")], {
    cwd: dir,
    encoding: "utf8",
    env,
  });
}

test("范围为空（已推送后重跑）必须退回判 HEAD，且判据 4 让它红", () => {
  // 事故原样：trailer 写成版本号 ⇒ 判据 4 认为"没声明"。
  const dir = makeRepo("Version-Bump: 1.0.1", { pushAll: true });
  const r = runBudget(dir);

  assert.equal(r.status, 1, `已推送后本地范围为空时必须红，实际退出码 ${r.status}\n${r.stdout}\n${r.stderr}`);
  // 判据失败走 `fail()` → stderr；「未覆盖」那句走 stdout。两者要分开断言。
  const output = r.stdout + r.stderr;
  assert.match(r.stdout, /HEAD~1\.\.HEAD/, "必须打印退回判 HEAD 这一笔所用的范围");
  assert.match(r.stdout, /候选里第一个非空：HEAD~1\.\.HEAD/, "来源行要点明这是候选兜底，不是 CI 事件范围");
  assert.match(output, /✗[\s\S]*Version-Bump/, "必须由判据 4（trailer 写法）报红，而不是别的偶然原因");
  assert.doesNotMatch(r.stdout, /未覆盖/, "不许再落到『未覆盖』这条静默通道");
});

test("反例自证：删掉 HEAD~1..HEAD 候选（旧行为），同一场景退化成『未覆盖、0 个 commit』", () => {
  const dir = makeRepo("Version-Bump: 1.0.1", { pushAll: true, legacy: true });
  const r = runBudget(dir);

  assert.equal(r.status, 1);
  assert.match(r.stdout, /判到的 commit：0/, "旧行为下应当一个 commit 都没判到");
  assert.match(r.stdout, /未覆盖/, "旧行为会走零覆盖通道 —— 这条断言证明新候选行是承重的");
});

test("浅克隆（fetch-depth: 1）判不到任何 commit 时：红，并指出是 checkout 只给了一个提交", () => {
  // 2026-11-07 Android 出包真实事故：build-android 用默认 `fetch-depth: 1`，
  // `HEAD~1` 不存在 ⇒ 兜底候选也没有对象 ⇒ 门禁红、出包停。
  // 这里重放浅克隆：断言它红（不是静默通过），并要求说清修法（fetch-depth: 2）。
  const src = makeRepo("Version-Bump: 1.0.1", { pushAll: true });
  const cloneDir = mkdtempSync(join(tmpdir(), "gosslan-budget-shallow-"));
  execFileSync("git", ["clone", "-q", "--depth", "1", `file://${src}`, cloneDir], { encoding: "utf8" });

  const r = runBudget(cloneDir);
  assert.equal(r.status, 1, "浅克隆判不到对象时必须红");
  assert.match(r.stdout, /未覆盖/);
  assert.match(r.stdout, /浅克隆/, "必须点明成因是浅克隆");
  assert.match(r.stdout, /fetch-depth: 2/, "必须给出可执行的修法");
});

test("正常有范围时行为不变：未推送的合规提交照旧通过", () => {
  const dir = makeRepo("Version-Bump: patch", { pushAll: false });
  const r = runBudget(dir);

  assert.equal(r.status, 0, `未推送的合规提交必须通过\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /Change Budget 通过/);
  assert.doesNotMatch(r.stdout, /未覆盖|HEAD~1\.\.HEAD/, "有未推范围时不许动用兜底");
});

test("正常有范围时行为不变：未推送的坏 trailer 照旧红（且不是零覆盖）", () => {
  const dir = makeRepo("Version-Bump: 1.0.1", { pushAll: false });
  const r = runBudget(dir);

  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /✗[\s\S]*Version-Bump/);
  assert.doesNotMatch(r.stdout, /未覆盖/);
  assert.doesNotMatch(r.stdout, /HEAD~1\.\.HEAD/, "有未推范围时不许动用兜底");
});

test("版本清单文件清单未漂移：判据 4 的四个文件在脚本里仍是这四个", () => {
  // 这条不是重复：上面三条临时仓库用的就是这四个名字；一旦脚本改了集合，
  // 临时仓库会"改了文件却不触发判据 4"，而测试仍然绿（空转）。
  const src = readFileSync(SCRIPT, "utf8");
  for (const f of VERSION_FILES) {
    assert.match(src, new RegExp(f.replace(/[.]/g, "\\.")), `判据 4 的文件清单里找不到 ${f}`);
  }
});
