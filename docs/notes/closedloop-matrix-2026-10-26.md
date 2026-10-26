# 闭环审计 · 矩阵（B1 进行中）

HEAD `6ca07ca5`。取值：`PASS` / `PARTIAL` / `FAIL` / `UNVERIFIED` / `BLOCKED` / `不适用(理由)` / `待审`。
**不适用 ≠ 通过；UNVERIFIED 与 BLOCKED 不计入通过率。** 每格必须有证据指针（`path` + 符号），行号会漂，落笔时已按该 HEAD 复核。

域轴说明：`domains.data.mjs` 的 11 域**不是完整文件分区**——`commands/` 是登记的装配层、`presentation` 覆盖整个 `src/`（见 findings 的 B1-K1）。因此这里的域是**业务语义分类**。

## 一、已走完六格的行

| FID | 动作 | 可执行 | 可打断 | 可恢复 | 可感知 | 可验证 | 可诊断可追溯 | 总判级 |
|---|---|---|---|---|---|---|---|---|
| F-MSG-014 | 取消一条还在排队的 1:1 消息 | PASS `chat.rs:98-126` 校验发起者/会话/自聊，结构化返回 `MessageCancelResult{outcome,delivered,remaining,was_written}` | PASS 终态由**数据库**裁定：`db::MessageCancelOutcome` 三态 `Cancelled/AlreadyDelivered/NotFound`（`chat.rs:136-155`）⇒ 取消与送达竞态有唯一赢家，且竞态输了说「已经传完」 | 待审（取消即终态；崩溃窗口未查） | PASS `cancelFeedback.ts` 六档人话 + `cancelFeedback.test.ts:31/35/42/49/53/57` 逐条钉 | PARTIAL 反馈层有测试；命令结局是否被 Rust 测试覆盖**未查** | **FAIL** 1:1 分支零日志（`chat.rs:181` `_ => {}`），`db/messages.rs:729/732` 静默返回 ⇒ **B1-F1** | **PARTIAL** |
| F-MSG-015 | 取消一条群消息（按成员台账取消剩余成员） | PASS `chat.rs:130-133` 走 `cancel_queued_group_message` | PASS `partial_cancelled` 是一等结局；`delivered/remaining` 按成员算 | 待审 | PASS `messageCancelNotice(res)` `TaskCenter.vue:168-174`，文案与气泡菜单共用一份 | PARTIAL 群侧取消有 `-lie` 轮次（`docs/acceptance/stability-smoke-matrix.md`，**新鲜度待比对**） | PASS `code=GROUP_CANCEL msg_id=… delivered=… remaining=…`（`chat.rs:171-178`）——**同函数内 1:1 与群不对称，正是 B1-F1 的证据** | **PARTIAL** |
| F-PRE-003 | 任务中心：行的生成与八个动作 | PASS 八个 `OperationAction` 全部映射到今天就存在的命令（`taskCenter.ts:44-64`），文件头第 3 条明确「动作只能是对已经存在的命令的引用——界面上一个点了什么都不会发生的按钮，比不给按钮更糟」 | PASS 取消下发动作真调命令（`TaskCenter.vue:142-159` `runAction` 一处 `busy` 门 + `try/catch/finally`，杜绝重复提交与卡住的按钮态） | 不适用(理由)：本层刻意**只出未完成任务**（`taskCenter.ts:19-21`），终态由气泡与 toast 说话；无历史视图是登记的边界而非缺失 | PASS 状态归一三档 `queued/running/blocked` + `blockedReason` 九个稳定短码，**未知码不上屏机器码**（`transferState.ts:62-82` 注释与实现一致） | PASS `taskCenter.test.ts`（含 `:341` `update_download` 行、`:349` 七档 phase 遍历） | **FAIL** 取消结局不留痕（并入 **B1-F1**）；另边界注释已过期（**B1-F2**） | **PARTIAL** |
| F-PLF-007 | 取消一次更新下载 | PASS `updater_cancel` 存在且被调用（`TaskCenter.vue:236-240`），取消后 `refreshUpdaterStatus()` 回真源补拉 | **PARTIAL** 不可逆边界**存在但无守卫**：`installing` 相位拒绝（`updater.rs:354-362`）依赖两处手抄字面量 ⇒ **B1-F3** | 不适用(理由)：更新器状态纯内存、检查与下载均用户主动，重启重走成本为一条命令 ⇒ 记 **B1-K2** 保留 | PASS 失败会抛进 `runAction` 的 `catch → toastError`（我第一轮误判为「无条件成功」，已撤回） | **FAIL** 唯一断言 `updater.rs:650-658` 是 `include_str!` + `contains` 文本匹配，**从不调用被测命令** ⇒ **B1-F3** | **FAIL** `code=` 词表无 `UPDATER_CANCEL` ⇒ 并入 **B1-F1** | **PARTIAL** |
| F-PRE-011 | 改设置（主题 / 语言 / 中继策略 / 绑定网卡 / 聊天样式） | PASS setter 先视觉生效再 `persistSoon()`（`useAppStore.ts:638-639`，连续拖动用去抖、非连续直写） | 不适用(理由)：去抖合并不是「取消」语义，`cancel` 丢弃待执行已由 `defer.test.ts:87` 钉住 | **PARTIAL** 时序风险已兜住（`:846-854` 两个 flush 出口 + `defer.test.ts:104`），但**写入真失败时无回滚**；且 flush 出口本身在 Tauri 窗口销毁下是否触发**无凭据** | **PARTIAL** 失败无任何提示；界面恒显「已应用」 | PARTIAL `defer.test.ts` 有凭据；「失败」这一路零测试 | **FAIL** `catch {}` 不记日志 ⇒ 诊断包与日志都查不到这一笔 ⇒ **B1-F4** | **PARTIAL** |
| F-OBS-002 | 前后端契约双向对账（161 命令 / 事件面） | PASS 门面唯一：`IPC 只能从 src/api 门面走`（含「6 条命令在 api 上根本没有包装」的回归） | 不适用(理由)：这是判据不是用户操作 | 不适用(理由)：同上 | 不适用(理由)：同上 | **PASS（我实跑）** `node --test src/api/events.test.ts src/utils/mapContract.test.ts` ⇒ **EXIT=0，17/17**；另独立 `comm` 复算：注册 161 / 去重调用名 160，孤儿仅 `get_topology`（`events.test.ts:375` 自declare 无 UI 入口） | PASS 命令名与注册表逐条对账、「门面之下不许留没人引用的包装」都是现成判据 | **PASS** |
| F-OBS-003 | 诊断面：错误分类 / 上限 / 脱敏 / 访问控制 | 不适用(理由)：非用户动作 | 不适用(理由)：同上 | PASS 单文件 512 KB 轮转（`logging.rs:140/1070`），有真文件读写测试 `logger_persists_to_file_and_rotates:1715` | 部分：日志窗口有独立 entry（`logs.html` + `src/entries/logs.ts`），用户可查 | **已证**（上两行测试名 + 我跑通的对账族） | **PARTIAL** 具名 `code=` 共 **87** 个、日志调用 363 处（error 81 / warn 129 / info 153），覆盖面广；但**关键操作结局缺码**（B1-F1）；脱敏是形状级（`diagnostics.rs:19-22`，作者自述并保留文件名/大小以便查传输故障）⇒ 隐私与可查性是**登记过的取舍** | **PARTIAL** |

