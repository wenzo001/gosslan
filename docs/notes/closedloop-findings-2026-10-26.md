# 闭环审计 · 发现清单（B1 进行中）

HEAD 基线：`6ca07ca5`（本文件内所有 `path:line` 均按此 HEAD 复核过；行号会随改动漂移，引用前请重开文件）。
判级口径见 `closedloop-audit-2026-10-26.md`。每条发现都必须先过「门一 · 断链证明」和「门二 · 修改必要性」。

---

## B1-F1 · 取消类操作的结局不留痕（P3，建议修）

**适用的六格**：可诊断可追溯 = FAIL；其余五格 PASS（见下）。

**断点**：Rust 命令层，`src-tauri/src/commands/chat.rs` 的 `cancel_message`。

**现象**：`cancel_message` 函数体内只有一处日志调用，且只在群聊分支里——`chat.rs:165-179` 打 `code=GROUP_CANCEL msg_id=… delivered=… remaining=…`。1:1 消息取消的三种结局（`chat.rs:136-155` 的 `cancelled` / `already_delivered` / `not_found`）**一条日志都不落**。DB 层同样静默：`src-tauri/src/db/messages.rs:729` `NotFound`、`:732` `AlreadyDelivered` 都是直接 `return Ok(...)`，无记录。

**这是同一条通道内的不对称，不是有意的取舍**：同一函数、同一操作类别，群侧有具名 `code=`、1:1 侧没有；若是有意的，按本仓习惯会写明理由（对照 `src-tauri/src/lib.rs:633-636` 那种「延迟是有意的，治的是永久泄漏不是界面 spinner」的写法）。

**同一形状还有三个成员**（按操作类别数，不按文件数）：

| 取消通道 | 结局是否留痕 | 失败分支是否留痕 |
|---|---|---|
| 1:1 消息 `cancel_message` | 无 | 有（`code=CANCEL_COMMIT_FAILED`） |
| 文件 `cancel_file_transfer` | 无 | 有（`code=FILE_CANCEL_LIST_FAILED`） |
| 更新 `updater_cancel`（`src-tauri/src/commands/updater.rs:353-377`） | 无 | `updater.rs` 里只有 `UPDATER_DOWNGRADE_BLOCKED` / `UPDATER_INSTALL_ABORTED` / `UPDATER_INSTALL_FAILED` 三个码，取消不在内 |
| 群消息取消 | 有（`GROUP_CANCEL`） | 有（`GROUP_CANCEL_COMMIT_FAILED` / `GROUP_CANCEL_BUBBLE_FAILED`） |

所以准确的定性是：**取消失败本身有记录，取消的正常结局和竞态拒绝都没有记录**。

**影响**：用户说「我明明点了取消，对方还是收到了」时，诊断包里没有任何可查询的行能证明当时是竞态（`already_delivered`）还是没点到（`not_found`）还是成功但对方已读。`diagnostics.rs` 的导出包读的是这三份日志，没有行就是没有。

**不适用于数据安全**：这条不会丢数据、不会卡死、不会误导界面。界面反馈恰恰是全仓做得最好的地方之一——`src/utils/cancelFeedback.ts` 把结局细分成六种人话，且 `src/utils/cancelFeedback.test.ts:31/35/42/49/53/57` 六条行为断言逐条钉住（「已经送达 ⇒ 说『已经传完』而不是『已取消』」「通知没送出去 ⇒ 只说『仅本机已取消』」「文件已写出后取消 ⇒ 文案必须承认字节可能已到对方」）。**问题只在留痕那一侧。**

**既有测试与不足**：`cancelFeedback.test.ts` 覆盖了反馈映射，`chat.rs` 的结构化返回值 `MessageCancelResult { outcome, delivered, remaining, was_written }` 类型完整；但没有任何测试断言「取消的结局进了日志」——本仓的 `code=` 词表目前有 87 个具名码，没有一条守卫管「关键操作结局必须有码」。

**建议修法（最小）**：只在**竞态与被拒**两类结局补日志，不追求每次取消都留行——按你「不为表面完备打扰用户、也不为可追溯造成新的资源风险」的口径，正常成功的取消可以不记。补两处即可：1:1 取消补 `code=DM_CANCEL msg_id=… outcome=… was_written=…`；`updater_cancel` 补 `code=UPDATER_CANCEL`。文件/内容取消同理。
**爆炸半径**：纯 `logger.*` 调用，不改 IPC 契约、不动状态机、不加取锁、不加 emit、不动前端。载荷只含 `msg_id`，与同函数群侧那行同形状，不新增脱敏面。
**验收标准**：一次 1:1 取消（已送达竞态档）后，日志里能 `grep 'code=DM_CANCEL'` 现读到一行且 `outcome=already_delivered`；把这条补成护栏时，必须证明「删掉那行日志 ⇒ 判据红」（本仓的护栏注入规矩）。

---

## B1-F2 · 决策注释与代码不一致：任务中心「kinds 只有四种」（P3，改注释即可）

**断点**：`src/utils/taskCenter.ts:22-25`。

**现象**：注释「三条边界」的第 2 条写着「**没有台账就不造任务**。kinds **只有四种**：文件、按 cid 取内容、消息补发、群历史。更新下载（B5）、待办图片、共享目录下载都还没有『进度 + 终态』的完整台账 —— 等它们有了再进来，不在这里先画一个动不了的行」。
实际：`OperationKind` 有**六个**成员（`taskCenter.ts:33-39`，含 `update_download`），且 `:272` `updaterRow()` 真的在造这一行、`:353` 给了 i18n key、`:374` 在 switch 里处理它。**5 个 builder 产出 6 种 kind**（`fileRow` 按方向出 `file_send` / `file_receive`）。

