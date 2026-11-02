# 零回归执行基线（P0，2026-11-02）

> 只读基线。本文只记录现状读数与复跑命令，不代表任何改动已完成。

## 仓库状态

| 项 | 读数 | 复跑命令 |
|---|---|---|
| HEAD | `de254feb13aa1280ce708d3aa5a997a9e7bb2cc8` | `git rev-parse HEAD` |
| 分支 | `main` | `git rev-parse --abbrev-ref HEAD` |
| 远端 `main` 真实 tip | `69e04f72b724b3ad927247c30e29388f7410e191` | `git ls-remote origin refs/heads/main` |
| 本地领先远端 | `80` 个提交 | `git rev-list --count origin/main..HEAD` |
| 工作树 | 干净 | `git status --short` |
| 应用版本 | `5.16.71` | `npm run version:show` |

## 架构面

| 项 | 读数 | 复跑命令 |
|---|---|---|
| 注册命令 | `166` | `node scripts/arch-map-stats.mjs` |
| 命令属性总数 | `197` | 同上 |
| `db::` 公开函数 | `185` | 同上 |
| 后端字面量事件名 | `31` | 同上 |
| 前端门面 `listen` 名 | `40` | 同上 |
| 前端门面 `invoke` 名 | `166` | 同上 |
| 发了但门面没听 | `0` | 同上 |
| `DB_VERSION` | `15` | 同上 |
| 建表数 / 索引数 | `20 / 30` | 同上 |
| 不变量条数 | `36` | 同上 |

## 源码形状与测试门禁

| 项 | 读数 | 复跑命令 |
|---|---|---|
| 八个消息状态字面量命中 | `708` 行 | `grep -rnE '"(sending|sent|delivered|read|failed|cancelled|partial_cancelled|recalled)"' src src-tauri/src --include='*.ts' --include='*.vue' --include='*.rs' \| wc -l` |
| `db::` 调用行数 | `1095` | `grep -rn 'db::' src-tauri/src --include='*.rs' \| wc -l` |
| Rust `include_str!` 行数 | `407` | `grep -rn 'include_str!' src-tauri/src --include='*.rs' \| wc -l` |
| 前端测试 `readFileSync` 行数 | `607` | `grep -rn 'readFileSync' src --include='*.test.ts' \| wc -l` |
| `verify-guards` Case 数 | `290` | `grep -h '^    Case(' scripts/guard_cases/*.py \| wc -l` |
| macOS Rust 基线 | `1409` 行 | `wc -l src-tauri/test-baseline.macos.txt` |
| Windows Rust 基线 | `1386` 行 | `wc -l src-tauri/test-baseline.windows.txt` |
| `designGuards.test.ts` 顶层测试 | `248` | `grep -c '^test(' src/utils/designGuards.test.ts` |
| `settingsStructure.test.ts` 顶层测试 | `8` | `grep -c '^test(' src/utils/settingsStructure.test.ts` |
| `storeContract.test.ts` 顶层测试 | `33` | `grep -c '^test(' src/utils/storeContract.test.ts` |
| 前端测试文件覆盖 | `142` 个文件全部被 glob 覆盖 | `node scripts/check-test-manifest.mjs --only frontend` |
| 跨平台基线完整性 | macOS `1409+3`，Windows `1386+26`，差额有源码门控背书 | 同上（不带 `--only` 时） |

## 口径说明

- 所有计数按当前工作树现读；并行会话若改动文件，需要重新跑同一命令。
- 本文不记录门禁步数与耗时：这两项由 `scripts/verify.mjs --list` 和对应脚本每次打印，抄进文档会漂。
- 本文不把源码文本命中数当作行为证据；它只用于评估源码形状判据的迁移成本。
