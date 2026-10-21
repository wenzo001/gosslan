# 提交与版本方案（2026-09-13）：把「每 commit 定档 + 一键发布」真正跑一遍

> 起因：用户 2026-09-13「我针对每一个需求的每一个 commit，都有一套版本叠加/改版/升级的规则，
> 你看一下。**要把它用起来**。」
> 规则本身在 `docs/VERSIONING.md`、实现在 `scripts/semver.mjs`；这份文档是**对这一批未提交改动
> 的实际应用**（含实测出来的档位），可以直接照着做，也可以用来核对 AI 的定档是否合理。

## 1. 规则一句话（照 `semver.mjs::classifyCommit` 的**实际**行为）

档位只看 **提交标题里 `type(scope): ` 之后的那段 summary 文本** + 该提交的改动行数（churn）：

| 判据（按顺序） | 结果 |
|---|---|
| 标题带 `!` | major |
| `feat/refactor/perf/build` **且 summary 命中架构线索词**（协议/架构/ADR/蓝牙/BLE/mesh/中继/传输/窗口/安卓/Android…）**且 churn ≥ 150** | major |
| `feat` | minor |
| `perf` | minor |
| `fix` / `docs` / `test` / `chore` / 其余 | patch |

⚠️ **scope 括号里的字不算**（`feat(ble): …` 的 `ble` 不参与线索词匹配），只有 summary 算。
⇒ **同一份代码，标题怎么写，要升的位就不同。**

门禁：`npm run version:check` 要求「每个提交声明的 `Version-Bump:` == 它被判定的档位」
且「当前版本 ≥ 按最高档提升后的版本」；发布：`npm run version:release`。

## 2. 这批改动的定档（`scripts/semver.mjs` 实测 + 实际执行结果）

**实际执行成 5 个提交**（原计划拆成 9 条，落地时按"一个主题一条"合并 —— 定档标准不变）：

| # | 实际提交 | 标题 | churn | 实测判档 |
|---|---|---|---|---|
| 1 | `92705c9` | `feat(ui): 默认头像取字规则升级（英文 4 字母 / 中文首字 / 中英混排）` | ~250 | **minor** |
| 2 | `084dedd` | `build: 一键并行打包（跨平台同时出包，Windows 只出当前环境的包）` | ~260 | patch |
| 3 | `324fa8f` | `feat(diag): 网络诊断重做 + 链路可观测性与稳定性修复` | 1477 | **minor** |
| 4 | `37200df` | `fix(ux): 文本选择与长按交互（PC 拖选一划就断 / 移动端长按与选字互相打架）` | 461 | patch |
| 5 | 本条 | `docs(notes): 框架审计报告 + 真机测试计划 + 提交定档方案` | ~420 | patch |

`npm run version:classify` 实测输出（**最高档 minor**）：

```
92705c9  minor  feat   feat(ui): 默认头像取字规则升级（…）
084dedd  patch  build  build: 一键并行打包（跨平台同时出包，Windows 只出当前环境的包）
324fa8f  minor  feat   feat(diag): 网络诊断重做 + 链路可观测性与稳定性修复
37200df  patch  fix    fix(ux): 文本选择与长按交互（…）
最高档: minor ⇒ 本次发布应提升到 4.3.0
```

⇒ 这次发布是 **`4.2.20 → 4.3.0`**。

> 第 3 条把"诊断重做"与审计查出的 5 处链路/文件缺陷合并在一条里（都是同一个审计批次的产出，
> 且改动在 `ble.rs`/`file.rs`/`transport.rs` 里互相交织，按 hunk 硬拆容易拆坏）。
> 标题按"最大档"取 `feat` ⇒ minor；缺陷细节写在提交正文与 CHANGELOG 里。

## 3. "要不要 major"的两个决定点（结论：都不要）

档位是被**标题措辞**触发的，不是被代码规模触发的。这两条改动换成带线索词的写法就会抬成 major：

| 带线索词的写法（会 major） | 实际采用的写法（minor / patch） |
|---|---|
| `feat(diag): … 蓝牙通道独立状态 …` | `feat(diag): 网络诊断重做 + 链路可观测性与稳定性修复` |
| `build: 一键并行打包（mac 与安卓同时出包）` | `build: 一键并行打包（跨平台同时出包，Windows 只出当前环境的包）` |

