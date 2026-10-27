# 闭环审计 · 注释承诺 ↔ 机器凭据对账表（B1）

**为什么要这张表**：本仓把大量设计决定与安全边界写在行内注释里。第一轮我按「读到代码像缺陷」立案，九条里六条被注释里已存在的兜底证伪（见 `closedloop-findings-2026-10-26.md` 末段）。所以真正决定「可验证」那一格是 PASS 还是 UNVERIFIED 的，不是代码在不在，而是**那句承诺有没有东西守着、守的东西能不能失败**。

判级口径：`已证` = 我复跑到真行为凭据（测试调用被测函数 / 我自己跑的读数）；`静态锚点` = 只有源码文本匹配在绿；`仅有注释` = 无任何机器凭据；`证伪` = 凭据与代码矛盾；`待复验` = 本轮未查到凭据，不下结论。
HEAD 基线 `6ca07ca5`，每条出处都在该 HEAD 重开文件复核过。

| # | 承诺原话（缩写） | 出处 | 我查到的凭据 | 判定 |
|---|---|---|---|---|
| 1 | 「新增不接界面的命令要红」 | `src/api/events.test.ts` | 我实跑 `node --test src/api/events.test.ts src/utils/mapContract.test.ts` ⇒ **17/17 通过，EXIT=0**；另用 `comm` 独立复算注册 161 / 调用面 160 去重，孤儿只 `get_topology`（`:375` 自declare 无 UI 入口） | **已证** |
| 2 | 「`installing` 相位不可取消——前端不显示按钮是**第二道**，不是唯一一道」 | `commands/updater.rs:349-362` | 唯一断言 `updater.rs:650-658` 是 `include_str!` + `contains("\"installing\"")` **文本匹配，从不调用 `updater_cancel`**；无共享常量；`phase` 跨 IPC 是 `types.ts:614` 的裸 `string`；前端另有 10 处同字面量 | **静态锚点** ⇒ 立案 **B1-F3**（P2） |
| 3 | 「三条边界：kinds **只有四种**，更新下载还没有完整台账，等它有了再进来」 | `src/utils/taskCenter.ts:22-25` | `OperationKind` 实际 6 个成员（`:33-39`）、`:272` `updaterRow()` 真造这行、`:353` 有 i18n key、`:374` switch 处理；`taskCenter.test.ts:341` 断言该行生成 | **证伪**（注释过期，代码对）⇒ 立案 **B1-F2**（P3） |
| 4 | 「`useDebounceFn` 的 `flush()` 只在真有待写入时执行……已由 `defer.test.ts` 的真值表钉住（库换语义 ⇒ 测试红）」 | `src/stores/useAppStore.ts:566-568` | `src/utils/defer.test.ts:87` 「cancel 丢弃待执行；flush 立刻执行且之后不重复」、`:104` 「无待执行时 flush 是空操作（不会凭空多写一次库）」——是对被测工具本身的行为断言 | **已证** |
| 5 | 「`isLiveTransferStatus` 是唯一判据，两处都只此一个函数，不许在组件里再推一遍」 | `src/utils/taskCenter.ts:137-148` | 现算引用：10 处引用只落在 `taskCenter.ts` 与 `taskCenter.test.ts` **两个文件**，无第三个推导点 | **已证**（按编译器/引用数现算） |
| 6 | 「转发 / 收藏的判据都从 `utils/messageKinds` 取（唯一一份），三处动作集合因此不会漂移」 | `src/components/message/MessageContextMenu.vue`（注释在 emits 表之后） | `src/utils/messageKinds.test.ts` 与 `src/utils/designGuards.test.ts` 都在引用面内（12 个文件用 `messageKinds`）；但我**没有逐条读这两个测试是否真的钉住「三处动作集合一致」** | **待复验**（有测试家族，覆盖内容未读） |
| 7 | 「SQLite 读写在阻塞池（INV-P34）」 | `commands/chat.rs:107` | 家族存在：`scripts/check-invariant-hooks.mjs` + `check-invariant-exceptions.mjs`，且它是快速层第 2/3 步 | **待复验**（未跑该步确认这一条在钩子分母内） |
| 8 | 「脱敏是**形状级**的，不是语义级；文件名与大小**故意保留**——传输类故障没有它就查不动」 | `src-tauri/src/diagnostics.rs:19-22` | 原文读到，是明确的知情取舍并写进导出包头；`redact()` 的形状清单有没有测试钉，本轮未查 | **仅有注释**（作为取舍成立；作为凭据待查） |
| 9 | 「协议里没有 cancel 帧 ⇒ 这一趟清扫治的是**永久**泄漏，不是界面 spinner（延迟是有意的）」 | `src-tauri/src/lib.rs:633-636` | 取舍陈述本身在原文成立。但**前半句我还没证**：用户主动取消是否真的发 `FileCancel` 帧与这句话并不矛盾（一个指发送方超时/断开的放弃，一个指用户点取消），我没读协议层确认边界 | **待复验**（划归 B2，别照抄这句当结论） |
| 10 | 「`openConversation` 每次都拉 DB，已实测」 | `src/api/index.ts:939` | 「已实测」三个字后面**没有**测试名、段名或轮次号；本轮未找到对应凭据 | **仅有注释** |
| 11 | 「后台会话靠带结论的事件覆盖，不挂在重查那一类上」（附当年代价说明） | `src/api/index.ts:936-943` | 分类写法与 `message-failed` 监听（`:944`）在读到的源码内自洽；行为层是否有轮次覆盖未查 | **已读原文**，行为层待查 |
| 12 | 「单文件超过 512 KB 即轮转」「轮转后保持 owner-only 权限」 | `src-tauri/src/logging.rs:31/140/1070` | `logging.rs:1715` `logger_persists_to_file_and_rotates`、`:1638` `rotated_logs_keep_owner_only_permissions` 是对真实文件的读写测试 | **已证**（上限与访问控制确有凭据） |
| 13 | 「迟到 Ack 只更新行（`LateApplied`），消息停在 cancelled/partial_cancelled（INV-P26）」 | `src-tauri/src/db/group_offline_queue.rs:48` | `cascade_tests.rs:1188-1203` 真的调 `ack_group_delivered` 并断言返回 `LateApplied` 且 `messages.status` 仍是 `cancelled`（「取消是硬终态」）；`:1336-1339` 断言 failed 行上的迟到 Ack 也只记账 | **已证** |
| 14 | 「Ack 的语义是『已成功接收并持久化』；打不开就既不落库也不 Ack ⇒ 补发时用最新公钥重新密封」 | `src-tauri/src/network/transport/handle_messaging.rs:91-98` | 前半句与实现一致（`:99-106` 解密失败直接 `return`，无 Ack、无落库）；后半句的「重新密封」在 `e2ee_payload.rs` 的 `reseal_for_send` 族，本轮**未逐行读到**「拿不到公钥就按原样补发」与「msg_id 不变」这两点 | **半证**（前半已证，后半待读） |
| 15 | 「重复投递也要回 Ack，否则一次丢 ACK = 发送方永远『发送中』」 | `handle_messaging.rs:64-69` | 实现在位并带 `[ACK] 重复消息仍回执` 日志；有 `dispatch_tests` 覆盖去重三态 | **已证**（行为实现 + 测试家族在，具体断言未逐条读） |