**定性**：**注释过期，代码是对的**。B5 落地后没人回来改这条边界说明——注释第 28 行已经改过一次（「消息取消在 B4 落地后…消息行因此也有取消键」），说明这段本来是要跟着更新的手抄清单，但漏了 `update_download`。功能侧有凭据：`src/utils/taskCenter.test.ts:341` 断言了 `update_download` 行的生成。

**风险**：属你反复警惕的「注释里手抄的名字清单会漂」那一族。具体危险不是现在行为错，而是**下一个人（或下一个 AI）拿这段注释当规格**，把已经接好并有测试的更新下载行当成「不该存在」删掉，或者据此判断「更新下载还没有台账，不用管它的取消」。没有任何守卫钉「kinds 数量 = 注释里那句 N 种」。

**建议修法**：把第 2 条边界改成与代码一致的陈述，并**把「只有四种」这种计数写法去掉**（计数由类型自己说话）。若要把 `update_download` 的「进度 + 终态」来源补一句（`UpdaterStatusView` 有 phase 与 downloaded，但更新器状态**纯内存、无持久化**，重启即无痕），就照第 1 条边界那种写法明确写出来——这一句现在是缺的，而它正是下一个人判断「要不要给更新任务做恢复」的依据。
**爆炸半径**：注释，零代码。**不修也不会疼**，但修它便宜到没有理由不修。

---

## B1-F3 · 不可逆操作的取消边界，靠 12 处手抄字面量 + 一条只查文本的断言（P2，建议修）

**适用的六格**：可打断（不可逆边界）与可验证 = PARTIAL；可诊断 = FAIL。

**这是全仓唯一一道拦住「安装中途取消 ⇒ 留下半装现场」的机制，而它没有类型保护。**

`src-tauri/src/commands/updater.rs:349-362` 的注释写得很清楚：「安装阶段不可取消——**字节已经交给安装器**，取消只会留下半装现场」，并声明这一条由「前端不显示按钮 + 这里直接返回错误**两道**保证」。逐处复验的实况：

| 层 | 位置 | 写法 |
|---|---|---|
| Rust 比较 | `updater.rs:359` | `== "installing"` 裸字面量 |
| Rust 赋值 | `updater.rs:449` | `st.phase = "installing".to_string()` 裸字面量 |
| Rust 常量 | — | **无**（`grep -nE 'const PHASE'` 零命中，已加同义模式复验） |
| 跨 IPC 类型 | `src/types.ts:614` | `phase: string`（**不是联合类型**）⇒ 编译器管不了取值集合 |
| 前端 | `src/updater/service.ts:16/124/160/211/227/275/276`、`src/components/settings/UpdatePanel.vue:39/62`、`src/utils/taskCenter.test.ts:349` | **10 处**同样的裸 `"installing"` |
| 唯一断言 | `updater.rs:650-658` `install_phase_is_not_cancellable` | `include_str!` + `body_of(...)` + `contains("\"installing\"") && contains("无法取消")` —— **纯源码文本匹配，从不调用 `updater_cancel`** |

**为什么这道断言挡不住它声称要挡的东西**：它证明的是「函数体里这两个字符串还在」，不是「在 installing 相位调用它会得到 `Err`」。可行的失效路径举例：把 `:449` 的赋值改成 `"install_started"`——两处字面量立刻不再相等，`:359` 那个比较恒为 false、安装中途可以被取消、界面那一道（`UpdatePanel.vue:39` 比的也是旧词）同时失效，而 `contains("\"installing\"")` 在函数体里**仍然命中**（比较那一处还在）⇒ 测试照绿。这正是「有断言 ≠ 被证明会失败」那一族，且它守的是**不可逆操作**。

**当前行为是对的**：我逐处读到两侧用同一个词，没有现存故障。这条的风险是「下一次改动会静默破掉它」，不是「现在坏着」。

**建议修法（按便宜程度排序，三条不互相替代）**：
1. Rust 侧提一个 `const PHASE_INSTALLING: &str = "installing"`，`:359` 与 `:449` 都引用它 ⇒ 字面量漂移变成**编译不过**（影响面按编译器数，零运行时风险）。
2. 补一条真行为测试：构造 `UpdaterSession`、置 `phase = installing`、**调用** `updater_cancel`、断言返回 `Err` 且 phase 没被改成 `cancelled`。这条是把「第二道」从文本证明升级成行为证明，不是放宽第 1 条。
3. 跨语言那一截（`types.ts:614` 的 `phase: string` → 收成联合类型，或给取值集合加契约断言）**复用现成的家**：`src/api/events.test.ts` 里已经有「RuntimeDiag：Rust 字段与 TS interface 必须逐字对应（camelCase 换算现算）」这条同族判据，照它的形状扩到 `UpdaterStatus` 即可，**不新建脚本**。

**爆炸半径**：1 在 `updater.rs` 单文件内；2 加测试不改产品码；3 要动 `types.ts` 一处类型声明，前端 10 处引用会跟着被编译器检查——这正是收益。**都不动状态机、不加 IPC、不加取锁、不加 emit。**
**验收标准**：把 `:449` 的字面量改成另一个词 ⇒ 修法 1 必须**编译失败**（不能只靠测试红）；修法 2 必须真的调用命令并断言 `Err`，且用一次单点变异自证（把 `:359` 的判断摘掉 ⇒ 那条测试必须红）。

