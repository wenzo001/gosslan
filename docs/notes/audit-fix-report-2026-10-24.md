# 2026-10-24 全项目审计修复报告（B1–B19）

> 输入：`.workbuddy/audit/gosslan-full-audit-2026-10-24.md`（第三遍复核版，git-ignored）
> 范围：审计确认的 **18 条缺陷**（P1 4 / P2 10 / P3 2，含 2 条条件性）+ 修复过程中独立复审发现的缺口
> 纪律：每批单独提交、每批可验证、不跑 `verify:full`、发版前不 push

---

## 0. 结论

- 审计 18 条**全部有落地处置**，没有"文档里列了、代码里没动"的缺口。
- 共 **19 个修复提交**（B1–B19），版本 `5.7.11 → 5.7.29`。
- 最终读数（HEAD 实跑）：
  - `cargo clippy --features bluetooth --all-targets -- -D warnings`：**0 红**
  - `cargo test --features bluetooth --lib`：**1185 passed / 0 failed / 1 ignored**
  - `npm test`：**1368 passed / 0 failed**
  - `npm run build`：通过；`npm run version:check`：退出码 0（5.7.29）
  - UI 运行时探针：**524/529**（5 条红均与本轮改动无关，见 §7）
- 关键判据都做了**变异验证**（把修复拆掉/改坏必须变红），不是空转测试。
- 仍未验证、需要真机或 CI 的项：CSP 真机 6 条冒烟、Windows/macOS 打包安装、双实例 E2E。

---

## 1. 缺陷 → 批次 → 判据总表

| # | 缺陷 | 批次 | 提交 | 关键判据 |
|---|---|---|---|---|
| 1 | SEC-01 打开文件未绑消息身份 | B1 | `735ab08b` | 伪造 `raw.path` 必须被拒；合法台账路径必须通过 |
| 2 | FUNC-02 取消终态写失败被吞 | B2 | `46e08f40` | 注入写失败 ⇒ 返回 Err 且可定位 |
| 3 | FUNC-03 群取消写幽灵 `file_transfers` 行 | B2 | `46e08f40` | 群取消后 `file_transfers` 行数不变 |
| 4 | FUNC-04 「已取消」可被复位复活 | B2 | `46e08f40` | 墓碑在、队列仍 sending ⇒ 重启不复活 |
| 5 | SEC-05 入站接收无配额 | B4 | `8b0034a7` | 连续两个超配额 Offer，第二个被拒 |
| 6 | SEC-02 `zip` 供应链漏洞 | B5 | `82d3434e` | `cargo deny check` 无失败 |
| 7 | SEC-07 CDLA 许可证未在 allow 列表 | B5 | `82d3434e` | 门禁退出码 |
| 8 | FUNC-01 macOS 沙盒打开接收目录失败 | B3 | `e7ab2961` | macOS `cfg` 单测 + 统一打开门面 |
| 9 | DB-01 建表/迁移 DDL 未包事务 | B6 | `0a26fb31` | 中断后整体回滚 |
| 10 | DB-02 迁移备份不自动清理 | B7 | `4796d7e0` | 保留 3 份受控 |
| 11 | REL-01 看门狗自身不被监督 | B8 | `fc1f4de6` | kill 监督循环后自动拉起（`code=WORKER_DEAD`） |
| 12 | DB-03 `list_transfers` 返回全表 | B9 | `b79aea9d` | 列表返回上限 + 索引 |
| 13 | PERF-01 更新器安装整包 clone | B10 | `4d532516` | 整包 take + 失败回填；峰值 1× |
| 14 | PERF-02 共享目录树一次性入内存 | B11 | `2db8a6c2` | N+1 条目录断言截断 |
| 15 | SEC-06 CSP 为 null | B13 + B18 | `d0b59fb9` + `0ac90331` | CSP 十条指令、`'unsafe-inline'` 数量 0 |
| 16 | SEC-09 身份私钥明文存 SQLite | B14 | `100150d8` | 威胁模型文档 + 不引 keyring 的决策 |
| 17 | TEST-01 `clippy --all-targets` 不绿 | B12 | `f8700ae2` | 门禁 0 警告（78 条清零） |
| 18 | TEST-02 负向场景测试缺口 | 随 B1/B2/B4 | — | 恶意路径、取消故障注入、超配额三条负向用例 |

