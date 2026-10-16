# 群信息同步：新成员自动拿到群里的聊天与群任务（2026-10-16）

负责人一句话需求（原话，含其中打包的几条硬不变量）：

> 新需求，就是群信息同步，就是群里的聊天，群任务，可以同步给其他新进群的人员，自动同步，
> 从群里面成员中群信息最早最全的那个人同步过去，全程自动执行。无感体验。同步中，可以有提示。
> 别让用户感觉到卡顿。

拆成可判的六条，以及每条落在哪儿：

| # | 需求里那句 | 落点 | 今天能跑判据的那一句 |
|---|---|---|---|
| 1 | 群里的聊天 + 群任务 | `db::apply_group_history_page` 落 `messages` 行（群任务就是 `kind IN ('todo','todo_update')` 的行，另有 `group_files` 台账） | `cargo test --features bluetooth --lib group_history` |
| 2 | 同步给**新进群**的人员 | 两个入群入口各喊一声（`handle_group_key` 与 `gossip.rs` 顺手建群那一路），条件都是"本机第一次建这个群的记录" | `both_membership_entry_points_trigger_the_sync_behind_a_first_membership_guard` |
| 3 | 从**最早最全**的那个人同步 | `group_history::pick_history_source`：先比 `oldest_seq`（最早），再比 `total`（最全），最后按 id 定序 | `earliest_beats_a_peer_with_more_messages` + `same_start_prefers_the_more_complete_peer` |
| 4 | **全程自动**执行 | 入群那一刻起跑 + 每 60 秒的清扫任务（`spawn_group_history_sweeper`）；标记只在整趟收口后写成 `done` | `the_group_history_sweeper_is_wired_exactly_once_at_startup` + `the_done_marker_is_written_only_after_the_whole_run_completes` |
| 5 | **无感**体验、同步中**可以有提示** | 非模态细横幅（`ChatWindow.vue` 读 `chat.groupHistorySync`），`role=status aria-live=polite`，不弹窗、不挡输入框 | 见本文第六节（无运行时判据，只有真机眼睛能判观感） |
| 6 | 别让用户感觉到**卡顿** | 取数与落库都在 `spawn_blocking`；页间让出 120ms；应答帧走调度表 **Low** 档；前端重查节流 1.5s | `a_history_page_is_classified_low_so_chat_is_never_starved` |

## 一、"最早最全"为什么不能靠猜角色

需求要的是"群信息最早最全的那个人"。而**没有任何一台机器知道别人家里有什么**：
`group_members` 只有 `(group_id, device_id)`，没有 `joined_at`，也没有"谁存了多少历史"的读数。

所以不能写成"找群主"。三条真实的失配场景：群主换过设备（新机是空的）、群主长期离线、
某个成员清过这个群的聊天记录（他的 `clear_boundary` 之上的历史比群主的还新）。

做法是**问一圈读数**：新成员向每个"在线、有直连、且升级到本特性"的成员发一次
`group_history_request{limit: 0}` —— 那一型只要摘要、不要正文（`total` + `oldest_seq` +
`newest_seq`，一个空页，不含任何内容）。拿到各家读数后按 (最早, 最全, id 定序) 三档选一台。

为什么值得为它多花一轮帧：这一条判据把需求里那句"最早最全"从**猜**变成**实测**，
而且不需要第三个帧形状（探测与取页共用 `group_history_request`，靠 `limit=0` 分型）。

## 二、帧：两帧就够，不多开第三个

- `group_history_request { request_id, from, to, group_id, after_seq, after_id, limit }`
- `group_history_reply { request_id, from, to, reply: GroupHistoryReplyBody }`

正文（一页消息 + 这一页涉及的群文件台账）封在 `reply.sealed` =
`base64(群密钥 ChaCha20-Poly1305(JSON))`。选群密钥而不是 X25519 双向密封，是因为
应答的是**群里共有**的内容，口径与 `GroupFileOffer.sealed_file_key` 一致；
链路上另有 Hello 验签那层身份保证（INV-P21）。