---

## B1-F4 · 设置落库失败既不上屏也不留痕（P2，建议修）

**适用的六格**：用户可感知 = PARTIAL；可诊断可追溯 = **FAIL**；可恢复 = PARTIAL。

**断点**：`src/stores/useAppStore.ts:530-553` 的 `persistSettings()`，`catch { /* 忽略：离线或后端暂不可用时不影响本地使用 */ }`（`:550-552`）。

**这条为什么在有第六项标准之后才成立**：我第一轮把它当「有意吞异常」看着想撤案——因为它确实有兜底：`:846-854` 在 `beforeunload` 与 `visibilitychange→hidden` 时调 `persistSoon.flush()`，把去抖窗口里没来得及写的最后一次补上；而 `flush` 的语义本身是有凭据的（`src/utils/defer.test.ts:87/104` 两条真行为断言，含「无待执行时 flush 是空操作（不会凭空多写一次库）」）。

但按「错误产生 → 分类与记录 → 安全处理 → 用户反馈 → 诊断查询 → 恢复或安全终止 → 结果留痕」这条链走一遍，实况是：

| 链上环节 | 实况 |
|---|---|
| 错误产生 | `api.saveSettings(...)` 抛（IPC 拒绝 / 后端取锁失败 / 磁盘问题） |
| 分类与记录 | **无**。`catch {}` 不带参数，既没有 `logFrontendError`，也没有任何计数 |
| 安全处理 | 无回滚：界面值已经改了（`:638` 主题/字体等 setter 先视觉生效再 `persistSoon()`），库没写进去 |
| 用户反馈 | **无**。界面看起来是「已应用」 |
| 诊断查询 | 查不到：日志里没有这一笔，`diagnostics.rs` 的导出包读的就是这些日志 ⇒ 导出来也没有 |
| 恢复或安全终止 | 只有「重启后设置回到上一次成功写入的值」这一条静默结果 |
| 结果留痕 | **无** |

所以准确的定性是：**影响业务结果的异常既不可见也不可查询**——正是你那条「不得静默吞掉影响业务结果的错误，不得仅依赖 Toast 作为错误记录」里最坏的那一格（这里连 Toast 都没有）。

**为什么这条不是「无所谓」**：`:532-549` 这份写入里含 `relayPolicy`、`relayAllowlist`、`bindIp`、`language`、`chatStyle`。其中**中继策略与绑定网卡会改变网络行为**——用户显式选了「允许中继」或手动绑了某张网卡，写库失败后界面仍是所选，但重启回到旧值，而他以为自己改成功了。这是"表面成功但真实结果未确认"那一问的实例。

**已有兜底与残余边界（诚实算）**：
1. 去抖时序风险**已被兜住**（flush 出口存在，`defer.test.ts` 有凭据）——所以这条**不是**「手快关掉就丢」；
2. 残余只剩「写入真的失败」这一路，失败概率低（同机 IPC + 本地 SQLite），主要触发条件是取锁失败 / 磁盘 / 迁移中途；
3. **兜底本身没有凭据**：`beforeunload` 在 Tauri 窗口销毁 / 应用退出 / 常驻窗 `preventDefault` 的语义下到底会不会跑，仓里没有任何测试或探针读数——这条已单独进对账表。

**建议修法（最小，按代价排）**：
1. `catch` 里补一条 `api.logFrontendError`（或同族的既有出口）级别的记录，带**是哪一项设置**与错误摘要——先做到「事后可查」，不打扰用户。这一步零界面变化、零契约变化。
2. 若要做「可见」：**不要**每次失败都弹 toast（拖动取色器 / 连发粘贴时那会刷屏，`:558-561` 记着当年就是因为这个才加的去抖）。建议只在失败时置一个 store 标志，由设置面板顶部一条常驻「未保存」状态行说话，成功后自动消失——这与本仓既有习惯一致（状态行说话，不弹窗）。
3. 上面那条兜底的凭据问题：用现有 CDP 探针跑一次真读数（关窗前是否真的执行了 flush），量出来不触发就改成显式落库出口，而不是靠窗口事件。

**爆炸半径**：1 是一行日志调用；2 是一个布尔 + 一条已有形状的状态行（前端单文件族，不动 IPC）；3 是探针，不改产品码。**都不动状态机、不动数据库、不加取锁。**
**验收标准**：让 `saveSettings` 失败（用本仓既有的隔离手段，不碰真实数据目录），日志里能现读到一行标明是哪项设置失败；且这条判据必须能红——把日志调用摘掉 ⇒ 判据红。若选做 2，还要证「连续 5 次失败只出现一条状态行、不出现 5 次 toast」，否则就是在制造新的刷屏缺陷。

---

## B1-F5 · 1:1 收端解密失败完全静默，双端都没有任何记录（P2，建议修；档位在两可之间）

**适用的六格**：可恢复 = PASS（见下）；**可诊断可追溯 = FAIL**；可感知 = PARTIAL（发送端最终能知道，接收端按设计什么都不该显示）。

**断点**：`src-tauri/src/network/transport/handle_messaging.rs:99-106`。`open_direct_content(...)` 返回 `None` 时直接 `return`，**既不落库也不 Ack，也不打日志**；`src-tauri/src/network/transport/e2ee_payload.rs:39` 的 `open_direct_content` 函数体内 `logger` / `log_throttled` / `code=` **命中 0**。