复审阶段补齐的缺口（独立提交）：

| 批次 | 提交 | 内容 |
|---|---|---|
| B15 | `21ddb268` | 配额闭环：`inbound_gate` 准入闸、保留 `.part` 预算、群续传/中继入口 |
| B16 | `88bb2ac9` | 失败留痕、群取消单事务、DDL+`user_version` 同事务、对账逐条报错 |
| B17 | `d28a96f1` | 共享目录截断：协议位 + 命令形状 + 界面提示 + i18n |
| B18 | `0ac90331` | CSP 从"宽松声明"收紧为严格策略 |
| B19 | `5e7c4666` | 更新器禁止降级（审计 §13 产品裁决） |

---

## 2. 逐批记录：问题 / 解决 / 影响

### B1 SEC-01｜打开本地文件未绑定消息身份（P1）

- **问题**：前端把消息里的 `path` 直接传给 `open_file_native`。IPC 调用方（或伪造的消息行）可以递进共享/下载目录内**任意**本应用托管文件的路径，让系统打开它。
- **解决**：前端改传 `msg_id`；后端按 `file-{transfer_id}` / `gfile-{transfer_id}` 前缀回绑 `file_transfers.path`，只打开台账里属于这条消息的那一份。伪造路径被拒并记 `code=OPEN_PATH_NOT_OWNED`；未绑定的路径记 `code=OPEN_PATH_UNBOUND`。
- **影响**：把"能打开托管目录内任意文件"收窄为"只能打开这条消息自己的文件"。收藏入口和另存为路径不回归。
- **判据**：恶意 `path` 必须被拒 / 合法台账路径必须通过 / 收藏入口不回归（`files_tests`）。

### B2 FUNC-02/03/04｜取消与终态收口（P1/P2）

- **问题**：
  1. 取消时先删队列、再写消息状态，第二笔写失败被 `let _ =` 吞掉 ⇒ 界面显示已取消、队列却还在发。
  2. 群取消在 `file_transfers` 里留下幽灵行。
  3. 崩溃窗口内「已取消」可被晚到的进度/重试写复位复活。
- **解决**：
  - 取消统一收口到**一个 `unchecked_transaction` + 单一出口**，检查受影响行数；失败返回 Err 并记 `code=CANCEL_COMMIT_FAILED`。
  - `set_message_status` 返回 `changes()`；无行不 `upsert`，记 `code=GHOST_TRANSFER_BLOCKED`。
  - 台账新增 `cancel_terminal` 墓碑列（迁移 v11→v12）；复位 SQL 排除墓碑，记 `code=RESURRECT_BLOCKED`。
- **影响**：取消后不会出现"界面上没了、其实还在发"；重启不会把已取消的任务复活。跨窗口/重启的残留由 `db/cascade_tests.rs` 覆盖。
- **判据**：注入写失败返回 Err；群取消后 `file_transfers` 行数不变；墓碑已写、队列仍 sending ⇒ 重启不复活（含变异验证）。

### B3 FUNC-01｜macOS 沙盒打开接收目录（P2）

- **问题**：`share.rs` 直接 `Command::new("open")`，App Sandbox 禁止 fork `/usr/bin/open`，必然失败。
- **解决**：新增 `open_dir_native`，macOS 走 `NSWorkspace.openURL`，其它平台走既有 opener；`share.rs` 删除裸 `Command`。
- **影响**：macOS 沙盒安装包里"打开接收目录"从必然失败变为可用；错误统一记 `code=OPEN_DIR_FAILED`。
- **判据**：macOS `cfg` 单测 + 打开门面唯一入口。

### B4 SEC-05｜入站接收配额（P1）

- **问题**：每收到一个 `FileOffer` 就建一个 `.part` 并占一格内存表。对端（或被盗好友身份）可以靠连续 Offer 写满磁盘、撑大表、拖垮同一 runtime 上的所有命令。旧实现只有 24h TTL 清扫，是"事后收尸"。
- **解决**：`Semaphore`/计数限制并发，单文件 8 GiB、总字节 16 GiB；超限拒绝并记 `code=RECV_QUOTA_EXCEEDED`。
- **影响**：入站资源上界与对端行为无关；恶意 Offer 从"能拖垮进程"降为"被拒绝"。
- **判据**：连续两个超配额 Offer，第二个被拒（含 kind 与 max 读数）。