## 二、读数

现算（命令：`grep -c '^| F-' docs/notes/closedloop-matrix-2026-10-26.md` ⇒ **7**）：已走完六格 **7** 行，其中 **PASS 1**、**PARTIAL 6**、不适用若干；立案 **4** 条（**P2 两条** = B1-F3、B1-F4；**P3 两条** = B1-F1、B1-F2），保留为有意取舍 **3** 条（B1-K1…K3），撤回 **6** 条。计数复核：`grep -oE '^## B1-F[0-9]+ · .*（P[0-3]' docs/notes/closedloop-findings-2026-10-26.md | grep -oE 'P[0-3]' | sort | uniq -c`。

**本文件的引用不受任何守卫保护**（实况见主报告「我自己的两处错」第 2 条：`check-doc-citations.mjs` 管 `file:line` 的那条只吃 `LIVE_DOCS` 那 8 份，`docs/notes/**` 不在内）。所以行号会随改动静默腐烂。二选一，**本审计不新建脚本**（按仓里「新判据先找现成的家」与自己编的规矩要撤）：

- 要它长期不腐烂 ⇒ 由你把主报告名加进 `check-doc-citations.mjs` 与 `check-doc-numbers.mjs` 的 `LIVE_DOCS`（各 1 行改动），代价是每次改代码都可能顶红快速层第 9 步；
- 不加 ⇒ 接受这是一份**带日期的快照**，与本仓对 `docs/notes/*-<日期>.md` 的既有立场一致，复核时按下方命令现验：