**这条为什么在功能上是"对的"**：`handle_messaging.rs:91-98` 把理由写得很清楚——Ack 的语义是「已成功接收并持久化」，打不开就**不能** Ack，这样发送方的 outbox 行还在，Hello/心跳会继续补发，期间 announce/who_has 会把双方公钥刷进 peers/friends，补发前用最新公钥**重新密封**，消息随自动恢复且 `msg_id` 不变。同段还记着 P0-2 的原始故障形态：若用真实 `msg_id` 写一条占位系统消息，后续正确副本会被 `INSERT OR IGNORE` 静默吞掉、明文永久不可恢复。**所以"不 Ack"是对的，"不记录"是另一件事。**

**缺口**：这是**安全相关事件**（密钥轮换 / 密文损坏 / 冒充都长这个样子），却和"这条帧本来就不是给我的（`:51-55` 身份不符）"一样完全不留痕。对照同一函数里的另一支：重复投递不仅回 Ack，还专门打一行 `[ACK] 重复消息仍回执 msg_id=… ← peer=…`（`:64-69`），注释写明是为了「留痕区分『没收到』与『收到了但 ACK 丢了』」。**同一函数、同类事件，一支有痕一支没有，属不对称。**

**后果**：用户问「为什么他发的消息我一直收不到」时，诊断包里查不到任何东西——不知道是没送到、公钥不对、还是密文坏了。发送端最终会看到失败（7 天后 `OUTBOX_EXPIRED` → `message-failed`），但**那 7 天里两端都说不清原因**，而这恰好是排「好友公钥三处口径不一致」那一族问题的唯一线索。

**先证伪过的兜底**（门一）：① 重启对账不管这条（它只管 `sending`/`active` 残留行）；② `message-failed` 事件只在发送方超时后发；③ 诊断包读的正是这三份日志，日志没有就没有；④ 没有任何计数器/指标记录解密失败。**四条都不接这条链。**

**建议修法（最小，且必须带节流）**：在 `None` 分支补一行**节流**记录，形如 `code=E2EE_OPEN_FAILED peer=… msg_id=… reason=no_pubkey|decrypt_failed`——**必须走 `log_throttled`**（同文件族里已有 `log_throttled("outbox_row_expired", 300_000)` 的先例），否则垃圾帧可以把日志刷满（虽有 512 KB 轮转兜底，仍不该让人有机会刷）。**绝不要**顺手补 Ack 或写占位行——那正是 P0-2 的形态。
**爆炸半径**：一处 logger 调用 + 一个节流键；不改协议、不改状态、不加 IPC、不加取锁。若 `open_direct_content` 需要区分原因，让它在返回 `None` 时同时返回一个枚举（纯函数内改动，无跨层契约）。
**验收标准**：用一个打不开的密文喂这条分支，日志里能现读到一行 `code=E2EE_OPEN_FAILED`；连喂 100 次，节流窗口内只出现一行（否则就是制造了刷屏缺陷）；且这条分支**始终不产生 Ack**——用一次单点变异自证（把 `return` 改成继续落库 ⇒ 必须有一条既有测试红，若没有，说明这个 P0-2 保护本身也只靠注释）。

---

## B1-F6 · 撤回的「账本」与「物化」是两笔独立写且都 `.ok()`，失败后重试也修不回来（P2，建议修）

**适用的六格**：可执行 = PASS；**可恢复 = FAIL**；**可诊断可追溯 = FAIL**；可感知 = PARTIAL（当时看起来成功，重开会话又出现）。

**断点**：`src-tauri/src/commands/chat.rs:370-377`（以及同形状的另外两处）。

**机制（逐条读到的实况）**：撤回在本地要落两样东西——① 账本行 `group_recalled_messages`（`db::insert_recall`，`INSERT OR IGNORE`，`db/recalls.rs:12-16`）；② 物化到消息行（`db::materialize_recall`，`UPDATE messages SET kind=recalled, content=''`，`recalls.rs:37-43`）。这两笔**是两条独立语句，没有事务**，而且两处结果都被丢掉：`db::insert_recall(…).ok(); db::materialize_recall(…).ok();`（`chat.rs:373-374`）。

**为什么这会造成不可恢复的分裂**：`is_recalled()` 只查**账本**（`recalls.rs:22-32`），不查消息行。而命令开头的幂等短路是：

```
if already_recalled { return Ok(()); }   // chat.rs:358-360
```

于是「账本写成功、物化失败」这一格出现后：消息行仍是原 `kind`、正文原样保留，但 `is_recalled` 永远返回 true ⇒ **用户再点一次撤回也会直接 Ok 返回，永远不会补上物化**。`grep` 全部调用点确认：**没有任何启动对账或后台作业会从账本重新物化**（`group_recalled_messages` 的其它写点只有群删除/会话删除的 `DELETE`）。

**用户看到什么**：撤回那一刻 UI 是**直接改缓存**的（`useChatStore.ts:2821-2827` 把 `kind` 改成 `recalled`、正文清空，不重读库）⇒ 看起来成功。**重开这个会话**（走 DB 重查）时，正文又原样回来了。而对方那边收到了撤回帧、已经物化 ⇒ 双方对同一条消息显示出不同事实，且没有任何东西会对账。

**同样的形状还有两处**（按调用点数，不按文件数）：`commands/group_announcements.rs:149-150`、`network/transport/gossip.rs:931-933`，都是一行 `insert_recall(…).ok();` 紧跟一行 `materialize_recall(…).ok();`。

**另一半风险**：撤回帧是在本地物化**之前**发出去的（`chat.rs:366` 先 `send_message`），这本身是对的（可靠投递优先），但它意味着「本机写失败」时**网络副作用已经不可撤回**——所以更不能把本地写失败当成功返回。