### B5 SEC-02/07｜供应链门禁（P1/P2）

- **问题**：`zip 4.6.1` 带已知漏洞；CDLA-Permissive-2.0 不在 allow 列表；`cargo deny` 不在 push 前闸门。
- **解决**：升级 `zip`；评估许可证后加入 allow 或替换；`cargo deny check` 进 push 前闸门。
- **影响**：已知漏洞与许可证风险在提交前被拦住，不再依赖人工记忆。
- **判据**：`cargo deny check` 退出码。

### B6 DB-01｜建表与迁移 DDL 未包事务（P2）

- **问题**：建表语句与 `ensure_schema` 逐条执行；中途失败会留下半套 schema。
- **解决**：DDL 包 `unchecked_transaction`，逐条确认 `PRAGMA`；迁移逐步在事务内执行。
- **影响**：中断后整体回滚，不会出现"表建了一半、版本号却已前进"。
- **判据**：中断注入后整体回滚（`startup_safety_tests`）。

### B7 DB-02｜迁移备份保留份数（P2）

- **问题**：迁移前备份从不清理，目录无限增长。
- **解决**：保留最近 3 份，统一走 `sweep_old_backups`；清扫失败记 `code=BACKUP_SWEEP_FAILED` 并继续启动（不阻断）。
- **影响**：备份目录有界；清扫失败可见但不影响可用性。
- **判据**：保留数受控 + 失败留痕。

### B8 REL-01｜看门狗自身被监督（P2）

- **问题**：`start` 丢弃监督循环的句柄。它一旦结束，5 个常驻 worker 全部失去看管，表现为"消息不收不发但界面正常"，日志里一行都没有。
- **解决**：共享句柄表（`Arc<Mutex<Vec<_>>>`）+ 二层守护：每 tick 判监督循环句柄，结束即带 `code=WORKER_DEAD` 重启；重启时接管旧 worker，不重复 spawn。
- **影响**：监督链断掉会自愈且留痕；"安静地全灭"不再可能。
- **判据**：kill worker/监督循环后自动拉起；`verdict` 真值表；启动与心跳活性证据。

### B9 DB-03｜`list_transfers` 返回全表（P3）

- **问题**：传输台账读取无上限；台账变长后每次全表读。
- **解决**：加 `LIMIT/OFFSET` 与热查询索引（实测 +2µs/条，换来有界读取）。
- **影响**：列表读取有界，长期使用不随台账增长线性变慢。
- **判据**：热表恰好携带预期索引；列表返回上限。

### B10 PERF-01｜更新器安装整包 clone（P2）

- **问题**：安装时把几十 MB 的整包 `clone()` 一份交给 `install`，峰值 2× 包体。
- **解决**：`take()` 整包移动；失败时把 `update`/`bytes` 原样放回会话，失败可重试不必重下。
- **影响**：内存峰值从 2× 降到 1×；弱内存设备上"安装时 OOM"风险下降，且验签/磁盘/占用失败可直接重试。
- **判据**：`take` 恰好 2 处、除错误文案外零 `clone`、回填恰好 2 处（含变异验证）。

### B11 PERF-02｜共享目录树一次性入内存（P2）

- **问题**：共享方遍历目录时把整棵树装进内存再序列化；超大目录导致内存峰值与长响应。
- **解决**：`walkdir` 流式收集 + 条数上限；超限截断并记 `code=SHARE_TREE_TRUNCATED`。
- **影响**：单次响应有界；恶意/超大目录不再拖垮共享方。
- **判据**：N+1 条目录断言截断；日志可定位。

### B12 TEST-01｜测试码进 lint 门禁（P2）

- **问题**：`clippy --all-targets` 长期不绿（测试码与 examples 里 78 条）。
- **解决**：清零 78 条并让 `--all-targets` 进闸门。
- **影响**：测试代码与示例也被 lint 约束，负债不再累积。
- **判据**：`clippy --features bluetooth --all-targets -- -D warnings` 0 红。

### B13 + B18 SEC-06｜WebView CSP（P2）

