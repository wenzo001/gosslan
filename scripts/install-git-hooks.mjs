#!/usr/bin/env node
/**
 * 把 `scripts/git-hooks/` 下的 hook 装进 `.git/hooks`（幂等）。
 *
 * 为什么需要安装器：`.git/hooks` 不进版本库，hook 不能靠"我记得装"。
 * `package.json` 的 `prepare` 会在 `npm install` 时自动跑一次；`npm run hooks:install`
 * 供已有工作区补装。非 git 工作区（源码包/CI 里没有 .git）静默跳过。
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "scripts", "git-hooks");
const DST = path.join(ROOT, ".git", "hooks");

if (!existsSync(path.join(ROOT, ".git"))) {
  console.log("不是 git 工作区（没有 .git）—— 跳过 hook 安装。");
  process.exit(0);
}

mkdirSync(DST, { recursive: true });
const names = readdirSync(SRC).filter((n) => !n.startsWith("."));
for (const name of names) {
  const dst = path.join(DST, name);
  copyFileSync(path.join(SRC, name), dst);
  chmodSync(dst, 0o755);
}
console.log(`已安装 ${names.length} 个 git hook：${names.join(", ")} → ${path.relative(ROOT, DST)}`);