**建议修法（两条都做，否则修不干净）**：
1. `insert_recall` + `materialize_recall` 放进**同一个事务**（本文件族已有先例：`db/group_offline_queue.rs:54` 的 `unchecked_transaction`），要么两笔都落，要么都不落。
2. 幂等短路改成**看两样**：账本已存在但消息行未物化时，仍要补物化再返回 `Ok(())`；这样「重试」才真的是修复路径，而不是被短路吞掉。
3. 两处 `.ok()` 改成向上一层返回错误并打 `code=RECALL_LOCAL_WRITE_FAILED msg_id=…`（帧已发出，所以文案要说清「已通知对方，本机状态未更新，可重试」这种实话，别报成功）。

**爆炸半径**：`db/recalls.rs` 加一个事务版函数 + 三处调用点改签名（`.ok()` → `?`）；不动协议、不动帧、不动前端。三处调用点都已经是「先校验后写」，改成事务不改变任何外部契约。**按编译器数影响面：3 个调用点 + 1 个 db 函数。**
**验收标准**：构造「物化失败」的那一格（隔离库 + 注入一次 `UPDATE` 失败，不碰真实数据目录），断言：① 账本与消息行**同时**回滚；② 再点一次撤回能补上；③ 日志里有一行具名码。另需一次单点变异自证：把幂等短路改回「只看账本」⇒ 第 ② 条必须红。

---

## B2-F1 · 磁盘写满时：界面只说"失败"，而且"保留续传前缀"这条好意会让盘一直是满的（P2，建议修）

**适用的六格**：可执行 PASS / 可打断 PASS / **可恢复 PARTIAL**（24h 清扫能自愈，但那是等到它自己过期）/ **可感知 FAIL**（说不出原因）/ **可验证 PARTIAL** / **可诊断 PARTIAL**（有通用错误串，无具名码、无分类）。

**先纠正一条错前提**：我第一轮从子代理那里拿到的是"全仓零磁盘空间检查"。**自己复跑后发现不成立**——但结论仍站得住，因为那几处全在 `logging.rs` 里，而且**是政策约束**：`logging.rs:132-136` 明写「查可用空间要 `statvfs` / `GetDiskFreeSpaceExW`，前者需要新依赖（本仓默认构建零新增第三方 crate，ADR-0015 §2）」⇒ 于是它改用**错误码/文本识别** `ENOSPC(28)` / `ERROR_DISK_FULL(112)` / `ERROR_HANDLE_DISK_FULL(3900)` / "no space"（`logging.rs:354-365`）。**同类识别在文件传输链上不存在**：`FileJobEnd` 只有 `Expired / GiveUp / Cancelled` 三档（`db/file_transfer.rs:118-125`），写盘错误在这里被 `map_err(|e| e.to_string())` 抹成一条通用串（`network/file/receive.rs:863`）。

**为什么这条在"盘满"这个特定场景比一般失败更糟**：
- 自动失败**刻意保留** `.part` 当续传前缀（`network/file/receive.rs:925-927` 明写「`fail_receive` 刻意保留它当续传前缀」）——**这条在断链场景完全正确**，但在盘满场景里正好相反：那半截文件继续占着本就不够的空间，下一次重试写第一片就又 ENOSPC，于是「保留以便续传」变成了「一直满、一直失败」。
- 用户能自救的唯一动作是**手动取消**那一单——因为 `cancel_receive` 会删 `.part`（`:926` 第一条，理由写着「用户说『不要了』，那半截文件既不该留在下载目录里」）。**但从界面看不出该这么做**：文案只有通用的失败，没有"磁盘空间不足"，也没有"取消这一单可以释放空间"。
- 兜底是 24h 的 `.part` 清扫（`receive.rs:33` 的 `TTL_MS`）⇒ 能自愈，但代价最多一天，且期间所有传输都会失败。

**建议修法（不引入任何新依赖，符合 ADR-0015）**：
1. **复用** `logging.rs` 已有的那套错误码/文本识别（`is_disk_full` 那一族），不要在传输链里另写一份分类 —— 按「新判据先找现成的家」的规矩，把它提成共用的一个小函数。
2. 给 `FileJobEnd` 加一个 `DiskFull` 变体（或给失败原因加一个枚举），落库时带上；这样气泡/任务中心能说「磁盘空间不足」而不是「发送失败」。
3. **`DiskFull` 这一档不要保留 `.part`**（在盘满时保留续传前缀没有意义，且会把盘锁死）——这是**唯一**需要和 `fail_receive`「刻意保留」的既有纪律分开的地方，必须在代码里写明为什么这一档例外，否则下一个人会当成 bug 改回去。
4. 记一个具名码 `code=FILE_DISK_FULL transfer=…`。

**爆炸半径**：`network/file/receive.rs` 的失败分类一处 + `db/file_transfer.rs` 的 `FileJobEnd` 加一个变体（**按编译器数影响面**：所有 `match end` 的地方都要补分支，编译器会逐个点名）+ 复用现有分类器。不动协议、不加依赖、不改表结构（`failed` 状态不变，只是多一个原因）。
**验收标准**：在隔离下载目录上用"只读目录"或小容量挂载构造写失败，断言：① 失败行带 `disk_full` 原因、界面文案说空间不足；② 该档失败后 `.part` **不存在**；③ 其它失败档（断链/超时）`.part` **仍存在**（反向对照，防止把续传一起改坏）；④ 日志有一行具名码。