- **问题**：CSP 为 `null` ⇒ 页面可外链、可跨源取数。
- **解决**：
  - B13 先上 CSP，挡外链与跨源。
  - B18 复核 `tauri-codegen 2.7.4` / `tauri 2.12.5` 源码后确认：打包时会给内联 `<script>` 算 `'sha256-…'`、给 `<style>` 注 `'nonce-…'`；CSP3 规定 nonce/hash 在场时 `'unsafe-inline'` **被忽略**。于是删掉两个 `'unsafe-inline'`，补 `base-uri 'none'; form-action 'none'; frame-ancestors 'none'`。
- **影响**：配置与实际生效策略一致；内联脚本/样式仍由 Tauri 的 hash/nonce 放行，生产行为等效但攻击面更小。
- **判据**：十条指令齐全 + `'unsafe-inline'` 数量 0（加回时立即红，已做变异验证）。
- **未验证**：真机 6 条冒烟（首屏主题、blob 预览、自定义协议、IPC、多窗口）——需要 WKWebView/WebView2。

### B14 SEC-09｜身份私钥威胁模型（P3，文档决策）

- **问题**：X25519/Ed25519 私钥以 base64 存在 SQLite `settings` 表。
- **解决**：写清威胁模型（同机其他用户、备份工具、磁盘取证、恶意软件）与"不引 `keyring`"的决策边界：库/侧车/备份 `0600`、app data 目录 `0700` 已由既有实现保证；引入系统钥匙串会带来旧库兼容与新依赖，收益不足以抵消。
- **影响**：这是一条**有意的产品决策**而非"漏修"；后续要换钥匙串时，威胁模型已给出验收口径。
- **判据**：文档 + 既有权限用例。

### B15 SEC-05 复审｜配额闭环（P1 复审）

- **问题**：B4 的配额只在直连接收入口生效；群续传、中继 Offer 可以绕开；断链保留的 `.part` 不计费 ⇒ "发一份、断链、换个 id 再来"仍可无限写盘；配额判断是 check-then-act，并发下可穿透。
- **解决**：
  - 新增 `AppState::inbound_gate`（`Mutex<()>`）与 `admit_inbound`：持闸算占用 → 判配额 → 必要时清理未登记的旧 `.part` → 才允许建接收器。
  - `inbound_usage` 把 `relay_file_keys` 一并计入；`RelayFileReceive` 记录 `size`。
  - 群续传重建、中继 Offer 入口都过同一道闸。
  - `.part` 预算只清 UUID 形状、未登记、非当前 transfer 的文件（用户自己的 `backup.part` 不删）；失败记 `code=PART_PRUNE_FAILED`。
- **影响**：配额从"一个入口的检查"变成"全入口的准入事实"；磁盘上界 = 在途 16 GiB + 保留 16 GiB，与对端行为无关。
- **判据**：`every_inbound_entry_goes_through_the_admission_gate`（从 `inbound_usage` 函数体里删掉 relay 累加即红）、保留 part 最旧先删、拒绝串带 `transfer=`/`peer=`/`max_retained=`。

### B16 复审收尾｜失败留痕与原子性

- **问题**（多处）：
  - `fail_file_job`、投递任务 Cancelled、群取消列表失败仍是静默写。
  - 群取消分两笔写，中途失败会留下"成员行已取消、摘要行没取消"。
  - 对账 `unwrap_or(false)` 把单条失败吞成"没变化"。
  - `apply_base_schema` 在事务外写 `user_version`。
  - 启动清扫失败只 `eprintln`。
  - worker 重启/放弃日志没有 `code=`。
  - 共享目录上限在隐藏文件/符号链接过滤之前检查 ⇒ 误报截断。
  - updater 安装命令 future 被丢弃时相位永久停在 `installing`。
  - 另存为仍用 `raw.path`（台账路径被忽略）。
- **解决**：
  - `finalize_with_note` 统一终态写失败留痕（`code=FILE_FINALIZE_FAILED`）；取消列表失败记 `code=FILE_CANCEL_LIST_FAILED`。
  - `cancel_group_file_atomically` 把成员行与摘要行收进一个事务。
  - `ReconcileReport { changed, failed }`，逐条报错。
  - `apply_base_schema_atomically(conn, ddl, fresh_version)`：`user_version` 进同一事务。
  - `db::init_with_notices` 返回启动通知，由 `state.rs` 落 warn。
  - `code=WORKER_RESTART` / `code=WORKER_GIVEUP`。
  - 上限检查移到过滤之后。
  - `InstallingPhase` Drop 守卫（`code=UPDATER_INSTALL_ABORTED`）。
  - 另存为路径以台账优先。