分页用 keyset（`WHERE (seq, id) > 游标`）而不是 `LIMIT/OFFSET`：分页期间源机自己还在往这个
会话写新消息，`OFFSET` 会在两页之间整体错位 —— 轻则同一条给两遍，重则**漏一条**，
而漏掉的那条在界面上没有任何痕迹（新成员只会以为"这个群本来就说到这儿"）。
`seq` 是全序权威、`id` 破同 seq 的平局（与 `db/messages.rs::get_latest_messages` 同一口径，INV-P09）。

预算的两个数只有一个家（`protocol.rs`，INV-P23）：`GROUP_HISTORY_PAGE_ITEMS = 200` 条与
`GROUP_HISTORY_PAGE_MAX_BYTES = 1_500_000` 字节，先到哪个算哪个，但**至少给一条**
（否则一条超长消息会把这一页永远推不动 —— 活锁）。

### 与既有帧的关系（为什么不是复用而是新增）

`ContentRequest`（按 cid 取一份文件）与 `ShareTreeRequest/Response`（`request_id` 一问一答）
是两个先例：本特征的**应答通路**照抄后者的 `request_id + oneshot` 形状，
**授权**照后者的"拥有即授权"思路但判据不同（见下一节）。它们都取不回一段聊天历史，
所以历史这一半必须新增两帧。`PROTOCOL_VERSION` 不 +1：加新帧类型由能力位门控，
不是破坏性变更（INV-P24、ADR-0007 决策 1）。

## 三、授权：为什么没有复用 `content_serve_allowed`

`transport/handle_share.rs::content_serve_allowed` 是"谁能从我这里取走这份内容"的那个家，
它第一支是 `if is_friend { return true }`。**这一支对群历史是错的**：
群历史属于群，一个不在群里的好友照那一判就会被放行，而按 cid 取文件时"好友就是授权"
是 ADR-0019 的既定语义。两件事的授权语义不同 ⇒ 判据必须是两个（同类先例：
1:1 与群的 kind 容忍度不是一件事，见 `CONTENT_FEATURE_FLEX_DM_KIND` 那段）。

新的判据是 `group_history::serve_allowed`，四格全真才给：
① `from == 这条链路的对端`（防冒名）② `to == 本机` ③ 请求方在**本群成员表**里
④ 本机持有该群密钥（密封用的就是它；被踢之后密钥被撤销 ⇒ 这一格自动关）。
四格各有一条单独反证，其中"不在群里的好友"那格是相对 `content_serve_allowed` 的**收紧**，
刻意写成用例钉住，防止下一个人"顺手统一成同一个判据"。

## 四、落库：与实时接收刻意不同的三处

`db::apply_group_history_page` 是新成员这一侧唯一的写入点。它与
`transport/gossip.rs` 那条实时路径共享 `insert_message_if_new` 的三态裁决与
`group_message_blocked_by_boundary` 的水位，但有三处**必须**不同（改动时不要"顺手统一"）：

1. **`ts` 用源机那一行的值**。实时路径 `let ts = db::now_ms()` 是对的（"我看到这条的时刻"），
   历史照抄就把 800 条旧消息全标成"刚刚"，时间线直接失真。
2. **`kind` 原样取，不走 `display_kind()`**（后者把 `video`/`audio` 折成 `file` 给界面用）。
   走了就会让"同步来的这条"与"实时收到的同一条"在库里成两种 kind（违反 INV-P08 那条
   "direct + gossip 是同一逻辑消息"的口径）。
3. **未读恒 0、已有会话行不动 `last_ts`**。同步 800 条不该变成 800 条未读红点；
   也不该把一个用户正在处理的会话顶到列表最前。会话行只在**本机还没有它**时由这次
   聊天活动建出来（这与"群关系同步不得创建会话"那条既有不变量不冲突 ——
   那条管的是只同步群资料的情况，这里是真的落消息行）。

另外两格与既有纪律同源：
- **群任务编号**：`todo_number_high_water` 本来就扫消息行，所以同步来的 `#N` 自动进高水位；
  但源机**已删除**的那些任务行在本机看不见 ⇒ 应答额外带 `todo_high_water`，
  本机据此抬地板（`raise_todo_number_floor`，只抬不降）。INV-P29 说编号永不复用。
- **撤回**：源机的行已经是 `kind='recalled'` 的物化形态，原样搬；本机若另有墓碑
  （`group_recalled_messages`），落库前照 `is_recalled` 判一次，不把正文复活。