---

## B3-F1 · 迁移步骤把「读不到 schema」当成「跳过」，版本号照常前进（P3，建议修）

**适用的六格**：可恢复 PARTIAL；**可诊断可追溯 FAIL**（真发生时两端都无痕）。

**断点**：`src-tauri/src/db.rs:265-284`（runner）与 4 处 `Err(e) => eprintln!("… skip …")`。

**机制**：14 个迁移步骤里，有 **4 处**（v1→v2、v2→v3、v3→v4、v4→v5）的写法是：

```
match column_exists(&tx, "friends", col) {
    Ok(false) => { tx.execute(alter)?; }
    Ok(true)  => {}
    Err(e)    => { eprintln!("[gosslan-db] v1→v2: skip {col}: {e}"); }   // ← 读不到 schema 也继续
}
tx.commit()?; Ok(())
```

而 runner 是 `(step.run)(conn)?;` 紧跟 `conn.pragma_update(user_version, step.to)?;`（`:280-281`）。所以「`column_exists` 出错」这一格的效果是：**DDL 没执行、步骤却报成功、版本号照样前进** ⇒ 列永久缺失，且此后的启动不会再跑这一步。

**先证伪过的兜底**（门一）：① DDL 与建表在单事务里、失败整体回滚（`InitError::SchemaMigrate` 的文案与 `migration_tests` 的 rollback 用例都成立）——但**这条只管"DDL 执行失败"，不管"判定阶段读失败"**；② 迁移前有备份（`db.rs:1042` `backup_before_migration`）⇒ 数据本身能救，但**用户不会知道要救**；③ 降级拒绝与"空库但有迁移备份 ⇒ 不按首次安装生成新身份"（`state.rs:1763-1764`）都成立，但它们判的是**另一种**危险。**三条都不接这一格。**

**为什么判定为 P3 而不是 P2**：`column_exists` 只有在 SQLite 层面失败时才会 `Err`（`pragma_table_info('不存在的表')` 返回 0 行、不报错），而这种时刻下一条语句通常也会失败。**可达性窄**，但模式是错的：读不到 schema 时不能假设"列已存在"。

**第二个、而且是每次都成立的问题**：这 4 处输出走 `eprintln!`，而迁移发生在 logger 就绪之前（`lib.rs:318` 明写"此刻还没有 state，先只打 stderr"）。打包后的 GUI 应用里 stderr 没人读（`lib.rs:141` 自己也记着"安卓上 stdout/stderr 不进文件、Release 也没人读"）。而启动留痕 `BOOT_DB_STATE`（`state.rs:1756-1758`）记录的是数据目录、字节数、安装状态与四张表的行数——**不记 `user_version`，也不记这次迁移从哪版到哪版**。所以「真的跳过了一步」这件事，事后在日志与诊断包里都查不到。

**建议修法（4 行 + 1 个字段）**：
1. 把 4 处 `Err(e) => eprintln!(…skip…)` 改成 `return Err(e.into())` —— 读不到 schema 就中止启动，这与本仓既有的「宁可停在启动前，也不要在半迁移状态里继续跑」完全一致（`InitError::SchemaMigrate` 已经是这个立场）。
2. `BOOT_DB_STATE` 那行补 `user_version=…`，以及（若发生过迁移）`migrated={from}→{to}`。这条让「跳过」在事后**可查**，成本是一次读数。
3. 可选、不建议本轮做：把 init 期的 `eprintln!` 先缓进内存，logger 起来后 flush 一次。改动面大（logger 与 db 初始化顺序耦合），按 稳定 > 可维护 排序不值。

**爆炸半径**：`db.rs` 四处 + `state.rs` 一行日志字段。不动表结构、不动协议、不加依赖。
**验收标准**：① 让 `column_exists` 在该步返回 Err（隔离库 + 注入一次 prepare 失败），断言启动**失败**且 `user_version` **没有**前进；② 正常迁移一次，`BOOT_DB_STATE` 里能读到 `user_version=14` 与 `migrated=…`；③ 单点变异自证：把任一处的 `return Err` 改回 `eprintln!`，第 ① 条必须红。

---

## 保留为有意取舍（审过、判定不修，写清理由）

**B1-K1 · 命令层不在任何业务领域内，方向守卫对它零覆盖** — 我一度当成缺陷，复验后是**显式且诚实的豁免**：`scripts/check-domain-deps.mjs:33-34` 写明「落到装配层（`commands` / `state` / `network` / `lib` / `main`）→ 放行（这些是 crosscutting 装配，不该被域管）」，`:77` 给 `commands` 附了理由「6422 行的命令注册表，前后端边界（Phase 7 拆）」；`scripts/check-domain-map.mjs` 实跑 **EXIT=0**，「每个源文件都有归属」。**不修**，两个原因：① 它有登记的后续（Phase 7），不是遗漏；② 把 161 条命令硬塞进某个域，会让 `chat.rs → protocol/network/db/content` 这类正当引用全部变成跨域违规，边界第一天就全红然后被绕过——那段注释（`:46-48`）说的正是这个失败模式。
**对本审计的实际影响（这条要记着）**：`domains.data.mjs` 的 11 域**不是一份完整的文件分区**——`commands/` 是装配层、`presentation` 覆盖整个 `src/`。所以 FID 的域轴是**业务语义分类**，不是从地图推出来的；影响面仍按编译器与引用数现算。

