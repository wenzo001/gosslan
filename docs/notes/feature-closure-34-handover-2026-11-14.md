# 交接：#34 后台任务跨重启扩展（2026-11-14，已实施）

> **状态更新**：#34 已在后续会话实施完毕。下面「当前代码状态」是当时的**取证起点**，
> 不是现在的实现；「实施计划」第 2 项按负责人裁决改为「不新增重复 OperationKind」。
> 落地范围、真值源与验收证据见 `docs/notes/feature-closure-ledger-2026-11-13.md` 的 §8/§10，
> 用户可见变更见 CHANGELOG 的 `[Unreleased]` 小节。用户决策与边界（不续传、不改安装相位契约）仍然有效。

本文件写给**接手实施 #34 的会话**。审计 `feature-closure-async-audit-2026-11-13.md` 的 6 项里
其余 5 项 + 代码审查 8 bug 已在 5.25.0 落地（提交 `46fb30dc`/`b68e3f1e`/`420b056b`/`2d8ad7c9`），
**只剩 #34（P2 后台任务跨重启生命周期）未做**。用户已拍板方向，本轮因额度另起会话实施。

## 用户决策（2026-11-14）

**重启重查重下 + 统一台账**：
- 更新下载：持久化更新意图（版本/阶段），重启后任务中心重新显示「有可用更新，重新下载」
  （重下整包，**不字节续传**——官方 tauri 更新器整块内存下载、签名校验后返回，不支持续传）。
- Todo 图片 / 共享目录下载：纳入统一任务台账（新增 OperationKind + 真值源 + 动作）。

## 当前代码状态（取证起点，接手请现查符号别抄行号）

- `src-tauri/src/commands/updater.rs`：`UpdaterStatus { phase, downloaded, total, version, error }`
  收在 `UpdaterSession`（全局 managed state，两窗口共用），每次跃迁 emit `updater-status`。
  **无持久化** ⇒ 重启后下载行消失。phase 取值 `idle|checking|downloading|ready|installing|failed|cancelled`。
  安装相位常量 `INSTALLING`（跨层契约，TS `src/updater/service.ts` 按它判不可取消）。
- `src-tauri/src/commands/android_updater.rs`：移动端更新（恒 `unsupported` 桌面相位）。
- `src/utils/taskCenter.ts`：唯一归一读模型。`OperationKind` 含 `update_download`；
  `updaterRow(u)` 只在 `phase==="downloading"` 成行（约 317/372）。`OperationSources.updater?: UpdaterStatusView`。
  文件头有判据「不许手抄 kinds 计数」（计数由 OperationKind 自己说话）。
- `src-tauri/src/commands/group_todo_media.rs`：`todo_image_meta` / `save_todo_image_bytes`（Todo 图片）。
- 共享目录下载：走文件链路（`commands/files.rs`），目前不在任务中心。

## 实施计划（建议）

1. **更新意图持久化**：把「检查到的可用更新版本 + 用户曾发起下载」落 settings/db（非密）。
   启动时若持久意图存在 → 重新 check（官方 updater）→ 任务中心/更新页显示「有可用更新，重新下载」。
   不恢复字节进度（官方不支持）；重启后 `downloaded` 归零、重新整包下载。
2. **统一台账**：给 Todo 图片 / 共享目录下载新增 `OperationKind`（如 `todo_image` / `shared_dir_download`）
   + 真值源 + 可执行动作（取消/重试，只引用真实命令）。taskCenter 文件头 kinds 计数判据会现算，别手抄。
3. **跨重启契约登记**：在 `feature-closure-ledger-2026-11-13.md` §8/§10 把「重启重查重下」落实并更新验收证据。

## 门禁与纪律

- 动 `src-tauri/**` ⇒ `npm run verify:full`（退码不经管道）；新增 Rust 用例 ⇒
  `node scripts/check-test-manifest.mjs --only rust --update` + `--sync-baselines` + `--only rust`。
- 动应用码 ⇒ 同提交 `Version-Bump:` + 五处版本清单（`node scripts/version.mjs patch|minor`）；
  标题按 `node scripts/check-change-budget.mjs --staged` 定档（[plan]/[impact]）。
- 更新器是安全敏感（签名校验/安装不可取消）：不绕过签名、不改安装相位契约；配反例自证。
- 纯文档笔标题带 [plan]（零影响豁免），否则 version:check 会把它算 patch 级。

## 边界

- 不做字节续传（官方 API 不支持，高风险）。
- 不动其余 5 项审计改进与 8 审查修复（已落地）。
- 额度提示：上一会话 device-auth agent 曾触额度上限；#34 建议直接实施或拆小批，避免重型 agent。