## 五、"不卡"具体落在哪几个动作上

- 取数、密封、落库三段：查库与落库在 `spawn_blocking` 内（那里握的是全仓唯一那把 `db` 锁），
  而 **JSON 序列化 + AEAD + base64 在锁外**做 —— 一页最多 1.5MB，
  但"慢活握着全局锁"这个形状本身就是 INV-P34 已经数到十二家的同一个根因。
- `emit_progress` 一律在 db 锁**之外**调用（INV-P25；`scripts/check-lock-scope.mjs` 也扫这一族）。
- 页间 `sleep(120ms)` + 应答帧走调度表 Low 档 ⇒ 聊天与文件分片随时能把它打断（INV-P20）。
- 前端只在"正打开着这一群"时重查消息，且最多每 1.5 秒一次；`done` 那一发不受节流。
  不节流的表现是每秒约 8 次整会话重查，每次跨进程抢那把锁 —— 后台补账就会变成手上的卡顿。
- 在飞闸 `AppState::group_history_active`：入群钩子、群消息建群、清扫任务三处喊同一声，
  没有它同一个群会同时排两三趟，各要一遍同样的历史（结果一样、开销翻倍）。

## 六、提示这一格有多少证据（如实登记）

**数据面**今天有跨进程判据：`--round=ghsync`（两台真进程，本步 14 条断言；「轮次账」按整趟 32 条记，
挂在发版前那一层 `npm run verify:release`）。它判的就是本文第四节那几格最容易写反的保真事实 ——
显示时间取自源机、卡片里的本机路径被剥掉、群任务那行的 kind 与编号、会话行建出来但未读为 0、
本机时钟被抬到历史之后、标记从 pending 收成 done —— 加上三条归因（A 有"交出一页"、B 有"同步收口"、
A 自己没有"收口"那一行）。反证档 `--round=ghsync-lie` 按 harness 既有口径**等待用真 id、判据读翻过的 id**，
实测恰好 5 条红、其余 9 条照绿（两面 run 目录记在 `docs/acceptance/stability-smoke-matrix.md` 顶部「轮次账」那条里）。

**界面上那条横幅仍然没有运行时判据**：今天能对它做的只有静态一致 —— 类型
`GroupHistoryProgress`、`src/api/index.ts` 的 `listen` 一行、`src/api/events.test.ts` 的
双侧自动扫描（emit 用常量也算得出名字，它读 `const NAME: &str = "..."` 那张映射表；
有 emit 必须有 listener，那条是本仓的零容忍），以及 i18n 两册键集合一致
（`src/i18n/index.test.ts`）与"截断的文本必须带 title"那条设计判据（`utils/designGuards.test.ts`，
本轮实测踩过一次：横幅里那句 `truncate` 文本没给 title 就直接红在第 16 步）。
**观感与"看不出卡顿"必须由负责人真机判**：横幅的措辞、数字前进的节律、以及消息增量出现时的表现。
本仓没有任何一层会替这几点作证 —— 也别拿"数据面轮次全绿"去替它作证，那是两件事。

## 六·补、手动那一格：老成员也能自己点一下（同日追加需求）

追加的原话是："这个人已经加进来，但他的信息有几条是老版本同步的、现在信息不全，我需要有一个按钮，
所有群成员也有一个按钮，从群好友里最全的那一套拉；如果最全的人自己点了，他扫描完发现他自己最全，
只会补充一些没有的或者错过的信息……每个人都有一个这样小的同步按钮，按钮可以不要太明显，但要有这个功能。"

拆成四条可判的：

| 那句口语 | 落点 |
| --- | --- |
| 所有群成员都有这个入口 | 后端 `request_manual_sync` **不受** `should_sync_group` 那道"只认 pending"的闸管（那道闸划的是"升级后不许满屏开始拉"，见 §七·3；手动点一下是用户自己给的许可） |
| 从最全的那一套拉 | 复用常规那趟，不新第二种搬运形状：还是问一圈摘要 → 按 (最早, 最全, id) 选一台 → `(seq, id)` 分页 |
| 自己最全 ⇒ 只补缺的/错过的 | 常规那趟游标起点本来就是 `after_seq = -1`（全量重扫），落库按 `msg_id` 幂等 ⇒ 已有行全部认成"重复"、一条不动，只有缺的那几条进库。**没有**"我最全就别问了"这种本地捷径：别人手里有没有本机缺的那几条，只有问过一次才知道（与 §一 同一个理由） |
| 按钮不要太明显，但要有功能 | 群按钮那一族的最后一枚，`opacity-70` + 同一套 ghost 样式；跑起来时图标换成转圈。真正"有功能"这件事由接线判据兜住（见下），不靠观感 |