## 读数（对账进度，现算）

- 本表已登记 **15** 条承诺（编号 1–15）：**已证 6**（#1 #4 #5 #12 #13 #15）、**静态锚点 1**（#2）、**证伪 1**（#3）、**仅有注释 2**（#8 #10）、**待复验 3**（#6 #7 #9）、**半证 1**（#14：前半已证、后半待读）、**源码自洽但行为层待查 1**（#11）。计数命令：`grep -oE '^\| [0-9]+ \|' docs/notes/closedloop-claims-2026-10-26.md | wc -l`。
- 由 #2 与 #3 直接立案 **2 条**（B1-F2、B1-F3）。
- 诊断面总量（B4 全量清点的分母）：具名 `code=` **87** 个；日志调用 **363** 处（`error` 81 / `warn` 129 / `info` 153）。

## 大白话：这张表在说什么

这个仓的注释写得比大多数仓认真得多，几乎每个决定都写了「为什么」。问题是**注释本身不是锁**。#2 和 #3 就是两种典型的失效方式：#3 是注释跟不上代码（现在写着"只有四种"，实际六种）；#2 更危险——有一条测试长得像守卫，名字也叫 `install_phase_is_not_cancellable`，但它只是在源码文本里找那两个字符串还在不在，**从来没真的调用过一次取消**。所以真要有人改坏那个相位判断，测试照样绿。

`#10` 那句「已实测」我全仓找不到对应的实测记录，属于"谁都不记得是谁测的"那一类——按你的口径，这种不能算已验证。