- **影响**：失败不再"看起来成功"；启动期问题可检索；相位不会卡死。
- **判据**：群取消触发聚合行失败 ⇒ 成员行回滚为 0；安装两格失败各留痕 2 次；`user_version` 在 DDL 事务内（新增用例）。

### B17 PERF-02 复审｜截断要说给用户听（P2 复审）

- **问题**：超过条数上限时只回前 N 条，`truncated` 只写共享方日志；请求方把"前 N 条"当成全部。
- **解决**：协议 `ShareTreeResponse.truncated`（`#[serde(default)]`，旧端按 false）；命令返回 `{ entries, truncated }`；`parseIpcValue(shareTreeSchema, …)` 校验旧形状；界面显示"对方目录条目过多，仅显示前 {count} 项"；截断位随树缓存，切好友不串台。
- **影响**：用户知道列表不完整，不会误以为对方只有这么多文件；旧端兼容（缺字段按 false）。
- **判据**：旧 JSON 解出 false；裸数组形状被拒；A/B 两棵树的截断位不串台；探针夹具同步后共享目录段全绿。

### B18 已并入 SEC-06｜严格 CSP

见上。

### B19 §13 裁决｜禁止更新器降级

- **问题**：更新包签名只证明"出自发布者"，不证明"比现在新"。清单端点被换或发布事故把旧包推上 `latest` 时，用户会被安静地回滚到已知漏洞版本。
- **解决**：`updater_check` 用自己的 semver 判据再比一次；不高于当前版本直接拒绝，记 `code=UPDATER_DOWNGRADE_BLOCKED`（带双方版本号），且**不把这份 `Update` 放进会话**。版本号解析失败按失败关闭。前端新增 `downgrade` 错误格与中英文案。
- **影响**：降级通道关闭；清单发布事故会以明确错误暴露，而不是静默回滚。代价是用户不能通过应用内更新回退旧版本（如需回退走手动安装）。
- **判据**：六向对照（更低/相同/更高补丁/更高次版本/预发布/非法版本）+ 闸门必须在检查路径且在入会话之前（删掉闸门立即红，已变异验证）。

---

## 3. 独立复审是怎么做的

B1–B14 落地后，用三条**只读**子代理分别复看：

- Agent A（B1/B2）：发现群取消两笔写、`unwrap_or(false)` 吞错、`saveAs` 仍用 `raw.path`。
- Agent B（B3–B7）：发现配额 check-then-act、保留 `.part` 不计费、群续传/中继入口不过配额、`user_version` 在事务外、启动清扫只 `eprintln`。
- Agent C（B8/B10/B11/B13）：读 `tauri-codegen`/`tauri` 源码证实 `'unsafe-inline'` 被 hash/nonce 失效；发现共享目录截断误报且无界面提示、updater `installing` 无 Drop 守卫、updater 测试断言假绿。

这些发现全部补成 B15–B18，并各带可变异验证的判据。

---

## 4. 与审计文档的边界差异（有意为之，不是漏修）

1. **`open_file_native` 的 `mine` 分支不加目录地板**：发送端可以从任意目录选文件，加"必须在托管目录内"的地板会误伤合法路径。信任依据写在注释里：对端写不了 `sender_id`（入站校验），所以"mine"只可能是本机自己发过的文件。
2. **`.part` 预算只清 UUID 形状、未登记、非当前 transfer 的文件**：用户自己的 `backup.part` 之类的普通文件不删。
3. **SEC-09 不引 `keyring`**：产品决策，理由与威胁模型见 `docs/notes/identity-key-threat-model-2026-10-24.md`。
4. **TEST-02 没有单独成批**：5 条最小负向用例已随 B1/B2/B4 落地；沙盒平台行为与崩溃恢复仍属真机/长跑范畴。
5. **入站配额数值维持现值**（8 并发 / 8 GiB 单文件 / 16 GiB 总量 / 16 GiB 保留）：2026-10-24 产品裁决，数值是运营参数、可调。

---

## 5. 验证证据

### 5.1 门禁读数（HEAD 实跑）