四种裁决（`ManualVerdict`，短码是前端选文案的唯一依据）：`started` / `already_running` /
`no_source` / `no_group`。**四种都要有一句**，这里翻过一次车并留字为证：我先写的是
"`started` 不弹提示，因为按钮自己会变成转圈、横幅会跟着动"——**那个理由是假的**。转圈与横幅都只在
**第一条进度事件**到达之后才存在，而跑一趟的顺序是"先向最多 8 台各问一次摘要（每台最长 4s）
→ 才取第一页" ⇒ 点下去到横幅出现之间有一段**界面上什么都没有**的窗口；需求原话是"同步中，可以有提示"，而这段窗口的用户读数是"我按了一枚没反应的图标"⇒ 连点。现在 `started` 也弹一句（一句 transient 提示，不是弹窗、不阻塞）。其余三种共同的形状是"点了之后屏幕上什么都不动"，没解释就等于按钮坏了。
`no_source` 时标记照写：这一趟没人可问不等于这一群不缺历史，清扫任务（§五）会在有人在线时补上。

★ 手动那一格**继承自动那一格的失败重试形状**，这条得写明白（它不是"点一下就完事"）：
一趟只在**完整跑到底**时才把标记收成 `done`，中途任何失败或"没有可用来源"都让标记留在 `pending`
⇒ 那把 60 秒清扫任务会再来问，直到跑成、或这个群被删（`delete_group` 连标记一起删）。
代价是**每趟**有界（探测 ≤8 台 × 4s、源 ≤4 台、页 ≤1000 趟，见 §七·7），但本机**没有"连败几天就停"这一档**，
也**没有指数退避**。所以：成员表里若有一台"认得这一帧却每次都答不上来"的对端，这台机器会为那一群
每分钟重问一次。手动点一下既不增加也不减少这个循环 —— 要不要加"连败就停"归负责人拍板，
因为它改的是**自动那一格共用**的语义，不是这一颗按钮独占的行为。

**这一格有多少证据**（逐条具名，全部真跑过）：

- Rust 裁决表 —— `the_manual_button_is_a_decision_table_not_a_second_shape`（四格互斥可达 +
  `no_group` 必须压过"在飞" + 短码串逐字钉住）。
- Rust 接线 —— `the_manual_entry_shares_one_marker_home_and_one_spawn_gate`：
  写 pending 只有**一个**家（`mark_history_pending`，两个入口共用）、起跑出口还是 `spawn_sync`、
  命令注册一次、`request_manual_sync` 除命令外没有第二个调用者。
- Rust 行为 —— `a_second_full_pass_fills_the_hole_and_touches_nothing_already_there`
  （缺的那条补上、已有那一行逐字不动、本机时钟不被压回）+ 既有的
  `applying_the_same_page_twice_inserts_once`（自己最全 ⇒ 第二趟 `(inserted, duplicate) = (0, N)`）。
- 前端 —— `storeContract.test.ts` 里"群历史按钮的 emit 必须有调用方接住，一路到命令名"
  （含一条"把调用方那一行摘掉"的非空转对照——组件之间那一跳**原本没有任何家**，
  漏接的表现正是"编译过、类型过、门禁全绿，而功能是一个零"）。
  另外四道现成的家一起覆盖它：`chat.*` 引用必须在 store 里导出、命令必须有前端调用点
  （`events.test.ts`）、命令注册表必须与 `docs/ARCHITECTURE-MAP.html` 的 `CMDS` 双向相等
  （`mapContract.test.ts`）、纯图标按钮必须有 `aria-label`（`a11yLabels.test.ts` 全库扫描）。

## 七、已知边界（不是待办里的隐瞒）