**判定依据（用户 2026-09-13 的口径）**：只有**破坏性 / 不兼容**的改动才动第一位；
这次没有任何协议、线格式、数据模型或存储结构的不兼容变更
（`DiscoveryDiag.recent_events → bluetooth` 只是**内部诊断结构**，前后端同源，不落盘、不外发），
所以**不该是 major**。`semver.mjs` 的 `feat + 线索词 + churn ≥ 150 ⇒ major` 只是启发式，
与这个口径冲突时**以用户口径为准**，做法是让标题不误带线索词 —— 但这是"绕开工具"，
见 §7 的改进建议。

## 4. 执行顺序（照抄）

```bash
# ① 每提交一条，标题 + 空行 + 正文 + 空行 + 档位声明（缺了 version:check 必 FAIL）
git add <该主题的文件…>
git commit -F - <<'MSG'
feat(ui): 默认头像取字规则升级（英文 4 字母 / 中文首字 / 中英混排）

规则见 src/utils/color.ts::avatarInitial（含用户 2026-09-13 的澄清：
中英混排以 3 个字母为界，≤2 个字母带一个中文）。
...
Version-Bump: minor
MSG

# ② 全部门禁（会逐条比对"声明档位 == 判定档位"，并检查 CHANGELOG 结构）
npm run version:check

# ③ 按最高档一次性提版本（package.json / Cargo.toml / tauri.conf.json / package-lock.json）
#    并把 CHANGELOG 的 [Unreleased] 落成带日期的版本小节
npm run version:release

# ④ 台账（可选，用于审计/回看）
npm run version:classify
npm run version:ledger
```

## 5. 必须注意的现场问题（2026-09-13 实况）

1. **同一工作树里有另一个会话在提交**（`0cb267b fix(android): 签名固定下来…`，并跑过 `version:release`
   把版本推到 4.2.20、把当时 `[Unreleased]` 的内容一并折进了 4.2.20 小节）。
   ⇒ **不要用 `git add -A`**：会把别人未完成的改动一起提交。**按主题显式列路径**。
2. **签名 keystore 曾经可被误提交**：`src-tauri/gen/android/app/release.keystore`（AGP 真正用的私钥副本）
   不在任何 `.gitignore` 里，`git check-ignore` 返回"未忽略"。已在根 `.gitignore` 补上
   （连同 `app/*.keystore`），现在 `git status` 里不再出现。
   ⚠️ 提交前仍建议 `git status --short | grep -i keystore` 自查一次。
3. **并发会话会把你的文件一起提交走**：`scripts/package.mjs` 与 `scripts/frontend-build.mjs`
   实际是随 `0cb267b` 入库的（那次提交的主题是安卓签名），所以本条方案里 `084dedd` 的正文虽写着
   "新增这两个脚本"，**真正的入库点是 `0cb267b`**。教训：并发树下不要只看自己的 `git add`，
   提交后要用 `git show --stat <hash>` 核对"到底进去了哪些文件"。

## 6. 与 CHANGELOG 的关系

这批改动的 CHANGELOG 条目都写在 `[Unreleased]` 下，随 `version:release` 一次性落成带日期的版本小节。
**本次（minor）落成的是 `[4.3.0] - 2026-09-13`**，同时把 `package.json` / `Cargo.toml` /
`Cargo.lock` / `tauri.conf.json` 四处版本号提到 4.3.0。

> 4.2.20 那次发布漏了 `src-tauri/Cargo.lock`（工作树里一直是 4.2.19 ⇒ 4.2.20 的未提交改动），
> 这次一并带上、提交在发布提交里。

## 7. 遗留：工具口径 vs 用户口径（建议改）

`scripts/semver.mjs` 的 `feat/refactor/perf/build + 线索词 + churn ≥ 150 ⇒ major` 是**启发式**，
它会把"规模大但有线索词的新功能"判成 major，与用户的口径（**只有破坏性/不兼容才 major**）冲突。
这次的处理是**让标题避开线索词**（§3），但那条规则还在，下一个人写 `feat(ble): …` 时还会踩。
建议（未做，等用户拍板）：
- 把线索词命中从"直接判 major"降级为**提示**（打印一行 warning，档位仍按 `feat ⇒ minor`）；
- 或者把 major 判据收紧成"线索词 **且** 正文里有 `BREAKING CHANGE:` / `不兼容` 之类显式标记"。