| 命令 | 结果 |
|---|---|
| `cargo fmt --all -- --check` | 通过 |
| `cargo clippy --features bluetooth --all-targets -- -D warnings` | 0 红 |
| `cargo test --features bluetooth --lib` | 1185 passed / 0 failed / 1 ignored |
| `npm test` | 1368 passed / 0 failed |
| `npm run build` | 通过 |
| `npm run version:check` | 退出码 0（5.7.29） |

### 5.2 变异验证（拆掉修复必须红）

| 批次 | 变异 | 结果 |
|---|---|---|
| B1 | 伪造路径直接放行 | 负向用例红 |
| B2 | 拆掉取消事务 | 回滚用例红（left 2 / right 0） |
| B8 | 删掉二层守护 | 监督用例红 |
| B9 | 删掉索引 | 索引计数用例红 |
| B10 | 删掉安装失败回填 | 计数用例红（1 vs 2） |
| B15 | 从 `inbound_usage` 删掉 relay 累加 | 入口判据红 |
| B16 | 拆掉 `cancel_group_file_atomically` 事务 | 回滚用例红 |
| B17 | 前端读回裸数组 | 校验用例红 |
| B18 | 加回 `'unsafe-inline'` | CSP 守卫红 |
| B19 | 删掉降级闸门 | `check_refuses_a_manifest_that_is_not_newer` 红 |

### 5.3 运行时探针

- 全量：**524/529**（完整日志 `.workbuddy/audit/ui-probe-20261024-full.log`，git-ignored）。
- 修掉 B17 遗留的夹具契约（裸数组 → `{entries, truncated}`）后，共享目录段全绿。
- 剩余 5 条红均与本轮改动无关：toast 80ms 计时（`ToastList`/`ToastRoot` 自 `e28efdeb` 未动；Reka 的停留计时在指针悬停 viewport 时会暂停）、设计令牌两档按压 2 条（引擎返回 `color(srgb)`，量具只归一化了部分形式）、链接线上导入回车、以及全量顺序下 renderer 卡死（脚本自述属"这一格没跑"，不是产品红）。

---

## 6. 影响评估

- **安全面**：SEC-01（打开边界回绑消息）、SEC-05（入站配额全入口闭环）、SEC-06（严格 CSP）、SEC-02/07（供应链门禁）、SEC-09（威胁模型与权限边界）全部有落地处置。
- **可靠性**：取消/终态/复位收进事务与墓碑；启动清扫失败可见；监督链断掉自愈；DB 落盘原子性补齐。
- **性能**：更新器安装峰值 2×→1×；共享目录树有界；台账读取有界并带索引。
- **可维护性**：测试码进 lint 门禁；新增判据都带变异验证；复审发现的缺口不再以"看起来修了"的形式留在代码里。
- **用户可感知**：共享目录截断有明确提示；更新器拒绝降级并给出明确错误；macOS 沙盒下能打开接收目录；取消不再"界面没了还在发"。

---

## 7. 仍未验证 / 残余风险

1. **CSP 真机 6 条冒烟**：首屏主题脚本、`blob:` 预览、自定义协议、IPC、多窗口 —— 需要 WKWebView/WebView2。
2. **Windows / macOS 打包安装与更新器真机重启**：本机不能出 Windows 包；macOS 公证未验。
3. **双/三实例 E2E**：本轮未跑（按用户要求未跑 `verify:full`）；发 release 前由 CI 的 `verify.yml` 与发布 workflow 兜底。
4. **toast 自动消失、设计令牌按压、链接导入回车**：既有探针红，与本轮改动无关，待单开批次。
5. **AOCI 认知索引**：本会话 MCP 工具不可用；CLI `status` 报"当前索引形态不支持修改"⇒ 未做机器维护，需要下次以可用工具会话收口。

---

## 8. 提交清单

`735ab08b` `46e08f40` `e7ab2961` `8b0034a7` `82d3434e` `0a26fb31` `4796d7e0` `fc1f4de6`
`b79aea9d` `4d532516` `2db8a6c2` `f8700ae2` `d0b59fb9` `100150d8` `21ddb268` `88bb2ac9`
`d28a96f1` `0ac90331` `5e7c4666`

每批可在 `git show <hash>` 看到该批的改动文件、CHANGELOG 条目与验证说明。