1. **只从有直连链路的成员取**。跨跳借道搬整段历史没做：一页 1.5MB 的帧经第三方转一跳
   要吃双份链路预算，而局域网场景里"群里总有直连成员"几乎总成立。
   找不到直连候选时这一趟判 `NoSource`、标记保持 `pending`，清扫任务每 60 秒再来看。
2. **群文件的字节不代拉**。同步只搬卡片行与 `group_files` 台账（名字/大小/哈希/归属），
   源机那份本地 `path` 在上 wire 前被剥掉（否则对面预览一个本机不存在的路径）。
   要点开哪个文件，走既有的 `ContentRequest`（受众闸 `content_serve_allowed` 认群成员，
   新成员本来就有权拉）。
3. **老群不动（自动那一路）**。只有入群时明确写过 `pending` 标记的群才会被扫到（§六·补 那个手动入口是唯一的例外：它由用户自己按下，不受这道闸管，但仍照写同一枚标记）
   （`should_sync_group(None) == false`）。这一条划的是"这轮只服务新进群的人"与
   "升级后满屏开始拉历史"之间那条线。
4. **`#77` 那套补递照旧**。`mesh/gossip_replay.rs` 的窗口（每组 16 条 / 10 分钟）
   与进程内缓存没改；它是"尽力补递掉线期间的最近几条"，本特征是"新成员拿整段历史"，
   两件事不互相替代。
5. **同步来源的可靠性以群密钥为准**，不是以成员表快照为准：一台持群密钥但**已不在**
   本机成员表里的对端，会被 ③ 那格拒服务（拒得对）；反过来一台在本机成员表里、
   但已经不持有密钥的对端，问了也解不开（它自己会拒）。
6. **一群的群文件台账第一页只带前 `GROUP_HISTORY_PAGE_ITEMS`(=200) 行**，超出的行数会被服务端
   数出来写进日志（`群历史交出一页 … 台账另有不带 N 行`）而**不再补**：那一行台账只服务
   "气泡上的投递名册/摘要"，缺了它卡片照样显示（名字/大小/哈希在消息正文里），
   文件字节仍可按 cid 从任何持有者拉。要把这一格做全，需要给台账单独一条游标 ——
   那是另一件事，本轮刻意不做，也不要读成"群文件同步已完整"。
7. **反复失败的代价是有的、但有界**：源机一直答、而本机每次解不开时，一趟最多换
   `GROUP_HISTORY_MAX_SOURCES` 台、每页最多 `GROUP_HISTORY_PAGE_ITEMS` 行，
   标记保持 pending ⇒ 清扫任务每 60 秒再试一趟。没有指数退避（今天还没有实测到的
   洪水现场；先记在这里，别等到出问题才想起没做）。

## 八、复跑清单（本文每条硬数字都能这样现算）

手动那一格（§六·补）：

```bash
cd src-tauri && cargo test --features bluetooth --lib group_history          # 裁决表 + 接线 + 重放那三条
node --test --test-reporter=tap src/utils/storeContract.test.ts              # 那一跳的接线与非空转对照
```

```bash
cd src-tauri && cargo test --features bluetooth --lib group_history    # 第一/三/四/七节那 34 条判据（条数由这条命令自己打印）
cd src-tauri && cargo fmt --check --all                                # 格式（全量层第 21 步同款）
cd src-tauri && cargo clippy --features bluetooth -- -D warnings       # 全量层同款；本轮实测抓到两处（question_mark / too_many_arguments）
python3 scripts/verify-guards.py --list                                # 护栏锚点还能命中（不编译、不注入，秒级）
node scripts/check-test-manifest.mjs                                   # Rust/前端用例清单基线对账
node scripts/check-doc-numbers.mjs                                     # 本文与「轮次账」里的硬数字现算对账
npm run verify                                                         # 前端层（类型 + 构建 + vitest + 设计判据）
npm run test:e2e:ghsync                                                # 两台真进程（见下那条前置）
npm run test:e2e:ghsync-selfproof                                      # 反证档：口径是"恰好 5 条红"
```

⚠️ 两条 e2e 命令前置的是 `src-tauri/target/release/gosslan`：改过任何 `.rs` 就要先
`cargo build --release`，否则 harness 的 preflight 以"源码比二进制新"直接拒跑
（这是刻意的 —— 拿旧二进制跑新判据得出的结论不算结论）。