```bash
# 现验本矩阵引用的 path:line 是否还在真文件真行范围内（只读，逐条打印越界项）
node -e '
const fs=require("fs"),p=require("path");
const txt=fs.readFileSync("docs/notes/closedloop-matrix-2026-10-26.md","utf8");
const bad=[];
for(const m of txt.matchAll(/(?:^|[^\/\w])((?:src|scripts|docs)[\w\/.-]*?\.(?:rs|ts|vue|mjs|json|md)):(\d+)/g)){
  const f=p.resolve(m[1]); let n=0; try{n=fs.readFileSync(f,"utf8").split("\n").length}catch{bad.push(m[1]+" (文件不存在)");continue}
  if(+m[2]>n||+m[2]<1) bad.push(m[1]+":"+m[2]+" 超出 "+n+" 行");
}
console.log(bad.length?"✗ "+bad.length+" 处失效：\n  "+bad.join("\n  "):"✓ path:line 引用全部有效");
'
```

**这 8 行不等于 B1 审完。** B1 的分母是 161 条命令里挂到 messaging / presentation 的那一部分 + 392 个触发挂点去重后的动作数，已枚举出动作族（消息右键 17 项、气泡 12 项、会话菜单 3 项、好友菜单 3 项、头部导航 7 项、编辑器 6 项、任务中心 8 项、群命令 11 项、收藏 9 项、通道与缓存 9 项），下表是**剩余待审队列**。

## 三、B1 待审队列（每行注明缺哪一格）

| 族 | 待审内容 | 主要缺的证据 |
|---|---|---|
| 消息操作 | 引用 / 转发 / 收藏 / 强提醒 / 多选批量 / 复制保存图片文件 / 定位原消息 | 六格全缺；`MessageContextMenu` 17 个 emit 与 `MessageItem` 12 个 emit 的**后端落点**未逐条追 |
| 1:1 主链 | 发送、已读回执、撤回、重发 | 状态机转移表未画完；重发的二次确认与「取消与 ACK 竞态」在 Rust 侧的归属未读 |
| 群 | 建群 / 邀请 / 移除 / 移交群主 / 群公告 / 群待办 / 成员级投递与补发 | 部分成功与迟到 ACK 的终态归属；`some_delivered` 的表达是否等于「部分成功」 |
| 会话 | 删除会话 / 清空数据 / 置顶 / 历史边界 | 删除的不可逆边界与二次确认；清空后的跨窗口广播（`events.test.ts` 有「清空数据必须广播」这条测试，需确认覆盖面） |
| 呈现层 | 浮层返回键栈、`RouteView` 与 pane 双事实源、窄窗移动端 | 属你正在做的线（`6ca07ca5`/`39a7f216`/`c3b21b3c`），本轮只登记 |
| 设置 | 11 节各写入项的**分域**验收（F-PRE-011 只覆盖了共用的那条写入通道） | 每项设置失败是否都走同一 catch；哪些项影响网络行为需要更高要求 |
| 搜索 / 收藏 / 链接 | 命令与落库面 | 六格全缺 |

## 四、错误链表（六项标准里「可诊断」的专用视图）

| 错误路径 | 产生 | 分类记录 | 安全处理 | 用户反馈 | 诊断查询 | 恢复或终止 | 留痕 | 判级 |
|---|---|---|---|---|---|---|---|---|
| 1:1 消息取消竞态（已送达） | ✓ | **✗ 无码无日志** | ✓ DB 单一裁定 | ✓ 六档人话 | **✗** | ✓ | **✗** | FAIL（B1-F1） |
| 群消息取消 | ✓ | ✓ `GROUP_CANCEL` | ✓ 台账按成员 | ✓ | ✓ | ✓ | ✓ | PASS |
| 取消更新（installing） | ✓ | **✗ 文本断言代替行为断言** | 部分（字面量耦合） | ✓ | **✗** | ✓ 拒绝并保留现场 | **✗** | FAIL（B1-F3） |
| 设置落库失败 | ✓ | **✗ 零记录** | **✗ 界面不回滚** | **✗** | **✗** | ✗ 静默回旧值 | **✗** | FAIL（B1-F4） |
| 崩溃留下 sending/active 行 | ✓ | ✓ 四条启动对账各带具名失败码（`state.rs:1786/1799/1817/1832`，如 `OUTBOX_ORPHAN_RECOVERED` / `TRANSFER_INTERRUPTED_RECOVERED`） | ✓ | 部分（落 failed 后气泡说话） | ✓ | ✓ | ✓ | **PASS**（这是本仓做得最好的一族） |
| Worker 高亮失败 | ✓ | ✓ `onerror` 全量降级主线程（`codeHighlight.ts:62-69`） | ✓ | 不适用(理由)：降级对用户是无感的正确行为 | 待审 | ✓ | 待审 | 待审 |