**B1-K2 · 更新器状态纯内存、无持久化**（`commands/updater.rs:151-372`，`phase`/`bytes` 全是 `Mutex`/atomics）— 崩溃后那次未完成的下载没有任何留痕，重启后界面上像是没发生。**不修**：更新检查与下载都是用户主动动作，重启后重走一次的成本是一条命令，而给它建持久台账要新造一张表 + 新的清理规则（`file_transfers` 那套终态守卫与 `done 不降级` 的不变量都得重新对一遍），按 稳定 > 可维护 的排序不值。
**但有一条要跟着修**：取消更新不留痕（`code=` 词表里没有 `UPDATER_CANCEL`），已并入 B1-F1 的补码清单。

**B1-K3 · 「协议没有发送方放弃帧 ⇒ 靠每小时清扫」** — `src-tauri/src/lib.rs:633-636` 原文写明这是知情取舍（「延迟 ≤ 本趟的节奏是有意的：它治的是**永久**泄漏，不是界面 spinner」）。**本轮不动**，两个原因：① 加一帧是跨版本兼容问题，得先定「旧版本收到不认识的帧怎么办」的口径，那是协议决策不是实现决策；② 我还没把前半句证干净——用户主动取消看起来是有 `FileCancel` 的，与注释所说并不矛盾（注释指的是发送方超时/断开那种放弃），这条划给 B2 精确复核，**不许照抄注释当结论**。

---

## B3-F2 · 「清除聊天数据」的清表清单是手抄的 15/20，两张台账表会被留下（P3，建议加守卫）

**适用的六格**：可执行 PASS；可恢复 PASS（失败会 `?` 上报、可见）；**可验证 PARTIAL**；**可诊断 PARTIAL**。

**断点**：`src-tauri/src/commands/favorites.rs:528-559`。

**读数（现算）**：schema 里共 **20** 张表，清表循环点名 **15** 张；另外两条用 `LIKE` 局部删（`settings` 的 `gk:%`、`conversation_clocks` 的 `group:%`）。**完整没被清的是 `friends`、`group_file_acks`、`group_recalled_messages`**（复跑命令写在下面）。`friends` 不清是**对**的——那是通讯录不是聊天数据；但另两张是**聊天数据的台账**，而且父表已经被清空：

| 留下的表 | 谁在读（非测试引用数） | 父表已清空后的后果 |
|---|---|---|
| `group_file_acks` | **16** 处 | 群文件 ACK 账本里留着指向已删 `group_files` / `group_file_recipients` 的行；30s tick 的 `replay_pending_group_file_acks` 仍会扫到它们（靠"已 received 就跳过"多半只是空转，但**行永不消失**，每次清空都往上叠） |
| `group_recalled_messages` | **7** 处 | 撤回账本留着已不存在的 msg_id；`is_recalled` 对同名 msg_id 仍返回 true ⇒ 若别处重投同一 msg_id，撤回路径会走 B1-F6 的"只查账本就短路"，把这条旧记录当成"已撤回" |

**这是"手抄清单会漂"的典型**：清表集合是人名一个个列的，而 schema 是另一处事实源，两者之间**没有任何判据**。加表时没人会记得回来加一行 ⇒ 新账本表默认成为"清除数据清不掉的东西"。

**不夸大的定性**：这不是数据丢失，也不会让用户看到错的状态；它是**清理不彻底 + 行慢慢累积**。所以判 P3，修复建议是**加守卫而不是改行为**。

**建议修法（最小，且是本仓最常做的事）**：
1. 在 `clear_all_data` 旁边加一条判据：从 `SCHEMA`（或 `sqlite_master`）现解析出全部表名，断言「每张表要么在清理集合里、要么在显式豁免表里且写了一句理由」。豁免表当前只该有 `friends`（通讯录）与 `settings`/`conversation_clocks`（键值与非群时钟，按 `LIKE` 局部清）。这样**加一张新表忘记登记就会红**。
2. 两张台账表按语义决定：清（推荐，它们属聊天数据的派生账）或显式豁免并写理由。若要保留 `group_recalled_messages`，需同时确认"撤销 B1-F6 的幂等短路"不会把旧账本当依据。
3. 计数不要手抄：判据里的"应清表数"由步骤 1 的解析结果现算，本仓第 8 步「文档硬数字对账」就是这个立场。

**爆炸半径**：`favorites.rs` 一处 + 一条 `node`/`python` 判据脚本（族里已有 `check-invariant-hooks` 一类现成的家，先找它）。不动 schema、不动协议。
**验收标准**：往 `SCHEMA` 临时加一张表（不登记进清理集合）⇒ 判据必须红；把清理集合里删一张 ⇒ 也必须红（双向）。复跑命令：

```bash
python3 - <<'EOF'
import re
schema=open("src-tauri/src/db.rs").read()
tables=sorted(set(re.findall(r"CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)",schema)))
src=open("src-tauri/src/commands/favorites.rs").read()
blk=src.split("for table in [",1)[1].split("]",1)[0]
cleared=sorted(set(re.findall(r'"([a-z_]+)"',blk)))
print("schema",len(tables),"cleared",len(cleared))
print("NOT cleared:",[t for t in tables if t not in cleared])
EOF
```

---

**B1-K4 · 「这位好友的公钥是哪一把」有两套读取次序，分叉期安全码仍会显示"一致"** —— 逐处读到：解密与 1:1 密封走 `sender_x25519_pubkey` 的**好友表优先、peers 回落**（`network/transport/e2ee_payload.rs:20-33`）；群密钥分发 `resolve_member_x25519`（`network/transport/peer_state.rs:42-51`，`pick_member_x25519 = peers.or(friends)`，顺序有测试钉住 `peer_state_tests.rs:47`）与界面安全码 `get_safety_number`（`commands/friends.rs:39-52`）走**peers 优先**。注释自己把后果写出来了：「**『双方安全码对得上』并不证明消息解得开**」（`e2ee_payload.rs:16-19`）。
**为什么仍判不修**：① 这个分叉有一个**已存在的补偿机制**——新候选密钥会被登记成 `PendingKeyRotation` 并 `emit("friend-key-changed")`（`network/transport/peer_registry.rs:39-51`），只对好友生效（非好友不许刷换钥横幅，`lib_friend_identity_tests.rs:423-425` 有断言），同一对候选去重；前端收进 `keyRotations`（`src/stores/useChatStore.ts:150`），聊天界面弹「同步新密钥 / 删除好友」横幅。所以"消息突然收不到"这一刻，用户**同时**看得到换钥横幅。② 加密次序（好友表优先）正是安全设计：`update_friend_pubkeys` 用 `COALESCE` **只填空、绝不覆盖**（`db/friends.rs:40-63`，理由写着"覆盖式写入会让一次伪造广播永久改掉好友真实公钥"），`replace_friend_pubkeys` 要用户显式确认 + Hello 自验签（`:65-80`）。把加密也改成 peers 优先，等于把这条信任锚点拆掉。
**残余（未修的那一小半，属可选改进）**：分叉窗口内安全码**仍显示"一致"**，因为安全码读的是 peers 里的新钥匙，而另一端的核验结果也会一致 ⇒ 唯一能提醒用户的是那条横幅，靠它自己在视线内。若将来要补，正确做法是**让安全码自己知道"存在待确认轮换"并显式标注**，而不是改加密次序。**不做**：按 稳定 > 可维护 排序，这条排在第八条之后，且需要动安全码的呈现口径（属产品决策）。

**B1-K5 · 「同一条消息在气泡与任务中心两种读法」** —— `sent`（字节已写出、对端未回执）在气泡上算完成（不再转圈）、在任务中心算"还有事没办完"（`blocked` + `waiting_ack`）。`src/utils/taskCenter.ts:137-148` 写明"两种读法是语义，不是漂移"，且两处共用同一个判定函数（现算：`isLiveTransferStatus` 的引用只落在 `taskCenter.ts` 与其测试两个文件）。**不修**：改成一种反而丢掉其中一个视图的有效信息。

---

## 撤回的六条（不要重复立案）

以下六条是我在取证第一阶段提出、随后被自己复验证伪的。写成这段是为了防止以后重新发现一遍。

1. **「取消更新无条件报成功」** — 错。`updater_cancel` 返回 `Result<(), String>`，`installing` 相位直接 `Err`（`src-tauri/src/commands/updater.rs:354-362`），`await` 抛出后落进 `runAction` 的 `catch → app.toastError`（`src/components/TaskCenter.vue:154-155`）。失败根本走不到那句 success。`updater.rs:653-657` 还有断言钉住，注释写明「取消必须在 installing 相位直接拒绝（前端不显示按钮是第二道，不是唯一一道）」。
2. **「`sent → done` 是 UI 谎报成功」** — 错。同一个 status 在气泡与任务中心有两种读法是写进注释的语义：`src/utils/transferState.ts:15-16`（气泡不转圈）与 `src/utils/taskCenter.ts:137-148`（任务中心问「还有没有事没办完」，`sent` 正是「等对方确认」那一格，`:161-167` 把它归成 `blocked`）。**等回执这件事用户看得见**，只是不在气泡上。
3. **「失败文件占位行只在内存、每次重开重新追加」** — 基本错。`src/stores/useChatStore.ts:2590-2608` 是 `sendFileAuto` **抛错**那条路：后端从未收到请求，本来就没有库行可写；注释写明目的是「不让消息永久停在 sending」，同段还 `toastError`。
4. **「后台会话状态不更新」** — 错，且是已被修过的历史缺陷。`src/api/index.ts:936-943` 写明两分类：只带 id 的事件回库重查、没在看的等 `openConversation` 每次拉 DB；**带结论的事件（`message-failed`）直接盖到缓存上、包含没在看的会话**，注释还记下了当年那一版的代价正是「后台会话依然什么都不更新」。
5. **「高亮 worker 的 Promise 会永久挂起」** — 半错。`src/utils/codeHighlight.ts:62-69` 的 `worker.onerror` 会把 `pending` 全量排空并降级到主线程。只剩「静默死亡且不触发 onerror」这一条假设，无凭据 ⇒ **不修**（不为不会发生的场景加处理）。
6. **「路由态与面板态双事实源」** — 不是新发现，是正在做的线：`6ca07ca5` / `39a7f216` / `c3b21b3c` 三笔都在收这条（`mainRoutes.ts:32` 的 `RouteView` 仍渲染 null）。本轮只做登记。

---

## 待补（B1 尚未审完的部分）

已立案 2 条，撤回 6 条。以下链路**还没有过门一**，不下结论：群成员级投递的部分成功与迟到 ACK、引用/转发/收藏/强提醒/多选批量、会话删除与历史边界、群待办与群公告、通知徽标计数、搜索、设置 11 节的写入与广播、以及呈现层浮层的取消权归属。
另外两类需要运行时才能定级的，已排在探针档：界面动作的行为级凭据（全仓零组件渲染测试）、以及 `useAppStore.ts:846-854` 那条 `beforeunload` / `visibilitychange` 落库兜底在真窗口销毁下到底会不会触发。
