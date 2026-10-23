# Changelog

本项目遵循[语义化版本 SemVer](https://semver.org/lang/zh-CN/)：

- **major**：破坏性变更 / 架构级重构（不向后兼容）
- **minor**：新增功能（向下兼容）
- **patch**：Bug 修复与细节优化

版本号统一由 `npm run version:patch|minor|major` 维护，一次改动同步 `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json` 五处，并把本文件 `[Unreleased]` 小节落为带日期的版本小节。

> 台账分卷（2026-10-07）：4.31.41 及更早的版本小节已整段搬到 [`docs/notes/changelog-archive.md`](docs/notes/changelog-archive.md)（只搬不改，条目文字一字未动）。
> 本文件继续只收未发布小节与 4.32 及以后的版本 —— 新的更新说明一律写进上面那一节，不往归档追加。

## [Unreleased]

## [5.7.2] - 2026-10-24

### 连续消息的「相邻侧压小圆角」第一次真的生效（运行时量具抓出来的假实现）

- 上一片把组内四角写在样式表 `.msg-stack[data-pos="…"] .gosslan-bubble-text` 上，而文本气泡的
  `border-radius` 本来就来自 `useMessageDisplay.bubbleStyle` 的**内联样式** ⇒ 内联压过样式表，
  四角实测恒为 18px，「合并」只剩间距生效、圆角那半从未画出来。现在按 `groupSide` 直接在内联样式里
  给出四角（相邻侧取 `--gosslan-bubble-radius-tight`、外侧取 `--gosslan-bubble-radius`），
  样式表那两条规则删掉（它们压不过内联，留着就是假守卫），`data-pos` 仍留在 DOM 上作对账锚点。
- 运行时探针补「连续消息组」那一格（同页挂五条，档位由应用自己的 `groupSide` 现算）：
  组内留白 2~4px、组间留白 8~12px、组首/组中/组尾/独占四档的圆角逐条核对、群头像与昵称只在组首出现，
  另配反向对照（全同一发送者时组间留白与身份行必须一起塌）。实测 **163/163** 条判据绿，
  读数：留白 `[4,4,4,10]`、四角 `[[18,18,6,6],[6,6,6,6],[6,6,6,6],[6,6,18,18],[18,18,18,18]]`。
- 第一版把组间距量成「气泡到气泡」，换发送者那一格读到 28px —— 那是尺子把新组的昵称行（18px）
  算进了留白；口径改成「上一条气泡下沿 → 本条第一个可见块上沿」，观感空档仍打印不参与判定。
- 顺手校正 `MessageItem` 里四处讲间距的注释：下间距早已是消息块那层的 `pb-1`(4px) 而不是 `pb-1.5`(6px)，
  注释还在指名 `.group/msg`，照着改会继续把两档留白讲错。

## [5.7.1] - 2026-10-23

### 连续消息间距判定补真值表（5.7.1）

- 把「组首 6px / 组内 0px / 分割行 0px」这一层从 `messageHeight` 提到零依赖的
  `messageKinds.messageTopGap()`（外加 `MSG_GAP_NEW/TIGHT`），估高端改为调用它。
  理由：`messageHeight` 依赖 `@/utils/*` 别名，`node --test` 加载不了（实测
  `ERR_MODULE_NOT_FOUND: @/utils`），能跑行为真值表的只有零 import 的那个家。
- 新增 5 条断言：组首/孤立 6、组内 0、有分割行一律 0，且常量本身是 6/0。
  渲染端（`MessageItem`）与估高端继续取同一份判定；DOM 矩形那半边仍由
  `check-ui-runtime --only=rowpair` 覆盖。

## [5.7.0] - 2026-10-23

### 聊天界面 iMessage 化 · 第一片：单聊/群聊版面与连续消息合并（5.7.0）

**版面**
- 单聊：消息区两方都不再显示头像与昵称（联系人信息只在顶部会话栏），左右气泡直接对齐两侧栏宽。
- 群聊：自己的消息不显示头像；对方的消息**只在每组第一条**显示头像与昵称，组内其余消息留同宽空位，
  气泡左边缘不再一条一条地跳。
- 气泡最大宽度 72% → 78%（`--gosslan-msg-max`），`previewMetrics.COLUMNS_PER_LINE` 由 37 现算改到 40；
  群聊头像 30px（`--gosslan-msg-avatar`）。

**连续消息合并（同发送者 / 5 分钟内 / 都是 text|code）**
- 判定收成一家：`messageKinds.groupSide()`（零 import，可跑真值表），返回 single / first / middle / last。
  渲染端（`MessageItem`）与估高端（`messageHeight`）调同一个函数 —— 行距与昵称行都随组位置变化，
  任何一边自己判一次都会让虚拟列表算错高度。
- 行距由固定 12px 改为：组内 4px、换组 10px（`GAP_BASE` + `GAP_TOP_TIGHT/NEW`）；时间/未读分割行照旧自带间距。
- 组内相邻边圆角压到 6px（`--gosslan-bubble-radius-tight`），只作用于文本气泡；图片/文件/合并/待办保持整卡圆角。
- 时间分割行的 5 分钟阈值改为引用 `GROUP_GAP_MS`（值只有一处，`previewMetrics` 只是别名），
  超过它必然插分割行 ⇒ 组自然断开；上/下有分割行时也强制断开（`breakAbove/breakBelow`）。

**尾巴口径反转（用户 2026-10-23 拍板）**
- 单聊保留尾巴并改成**贴在气泡底角向下**的弧形（盒高 14、露在气泡外 7px、上半截压进气泡盖住底边描边）；
  形状只有一份，自己的消息靠 `scaleX(-1)` 镜像。
- 群聊**整条不渲染尾巴**：五个气泡组件都带 `tail` 开关，由 `MessageItem` 按 `isGroup` 给出。
- 代码卡片没有四边描边，尾巴描边显式取 `--gosslan-card-line`（原先会退到正文色，线色与卡片不一致）。

**验证**
- `npm test`（全绿）、`npm run verify` 18/18（21.5s）。
- CDP 探针 `--only=rowpair` 在 Brave 下 **46/46**：单聊尾巴 `below=6 / inside=8`、群聊 `tailCount=0`、
  组首头像 1 个、昵称 1 行；估高与实测差 0.5px；反向对照（尾巴下推 20px）读数 >12px 证明量具不是恒绿。
- 未验：Android / iOS 真机（本片只有版面与 CSS，仍按 BLOCKED 记）；浅色主题下的尾巴目视帧未单独拍。

## [5.6.1] - 2026-10-23

### 界面精修批（5.6.1）

#### 品牌中文名改为「小院儿」

- 中文文案里的旧名全部换成「小院儿」（英文名仍是 Gosslan）：应用名、关于页、权限说明、
  五个静态入口页、macOS `InfoPlist.strings` 的本地化显示名同批改。
- 聊天主场新增品牌露出：空状态标题、侧边栏底部小字、桌面标题栏兜底文案。

#### macOS 原生窗口按钮与窗口阴影

- 三颗窗口键不再自绘：`TitleBar.vue` 删掉红/黄/绿按钮与自维护的 focused / fullscreen 状态，
  所有窗口统一走 `macos_window::use_native_titlebar()`（Titled + FullSizeContentView、透明标题栏、
  隐藏标题、原生三键显式 unhide）。
- 窗口恢复系统阴影（`setHasShadow(true)`）：此前关掉阴影后，浅色界面压在浅色桌面上时分不出窗口边界。
- 随之删掉已无出口的 `window_toggle_fullscreen` 命令与两条 capability 权限，
  `lib_window_tests` 的必需命令表由 8 项收为 6 项。

#### 气泡尖角重做

- 尖角形状收成唯一家 `components/message/BubbleTail.vue`（cubic Bézier 叶形 + 开口描边路径），
  五个气泡组件只引用、不再各写一份 SVG；判据同时钉住"唯一家"与"5 处必须引用"。
- 描边与气泡边线同色：`--bubble-line` 由 `useMessageDisplay` 按 mine / other 给出，
  填充色用 `--bubble-tail-fill`（默认 `--bubble-bg`，代码气泡自行覆盖），边线在尖角处连续闭合。
  位置用 `top: calc(max(0px, calc(12px - var(--bubble-tail-offset, 0px))) - 1px)` 夹住，
  群聊昵称行把气泡推得再高，尖角也不越出气泡顶边。

#### 移动端资料页与设置网络页

- 资料页去掉「我在线」文字、只留状态绿点；昵称输入框加长；输入框与字数计数间距收紧。
- 网络页「实时事件链路」行固定两行描述高度：点「重新连接」后中间卡片不再先缩窄再回弹。

#### 消息右键：只认消息内容 + 桌面「复制选中内容」/ 移动端原生选字

- 触发边界收敛到 `[data-msg-col]`（正文 / 昵称 / 引用内容 / 回执）：头像、表情回应条、行内空白
  不再因为"同属一条消息"就弹消息菜单；表情回应的笑脸按钮虽在列内（绝对定位），也显式排除。
  运行时探针用**真右键逐个落点**，并用 window 捕获记录真实命中元素，核对边界不是靠选择器名字猜的。
- 桌面端有有效选区时，菜单新增「复制选中内容」：只复制右键那一刻的**选区快照**（跨节点选区
  也完整；菜单打开后选区被浏览器改写/清空仍按快照复制）。原有整条复制改名「复制消息」以区分；
  没有有效选区时「复制选中内容」不渲染。5.5.10 那条「有选区放行原生菜单」仍适用于非消息内容
  区域；消息内容区改由应用接管。
- 移动端恢复系统原生选字：正文 `.gosslan-selectable` 在 `pointer: coarse` 下可选中并保留
  `-webkit-touch-callout: default`；长按正文**不再**启动自定义面板，`contextmenu` 默认行为放行
  （`App.vue` 的全局兜底也放行可选正文）。昵称 / 引用块 / 卡片 / 内边距不可选，长按这些非正文区
  才开底部面板；已有选区（含拖动选区手柄的时机）长按也不会再叠第二个菜单。移动端不提供自定义
  「复制选中内容」，选区复制交给系统菜单。
- 探针覆盖：桌面正文/昵称/引用块弹菜单、头像/表情条/行内空白/回应入口不弹；选中复制只拿到
  选中文本、无选区时无该入口、整条复制仍在、连续两条消息与跨节点选区；移动端 390px + coarse
  下长按正文不弹面板、正文 contextmenu 放行（含 target 被上提到气泡根）、非正文 contextmenu
  被拦、短按 / 滑动 / 已有选区不误弹。**Android / iOS 真机的系统选区手柄与系统复制菜单未验**
  （Chrome 触摸模拟不等于真实 WebView），需要真机补验。

#### 图片预览

- 预览图不再切圆角（完整展示）；左右切换键从 `white/10` 改成深色底 + 阴影 + ring
  （白图放大时原来完全看不见）；右上工具条、底部提示、错误态与重试键一并补底色/描边。
- 左右切换键的按压走仓库统一的 0.97（不再组件自挂 0.95）；`prefers-reduced-motion: reduce`
  下不产生按压缩放（运行时探针真按住读 `transform: none`）。
- 顺带修「按左右键靠上的地方会把预览关掉」：那两颗按钮用 `-translate-y-1/2` 定位，而全局按压规则
  `button:active { transform: scale(.97) }` 同优先级且更靠后 ⇒ 按下瞬间按钮下移、click 落到遮罩上。
  竖向居中改由外层容器承担，按钮只负责缩小反馈；另加"按下与点击必须落在同一元素"的关窗守卫。

## [5.6.0] - 2026-10-23

### 统一后台任务中心 + 全链路取消/撤回 + 异步链路审计（5.6.0 一整批）

> 这一批在 feature 分支上按 A0/B1/B2/T1/B3/B4/B5/B7/A1–A4 分了 20 多笔提交（每笔都带自己的判据与
> 台账）；合并进 main 时收成这一节，逐笔的动机与验证仍可从 git 历史里读到（`git log --oneline 5.5.24..`）。

**后台任务中心（T1）**
- 新 `TaskCenter.vue`（取代 `TransferCenter.vue`）：把散在四处的进度并成一张表 —— 文件收发、
  按 cid 取内容、消息补发、群历史、更新下载。归一逻辑只有 `src/utils/taskCenter.ts` 一家：
  只列**未完成**（`queued | running | blocked`），卡住那行给出稳定短码与**今天真能点的**动作
  （取消 / 立即重取 / 立即同步 / 去会话）。新命令 `get_pending_message_operations` 提供
  "还没送到对端"的消息行（读 outbox + group_outbox，上限 200、SQLite 在 `spawn_blocking` 里）。
- 药丸可拖到四个角并持久化（`utils/pillAnchor.ts`：四象限吸附、越界夹回、点按与拖动靠 6px 阈值分开）。
- 运行时判据：CDP 探针 `--only=opscenter` **21 格**（真拖动/吸附/接线/DOM 顺序/390 宽/空态/更新行）。

**取消（文件与消息）**
- 用户取消成为**第二个不可降级终态**：`file_transfers.cancel_terminal` 墓碑（迁移 v11→v12）、
  `SendFileError::cancelled` ⇒ `RetryVerdict::Cancelled`；群文件按成员的 `cancelled` 是硬终态，
  三处复活入口（离线补发 / 接收会话重建 / stale 清扫）全部关闭，投递闸门排在并发许可之前。
- 接收侧也能取消：单聊摘接收器 + 删 `.part`；群文件同样停手，并且**不再只 emit 一个事件骗界面**。
- **取消通知到对端**：新帧 `FileCancel` / `GroupFileCancel`（High 优先级、能力位 `1<<8` 门控）；
  用户取消与对端取消共用 `commands::apply_local_cancel` 一个收尾家；群按成员只影响那一格。
- 消息也能取消：`cancel_message` 在同一个事务里删队列行 + 状态写 `cancelled`；单聊判据靠
  `ack_delivered` 的"行还在不在"，群消息靠"没有任何成员的 Ack 被处理过"（`GroupAck` 是置 delivered
  与删行同一事务）。界面区分「已取消」与「**仅本机已取消**」（`notifiedPeer`）。
- `utils/cancelSend.ts` 是"能不能取消、走哪条通道"的唯一判据（顺手修掉旧条件要求自聊的错位）。

**撤回**
- 撤回只收文本族（`RECALLABLE_KINDS = text|code|merge`，两侧对账）：撤回只改消息行、停不掉传输，
  对着还在传的文件按撤回会得到"气泡已撤回、字节照样在发"。
- 失败/取消的文件与图片可以**再次发送**：`utils/resendChannel.ts` 按 kind × 群 × 本机有无附件
  分三条通道；顺带修掉图片被按普通消息重发的假成功（对端收到"有名字没有字节"的图、本机还转绿）。

**更新下载**
- 状态收进 `UpdaterSession`（跨窗口共用）：`updater_status` + `updater-status` 事件（250ms 节流、
  广播一个家）；任务中心列 `downloading`、设置窗重开按后端快照恢复、`installing` 不可取消。

**异步链路审计（A0 + A1–A4）**
- 新增门禁 `scripts/check-import-cycles.mjs`（零环才绿、过期白名单也红、带 `--self-test`）；
  审计报告 `docs/notes/async-cycles-leaks-audit-2026-10-23.md` 的 6 条发现全部收口：
  取消后收回停滞标记、删好友摘样式缓存、按状态回收群文件分母快照、到期清扫读有界（附 2 万行
  0.289 ms 的读数）、两个一次性定时器登记进 init 作用域、看门狗留启动/心跳两行活性证据。

**判据规模**：Rust 1147 passed、前端 1310、护栏非空转用例 264 条（本轮新增 12 条，均"改坏即红"）、
`verify:local` 22/23（唯一红是未推区间的 Change Budget 判据 3）。仍未证的是三格人工项：
两台真机之间"取消后对面真停 / 这一格不再收字节"、"设置窗重开看到进度"、"按取消后回执停在已取消"。

## [5.5.26] - 2026-10-23

### 外部链接的操作入口

- 顶部那四枚纯图标（导出 / 导入 / 链接导入 / 添加）改成**带文字的入口**，并且**三个入口同一行、
  同一档样式**（用户 2026-10-23：上一版"上面一个实心大蓝按钮、下面一个描边按钮"既突兀又不像一组，
  左栏最窄只有 200px 时实底按钮还会把标题挤没）。「添加」保留主色描边表达层级，不再是整块实底。
  导出本身就是备份，文案按大众共识写，图标只作辅助。
- 原来四种动作共用一个弹窗（点哪个都在里面再挂一枚「从 JSON 文件导入」）。现在拆开各管各的：
  新增/编辑只管这一条链接的名称与网址，导入只管导入（文件与网址两种来源在同一处），
  备份是直接落盘不弹窗。判据现算切块核对「导入没混进新增/编辑」。

### 表单回车确认

- **修掉一处静默失效**：模板写 `@keydown.enter="ime.enter(save)"` 时，Vue 编译成
  `($event) => ime.enter(save)` —— 返回的处理器被丢掉，回车**一次都没执行**。全仓 16 处都是这个
  形状（组名、链接、任务、自定义类型、接入点、中继配置…），所以"要手点"不是错觉。
  `useImeEnterGuard.enter` 现在收第二个参数，模板统一写 `ime.enter(save, $event)`。
- 补齐缺回车的确认表单：建群（群名回车即建）、群公告与任务描述（多行框用 ⌘/Ctrl+Enter 提交，
  裸回车留给换行）、任务自定义类型（回车即存）。单行输入不再无条件 `prevent`，让输入法照常吃回车。
- 判据 53 从「引了这个家」扩到「内联绑定必须拿到 `$event`」，正/反控各一条；
  真按键由运行时探针 `--only=links` 量（回车新增、回车线上导入各一格）。

### 聊天气泡尖角

- 气泡那条指向头像的小尖角原来吊在气泡底部，跟头像完全不搭（用户截图）。现在竖向**对准头像中心**：
  群聊那行昵称把气泡往下推的 18px 由 `MessageItem` 报进 `--bubble-tail-offset`，CSS 只做减法。
  单聊/群聊两档由 `--only=rowpair` 量两条中心线（相差 <= 1px），改回底部即红。
- **代码气泡那一格本轮也改了**（上一版写的是"按自己 toolbar 的配色成对定位，不动"，被用户截图点名）：
  它在组件里又钉了一份 `top: auto; bottom: 12px`，把尖角钉在卡片底栏上、与头像完全错开。
  现在位置只有 `style.css` 那一个家，组件里只补配色。判据把"第二家"的形状（`.bubble-tail` 选择器里
  出现 `top`/`bottom`）在全部挂尖角的气泡上现数（≥5 家），代码气泡那格单独点名注释。
- **「把所有的气泡尾巴都检查下」= 五种气泡各量一遍**：探针 `--only=rowpair` 现在挂正文 / 代码 / 文件 /
  合并转发四种载荷 × 单聊与群聊两档，读尾巴与头像的两条中心线（本机实测 56.5~57.5 vs 56.5，全在 1px 内）。
  群聊那一档还顺带判"尖角的包含块是不是气泡自己"：把 `cardStyle` 的 `position: relative` 摘掉，
  文件与合并转发两格立刻 38.5 vs 56.5 变红，而**同两种气泡的单聊格仍是绿的** —— 只量单聊会整个漏掉这族缺陷。
  ⚠️ 同日后半段这条口径改过：群聊里"中心对齐"会让尖角上半截越出气泡顶边（看着像插在昵称行上的一面小旗），
  现在群聊判"尖角不越出气泡顶边"、单聊仍判"中心对准头像中心"；理由与读数见下面「界面缺陷批」。
- 本轮新增的三条判据都进了护栏非空转用例集（`guard_cases/frontend_ui.py`，现算 242 条）：
  调用点顺序、端口不再回报退没退、代码气泡再钉一份竖向位置 —— 三条都在本机跑过"改坏即 FAIL、恢复即 PASS"。

### 联系人里的「自己」

- 点通讯录里自己那一行不再被弹回通讯录并提示「内容不存在或已不可访问」：深链校验那一档把自聊 id
  当**合法**的资料页对象（与下面会话那一档 `id === device_id` 同一个口径），"我自己"那行的构造
  收进 `selfChat.selfFriendOf` 一个家（原来在 `ConversationList` 里就地拼，深链还原不出同一条）。
  资料页只显示自己**能显示**的信息（设备类型 / 设备 ID / 端到端加密），安全码与连接方式那一档不适用，
  「删除好友」不给（好友才谈删除）。
- 顺带修一处静默死按钮：自己资料页的「发消息」先 `await ensureConversation`，那次 IPC 一旦失败，
  整段动作（打开会话 + 落路由）被一起带走 —— 资料页清空但哪儿也没去。现在 ensure 失败也继续往下走，
  会话行缺失时 store 自己会再兜底一次。

### 加好友页「发起聊天」真的进入聊天窗口

- 症状（用户 2026-10-23）：已经是好友的人点「发起聊天」只是把弹窗关掉，人还停在通讯录。
- 根因不在跳转，在**分层返回的历史条目**：弹窗那层释放时 `history.back()` 退掉自己压的同 URL 条目，
  而 Vue 的 watcher 跑在微任务里、**早于** vue-router 写历史条目 ⇒ 那次 `back()` 排在跳转之后执行，
  把刚进去的聊天页原路退了回来。
- 改法两条腿：① 处理函数**先等导航落地、再在 `finally` 里关弹窗**（导航被守卫挡掉也不能把弹窗卡住）；
  ② 端口如实回报 `back()` **到底退没退** —— 压入之后导航过的条目现在是合法的"后退到上一级"目标，
  不再退掉，纯逻辑据回报决定要不要减计数与预吃那次 pop（否则用户下一次真按返回键会被静默吞掉）。
  移动端返回键于是是「聊天 → 通讯录」，层全关完后仍然真的退出应用。
- 证据：真浏览器读历史条目（弹窗 `state.gosslanBackLayer=1` → 跳转后条目为 null、`state.back="/contacts"`
  → 按返回落回 `/contacts`）；反面控制按旧顺序执行仍然停在 `/contacts`；纯逻辑新增"端口拒退"一格
  （退回旧的无条件退条目形状即红）；调用点顺序由新增判据钉住，三处单点变异都证过会红。

### 粘贴大段文字不再"卡一下才显示"

- 根因不在 JS 慢，在**插入方式**：聊天输入框的粘贴走 `document.execCommand("insertText")`，
  而 Chromium 会把带换行的文本**逐行**开编辑事务 —— 真 ⌘V 实测 300 行 / 10k 字符 ⇒
  299 个子元素 + 599 次 `input` 事件、按键回执 **562–662 ms**；1500 行 / 50k 字符 ⇒ **4367 ms**。
  整段同步跑在 paste 事件里，所以粘贴的文字必须等它全部做完才画得出来（就是用户说的"卡一下"）。
- 改成**一次插入一个文本节点 + 补发一次 `input`**：编辑区自己是 `whitespace-pre-wrap`，
  文本节点里的换行符就是换行，不需要每行一个元素。同一动作实测 **6–9 ms / 19–36 ms**
  （子元素 0 个、`input` 事件 1 次），`serializeDraft` 走的 innerText 换行数一字不差（299/1419）。
- 顺带把两件"看不见的错"钉住：caret 落在**文本节点内部**的末尾（落在编辑器元素上会让
  `caretContext()` 拿不到上下文 ⇒ 粘完接着打 @ 不弹成员选择）；粘贴后发送键立刻可用。
- **撤销没有变弱**：手动改 DOM 不进 Chromium 的原生 undo 栈（实测按 ⌘/Ctrl+Z 什么都不回退），
  所以组件自己记一份"粘贴前快照"，紧跟粘贴的那一次 ⌘/Ctrl+Z 由它接住（真按键实测：
  1393 字符 → 4 字符回到粘贴前）；粘贴之后又编辑过就不拦（那次按键该撤销的是编辑，交回原生）。
  回灌快照也走编辑器那张标签白名单，不裸塞 innerHTML。
- 其它输入框不用改，并且是量过的：普通 `<textarea>` 真 ⌘V 粘 52,889 字符 / 1500 行 **22 ms** 落全，
  单行 `<input>` 7 ms —— 逐行开事务是 contenteditable 特有的，全仓只有聊天框是 contenteditable。
- 判据：运行时探针新增 `pasteframe` 段（10 格；主判据钉"一次 input / 零个子元素"这两个机制形状，
  耗时那格只当兜底），把粘贴改回旧写法实测红 4 格；源码侧另加一条判据 + 两条护栏非空转用例
  （现算 244 条），都跑过"改坏即 FAIL、恢复即 PASS"。

### 界面缺陷批（用户截图逐条）

#### 长串数字撑出横向滚动条

- 群公告只写了 `whitespace-pre-wrap`：它保留换行但仍按**词**断行，一串数字就是**一个词** ⇒
  内容撑出容器；外层弹窗的 `overflow-y:auto` 会让 `overflow-x` 跟着算成 auto ⇒ 长出横条。补 `break-words`。
- 新增判据「挂了 pre-wrap 就必须配断词」：按**真实 class 属性**认（注释不算），三种断词出口
  与内联 `word-break` 都算数；全仓 16 处 pre-wrap 现算，把那一处断词摘掉即红。
- 单行截断仍是省略号：`truncate` 由原有判据（截断必须带 title / aria-label）覆盖。

#### 自己发的图片不再提供「重新获取」

- 「重新获取」是**收件方**语义（请对端按 cid 再发一份）；自己发出去的那张图，对端是接收方，
  向它索取既拿不到原图也没有意义。三处按 `mine` 分叉：气泡不外发 refetch、清理占位的点击不触发、
  第二行改成「本机原图已删除，重新发送一次才能再看到」。
- 失败原因只报这一层**真拿得到**的分界（本机有没有可加载的地址：没有文件 / 读不出来），不编更细的原因。
- 接线按**出现次数**钉住：每一处 `<MessageImageBubble>` 都必须传 `:mine`，摘掉一处即红。

#### 群聊气泡尖角贴回气泡

- 两个真因：① 群聊气泡被昵称行推下 18px，尖角正好落在 18px 胶囊的**圆角**上，直边三角形
  只能碰到弧线一个点，中间露出背景；② 尖角上半截越出气泡顶边，像插在昵称行上的一面小旗。
- 改法：尖角那一侧的上圆角跟着尖角走（群聊 2px、单聊保持胶囊；写在 `bubbleStyle`/`cardStyle` 的
  内联样式里，样式表规则压不过内联）；竖向 `top: max(0px, calc(12px − 偏移))` 把尖角钉在气泡顶边上。
- 口径变更：群聊不再要求"尖角中心 = 头像中心"，改为"尖角不越出气泡顶边（0~1.5px）"；单聊仍按中心 ≤1px。
  `--only=rowpair` 另加横向融合判据（底边压在气泡边缘上，对方/自己 × 单聊/群聊四格）。

#### 切会话不再抖

- 收敛窗口原来会被 `scrollToBottom()` 清零 —— 切会话时 ChatWindow 在 `nextTick` 后还会调它"首屏贴底"，
  那一下把逐次贴底放回来了。现在不清，并把窗口从固定时长改成**安静期**（每次实测修正顺延 120ms、
  上限 900ms），收敛完只贴一次。`--only=vlist` 的采样帧读数：方向反转 0 次、末位置贴底。

#### 资料页边距与移动端设置

- 资料页恢复页面级 `p-4`，与设置一级/二级页同口径（"走满宽"那版说的是卡片内部按钮排布，不是贴屏幕边）。
- 移动端设置原来外壳与页面**各开一层滚动容器**：两层各留一条 `scrollbar-gutter`（左右各多吃 8px），
  触屏滚到底还会串联到外层，看起来就是"滑一会边距变了"。用 `MobilePageFrame` 现成的 `:scroll="false"`
  收成一层；实测同一张卡滚动 623px 后左边缘不动、滚动祖先只剩一个。
- 设置行加 `data-no-press`：满宽列表行不是按钮，`button:active` 的 scale(0.97) 会让整张分组卡
  "缩一下"（单行分组里那一行就是整张卡），按压反馈保留背景色。运行时探针真按一次读 `transform`，
  并用返回键做**正控**证明量具没坏。

#### 点自己头像进资料页 + 回来接上阅读位置

- 原来自己那一支直接 `return`（点了没反应）。现在移动端进资料页、桌面进设置。
- 阅读位置三条口径：离开 3 分钟内回来恢复原像素位置；来新消息（未读）位置让给未读；
  离开时本来就在底部 ⇒ 回来贴底。判定收在 `utils/scrollRestore.ts`，过期那一格与三个出口都有单测。

## [5.5.24] - 2026-10-23

### 发版签名自检

- tag 构建的签名预检不再只看「私钥能 base64 解码」：现在真的签一次临时文件，
  私钥与密码不配套时 5 秒内用注解点名两边的字符数；构建前统一去掉粘贴带的行尾空白
  （密码文件本身 44 字节含结尾换行，正文是 43 个字符）。

## [5.5.23] - 2026-10-23

### 发版链修复（5.5.22 桌面产物缺失）

- 恢复自动更新通道：5.5.22 的 tag 打在带坏 `build.rs` 的提交上，桌面构建全红、
  `latest.json` 未生成 ⇒ `releases/latest/download/latest.json` 返回 404。
  5.5.23 从修好的提交重新出四端产物。
- Windows Rust 单测壳合并 Common-Controls v6 清单（`windows-test.manifest`），
  修掉加载期 `0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND`（`comctl32!TaskDialogIndirect`
  只有 v6 有，而 libtest 的壳没有 tauri-build 给正式二进制嵌的那份清单）。
- CI 诊断：Windows 失败诊断改看 `target\release\deps`（测试跑的是 release）、
  按 `Symbol:` 解析导入函数（上一版按 `Name:` 抓永远 0 条）、补应用程序错误事件日志。

## [5.5.22] - 2026-10-23

### 移动端设置与资料页统一

- 设置行在窄屏放不下控件时自动换到下一行（分段选择、长按钮不再把标题/说明挤成一条缝）。
- 移动端设置里的「资料」改为进入与「我的」头像同一个资料页；资料卡去掉外层重复内边距、
  走满宽，只保留一套宽度与按钮布局。

### 补回 5.5.21 漏掉的审查修复

- 文本消息「以代码块显示」只在 `codeDetect` 判定内容像代码时提供入口（自聊仍不提供撤回/渲染）。
- 删除会话/好友前取消在途传输、已撤回消息的 render 事件不生效（恢复对应用例）。
- `updater-manifest.yml` 的 shell 变量恢复 `${failed}`，与远程同批修复一致。

## [5.5.21] - 2026-10-23

### 签名预检：把「差多少」变成数字

5.5.20 的读数显示 secret 值里**没有非法字符**（全是合法 base64 字母表），但解不开 ⇒
长度不是 4 的倍数。本版起预检在注解里直接给出**实际长度**（正确值 348），
这样一眼就能看出是截断还是贴错文件。

## [5.5.20] - 2026-10-23

### 签名预检补一条：报出「非法字符集合」

5.5.18/5.5.19 两次都红在 `TAURI_SIGNING_PRIVATE_KEY 不是合法 base64`，但光看这句话分不清
是**填了路径**、**带了引号**还是**被截断**。现在预检会在报错里附上非法字符的**集合**
（合法密钥这个集合必然为空 ⇒ 不泄漏任何密钥字节），并写明正确值的长度与前缀。

## [5.5.19] - 2026-10-23

### 发版重试：签名 secret 已重贴

- 上一版（5.5.18）卡在 `TAURI_SIGNING_PRIVATE_KEY 不是合法 base64` —— 预检当场点名，
  用户重贴了密钥内容（348 字符）与密码。
- 本版沿用 5.5.18 的发布链修复：草稿 Release 会被自动发布、签名预检会具名报错、
  桌面构建一旦失败清单任务立刻止损（不再空等 45 分钟）。

## [5.5.18] - 2026-10-23

### 让发版真的发得出去（v5.5.17 没发出去的两道拦路虎）

- **人工草稿 Release**：草稿对 `releases/tags/<tag>` 返回 404 ⇒ 发布脚本判"不存在" → 创建被顶成
  `already exists` → 复查询仍 404 ⇒ 四条发布 job 全红。现在脚本用列表 API 兜底认它，并在上传
  完成后 `release edit --draft=false` **主动发布**（判据：`publishRelease.test.ts` 的 draft 场景）。
- **签名密钥填错**：tag 构建跑到签名那一步才红、日志只有 `exit code 1`。现在预检会 **base64 解码**
  并要求解出来以 `untrusted comment:` 开头，不是就立刻具名报错（两条构建腿同口径）。
- 文档：`docs/updates.md` 新增「发不出去时的三种真形状」（草稿 / 错密钥 / 重用 tag）。

## [5.5.17] - 2026-10-23

### 代码/文本消息：发出后切换渲染（支持该能力位的成员生效）

- 新增静默 `render` 事件（`{target, mode: code|text}`）与 `CONTENT_FEATURE_RENDER`；
  作者可在右键菜单/移动 ActionSheet 把已发出的 code/text 消息切到另一种渲染。
- 后端用 `message_render` 表做 per-msg LWW（`seq` 大者胜），`messages.kind` 是物化视图；
  迟到/重投不会把渲染翻回旧状态。群发送只给声明了 RENDER 的成员写 outbox，
  旧/离线成员保持原渲染，不产生“不支持的消息”占位。
- 单聊/群共用 `set_message_render` 命令；1:1 走能力位门控，群侧按成员能力过滤。
  `text → code` 只在 `codeDetect` 认为像代码时给入口。
- 判据：Rust `render_lww_only_applies_newer_events`；`renderMessage.test.ts` 接线；
  `ARCHITECTURE-MAP` 登记命令与 `message_render`。
- `npm test` 1263/1263、`npm run build`、`cargo check`、LWW 单测通过。
  **双实例渲染切换/真机未跑**；发版前需补这一层。

## [5.5.16] - 2026-10-23

### 聊天输入：代码自动识别与围栏剥离

- 新增 `utils/codeDetect.ts`：整段 ```lang 围栏为强信号；多行文本需至少两个结构信号
  （缩进、括号/分号、关键字、shebang、JSON/XML/SQL 形态）；单行、URL、中文段落不判。
- Composer 输入 250ms 防抖检测，命中后自动进入代码模式并显示“已识别为 X 代码 · 撤销”；
  用户手动切换会抑制本轮自动识别；发送时自动剥掉外层围栏，落库内容不含 ```lang。
- 判据 `codeDetect.test.ts`（正反例 + Composer 接线）；`npm test` 1262/1262、
  `npm run build` 通过。
- 代码消息“发出后切换渲染对所有人生效”是下一笔独立协议改动，不在本提交内。

## [5.5.15] - 2026-10-23

### 设置、资料、链接与气泡的一批体验修正

- 桌面设置收敛为 4 类：通用（个人资料/语言/外观/通知/存储/重置与恢复）、网络与文件、
  安全、关于；旧深链键仍映射到容器；去掉桌面左侧的返回按钮（键盘返回保留）。
  移动端分组同步为 4 组。
- 侧栏底部新增升级提示：仅在 `available/ready` 且未被 dismiss 时出现；点击写入一次性
  `gosslan:settings-section=about` 并打开设置，设置窗口 mount/focus 时消费并自动检查。
- 安卓资料页：移动端外层补 `p-4`；在线状态移到昵称行，两个按钮单独一行，窄屏不再把
  “在线”挤成孤行；桌面仍保持头像与字段垂直居中。
- 自定义头像色：原生 `<input type=color>` 直接覆盖在色块上（不再 `sr-only` + 程序化
  `.click()`）；macOS WKWebView 的真实行为仍需真机确认。
- 链接面板：新增/编辑/线上导入/文件导入统一进 `BaseModal`；空列表时不再显示导出按钮。
- 聊天气泡：圆角调到 18px；尖角从顶部移到气泡底部（代码气泡单独对齐 12px），
  减轻“板正”的观感。
- 判据：`settingsStructure.test.ts` 重写为 4 容器 + 组件列表；`npm test` 1258/1258、
  `npm run build` 通过。**macOS 真机取色、安卓资料页与气泡截图未跑**。

## [5.5.14] - 2026-10-23

### 抖动窗口与强提醒分离

- `RemindPayload` 新增 `nudge`：独立抖动不锚定任何消息、不自动回执、不折叠强提醒；
  `target` 允许为空。新增 `CONTENT_FEATURE_NUDGE` 能力位，旧端不会收到；群发送显式拒绝。
- 工具栏「抖动」改为发 `nudge=true` 的独立帧；接收端只按通知总开关聚焦/抖窗，并显示一条
  会话内居中灰字（发送方「已发送」/ 接收方「谁发的」），60 秒以上的迟到帧丢弃。
  强提醒链路（逐消息、alerted/confirmed、「我知道了」）原样保留。
- 判据：`reminders.test.ts`（nudge 空 target/折叠）、`remindFlow.test.ts`（onMessage 分流、
  shakeConversation 不再锚消息、nudge 不 ack）、`nudge.test.ts` 迟到边界；
  `defer.test.ts` 白名单注明年龄判定不是限流。
- `npm test` 1258/1258、`npm run build`、`cargo check --features bluetooth` 通过。
  **双实例抖动/真机未跑**；发版前需补这一层。

## [5.5.13] - 2026-10-23

### 添加好友页「发起聊天」+ 任务类型自定义聚焦

- 添加好友页里已是好友的那一行，从静态「已加好友」改成「发起聊天」按钮：点击关闭
  弹窗并打开与该好友的单聊。
- 任务详情把类型切到「自定义…」时，用本地 `categoryDraft` 立刻展开名字输入框并聚焦；
  输入框/确认按钮/类型选择器的显示都用这份 draft，不再等 `item.category` 先落库。
  看板的新建/编辑表单选自定义后也自动聚焦。
- 判据：`friendChatAction.test.ts` 与 `todoCategoryDraft.test.ts` 的接线断言；
  旧树分别 0 处 `chat` emit / `categoryDraft`（实测会红）。
- `npm test` 1254/1254、`npm run build` 通过；真机交互未跑（按用户要求只跑 local）。

## [5.5.12] - 2026-10-23

### 撤回：单聊与群统一 5 分钟，过期不再显示入口

- 新增单聊命令 `recall_message`：仅原作者、目标必须属于该单聊、5 分钟窗口；复用
  `send_message(..., "recall")` 的 E2EE / outbox 管道，先发可靠事件再物化本地。
- 群撤回改用 `protocol::recall_verdict`，并补上“目标消息必须属于该群”的校验；
  `RECALL_WINDOW_MS` 收敛到 `protocol.rs` 的唯一常量。
- 前端 `canRecallNow()` 用函数而非 computed 现算窗口；桌面右键菜单与移动 ActionSheet
  共用同一判据，超过 5 分钟入口直接消失；确认后按 `group:` / 单聊分流。
- 判据：`protocol` 的 `recall_verdict` 真值表；`recall.test.ts` 的常量对账、窗口边界与
  `MessageItem` 接线；`ARCHITECTURE-MAP.html` 登记 `recall_message`；`defer.test.ts`
  白名单注明这是“窗口判定”不是限流。
- 本地 `verify:local` 22/22、`npm test` 1251/1251、`npm run build`、`cargo fmt --check` 通过。
  **双实例撤回/真机未跑**；发版前需补这一层。

## [5.5.11] - 2026-10-22

### 传输面板：排队原因、取消入口与孤儿发送台账对账

- `TransferInfo` 新增 `blocked_reason`：`queue_missing` / `queue_closed` /
  `retry_exhausted` / `waiting_retry` / `peer_offline`。面板对排队行显示原因，
  并给发送行加「取消发送」按钮（复用 `cancel_file_transfer`，`signalled=false`
  也会落终态）。
- 启动与 outbox 清扫器每轮跑同一份对账：**只碰 `direction='send'` 的 pending**，
  建行满 2 分钟、且没有活着的 outbox（pending/sending）或 attempts 已用尽 ⇒
  走唯一终态出口 `finalize_file_failure(GiveUp)`。接收行没有 outbox，绝不参与。
- 判据：`file_transfer_status_tests` 两条（接收行不误判；只杀老孤儿/耗尽，不碰新鲜行与
  有活跃 outbox 的行）；`transferState` 的短码映射真值表。
- 本地 `verify:local` 22/22、`npm test` 1248/1248、`npm run build` 通过。
  **双实例/真机取消与对账未跑**；发版前需要补这一层。

## [5.5.10] - 2026-10-22

### 选字复制：消息行不再无条件吃掉系统菜单

- `MessageItem` 的消息行此前写死 `@contextmenu.prevent`。组件级 `prevent` 在 handler
  之前执行，即使 `openContextMenu` 在移动端提前返回，系统复制菜单也已经被阻止 ——
  表现就是“有选区手柄、没有复制提示框”；桌面用鼠标选中正文同样吃不到系统菜单。
- 现在统一走 `onContextMenu` + `shouldPreventContextMenu`：有非折叠选区 ⇒ 放行；
  移动端选择模式 ⇒ 放行；其余才 prevent 并打开自定义消息菜单。
- 判据 `contextMenu.test.ts`：三信号真值表 + `MessageItem` 接线（旧树 0 处
  `@contextmenu="onContextMenu"`，会红）。`npm test` 1247/1247、`npm run build` 通过。
- **安卓真机复制工具条未跑**（需要设备）。

## [5.5.9] - 2026-10-22

### 安卓：点击收到的 APK 直接进系统安装器

- 此前 `openLocalFile` 在 Android 一律走 SAF「另存为」，收到 APK 只能保存，不能安装。
- 现在 `.apk` 走 `open_file_native` → `OpenWith.openWith`，`resolveMime` 明确返回
  `application/vnd.android.package-archive`；Manifest 声明 `REQUEST_INSTALL_PACKAGES`。
- 首次安装仍由系统弹「允许安装未知应用」，不是静默安装。
- 判据 `apkInstall.test.ts`：`isApkName` 真值表 + 前端分流 / Kotlin MIME / Manifest 三处接线；
  旧树三处均 0 命中（实测），新树 `npm test` 1245/1245 通过。
- **Android 真机安装未跑**（需要设备）。

## [5.5.8] - 2026-10-22

### 修复：安卓「另存为」写成功却报失败

- `OpenWith.kt` 的 `saveWith` / `writeBytesWith` 此前写成
  `openOutputStream(...)?.use { ...; null } ?: "无法写入所选位置"`。Kotlin 的 `use`
  返回 block 的最后一个表达式，block 以 `null` 结尾 ⇒ 成功也走 Elvis 右侧：文件已经
  写完、流也关了，界面仍提示“无法打开/保存”。这正是用户反馈的“其实保存成功了”。
- 现在先判空流，再用 `use` 写完并显式 `return null`；两条路径的返回值重新与 Rust 侧
  “null=成功、非空=原因”的约定一致。
- 新增主机判据 `android_save_bridge_does_not_report_success_as_failure`：按函数体形状
  剥注释后判“必须先 `if (out == null)`、再 `out.use {`、禁止 `use { …; null } ?: 失败串`”。
  旧文件实测 0 个 `if (out == null)`、2 处旧 Elvis 形状 ⇒ 判据在旧代码上会红；新代码通过。
- `cargo fmt --check --all` 通过。**Android 真机保存未跑**（需要设备），本次不把它写成绿。

## [5.5.7] - 2026-10-22

### R-10 的另一半：握手补全那次「回发 Hello」有了期限

- `transport.rs` 在读循环**起来之前**回发本节点 Hello（让拨号方也学到身份）。这一发
  `high_tx.send(..).await` 此前**没有期限**：控制队列满（writer 被 bulk 压住）或对端
  接受连接后不再读 ⇒ 整条连接永远到不了读循环，表现是「链路在表里、一个入站帧都没有」
  而发送侧看到的是"投进队列就成功"。
- 现在包进与拨号侧同一个 `HANDSHAKE_TIMEOUT`（5s）：超时只丢这一次身份补发（对端身份由
  下一次 Hello/announce 补），链路照常进读循环。
- 判据 `hello_reply_before_reader_loop_is_bounded`：按 transport 生产码全集判这条 send
  必须在 timeout 里；非空转已证（改回无界 ⇒ 红；还原 ⇒ 绿，文件逐字相同）。

## [5.5.6] - 2026-10-22

### 修复：对端失联时 BLE 栈 panic 把整个应用打死

- 现场（双实例 e2e `--fault=peer-freeze`，对端 SIGSTOP）：A 侧日志最后一行是
  `panic @ vendor/btleplug/src/corebluetooth/internal.rs:268：Got characteristics for a service
  we don't know about`，之后进程再没写过任何日志 —— 正在等 `FileAccept` 的文件永久卡住，
  界面上看就是"对端回来以后这一单再也不动"。
- 根因：CoreBluetooth 会在断链/重连竞态里，为一个**已不在 services 表里的旧服务**再投一次
  `didDiscoverCharacteristicsForService`；vendored btleplug 上游那句 `expect` 直接 panic，
  而 release 是 `panic = "abort"` ⇒ 整条进程被杀。
- 修法：迟到的回调**丢掉**（服务已不在表里，特征无处挂载，下一次 service discovery 会重建），
  不改任何正常路径。补一条判据钉住"重新 vendor 时别把补丁丢了"，且按**代码形状**判
  （补丁注释里会转述上游那句话，按文本判会咬到自己的注释）。
- 同一批里另外 5 条此前红的 e2e 轮次复跑**全绿**：`multi-file`、`sender-kill-mid`、
  `recv-readonly`、`src-shrunk`、`contentpull`（`posttext` / `kill-mid` / `dmreact` 已在上一批转绿）。

## [5.5.5] - 2026-10-22

### 常驻 worker 有了看门狗（审计 R-05 —— 34 条里此前唯一完全没做的一条）

- 五个进程级常驻 worker（`peer_emitter` / `outbox_retrier` / `runtime_diag_reporter` /
  `db_hold_reporter` / `outbox_sweeper`）此前都是 spawn 完就把句柄丢掉，全仓 `is_finished`
  **0 命中**。其中 outbox 清扫器一死，`sending` 行就再也没有终态出口 —— 界面一切正常，
  用户看到的是「消息永远发送中直到重启」。
- 现在统一由 `worker_supervisor` 拉起：名单只有一份（`RESIDENT_WORKERS`），每 10s 判活，
  死了就重启并留一行 warn；同一个 worker 最多重启 5 次，超过只留 error（防「每 10s 重启
  一次」把 CPU 打满）。
- 接线判据三条：① 名单恰好 5 个且名字唯一；② `lib.rs` 里 `start(` 恰好一处、五条老的
  直接 `spawn_*` 一条都不许留（留着 = 同一个 worker 跑两份）；③ 「句柄已结束」这个输入
  信号用真实 tokio 任务正反两向证明。
- 刻意**不收编**的两类写在模块注释里：`network::start` 管的那批（有显式 stop 生命周期，
  重启一个已停的任务会把"用户关了局域网"变成"它又自己起来了"），以及挂在延迟启动作业里的
  `group_history_sweeper`（时序要单独确认）。

## [5.5.4] - 2026-10-22

### 应用内更新：两处「看着守住了、其实没有」

- **更新面板的进度条改回 `transform: scaleX`**：`UpdatePanel.vue` 之前用
  `transition-[width]` + `width:%`，违反 §14.6（S-5 的同族复发 —— 那次只改了
  `ChatWindow` 一个组件、没留仓库级判据，几小时后新代码又写回来了）。
  现在新增一条**仓库级**判据：扫全部 `.vue` 模板，`transition-[width]/[height]/[top]…`
  必须为 0（带合成正控 + 文件数下限，注入一处即红，已实测）。
- **清单生成器的「0 字节安装包」开关原来是假的**：`buildManifest` 有 `minAssetBytes`
  形参与注释，但**函数体从未使用**，CLI 也没传值 ⇒ 注释里承诺的防护根本不存在。
  现在真正按字节数拦（CLI 传 1024），并补 3 段单测（默认不查 / 小文件必红 / 大文件放行）。

## [5.5.3] - 2026-10-22

### 修复远端 CI 的两处红（本地全绿、远端全红的那一类）

- **Rust 门禁**：`notifications.rs` 的点击等待槽位改用 CAS 循环，不再用
  `AtomicUsize::fetch_update` —— 该方法在新 stable 上已废弃（改名 `try_update`），
  CI 的 `clippy -D warnings` 因此整条 Rust 门禁红；而本机 rustc 1.98.1 还没废弃它，
  所以本地 `cargo clippy` 是绿的。CAS 循环两个工具链都认（改写成 `try_update`
  会反过来在本机编不过）。
- **发布构建**：两个桌面 workflow 在 tag 上新增「签名 Secrets 预检」。缺
  `TAURI_SIGNING_PRIVATE_KEY` 时第 5 秒就红并写明修法，而不是等整个 release
  编完（约 7 分钟）之后只留下 `Process completed with exit code 1` —— v5.5.0/v5.5.1
  的四个桌面 job 就是这么红的。签发链路本身已用本机密钥按 tag 形状验证：
  `.app.tar.gz` + `.sig` 正常生成（`EXIT=0`）。

## [5.5.2] - 2026-10-22

### 文件队列的周期补发

- `spawn_outbox_retrier`（每 5s）此前只补发单聊 `outbox` 与 `group_outbox`，**没有**
  `flush_pending_files` —— 而文件队列的补发只挂在"建链事件"上（Hello / 拨号成功 / BLE 连上）。
  于是对端重启、冻结、或接收目录恢复可写之后，`file_outbox` 里已入队的行没有任何东西
  会再把它们送出去，只能等下一次建链或 30 分钟的失败期限。
- 现在三条队列同频补发。**这一条尚未通过双实例 e2e 验证**（`--fault=kill-mid` 仍红，
  失败点已前移到"链路在文件完成后消失"，见 `.workbuddy/audit/2026-10-22-e2e-failures.md`）。

## [5.5.1] - 2026-10-22

### 头像与名字对齐修复

- 消息行改成顶部对齐：此前 flex 默认 `stretch` 会把头像按钮拉成整行高，头像在按钮里
  按行高居中 ⇒ 多行文本、图片、任务卡这类长消息里头像沉到气泡中部，与上方的名字完全错开。

### 发布链路修复（v5.5.0 的桌面产物没能出包）

- macOS 不再走 Tauri 内置的 dmg 打包：`bundle_dmg.sh` 在 CI 的 `find_mount_dir` 里用
  `grep -E` 匹配设备名，BSD grep 报 `brackets ([ ]) not balanced` ⇒ 找不到挂载点 ⇒
  整个 job 红（两个 mac job 各重试三次全红），连带 updater 真正需要的 `.app.tar.gz`
  也没生成。改成 `--bundles app` 先出 `.app` + `.app.tar.gz` + `.sig`，dmg 再用
  `hdiutil create` 单独产出（无挂载、无 AppleScript）。
- Windows 不再用 `$args` + `@args` splatting 传参：`$args` 是 PowerShell 的自动变量，
  赋值后 `--target` 没真正生效 ⇒ 产物落在 `target/release` 而不是 `target/<triple>/release`
  ⇒ "构建成功、上传安装包失败"。改成按分支写两条完整命令（与 WebView2 档同一条口径）。
- Android 编译门禁的 3 条 dead-code warning：R-08 的点击等待槽位（`slot_allows` /
  `acquire_click_waiter` / `ClickWaiterGuard`）只在桌面分支被调用，按调用平台补齐 cfg。

## [5.5.0] - 2026-10-22

### 头像选择器、群任务指派与群聊切换滚动

- 默认头像：背景色调色板按红→橙→琥珀→绿→青→蓝→靛→紫→粉→棕→灰的相近色系排序，
  共 33 色，并新增原生取色器的自定义颜色；Emoji 从 36 个扩到 72 个。卡片弹窗补底部
  安全区与键盘让位，滚到最底部时最后一颗色块和确认键都完整可见。
- 群任务：新增/编辑指派只列当前群成员；保存与认领时自动剔除非成员。打开看板会重拉
  最新群资料；群主权威成员表（GroupKey / 群主签名消息）到达时整体替换本地成员集合，
  修复离线漏收退群帧后旧成员永久残留。
- 群聊切换：虚拟列表在切换会话后的高度重测静默期内不再逐次贴底，只在收敛结束时贴一次，
  消除切到群聊时滚动区的小幅快速抖动。

### 自动更新（Tauri Updater + GitHub Releases）

- 接入官方 `tauri-plugin-updater`：设置 → 关于新增「应用更新」，支持手动检查、版本/说明/发布时间、
  下载进度、取消下载、安装并重启、稍后处理；启动后仅异步检查一次，失败静默、无轮询、无弹窗。
- 下载/检查均有超时与单飞；取消会真正 drop 下载 future（不是只隐藏 loading）；跨窗口由 Rust
  会话串行化。移动端不进入应用内更新，提示从 GitHub Releases 手动更新。
- GitHub Actions 在 tag 构建时生成 updater 签名产物；新增 `updater-manifest.yml` 等待四平台产物齐后
  生成并校验 `latest.json`。私钥只通过 `TAURI_SIGNING_PRIVATE_KEY` / `_PASSWORD` Secrets 注入。
- 注意：已发布的 5.4.0 没有 updater，第一个包含本功能的版本需要老用户手动安装一次；详见
  `docs/updates.md`。

### 交互流畅度与运行时可靠性

- 交互反馈：菜单有了退场动画（不再"啪"地消失），菜单项与所有非 `<button>` 的交互元素
  （选项卡、自绘按钮、列表行）补上按压底色；浮层进出场时长收进统一令牌，退场与进场对称，
  `prefers-reduced-motion` 下统一退化为立即显示。
- 操作面板支持下拉关闭并带橡皮筋回弹；文件进度条改用 `transform: scaleX` 绘制，
  不再每帧触发一次布局。
- 事件监听成对解绑：窗口重新绑定与切会话时不再累积监听；群待办与群文件的失败事件
  收进统一监听，不再依赖"用户恰好停在那条会话"。
- 新增全局「正在传输」入口：切到任何会话都能看到还有几个文件在传、整体进度多少，
  点开可看每条的文件名、方向、百分比与进度条；没有进行中的传输时不显示。
- 后端把文件 / 群 / 设置 / 网络类命令里的重活搬出主线程（`spawn_blocking`），
  主线程常驻阻塞调用点从 76 处降到 31 处，并加了一条语义级棘轮（重活函数体里
  没有 `spawn_blocking` 就红）防止回涨。
- 超时回收：`peer_manager` 里"见过一次就永留"的设备身份开始随 `peers` 表超时回收；
  好友身份不受影响 —— 离线好友在下一次 Hello 之前仍然收得到密封消息。
- 通知与辅助窗口的等待队列补了在飞上限，避免对端长时间不响应时堆出无界线程。

## [5.4.1] - 2026-10-22

### 默认头像选择器与资料页对齐修复

- 选择器预览固定在顶部，只有下方表情/背景色选项区滚动；选中环改画在按钮内部，
  色块选中带勾，两项选项行居中，左右边缘不再被滚动区裁掉。
- 资料页头像收到 64px，与右侧输入行 + 按钮行视觉同高、上下居中；
  两个入口按用户口径改成「上传头像」「自定义 emoji 头像」，弹窗标题同步。

## [5.4.0] - 2026-10-22

### 移动端布局、外链导入导出与群历史体验

- 移动端搜索改为整页（底栏隐藏、页面本身不滚，只有结果区滚）；群任务移动端整页铺满、
  看板列表独占滚动；群成员弹窗去掉内层 `max-h + overflow`，只保留外壳一层滚动。
- 收藏列表给每一级 flex 容器补 `min-w-0`：超长文件名现在真正省略，右侧「⋯」仍在面板内可点。
- 长文本溢出检查：收藏行/标题加 `max-w-full`，菜单按钮提升 z 序；其余列表已由既有
  “truncate 必带 title” 判据覆盖。
- 外链支持 JSON 导出、文件导入、线上 JSON 导入（后端拉取，绕开 CORS；10s、3 次跳转、
  256 KiB 流式上限），按 URL 去重合并，导入后立即回填列表。
- 点击消息里的对方头像进入与通讯录一致的好友资料页；群内非好友退到群成员面板，返回回聊天。
- 群历史主动同步补齐进度条；预览失败新增 10 秒负缓存（文件落盘/重新同步即失效），
  避免群历史恢复时缺文件消息反复发起 IPC 造成事件风暴。

### 默认头像配置

- 资料页新增「默认头像」：从与随机算法同一份 emoji × 背景色清单里手动搭配，
  或点「随机一个」；不开放自由输入，选项集与 `avatarSeedFor` 的随机脸同源。
- 确认后把组合编码为 512px SVG data URL，沿用既有头像图片通道（落库、UserInfo 广播、
  Hello 携带），未新增协议字段或数据库列；整串约 0.5KB，仍在 Hello 的 2KB 闸门内。
- 选择器内含大预览、选中态、随机、取消/确认；390 宽下弹窗与两组网格不横向溢出。
  浏览器探针 11 条（含「SVG 真的画出 emoji」与「确认走既有 updateProfile」），
  macOS WKWebView 单独截图确认渲染正常。

## [5.3.3] - 2026-10-22

### 聊天切换动效与收藏 tab 路由

- 会话切换改为「布局落定后整列短淡入」：虚拟列表先贴底，再用 150ms 整列淡入
  遮住布局追赶，不再让消息从上往下铺。
- 图片缩略图与灯箱都移除 `layoutId`/layout 补间：骨架高度变真实高度时不再从底部拉伸；
  灯箱的手势与 reduced-motion 分支保留。
- 移动端收藏列表改为普通一级 tab（`pane: list`），点单条才进详情（`pane: detail`，底栏隐藏）；
  底栏显示条件不再为收藏开特例，收藏页与聊天/通讯录使用同一套 tab 语义。

### 路由架构收口：跨端导航、深链与返回栈

- 路由表抽成纯数据 `src/router/mainRoutes.ts`，新增 memory-history 契约测试：
  15 条正式路径、参数保留、旧深链重定向、未知路径回落、meta 四件套与层级深度。
- 旧路径兼容：`/profile` → `/me/profile`，`/settings(/:key)` → `/me/settings(/:key)`，
  `/logs` → `/me/logs`；移动端 `/links` 归一 `/me/links`，桌面保留 `/links`。
- `/favorites/:favId` 接通：列表→详情 push、详情内切换与删除 replace；
  无效/已删除 favId 在首轮读取后 toast 并回列表；读取失败保留重试，不误判不存在。
- `/search?q` 参与 URL：输入/提交用 replace 同步，外部前进后退回灌输入框；
  命中跳转不再同时触发 close（消除与 replace 抢历史）；无历史关闭回 `/chats`。
- 无效会话/好友深链在首轮数据后校验并回退；校验区分「数据源读取失败」与「对象不存在」，
  IPC 失败时不会把合法深链误跳走；启动恢复/后台异步打开不再覆盖当前会话 URL。
- 路由驱动的日志页、链接页、搜索不再重复注册 `useBackLayer`；一级 tab 切换用 replace。
- 桌面深链 `/me/profile`、`/me/settings(/:key)`、`/me/logs` 映射到独立窗口动作后回聊天，
  不再是静默回落或错误弹窗。

## [5.3.2] - 2026-10-22

### Review 收尾：旧口径清理与设置路由边界

- `SettingsPanel` 改用可空注入获取 route/router：桌面窗口被拖窄成移动布局时，
  分区路由不会因为条件 hook 失效；切换为路由驱动时清空本地二级状态。
- 移动端返回快捷键在设置/日志深链没有历史条目时回落到 `/me`（不再误回 `/chats`）。
- 修正 `NavRail.vue` 中仍指向已删除 `navIconPaths.ts` 的自绘注释。
- 修正 `router/main.ts` 的 history 探测注释（不再按自定义协议分流）。
- `open-source-replacement-matrix.md` 的导航图标行改为 lucide + `navIcons.ts` 的现状。
- 重新生成 `frontend-inventory.md` 的资产清单段。

## [5.3.1] - 2026-10-22

### 移动端底栏 / 滚动条 / 设置路由修复

- 移动底栏从 `fixed` 改为根节点内 `absolute`；页面转场退场壳 `pointer-events: none`，
  修复「点底栏有时候不动」。
- 全端常显 8px 原生 CSS 滚动条（4px 实际滑块）；滚动容器 `scrollbar-gutter: stable`，
  居中内容 `.scrollbar-both`（`stable both-edges`）；移除 macOS overlay 覆盖。
- 移动设置分区接入 `/me/settings/:key`；主窗口的移动设置/日志路径下沉到 `/me/settings`、
  `/me/logs`，避免与 `settings.html` / `logs.html` 在 dev 下撞路径。
- 收藏详情在移动端不再 `inset-0` 盖住底栏：底边抬到 TabBar 之上，详情页里也能直接切换菜单。
- 桌面设置窗口新增可见「返回」与 `Alt+←` / `⌘[` / `Ctrl+[`；桌面三栏与移动抽屉/底栏
  明确为两条渲染分支。

## [5.3.0] - 2026-10-22

### 交互升级：motion-v、Spinner 收敛与性能余项

- 按用户裁决引入 `motion-v@2.8.0`（精确版本）：侧栏/底栏共享布局药丸、消息缩略图 → 灯箱
  共享元素（`layoutId`）、群任务行 FLIP、灯箱手势 `useMotionValue`。业务组件统一从
  `src/utils/motion/` 导入；每处 JS 动画带 `useReducedMotion()` 分支。
- 历史模式统一 web history（`tauri:` / `asset:` 也走；仅 `pushState` 抛错时退 hash）。
- 新增 `ui/Spinner.vue` 并迁移全部 `animate-spin`；reduce 档不再把加载指示器冻成静止帧；
  新增「加载旋转只能在 Spinner」的静态护栏。
- 性能：公告改读 `activeAnnouncements` 缓存（不再每次消息变动扫整段历史）；收藏行数据
  一次算好并加上限；`motion` 拆独立 chunk，vendor 回到约 114 KB gzip。
- 文档：`design-guidelines.md` 新增 §14 交互反馈规范；修正反模式文档 X1/X2；
  `open-source-replacement-matrix.md` 登记 motion-v 的传递依赖、使用面与回滚点。

## [5.2.2] - 2026-10-22

### 下拉菜单统一淡入

- 附件「更多」、会话「+」、右键菜单、状态选择等所有 `.gosslan-menu` 共用一条 140ms
  淡入（只动 opacity，不碰 floating-ui 的定位 transform）；`prefers-reduced-motion` 下关闭。

## [5.2.1] - 2026-10-22

### 路由历史模式：自定义协议防御性降级

- `tauri://` / `asset:` 下直接使用 `createWebHashHistory()`：这两个协议的文档路径不是
  SPA 服务器，`pushState` 与刷新行为未在真机验证。hash 同样产生真实历史条目，
  Android 的 wry 物理返回链不受影响；Windows/Android 的 `http://tauri.localhost`
  仍走 `createWebHistory()`。

## [5.2.0] - 2026-10-22

### 前端路由化 + 全端丝滑体验

- 主窗口接入 `vue-router@5.4.0`（14 条命名路由），设置窗口独立 hash 路由（10 个分区）；
  `navState` / `mobileView` 改为路由派生态，页面级 `useBackLayer` 退役、浮层返回栈保留。
- 修复导航死胡同 D-A~D-F：收藏返回、桌面资料页返回、收藏页关闭、新的朋友状态泄漏、
  桌面不可达分支；新增 `Esc` / `⌘[` / `Ctrl+[` / `Alt+←` 返回快捷键。
- 每会话输入草稿与滚动位置恢复；切会话不再丢草稿，返回时回到离开的那一屏。
- 侧边栏 / 底栏图标统一为 `lucide-vue-next`，选中态改为药丸底 + 主题色 + 弹簧；
  页面转场、设置分区、弹窗、Toast、消息回执与文件进度统一动效令牌。
- 性能：成员资料按行缓存、好友表 Map 查表、链路查询脱离消息条数、长列表头像懒加载、
  文件进度改走合成层。
- 依赖：Vite 7 / `@vitejs/plugin-vue` 6 / Pinia 3；`@pinia/colada` 只装不接线；
  `motion-v` 实测 vendor gzip +46.48 KB 后不采纳（CSS 弹簧已覆盖）。
- 文档：新增《路由与导航层级规范》《前端性能反模式清单》；
  `design-guidelines.md` §11.3 重写并新增 §12 / §13。

## [5.1.2] - 2026-10-21

### 减冗重构（Batch 1）：测试清单 / 正则 / CI / 归档 + Rust 基础设施 + lint 工具链

- `npm test` 从 104 条手工枚举改为 Node 22 的 glob 覆盖制（`src/**/*.test.ts` + `scripts/*.test.ts`）；
  清单守卫反向判「磁盘上每个 `.test.ts` 都被某个 glob 覆盖」，防止 glob 被改窄后测试静默不跑。
- 正则转义只剩 `src/utils/escapeRe.ts` 一份定义；守卫从「查函数形状」升级为「查字符类字面量 + 扫全 src」。
- `CodeBlock.vue` 的本地 `escapeHtml` 统一到 `utils/highlight.ts` 的 `escHtml`；乐观消息临时 ID 改用
  `crypto.randomUUID()`。
- CI：「护栏非空转（全量）」只在定时与手动触发时跑；新增每次 push 跑的 `lint` 腿
  （ruff / shellcheck / markdownlint）与只在定时/手动触发的 `supply-chain` 腿（cargo-deny / cargo-audit）。
- 4 个一次性脚本移入 `scripts/archive/`（含说明 README）；`flatten-ios-icons.mjs` 仍标注
  「上线前仍需执行」，并修正了归档后的仓库根推导。
- Rust：`StartupError` / `SendFileError` 改 thiserror；`cache_cleaner::walk_files` 改 walkdir
  （仍不跟随软链）；logging / export 三份手写 `civil_from_days` 改 `time` 的 UTC 算术；
  测试夹具改用 `tempfile::TempDir`。
- `CHANGELOG.md` 纳入文档引用守卫，并修正 3 处外部 crate 源码引用（rusqlite / mio / tauri-macros）。

## [5.1.1] - 2026-10-21

### 测试：VACUUM 预算用例在满载下不再因计时抖动假红

- 全量门禁在满载跑 1088 条用例时，2ms 预算的实际中止耗时被线程调度拖到 14ms，
  原断言 `< 5×预算` 会假红。判据改为：决定性断言仍是"必须 Aborted"（预算没生效会
  一路跑完并得到 Completed），耗时只设 250ms 的绝对上界 —— 3 秒预算的用户感知仍约 3 秒。

## [5.1.0] - 2026-10-21

### 群文件真断点续传：断链/重启后从已收字节继续，不再整份重传

- 协议新增能力位 `CONTENT_FEATURE_GROUP_FILE_RESUME`、Offer/Chunk/Done 的 `attempt`
  轮次与 `GroupFileResume` 回执：接收端报磁盘上的真实前缀，发送端 `seek` 到该字节续发，
  最终仍走整份 SHA-256 校验。旧端不声明能力位 ⇒ 完全走原路、零行为变化。
- 接收端重启：从 `.part` 重建接收器（分块喂哈希、append 打开）；发送端重启：开机第一拍
  把所有本机 `sending` 行立刻回 `pending`（不必等 10 分钟 stale 阈值），轮次号取启动纳秒
  种子，保证跨进程单调。
- 轮次隔离：上一轮残留分片安静丢弃，不打死整单；Restart 时删旧 `.part`，避免
  "旧字节 + 新字节" 导致 SHA 永远不符的循环；续传分支同样建文件气泡（只在真插入新行时 +未读，
  两条 Offer 入口不再把群未读翻倍）。
- 长传输保护：会话密钥 TTL 在每次 Offer/分片活动时刷新；续传握手等待按"接收端要哈希的
  前缀大小"放大（32 MiB/s 保守折算，封顶 10 分钟），不再固定 15s。
- 验证：续传相关单测 16 条；双实例 e2e `--round=gfile` **28 条断言全绿**
  （Offer→Resume(0)→Chunk→Done→ACK、SHA、气泡、无 `.part`）。
  传输中途断链/杀进程的续传矩阵仍需真机/故障注入验证（见审计 §10.1.6）。

### 群文件发送：并发上限 8，排队无损、取消可穿透

- 全局 `Semaphore(8)` 放在唯一投递入口（传输调度层）：排队成员保持 `pending`，不丢文件、
  不降级；按 `(transfer, recipient)` 的在途闸防止 fan-out 与离线补发叠出两个任务。
- 取消槽位在并发闸之前登记，并在拿到许可后先检查 ⇒ 排队期间点"取消发送"不再被静默丢掉；
  回执/取消槽位都改为 RAII，超时/取消/panic 不漏。
- 验证：源码判据 + 在途闸行为测试 + 单成员 e2e 正常路径；8 vs 200 的内存峰值/吞吐尚无实测。

### 蓝牙：外设事件队列硬上限，积压时受控断链（不静默丢帧）

- 三平台共用的有界队列（64 条，最坏 32 MiB）；满时拒绝入队并通过 `watch` 带外通知，
  消费侧拆掉全部外设路由 + 2–5s 抖动冷却；冷却期帧计数后丢弃并落日志。
- 验证：单测 2 条、Android `--bluetooth` 编译 0 warning；真机溢出/重连需两台带 BLE 电台的设备。

### 崩溃测试现场：保留 30 天，单次 > 2 GB 只清大文件

- `unknown`（没有 `summary.json` / 崩在半路）单独一条规则：超 30 天且未被文档引用才删；
  单次 > 2 GB 时先删最大文件、保留最近修改的那一个；半截目录不阻断清理。
- 验证：`--prune-selfcheck` 30 格全绿（含真盘面实删）。

### 群任务运行态缓存：每群最多 500 条（只裁内存，不删历史）

- `putTodoRows` / `mergeIncomingTodoRows` 两条入口都保留最新 500 条；数据库一行未删。

### 修复：文件发送超时提示 `undefined`、气泡永远停在"发送中"

- `outbox_sweep` 的 `file-failed` 事件改发 `FileFailedInfo { transfer_id, reason }`，
  与前端 `listen<FileFailedInfo>` 对齐；源码判据防止退化回裸字符串。

### 稳定性（同批审计）：锁序、Outbox、VACUUM、增量读、中继守卫

- peers↔db 锁序 5 处反转修复 + 跨锁守卫（0 处嵌套）；群 outbox 逐行判定（按成员独立放弃）；
  群文件 `sending` 卡死收敛；发送完成/中继/群历史登记改为 RAII 守卫。
- VACUUM 增加 3 秒时间预算、进度中止与失败恢复（独立存储模块，异常时库保持原样）。
- TCP 帧增量读取；E2E 的 fd 泄漏、等待窗口与崩溃现场留存修复；`semver.mjs` 去 shell 注入。

## [5.0.42] - 2026-10-21

### Android 签名：注入阶段自检 —— 密码打不开钥匙时 5 秒内失败并点名

- 根因：2026-10-21 的 Android CI 红的真因是
  `KeytoolException: keystore password was incorrect` ⇒ **alias 与密码都非空**（不是少填），
  而是 `ANDROID_KEYSTORE_PASSWORD` 与这把 keystore 的真实密码对不上
  （base64 与密码不是同一把钥匙，或密码本身填错）。
- 为什么会"找不到原因"：Gradle 要等**编译完 5 分钟**才报这一句，而那句话在 runner 的
  step log 里；私有仓库 + 无 token 时外部读不到（403）⇒ 外面只剩 "exit code 1"。
- 改法：注入阶段（拿到 keystore 的第一秒）用 `keytool -list` **自检 store 密码** ——
  通过则继续；失败则**立刻** `::error::` 点名（密码打不开 / base64 与密码必须来自同一把
  钥匙 / 本地自查命令 / 换钥匙要三样一起换）并以退出码 1 结束。
  没有 keytool 的环境只警告跳过，不硬失败。

### CI：Android 失败的原因要能被别人读到（注解是私有仓库下唯一的通道）

- 根因：2026-10-21 的 Android 构建红了，外部只看得到一句
  "Process completed with exit code 1" —— 根因留在 runner 的 `/tmp/gosslan-android-*.log` 里，
  而**私有仓库 + 无 token 时读不到 step log**（实测 `GET /actions/jobs/{id}/logs`
  匿名访问返回 403 "Must have admin rights"）⇒ 注解是唯一能被别人读到的通道。
- 改法（两处）：
  - 签名守卫缺项时**直接发 `::error::`**（点名缺哪个 Secret）—— 不再只留在 step 输出里。
  - Android 构建 step 改为 `continue-on-error` + **另起一步把 Gradle 关键行转成注解**
    （`FAILURE:` / `What went wrong` / `Execution failed` / `❌` 等），
    失败时 job 仍然红，但根因这次**能被别人看到**。

### CI：前端门禁的 20 分钟上限太紧，慢 runner 被掐成 `cancelled`

- 根因：Verify 的「前端测试 / 清单 / 构建」这条腿在 GitHub 的 macos runner 上要 **19m41s**
  —— 正好卡在 `timeout-minutes: 20` 下面 ⇒ 后两轮都被这条上限掐成 `cancelled`。
  而 GitHub 对**超时**给的结论是 `cancelled` 而不是 `failure` ⇒ job 注解里只剩一句
  "Process completed with exit code 1"，极易被读成"产品红"，实际是"慢"
  （本机同一组只要约 2.5 分钟，差的是 runner 算力）。
- 改法：这条腿的上限从 20 分钟提到 45 分钟。**检查强度一字未动**
  （步骤、断言、护栏都没变），只是让"慢"与"红"彻底分开。

## [5.0.41] - 2026-10-21

### Android 签名 Secret：把「空串」和「未设置」一视同仁（少填一个也能跑）

- 根因：GitHub Actions 把**未配置**的 secret 传成**空字符串**（不是 undefined），
  而脚本写的是 `?? storePassword` ⇒ `??` 只对 undefined/null 回退 ⇒
  `ANDROID_KEY_PASSWORD` 留空时 keyPassword 变成 ""（**并没有**回退到 store 密码）
  ⇒ Gradle 在**签名阶段**才报 "keystore password was incorrect"；此时 store 密码是对的、
  keystore 也能正常打开 ⇒ 这个错极难定位。
- 改法：统一走 `envOr()`（空串/纯空白一律当"没配"）⇒ KEY_PASSWORD 不填就沿用 store 密码；
  并且"有 BASE64 但缺 STORE_PASSWORD / KEY_ALIAS"时**在注入脚本里就明确报错、退出码 1**，
  不再让 Gradle 报一个看不懂的错。
- 证据：六个场景本地实测 —— ①四项全填 ②不填 KEY_PASSWORD（正确回退）
  ③KEY_PASSWORD=空串（正确回退）④缺 ALIAS（拒发，退出码 1）⑤缺 STORE_PASSWORD（拒发，退出码 1）
  ⑥完全不配 secret（落开发版钥匙）。变异证明：把 `envOr` 改回 `??` 语义
  ⇒ keyPassword 变 ""（错误真实存在），还原后复绿。
- 端到端：走**发行版 secret 路径**跑完整 Android 构建 **exit 0**（5m59s，双 ABI APK 都出），
  产物 APK 的证书 SHA-256 = `05ecd540…3dc1`，与发行版 keystore 指纹**逐位一致**
  （DN `CN=Gosslan`，不是开发版的 `CN=Gosslan Dev`）⇒ 配好 secret 后 CI 出的就是发行版签名的包。

### Android 签名：从「每次现生成」改成两把固定钥匙

- 根因：`scripts/android/keystore/` 在 .gitignore 里 ⇒ CI 上永远没有本地 keystore
  ⇒ 走"现生成一把"那条路 ⇒ **每次构建出来的 APK 签名都不一样** ⇒ 用户覆盖安装必失败
  （`INSTALL_FAILED_UPDATE_INCOMPATIBLE`），已发出去的包再也升不上。
- 改法（两把固定钥匙）：
  - **发行版**（私有）：`ANDROID_KEYSTORE_BASE64` 等 4 个 GitHub Actions Secrets
    （加密存储，别人看不到，含 fork 的 PR 也读不到）—— 正式对外发版用它。
  - **开发版**（公开·入库）：`scripts/android/keystore/gosslan-dev.keystore`
    —— CI 日常构建与开发者本地用它 ⇒ 签名固定、可覆盖安装。
  - 正式发版（tag → Release）**必须**有发行版 secret：没有就**拒绝发布**
    （workflow 守卫 + 脚本 `--require-release-signing` 双保险）——
    公开钥匙签的正式包，任何人都能伪造同签名的"升级包"顶替你的应用。
- ⚠️ **用户侧一次性代价**：之前那些 APK 是"每次现生成"签的，彼此签名不同 ⇒
  升级到本版起需要**先卸载旧包再装**（报"签名不一致"）；此后就能一直覆盖安装了。
- 顺带：Android 构建失败时把 **Gradle 的真错误**打进 CI 注解（原来只打 `tail -8`，
  注解里只剩帮助文本，根因留在 runner 的 /tmp 里、外部根本读不到）。
- 操作步骤见 `docs/notes/android-signing.md`（含 base64 取法与 4 个 Secret 的填法）。

## [5.0.40] - 2026-10-21

### 跨平台：那条"用户提示可操作"的断言写死了 POSIX 分隔符

- 根因：5.0.38 那批加的 `state::tests::startup_error_message_is_actionable_and_names_the_code`
  把日志目录**写死成 POSIX 形状**（`/data/gosslan/logs`），而消息里那段是用
  `Path::join("logs")` 拼的 ⇒ Windows 上实际是 `/data/gosslan\logs` ⇒ **只有 Windows 那一腿红**，
  macOS 与本地永远绿。2026-10-21 的 CI 在 Windows 腿上抓到（Verify 的 Rust job 失败：
  1024 passed / 1 failed，失败点正是这条断言的第三句）。这是**跨平台盲区**：
  判据在本机全绿，容易误以为跨平台也绿。
- 改法：断言改用**同一个拼法**（`Path::new("/data/gosslan").join("logs")`）⇒ 两个平台都对。
  顺带扫了全仓同类"写死 POSIX 路径的断言"（只剩测试数据里的 `/tmp/…`，不是路径拼接）。
- **产品代码一行未动**：消息里那段路径本来就是对的，错的是判据。

## [5.0.39] - 2026-10-21

### 群文件 ACK 的跨进程恢复：持久化账本 + 事务化收尾

- 根因：群文件 ACK 帧是**一次性**的（对端不会为同一条 transfer 再发第二遍），而落库可能失败
  （SQLITE_BUSY / 磁盘满 / 进程被杀）⇒ 一条**已经送达**的群文件会永远停在"发送中"，
  收尾也没有第二次机会。
- 改法（三步流）：① **先落持久化账本** `group_file_acks`（"收到过"这件事本身必须可靠 ⇒ 这一步也走有界重试，写不进去就不算收尾）；
  ② 再做状态收尾，且收尾在**一个事务**里完成（该 recipient 落终态 + 读全体 recipient 聚合 +
  把发送端气泡写回 `messages`，三者同生共死）；③ 收尾成功才删账本行。
  收尾失败 ⇒ 账本行留着，由**进程级清扫器**每个 tick 重放 ⇒ 进程重启后账本还在 ⇒ **跨进程也能恢复**；
  同一行重放超过 5 次仍失败 ⇒ 按"失败"语义收尾（明确的终态，不留永久挂起）。
- 兼容（用户可无痛升级）：**协议帧与消息格式一个字都没改**（老 peer 与新版本互操作不变）；
  schema **只增一张表**、不删不改任何既有表 ⇒ SCHEMA 每次启动都会补齐，老库升级后自动拥有该表，
  历史数据一行不动；降级回旧版本时这张表被旧程序忽略，不影响任何既有功能。
- 判据：6 条**真故障注入**用例 —— ① 写失败 ⇒ 事务回滚、recipient 与气泡都原样；
  ② **后一步（写气泡）失败 ⇒ 前一步（recipient 落终态）必须被回滚**（原子性的唯一可观察差别，
  变异证明：把气泡写挪到提交之后 ⇒ 该用例当场转红）；③ 账本跨连接/跨进程仍在且能被重放后清空；
  ④ 老库升级后自动补齐账本表且历史数据不动；⑤ 迟到的失败 ACK 不降级已 completed；
  ⑥ 陌生人的 ACK 被拒且不碰任何行。

### 文档收敛：删掉过时件、历史件归档，接手入口只留一份

- **入口只留一份**：`AI_PROJECT_HANDOFF.md` 全面重写（2026-10-21），自带上手所需的
  文档地图 / 技术栈 / 核心机制速览 / 命令 / 验证口径 / Frozen Core / 常见坑 12 条；
  旧版（v1.0.0 快照、§2 功能清单、§7 时间线）整段删除——那类"会被时间冲淡"的内容
  不再本文维护，改由 `CHANGELOG.md` 承担"最近改了什么"。
- **删除 4 份过时件**：`AI_TASK_HANDOFF_20261012.md`（被 HANDOFF 取代）、
  `docs/ARCHITECTURE-EXPLAINED.md`（自标 v4.2.7 快照、行号全漂）、
  `docs/P1-image-out-of-sqlite-overview.md`（零引用的交付说明）、
  `docs/strong-reminder-plan.md`（已被 `docs/acceptance/strong-reminder-final.md` 取代）。
- **历史件归档进 `docs/archive/`**（20+ 份）：两份架构复审快照、4 份带版本号的旧验收、
  9 份 2026-09 的排障/调研笔记、`changelog-archive`（1.2MB）、`docs/audit/` 整目录。
  `docs/archive/README.md` 写明"只作证据、数字会漂、引用前先现算"。
- **导航同步**：`README.md` 的「AI 开发必读」表从 14 行压到 8 行（入口 + 宪法 + 5 份参考 + 1 行按需），
  项目结构树同步到清理后的目录；`docs/AI_ENGINEERING_INDEX.md` 改成"备查索引"（明确写"不要从这里开始读"）；
  `AI_RULES.md` 头部加时效性说明（本文的 v1.0 是范围登记不是版本号）；
  `docs/stability-roadmap.md` 头部加读法（34 万字按节查、不要通读）。
- `docs/large-file-split-plan.md` 里 4 处 `docs/notes/changelog-archive.md` 路径改到归档后的位置。
- 复跑读数：`npm test` 1154/1154、5 个文档守卫（doc-numbers / doc-citations / invariant-hooks /
  invariant-exceptions / domain-map）全绿；`version:check` 绿。

## [5.0.38] - 2026-10-21

### 启动早期 panic 的现场留痕：真因是「路径分裂」，不是「没装钩子」

- 根因：bootstrap 插件把现场文件绑成 `<app_data>/<stem>-crash.log`，而 `Logger` 绑的是
  `<app_data>/logs/<stem>-crash.log`；`CRASH_FILE` 是 `OnceLock`（先到先得）⇒ Logger 那次
  **权威绑定被静默丢弃**，独立通道从此一直写错文件；而用户被指引去发的、诊断包读的、
  下一轮启动判定读的，全都是 `logs/` 那份 ⇒ 现场文件里**一行 `>>>` 都没有**，
  "打开就闪退"永远被读成"异常终止/强杀"。
- 改法：唯一计算点 `logging::log_dir_in` / `crash_file_in`（bootstrap 与 `Logger::new` 同源）；
  绑定分**权威/早期两槽**（权威优先，两个都是无锁读，panic 钩子里不会抢锁）；
  `crash_note_to` 改为返回 `bool`（超 2MB **整份重开**、写失败退 stderr、不再假装写成了）；
  `classify_previous_exit` 新认 `>>> panic @ …`（原来只认 `===== 崩溃现场`）。
- 真机证据（隔离 HOME 起真实 release 二进制）：早期通道落进 `logs/`、`<app_data>/` 下不再产生野文件；
  注入 setup 期 panic ⇒ 进程 **exit 134** 且现场文件里有 `>>> panic @ src/lib.rs:…`；
  下一轮启动判 **`BOOT_PREV_PANIC`**（修复前是 `BOOT_PREV_SILENT_KILL`）。

### 群文件 ACK：终态写失败不再被吞，聚合不再被读失败带偏

- 三个真实误判：① `let _ = update_group_file_recipient(...)`（终态写失败被吞，却继续用内存里的
  结论算气泡）；② `list_group_file_recipients(...).unwrap_or_default()`（**读失败 ⇒ 空集合 ⇒
  `all_terminal` 恒真 ⇒ 一批成功送达的群文件被判 `failed`**）；③ 幂等检查那处同型
  （读失败会让**迟到的 failure ACK 把 completed 降级**）。
- 改法：写入走 `retry_ack_write`（最多 3 次 / 间隔 25ms，**每次之间释放全局 DB 锁**）；
  两处读改为 `match`，失败留 `GFILE_ACK_READ_FAILED` / `GFILE_AGGREGATE_READ_FAILED` 且**不决定终态**；
  聚合抽成纯函数 `group_file_bubble`（**空集合返回 `None` 而不是 `failed`**）；
  气泡写失败留 `GFILE_BUBBLE_PERSIST_FAILED` 且不 emit。
- 判据：真值表 6 格 + 重试策略 3 格（用真实闭包跑出来，不是源码文本断言）。
- 边界（明说，不假装已根治）：持久写失败后账本仍在旧状态，**跨进程恢复仍依赖重放的 ACK** ——
  根治需要加 schema/协议字段，本轮按"不改 ACK 协议与消息格式"的约束没有动。

### 护栏非空转：把「环境不支持」与「护栏空转」分成两个 verdict

- 过去两者走同一个 `False` ⇒ CI 的 Verify 连着红在一条 `GUARD_ENV_SKIP` 上（**真缺陷，
  但诊断是环境限制**：macOS runner 收不到本机 255.255.255.255 广播）。
- 改法：`Case.env_skip`（必须写理由）+ **三层防线** —— ① 不声明的用例遇到环境跳过**仍然判失败**
  （不许免检）；② 声明了的单列成 `ENV_SKIP`、带名字与理由，汇总里**不允许静默**；
  ③ `--strict-env` 可把它重新算回失败（发版/CI 想要"全绿才算过"时用）。
- 证据：同一条用例 **改前 exit 1**（`❌ 1 条不符合预期`）→ **改后 exit 0**
  （`⏭️` 单列 + 理由 + `⚠️ 另有 1 条只因环境未证明`）；`--strict-env` ⇒ exit 1；
  另用真实 `verify()` 验过「不声明仍 FAIL / 声明才 ENV_SKIP / 注入后现场恢复」三条。

### 前端批次（本轮一并入库）：手势去重 / 三态统一 / 图标配色去重

- 长按手势：`ConversationListItem` 与 `FriendListItem` 各有一份逐字相同的状态机 ⇒ 收成
  `composables/usePressMenu.ts`（事件/计时）+ `utils/pressGesture.ts`（纯判据）。
- 三态统一：`StateBlock` 增 `compact` 档，`GroupFilesPanel` / `DevDiagPanel` / `ShareDirectory` 统一走它。
- 图标配色：新增 `utils/fileKind.ts` 的 `fileKindStyle(name, dark)`，群文件面板与收藏页不再各抄一份。
- 另新增 `utils/{singleFlight,safeStorage,escapeRe,textLimits}.ts`、`components/ui/{CharCounter,NavIcon}.vue`
  与对应单测；`scripts/frontend-inventory.mjs` + `docs/architecture/frontend-inventory.md` 是配套盘点。

### 群聊/单聊会话归属收口

- `handle_gossip` 的会话键解析收成唯一实现 `inbound_conversation`：群聊只认非空的 `group_id`
  （`group:{gid}`），单聊才用 `sender_id`；`conv_id` / `conv_kind` / 会话名不再各自 match 一遍。
  **修掉的真实形状是幽灵群键**：旧写法 `format!("group:{}", group_id.unwrap_or_default())` 在目标缺失/空白时
  生成 `group:` —— 消息写进一个没有 id 的群会话、真正的群看不到它，会话列表还多一条空名会话。
  `sender_id` 回退这条路径在 HEAD 并不存在（逐条核对 8 条入站路径 + 前端 `applyIncomingToConversations`
  后确认），所以下面那条变异是**防回归**，不是"修好了一个已经发生的串单聊"。
- 回归：3 条纯函数真值表 + 1 条真实 schema/真实 DB 函数集成用例（群文本/图片/群文件卡片、两群一单聊、
  重复投递、群改名、群历史页、`group_outbox` 帧保真）+ 2 条前端会话摘要隔离用例；单点变异
  （缺目标回退 `sender_id`+`single`）实测转红后逐字还原复绿。

### 群聊归属：把「只有一个定义点」钉成结构护栏

- 上一批收口之后剩下的风险是**函数对、接线错**：真值表只证明 `inbound_conversation` 判得对，
  没有任何东西挡住把归属逻辑重新内联回 `handle_gossip`（最短形状 `conv_id = env.sender_id` ⇒ 群消息进单聊）。
  新增 `handle_gossip_takes_conversation_only_from_the_single_definition`：`inbound_conversation(` 恰好一次、
  会话键必须取自 `target.conv_id`、禁止 `conv_id = env.sender_id` 与就地 `format!("group:")`。
  三条字面量都在**原文**上搜 —— 去空白（`code_flat`）后带空格的语句恒不命中，那是判据自等。
- 非空转：把 `let conv_id = target.conv_id;` 单点改坏 ⇒ 该用例 FAIL（exit 101，报「会话键必须原样取自 …」），
  逐字还原后 SHA-256 与改前一致、复绿。用例已登记进两份平台基线（macos 1032 / windows 1011）。
- `docs/protocol-invariants.md` 新增 **INV-P35**（会话归属只来自目标，不来自发送者），
  钩子把后端 5 条 + 前端 2 条一起挂上（`check-invariant-hooks` 现读 35 条全部可解析）。
- 历史数据只读复核（把本机 `gosslan.db` 连同 `-wal` 拷到临时目录后查，不改原库）：`conversations.kind`
  与键前缀 0 冲突、孤儿消息 0 条、群专属 kind 落进单聊 0 条。单聊里那 6 条 `remind` 是 1:1 抖动功能
  （`commands/chat.rs` 同名分支，载荷带 `shake:true`），不是串会话 ⇒ **不改写任何历史行**。

### 字号令牌收口

- 生产码 `text-[NNpx]` 由 **266 处 / 56 文件** 收成六档语义令牌：`micro`(10)、`caption`(11)、
  `meta`(12)、`body`(13)、`emphasis`(14)、`title`(15)，像素逐档不变；令牌显式 `line-height: inherit`，
  避免 Tailwind 默认行高改变版式。生产码现算 0 处任意像素字号。
- 新增判据 `designGuards.test.ts::㊿ 字号只走令牌`：扫生产码缺席型断言 + 正/反控 + config 六档像素对账。

## [5.0.37] - 2026-10-20

### 有限范围验收收尾：`logs/` 目录权限收紧 + 诊断包的后端出口

- **`logs/` 目录不再是 0755**（§2 那一格）。真机现读的旧形状：`com.gosslan.app` 是 `drwx------`，
  但它下面的 `logs/` 是 `drwxr-xr-x` —— 同机其他用户能**列出所有实例的日志名**（文件名里带实例号，
  列表本身就是一份"这台机器上有谁在跑"的清单）；而早停跑的那个实例留下的 `gosslan-3.log` 还停在
  `0644`，因为启动时那两条 `restrict_to_owner` 只认本轮的 stem。改法是两件，各管一头：
  1. 新建目录走 `private_fs::create_private_dir`（`DirBuilder::recursive(true).mode(0o700)`）——
     mkdir 就把位带上，不留"先 0755 建出来再 chmod"之间那段能被列出的窗口；
  2. 启动时 `Logger::new` 补一次 `restrict_dir_to_owner(dir)` + 扫一遍目录里所有 `*.log` 收成 0600
     （只认 `.log`，别的文件一个都不碰 —— 用户可能把导出包放在同一个目录里，越界改权限比漏改更糟）。
  ⚠️ `create_private_dir` 对**已存在**的目录刻意不改写：`logging::tests::disk_write_failure_is_counted_and_noted_in_memory`
  靠"把目录调成只读"制造落盘失败，如果建目录时顺手 chmod 回去，那条判据的失败机制会被产品代码静默修好。
  Windows 侧不做任何事（app data 在 `%APPDATA%` 用户 profile 下，ACL 本来就只授该用户与 SYSTEM）；
  Android 走 `cfg(unix)` 这条路，私有目录由系统给 0700。MSRV 1.77：用到的 `DirBuilderExt::mode` 远早于它。
  判据：`private_fs::tests::create_private_dir_makes_0700_and_leaves_an_existing_dir_alone`（两格分开证）、
  `logging::tests::log_dir_is_tightened_at_startup_and_covers_stale_logs`（含"不是日志的文件不许动"那格）、
  `logging::tests::rotated_logs_keep_owner_only_permissions`（轮转后两份都 0600，前置条件自己断言"真的翻过一代"）。
  非空转：三处各做一次单点改坏（摘掉启动 chmod / 摘掉 mkdir 的 mode / 摘掉 append 里的文件 chmod），
  三条判据分别 FAIL，原样恢复后全绿，两个文件的 SHA-256 逐字节核对一致。

- **脱敏诊断包的后端出口**（§3）。新增 `src-tauri/src/diagnostics.rs`（纯函数 + 自己的单测）与两条命令：
  `get_log_locations`（目录 / 本轮那份 / 崩溃现场三条真实路径，供界面显示与"复制路径"）、
  `export_diagnostics_bundle(destination)`（读那三份 → 逐行脱敏 → 写到**用户在保存对话框里选好**的路径，
  整块在 `spawn_blocking` 里并且等它）。脱敏的五类形状不是猜的，是 2026-10-20 从真机
  `…/com.gosslan.app/logs/*.log` 里现读出来的：设备指纹 `[dev:…]`（含机器名）→ `[本机]`、
  IPv4 `192.168.31.229` → `192.*.*.229`（**留首尾两段**是刻意的：`send_bind` 与组播 `…255` 只差最后一段，
  全糊掉就查不动"广播发到哪"，一位不糊就把网段交出去）、对端 id `gosslan-044bb98f6d33b-i1` →
  `gosslan-044b…-i1`、BLE 端点 `ep=ble:312FF2DD-5BC5-…` → `ep=ble:312F…`（CoreBluetooth 给外围设备的
  **稳定**标识 —— 对端换了随机蓝牙地址它也不变，留着它等于交出"这台机器见过哪台手机"；这一条是
  写完前四条之后回头翻真机日志补上的第五个形状）、家目录 → `~`。反向那一格也钉住了：版本号 `4.44.0`、
  `bytes=379`、不足 16 位的短 hex 段都不许被啃（只产纯文本，理由与 `export.rs` 同一口径 ——
  日志里可能带着对端送来的内容，渲染成 HTML 等于自己造 XSS 通道）。空指纹 / `HOME=/` 这类退化输入必须跳过替换，
  否则 `replace("")` 会在每个字符之间插值 —— 那不是脱敏，是销毁证据。
  **本轮没接上的是界面那一格**：能放按钮的 `SettingsWindow.vue` / `LogViewer.vue` / 两份语言包
  此刻正被另一条工作线改着，按"不覆盖别人在飞的文件"的口径，两条命令按 `src/api/events.test.ts`
  自己留的那个出口挂进 `DEAD_COMMANDS` 并写明归属（那条判据会**自动过期**：前端一旦真 invoke，
  `resurrected` 那一格就判红逼着删条目）。接口、归属与验收条件写在
  `docs/notes/diagnostics-where-logs-are-2026-10-20.md` 第 4 节。

- **更正 + 第二次跑（§6.12.2）**：上一条里"687 ms 打开设置"经自己留下的时间线复核**并不在大文件传输窗口内**
  （实例 01:09:46 起、按键 01:09:47–48，大文件在其后的步骤才开始跑），表格那一格已按此改口径。第二次跑改用一个
  外部门闸（现读 `recv/*` 字节在两次 0.2s 轮询间从 1,048,576 涨到 6,291,456），量到增长之后再测：
  两个实例进程的 AX 往返各三次 **166/153/163 ms** 与 **142/141/133 ms**；`--round=gfile` 600 MB 全绿 28 条断言；
  内存 app 组 120,224→峰 **224,128**→末 96,048 KB、webContent 组 77,408→峰 **304,480**→末 55,312 KB（覆盖 125/125）。
  两次（200 MB / 600 MB）的 WebContent 峰值 287,280 / 304,480 KB 几乎不随载荷涨、结束后都落回基线以下 ⇒ 仍然只是
  "没观测到"，不是"没有"。原先挂着 NOT RUN 的两格后来都补成可判读读数：**传输期间打开设置 PASS**（增长门闸命中后当场重新枚举
  pid —— 上一轮失效就是因为缓存了会被驱动重启换掉的 pid，两个实例进程各命中一次：948 ms 与 826 ms，窗口名
  `Gosslan`→`设置, Gosslan`）；**传输期间切换会话 PASS**（像素判据：点侧栏 `(370,350)` 后聊天区截图哈希
  82bb47fccc84→368a14c295df、669 ms 内变化；同轮先做屏幕录制正控，应用区与边角两块哈希不同才认这条判据）。
  三次跑的 WebContent 峰值合起来看：200 / 600 / 800 MB → 287,280 / 304,480 / 361,664 KB，结束后均落回基线以下。
- **CI 那条红的日志原文**：本机 `/logs` 要认证取不到，改用公开可读的 check-run 注解，拿到
  `❌ 发现 socket 必须收得到广播… ⇒ 改坏之后测试因环境不支持而跳过（GUARD_ENV_SKIP），非空转在此环境无法证明（不等于护栏空转）`
  与 `❌ 1 条不符合预期` —— 233 条里只有这 1 条。这证明上一夜那行 `--nocapture` 生效（不再被误判成空转），
  残留那一格是**环境没有可用广播路由**：本机网络掉出去那一刻日志里就是 `diag/broadcast_error … Can''t assign requested address (os error 49)`，
  同一条用例本机独立复跑是 PASS。"要不要让环境跳过不判红"是口径问题，本轮断言/阈值/锚点一字未动，交负责人拍板（§6.12.3）。
- **200 MB 传输期间的界面应答（§4 那一格的真实读数）**：`E2E_FREEZE_MB=200 E2E_FREEZE_S=60 node scripts/e2e-multi-instance.mjs --fault=peer-freeze`
  全绿 24 条断言；发送端 `Cmd+,` 之后 687 ms 出现设置窗，冻结窗口内三次 AX 往返 210 / 176 / 171 ms ⇒ 主线程应答正常；
  内存按 pid 算的 `driftSecondMinusFirstHalfKb` 全部为负（主进程 −4,358 / −8,173 KB，WebContent −381…−5,989 KB），
  组峰值 203,232 / 287,280 KB 是 `ps` 的 rss 且一组里 pid 会换 ⇒ **不许读成"同一条曲线涨到 281 MB 又跌回来"**。
  **接收端 UI 卡死这一格本轮既没复现也没排除**（那一次的形状是"对端正常但慢"，这一轮的接收端是被 `SIGSTOP` 冻住的注入设定）；
  JS 堆 NOT RUN（WKWebView 无 CDP）；"切换会话"点击发出去了但没有可判读数 ⇒ NOT RUN（缺判据，不谎报）。
  同一次跑还顺带读到 §2 的后效：`logs/` 变 `drwx------`，目录里每一份 `.log`（含 10-18 起没人写过的 `gosslan-3.log`）都是 `-rw-------`。

## [5.0.36] - 2026-10-20

### 生产诊断补齐：落盘失败可见、上次退出可判、后台任务不再丢证据

- 落盘不再静默：`Logger::append_file` 由「IO 失败一律 `let _ =` 掉」改成返回 `Err(原因)`，
  调用方计数 + 第一次把降级说明送进内存环（`warn [boot] 日志落盘已降级：…`）。盘满类错误
  （ENOSPC `28` / Windows `112`/`3900` / EDQUOT `122`）进入 **256 行退避窗口**，窗口内不再试写。
  为什么不做「每条查一次可用空间」：`statvfs`/`GetDiskFreeSpaceExW` 要么要新依赖、要么只在
  `bluetooth` feature 的 Windows 构建里才有 `windows` crate，而**第一次写失败就是最准的信号**。
  裸 OS 码而不是 `ErrorKind::StorageFull`：后者稳定于 1.83，本仓 `rust-version = 1.77`，
  clippy 的 `incompatible_msrv` 会直接把它判成 error。
- 上次怎么结束的现在可判：新增 `----- 正常退出 <时间> 运行 <id> -----` 路标（托盘「退出」与
  `RunEvent::Exit` 两处），加 `classify_previous_exit` 四态判定（正常 / panic 现场 / **异常终止** / 无历史）。
  判定行**同时写进日志文件**，只发文件的用户也拿得到结论。边界如实写着：`kill -9`、OOM、掉电
  这三类在进程内部不可能留痕，只能按「有启动、无退出、无崩溃块」的缺席归类，**不许**细分成哪一种。
- 每条日志的关联：`Logger` 新增 `run_id`（本轮进程标识），写进「启动」与「正常退出」两条路标，
  多实例 + 快速重启的现场文件能按 run 切开。
- 后台网络任务不再丢证据：`await_tasks` 原先 `let _ = t.await`（`JoinError` 直接消失）、
  超时只 `eprintln!`；现在两者都进日志（`warn [net_task]`）。
- 「查看最近错误 / 导出脱敏诊断包」这一格**本轮不交付命令面**（写成做过就是假字段）。原因不是没实现，
  是接不完：契约判据 `mapContract.test.ts` 要求每条 `invoke` 既有注册、又有**真实调用方**，
  而能放按钮的 `LogViewer.vue` / `DevDiagPanel.vue` / `ResponsiveLayout.vue` 与两份语言包此刻全是
  并行前端会话在飞的 `M` 文件 —— 本轮不覆盖别人的文件，也不留一条没人调的 API。
  当下可用的替代路径写在 `docs/notes/diagnostics-where-logs-are-2026-10-20.md`：
  界面里「运行日志」窗看最近错误（内存环 500 条）+ 按文档给的目录手工取那三份文件。
  下一步由那条前端线的负责人一次做齐：命令注册 + 契约图 IPC 行 + 按钮 + 两份语言包键。
- 新增 5 条 Rust 用例把这几格各自钉住（998 条全绿，基线按平台重同步）：
  `previous_exit_is_classified_by_presence_and_absence`、
  `exit_marker_lets_next_run_read_previous_as_clean_and_absence_as_abnormal`（正控 + 反控 + 落盘核对）、
  `disk_write_failure_is_counted_and_noted_in_memory`（`0500` 目录逼出真实写失败：计数、降级只进一次、
  两条日志都还在环里）、`startup_marker_carries_the_run_id`、
  `failed_background_task_leaves_one_named_warning_while_a_clean_one_leaves_none`
  （正控 = 干净退出的任务**不许**产生 `net_task` 记录，否则这条判据在任何实现下都绿）。
  其中"退出路标写了却没加进 `is_crash_native_line` 过滤器 ⇒ 永远判成异常终止"这一条是**用例抓出来的真缺陷**，
  不是先修好再补测试。`net_task` 那条做过单点变异：把 warn 那一支摘掉 ⇒ 判据红（实测「0 条」），
  原样写回 ⇒ 判据绿，`diff -q` 证复原。
- 实测（release 二进制 + 隔离 HOME）：`kill -9` 后下一轮日志文件里出现
  `warn [boot] 上次收尾判定：异常终止 —— 只有启动路标…`；把在用库截断后同一文件里出现
  `error [file] … database disk image is malformed`（生产构建的 Rust 失败确实落盘）；
  同一份 release 二进制里**前端那一跳也实测到了**：主窗口入口用一次性探针抛一条未捕获异常 + 一条未处理
  rejection，日志文件里出现 `warn [ui] [前端 error] Error: DIAG-PROBE-5036 未捕获异常`（行尾带 `@ tauri://localhost/assets/main-*.js:26:33282`） 与 `warn [ui] [前端 rejection] …` ⇒ §3 那条验收底线两端都闭合（只注册 hook 不算，
  这次是文件里有行）。**探针没有入库**：跑完按字节还原（`cmp` + `git diff --quiet` 各证一次）⇒ 这一格的形状是
  "实测过的链路"，还不是"界面上可复现的按钮"，后者仍是 §6.11.1 那 5 件收尾。
  启动路标实测带 `版本 5.0.36 · macos-aarch64 · release · … · 运行 dc7085`（三条 run 各自不同 id）。
  **SIGTERM 也接不住**：`kill -TERM` 之后下一轮同样读成「异常终止」⇒ 退出路标只由应用内收尾
  （托盘「退出」/ `RunEvent::Exit`）写，凡外部信号杀进程都归到缺席那一类 —— 这条边界是实测出来的，
  不是推测。权限现读：两份日志文件 `-rw-------`、`com.gosslan.app` `drwx------`，
  而 `logs/` 目录本身 `drwxr-xr-x`（日志层只给文件设 0600；保护来自父目录那一层，已写进用户文档）。
  内存侧新增 `scripts/mem-sample.mjs`（主进程与 `com.apple.WebKit.WebContent` 分开采，**按 pid 记轨迹** + 写覆盖率）。
  单实例长跑实测（1 Hz，227/227 点全覆盖，活 235 s）：主进程 104,688 → 峰 104,752 → 末 101,776 KB
  （后半段均值 − 前半段 = **−667 KB**）、两个 WebContent 分别 −1,932 与 −4,069 KB ⇒ 这一窗口内两侧都不回涨。
  ⚠️ 这不等于"没有泄漏"：RSS 不是 JS 堆（**JS 堆 NOT RUN**，WKWebView 无 CDP），4 分钟也不是数小时。
  传输负载下的轨迹**采不到**（群文件那轮实例只活几秒，两轮分别只覆盖 1/83 与 0/457 个采样点 ⇒ BLOCKED）、
  界面卡死**没复现**（release 下没有可注入通道 ⇒ NOT RUN）、十处无界增长点逐个容量核对**没做** ⇒ NOT RUN。
  第一版量具的坑也记进文档：分组求和的 `baseline/final` 会被"两端恰好没进程"污染成 `0/0/0`，
  看着像"已恢复"—— 修的是量具，不是读数。
- 护栏一条诊断修正：`发现 socket 必须收得到广播` 那条用例的 `cmd` 补 `-- --nocapture`。
  cargo 不打印**通过**测试的 stdout ⇒ 测试自证的 `GUARD_ENV_SKIP` 传不到 runner，
  真机才有效的护栏在 CI 上被误判成「空转」。断言/阈值/锚点一字未动，这条 job 仍然红（runner
  对两种形状都判 False），差的只是诊断说不说真话。

## [5.0.35] - 2026-10-19

### 后端：三处收尾事务补上耗时出口（B15），全量护栏首次接进 CI

- 事务观测：`db_hold::note_tx` 给群文件收尾 / 单聊收尾 / 群台账补账三处生产事务各记一行
  `tx <阶段> transfer_id=… ms=… ok=…`；阈值沿用 `DbLock::slow_threshold_ms`（500ms，同一个家，
  不另造常数），**只在超阈值或失败时留痕** —— 既有不变量
  `network::file_tests::normal_completion_writes_no_ledger_note` 钉的是正常收尾一行都不许写，
  这条没有为了通过而被改；快且成功的事务耗时本来已在 60s 锁摘要（最长持有/累计）里。
  出口不取锁、不重试、不碰 commit/rollback 与错误语义；行内没有 SQL、参数、正文、文件名或密钥。
- 判据两条：行为 `db_hold::tests::note_tx_stays_quiet_unless_slow_or_failed`；接线
  `tests::production_transaction_sites_are_all_timed`（每册 `.transaction()` 调用点数=1、
  `note_tx` 调用数=1、必须有计时起点、阈值必须取自 `slow_threshold_ms()`，并钉住出口那一句的
  `format!` 形状）。单点变异实测：把 `receive.rs` 的埋点改成合法但不匹配的写法 ⇒ 接线判据
  **exit 101** 并指名那一册；还原后与备份逐字节相同 ⇒ 两条判据各自 **exit 0**。
  Rust **993 通过 + 1 ignored**（macOS 基线 994，`check-test-manifest --only rust` ✓）。
- CI：`.github/workflows/verify.yml` 新增 `guards` job，直接执行
  `python3 scripts/verify-guards.py`（**不带 `--only`**，条数由该工具自己打印）。此前全量护栏
  非空转**没有任何自动触发点** —— CI 三个 job 走 `--group frontend/rust/android`，而护栏那一步
  在这些路径上传的都是 `--only frontend`。同一批加入 `schedule`（UTC 19:20），其余三个 job 在
  schedule 事件下跳过以免夜间重跑；不设 `continue-on-error`，红就是红。
  ⚠️ GitHub 的定时工作流只按**默认分支**上的定义运行 ⇒ 这条要等进 main 才按夜持续生效。
- 领域边补声明：`network/transport.rs` 显式 `use crate::db_hold::note_tx;`，`docs/domains.data.mjs`
  把 `observability` 加进「传输」域的 `consumes`。起因是 `check-domain-deps.mjs` 的第 13 步当场红
  ——内联 `crate::db_hold::…` 让"判据看不见的内联跨域引用"从 6 对涨到 7 对；按该判据自己给的
  修法改成声明出来的 use，**棘轮上限没有调大**（复跑 exit 0 / 6 对）。
- 文档：`docs/architecture/backend-modernization.md` §6.10 的 B15 由"待开工"改为已落地，
  §6.7 加本批实测读数与变异自证，§6.8/§7 把"全量护栏无人跑"改判为"已接入、远端首跑待读"。

## [5.0.34] - 2026-10-19

### 前端：三处锚定浮层收进 Reka、划选/空态/错误出口三处真实缺陷、两个手抄分母改现算

- **通用自研实现删除**：`utils/hoverCard.ts`、`utils/popupPosition.ts`、`composables/useHoverCard.ts`
  连同各自测试整册移除（−286 行），表情名单 / 已读名单 / 表情选择器 / 输入框表情面板四处改由
  Reka `HoverCard` + `Popover`（floating-ui 定位、DismissableLayer 管 Esc 与外点）托管；
  `EmojiPicker` 不再自己 `absolute` 摆位，方向 prop 一起删掉。
  仓内现在只剩**禁止这些写法复活**的断言，没有实现残留。
- **三处真实缺陷（都来自真实窗口/真浏览器读数，不是探针通过率）**：
  ① 划选文字划过头像或图片气泡会被浏览器改成"拖图片"⇒ `style.css` 全局
  `img { -webkit-user-drag: none }`（此前全仓 26 个 `<img>` 只有 2 个自己写了 `draggable="false"`）；
  ② 通讯录页空态复用聊天空态的「发起聊天」⇒ 点下去只是把 `navState` 再赋一次，按钮活着而什么都不发生，
  改为通讯录专属文案 + 「添加好友」；
  ③ 字体「系统默认」档用空串当 `SelectItem` value ⇒ Reka 直接吞掉这一项，菜单少一档、触发器一片空白，
  改为非空哨兵并在落库前映射回空串。另外群任务看板 4 处 `toast(String(e), "error")` 统一走
  `toastError`（原始串不再甩给用户，且进日志）。
- **判据侧两处"绿但不守住"**：图标白名单与窗口登记表都是**手抄分母** —— 前者比入口少两个名字，
  已漏掉两处直连 `lucide-vue-next` 的真实违规；后者只要新增一扇窗没登记就整批照绿。
  两处改为从 `ui/icons.ts` / `src/entries/` 现算，并各配一次单点变异证明。
- **提交前双轴审查又捞出两条**（报告 §6.30）：恢复两条被误删的 `SelfAvatar` 非空转用例（231→**233**）；
  `MessageReactionBar` 的"开着哪一颗"原有第二条状态源 ⇒ 指针在 `open-delay` 内快速进出时
  `aria-expanded`/`data-open-emoji` 会停在 true 而名单从未渲染，改为纯派生（三 ref + 一个函数 → 两 ref + 一个 computed）。
- **读数**：`npm test` **1048/1048、exit 0**；`npm run verify` 快速层 **17/17、18.5s、exit 0**；
  UI 探针 `--only=reaction,roster,touchroster` **70/70、exit 0**（全量 396/396 在同批次早前树上跑过）；
  恢复的两条用例各 `--only <名片段>` **1/1、exit 0**；真实 WKWebView 已补已读名单 `AXPress` 点开/收起与
  390×768 窄窗移动端布局，并修掉 `ax-tree.mjs` 不认 `AXPopUpButton` 的取证盲区。
  Windows / Android / iOS / E2E 与预览窗口真机点击 **NOT RUN**。明细见
  `docs/architecture/refactor-5.0-report.md` §6.22–§6.30 与 `open-source-replacement-matrix.md` 第 4 节。

## [5.0.33] - 2026-10-19

### 修复：多链路建链窗口内离线消息不重试（A-17）

- 5.0.32 标准 E2E 全套复跑中，contentpull 首跑步骤 5「A 侧 outbox 被 Ack 删除」
  **30.1s 超时（1/4）**；失败轮 B 库零消息、A 气泡仍 `sending`，A 侧同时有
  LAN×2 + Routed 三条到 B 的链路。`flush_outbox` 只在建链/Hello 触发，且
  `try_send` 的错误被忽略 ⇒ 那个窗口里没真正发出去的消息会一直等下一次链路事件。
- 新增 `AppState::spawn_outbox_retrier`：每 **5s** 对**当前有链路**的 peer 重放
  `flush_outbox` + `flush_group_outbox`；收端按 `msg_id` 幂等，Ack/GroupAck 才删行。
  文件队列不在此重放（自有 attempts/退避/5 次上限）。
- 判据 `outbox_retrier_is_wired_and_covers_both_queues` 钉唯一接线、周期、按链路筛选、
  两个队列都覆盖；两次单点变异（摘启动调用 / 摘群队列重放）均按预期报红、还原后绿；
  Rust **991 通过 + 1 ignored**，基线 992（Windows 975）。
- 5.0.33 release 上 contentpull **×3 全部 36/36 绿**，未再出现文本 Ack 超时、未出现重复消息；
  5.0.33 回归：default **18/18**、group **37/37**、posttext **39/39**（重放未引入重复消息/会话覆写）；
  其余 E2E/真机 **NOT RUN**；干净 worktree `verify:local` **22/22**（1089.0s，冷 target）；
- 远端 CI @`519d473`：macOS 构建、Windows x64+ARM64 构建、Android APK、Rust 双平台单测
  全 success；Verify 唯一红是**前端**“操作面板”护栏空转（1 条，前端范围，非后端腿）。
  本地复现同一 Case：手工摘 `@click` 后 `npm test` 确实失败 ⇒ 测试非空转，问题在 guard
  runner/CI 对该用例的注入/判定路径，待前端负责人查。
  Windows 5.0.33 交叉编译 exit 0（**14m27s**，冷 target，PE32+ GUI x86-64 9.6MB）。

## [5.0.32] - 2026-10-19

### 可观测性：SQLite 锁等待/持有时长进入运行日志

- `DbLock` 早已逐次量 wait/hold，但 `take_summary()` 此前只有测试在读 ⇒ 现场看不到
  锁竞争。新增 `AppState::spawn_db_hold_reporter`（60s 周期，`DbLock` 的唯一生产读者）：
  空窗口不产行；慢持锁（默认 ≥500ms）时 warn 一行，含取锁次数、最长持有、最长等待、
  累计持有、超阈值次数；不含 SQL、参数、文件名或正文。
- 判据 `db_hold_summary_has_exactly_one_production_reader` 钉住唯一读者、唯一启动点、
  阈值来源与日志出口；两次单点变异（摘启动调用 / 摘唯一读取点）均报红、还原后绿；
  Rust **990 通过 + 1 ignored**，基线 990→991（Windows 973→974）。
- 不改锁语义、DB、协议；干净 worktree `verify:local` **22/22**（165.0s）；E2E/真机 **NOT RUN**。
- 定点护栏 3/3：文件气泡不整文件扫描 / outbox 终态写库门控 / transport 锁抗中毒，
  均改坏即 FAIL、恢复即 PASS（干净 worktree 5.0.32）。
- E2E 全套在 5.0.32 上复跑发现 **A-17（OPEN）**：contentpull 首跑步骤 5 文本 Ack
  **30.1s 超时（1/4）**，同二进制连续 3 次复跑 36/36 绿；失败轮 A 侧有
  LAN×2 + Routed 三条链路；未根因、未改产品码。
- 旧/新互操作在 5.0.33 上重跑（4.44.4 从 tag 本地构建，暖 target 3m47s；冷 7m57s）：
  default 18/18×2、group 37/37×2、gfile 28/28×2、gossip3 25/25×2，
  合计 **8 轮 / 216 断言全绿**；两侧 DB_VERSION=11。
- Windows 交叉编译在 5.0.32 代码上复跑：`cargo xwin build --release` exit 0 / **8m38s（冷 target）**，产物仍为 PE32+ GUI x86-64 9.6MB；运行时 **NOT RUN**。
- UI 响应性复测（5.0.32 release）：600MB contentpull 传输中，接收端设置窗口 **397ms**
  可开（System Events 激活 + Cmd+,，窗口名 `设置`/`Gosslan`；探测后立即停轮，
  只证响应性）。历史 300MB 读数为 734ms（5.0.29）。
- 真实数据 + 真 v10 schema 迁移演练：把真实库副本的 `messages` 按逐字 v10 DDL 重建
  （无 `mention_targets`）后跑生产 `init`：迁移前备份 tables=19/integrity=ok，
  迁移后 v11、列新增、56/56 行为 NULL（不回填）、19 表/208 行保留、integrity=ok。
  边界：数据来自真实库、schema 是逐字 v10 DDL，但**不是用户直接提供的 v10 现场**。

## [5.0.31] - 2026-10-19

### 修复：原件事后变小后，发送侧台账与气泡的 `size` 跟实发字节走（A-11）

- `src-shrunk` E2E 实测：入队后原件被截断到 4096 B，线协议、落地内容、sha、两侧终态
  都正确，但发送侧 `file_transfers.size` 与气泡 `content.size` 仍是入队时的 1048576
  —— `upsert_transfer` 的冲突分支只更新 status/path/progress，气泡则从未回填。
- `upsert_transfer` 冲突更新同步 `size = excluded.size`，保留 `WHERE status <> 'done'`
  （已完成行仍不许被晚到写入降级或改尺寸）；新增 `db::fill_message_size`，与
  `fill_message_sha256` 同一形状（幂等、缺行/非 JSON 静默跳过、返回是否真的改了行）。
  发送入口用实际 `metadata.len()` 回填气泡；任一字段变更时重发 `message-received`，
  让前端内存里的那条记录同步到真值（与 v4.22.16 的 sha 回填同一道理）。
- 单测先红后绿三条：`transfer_upsert_keeps_size_in_sync_until_done`、
  `fill_message_size_backfills_the_actual_size_once`，以及失败收尾的
  `a_failure_finalize_keeps_the_known_transfer_size`（终态写入传 size=0 是“不知道”，
  必须沿用台账已知值，否则新同步逻辑会把失败单抹成 0）。Rust **989 通过 + 1 ignored**，
  基线 987 → **990**（macOS；Windows 970 → 973）。
- E2E `src-shrunk` 补两条断言（A 台账 / A 气泡 size == 实发字节），5.0.31 release
  复跑 **26/26 ×3**：入队 1048576 → 实发 4096，A 气泡/A 台账/B 台账均 4096；
  默认轮 **18/18**（文件链回归）、失败路径 `recv-readonly` **24/24**；同一终态 release
  回归受 size 同步影响的文件链：`kill-mid` 25/25、`sender-kill-mid` 26/26、
  `peer-freeze` 24/24、`multi-file` 29/29（含两发送者→一接收者的三实例同名并发）、`poison-part` 22/22、`resume-prefix` 23/23、
  `recv-dir-rotted` 24/24、`gfile` 28/28（首跑为 cargo 默认 toolchain 环境噪声，显式
  `RUSTUP_TOOLCHAIN` 复跑绿）；contentpull 增 A-16 受众闸（非好友同群仍按 cid 服务）
  **36/36**；干净 worktree `verify:local` **22/22**（64.4s）。
  其余 E2E 轮次与真机仍按 **NOT RUN**。
- 汇总口径更正：24 个门禁 E2E 步骤逐轮现算 **647** 断言（旧写法 661 多计 14），
  加互操作 216 = **32 轮 / 863**；24 轮已在 5.0.31 终态 release 上全部重跑。
- Windows 交叉编译打通：官方 LLVM 18.1.8（macOS ARM64）提供 `llvm-rc`/`llvm-lib`/
  `lld-link`，`cargo xwin 0.23.1` 下 check 42.6s、release 2m39s 均 exit 0，产物
  `gosslan.exe` 9.6MB（PE32+ GUI x86-64）。**运行时仍 NOT RUN**（无 Windows 主机/Wine）。
- 真实数据副本 v10→v11：真实库只读副本置 v10 后跑迁移演练，备份校验 tables=19/
  integrity=ok，迁移后 19 表/208 行保留、`integrity_check=ok`；副本列已存在 ⇒
  `ALTER` 幂等跳过（真正加列由逐字 v10 DDL 夹具覆盖）。真实 4.x 用户库仍 **NOT RUN**。
- 真实数据副本：本机真实安装库的只读 `.backup` 副本用 5.0.31 启动 7s，前后
  `user_version=11`/`integrity_check=ok`、8 张主表行数与 6 组语义聚合逐项相等，
  目录/库权限收紧为 **0700/0600**；源库未写。该库已是 v11，**不是**真实 4.x
  用户库的 v10→v11 schema 迁移（后者仍 **NOT RUN**）。

## [5.0.30] - 2026-10-19

### 安全：应用数据目录收紧到仅属主可进入

- `AppState::init()` 解析出 app data 目录后调用 `private_fs::restrict_dir_to_owner`：
  Unix 上收紧到 `0700`。文件 `0600` 挡住读取，这条再挡住同机其他用户 `ls` 出
  备份名、日志名与实例库名。非 Unix 无操作；失败只告警、不阻断启动。
- 新增 1 条 Unix 判据：临时目录从 `0755` 收紧到 `0700`；Rust **986 通过 + 1 ignored**，
  基线 986 → **987**。E2E/真机 **NOT RUN**（本批只改启动期目录权限）。

## [5.0.29] - 2026-10-19

### 修复：文件发送成功后统一清理 `file_outbox`

- E2E `sender-kill-mid` 实测：发送端在飞时被 SIGKILL、重启续传完成后，两侧 `file_transfers`
  都是 `done`、文件 sha 正确，但发送端 `file_outbox` 仍残留 `pending` 行 ⇒ 清扫器会在
  下次建链再投一次（重复投递），界面也可能永久停在“排队中”。
- `finalize_send_accepted` 现在对**所有成功路径**（正常 `FileCompleteAck`、`AlreadyHave`
  快路、重启续传/内容拉取等）统一调用 `drop_sent_outbox_row`（按 `transfer_id` 幂等；
  直接发送没有队列行时 no-op；删除失败照旧留痕）。`flush_pending_files` 原有调用点保留。
- 加强源码守卫：成功收尾函数必须包含 `drop_sent_outbox_row(`；Rust **985 通过 + 1 ignored**。
  E2E `sender-kill-mid` 复跑见该轮读数；E2E/真机其余项仍按 NOT RUN 标注。
- E2E 扩展（隔离 HOME，release 5.0.29）：**18 轮 / 513 断言全绿** —— default、
  contentpull 40MB/300MB、kill-mid、peer-freeze、multi-file、gossip3、sender-kill、
  recv-readonly、group、gfile、ghsync、recv-dir-rotted、src-shrunk、lanoff、
  posttext、task、dmreaction；group 用 AX 读到 `[有人@我]`/6 未读。`gfile` 首跑为
  `cargo build --example e2e_peer` 的 toolchain 环境噪声，复跑绿。
- 旧/新二进制互操作（4.44.4 release ↔ 5.0.29，A/B 双向）：default **18/18 ×2**、
  group **37/37 ×2**、gfile **28/28 ×2**、gossip3 **25/25 ×2**，合计
  **8 轮 / 216 断言全绿**；两侧 DB_VERSION=11。未覆盖真机与 4.x 用户库实迁移。
- 续传/崩溃扩展：`poison-part` **22/22**、`resume-prefix` **23/23**、
  `groupcrash` **26/26**、`gossip-late` **23/23**、`stall-mid` **25/25**、`disk` **18/18**。
  标准轮合计 **24 轮 / 650 断言**，加互操作共 **32 轮 / 866 断言全绿**。
- 反向自证：`--negative`（幽灵收件人）投递断言如期红、进程 exit 0；
  `kill-mid-lie` 两条断言按设计红（期望 6291457/实际 6291456、sha 不符）——
  EXPECTED RED，不是产品失败，证明正向 `kill-mid` 25/25 非空转。
  `sender-kill-mid-lie`（expect 0000…/actual 20492a…）与 `recv-readonly-lie`
  （expect done/actual failed）同样按设计红。
- 依赖安全审计：`cargo audit --file src-tauri/Cargo.lock` **exit 0、0 个漏洞**；
  10 条 allowed warnings（unmaintained/unsound，传递依赖：proc-macro-error、unic-*、
  zbus/zvariant、glib 0.18.5；glib 仅 Linux GTK 路径）。Linux 运行时未验证。
- `src-shrunk` 已知展示差异：A 入队台账/气泡仍记 1048576，B 台账/盘上 4096；
  内容、sha、两侧终态均正确，属 UI 尺寸展示口径，不影响数据完整性（A-11，已在 5.0.31 修复）。

## [5.0.28] - 2026-10-19

### 安全：启动时收紧历史日志文件

- `Logger::new()` 构造时立即收紧**已存在**的当前日志与轮转后的 `.old.log`，不再依赖
  “下一次写入”或“下一次轮转”；历史安装留下的 `0644` 旧日志在启动时即变为 `0600`。
- 判据扩展为：预置 `0644` 的 `t.log` / `t.old.log`，构造后连同崩溃现场三者必须全部
  `0600`；Rust **983/983**。E2E/真机 **NOT RUN**。
- 真实数据副本演练：只读备份真实安装库 → 副本置 v10 → 生产 `init` 迁移：
  **19 表 / 208 行**、逐表行数与关键字段聚合一致、备份 `integrity=ok`；源库未改、副本已删除。
  这是真实数据体量/形状的演练，**不等于真实 4.x schema 迁移**。
- 真实 v10 原始 DDL 判据：夹具逐字取自 `git show 0b84f11^:src-tauri/src/db.rs`（引入 v11 的
  提交的父提交），18 张历史表 + 身份/好友/会话/消息/群/文件/队列/收藏数据在 v10→v11 后逐字段保留；
  Rust 984 通过 + 1 ignored（真实副本演练入口）。
- E2E（隔离 HOME，真实库 mtime 未变）：`contentpull` 40MB/300MB 均 **32/32 PASS**，
  默认轮 **18/18 PASS**；300MB 传输开始后 **734ms** 接收端设置窗口可开。断线格原断言
  假设杀前 0 个 accept，实测有 1 份在杀前已被旧连接接下（4 份全部落盘且 sha 正确）⇒
  判据改为“杀前已接下的不算剩余”，总 accept 仍须覆盖 4 单且超时 0。

## [5.0.27] - 2026-10-19

### 安全：日志与崩溃现场收紧为仅属主可读写

- Unix 上运行日志、轮转后的 `.old.log`、崩溃现场与启动路标统一收紧到 `0600`；
  日志里有 peer id、IP 与文件名，真实安装实测原为 `0644`，下次写入自动收紧。
- 抽出 `private_fs::restrict_to_owner`，数据库/侧车/迁移备份/日志共用一个实现，避免每个
  写文件的地方各写一份 chmod；非 Unix 为无操作，失败只告警不阻断启动。
- 新增 1 条 Unix 判据：`Logger::new` 的启动路标与首条日志必须都为 `0600`；
  Rust 基线 982 → **983**。E2E/真机 **NOT RUN**。

## [5.0.26] - 2026-10-19

### 安全：数据库、WAL/SHM 与迁移备份收紧为仅属主可读写

- Unix 上 `db::init()` 打开主库后立即把文件权限收紧到 `0600`；启用 WAL 后再补收紧
  `-wal/-shm` 侧车；`VACUUM INTO` 生成的迁移前备份同样收紧到 `0600`（备份是含身份密钥
  与全部消息的完整副本，权限不得比原库宽）。
- 真实安装只读实测：`gosslan.db` 与 `-wal` 均为 `0644`（同机其他用户可读）⇒ 下次启动
  自动收紧；非 Unix 平台不做操作。权限设置失败只告警、不阻断启动（异常文件系统可用性优先）。
- 新增 1 条 Unix 判据：显式把主库/侧车改回 `0644`，再走一次 v10→v11，主库、侧车与备份
  必须全部为 `0600`；Rust 基线 981 → **982**。E2E/真机 **NOT RUN**。

- 启动时同步扫描本库的历史迁移备份（`<stem>.pre-v…-to-v….db`），把 5.0.22–5.0.25
  留下的 `0644` 补收紧到 `0600`；只按文件名匹配后再 `stat`，同目录其它文件不动。
## [5.0.25] - 2026-10-19

### 优化：附件预览读盘移出 async worker

- `read_file_preview` / `read_favorite_preview` / `read_content_preview` 从
  `#[tauri::command(async)] + 同步 fn` 改为 `async fn` + `spawn_blocking`：三者都要做
  `canonicalize` 与最多 15 MiB 的 `std::fs::read`，慢盘/网络盘上会钉住一个 Tokio worker，
  而同一 runtime 上还排着开窗与网络命令。15 MiB 上限与路径越权检查一字未改。
- 新增 1 条源码判据：三格必须在 `spawn_blocking` 之后读盘、读盘前不许跨 `.await`、15 MiB
  上限必须还在。注入一处 `spawn_blocking` 之前的读盘 ⇒ **FAIL**，恢复 ⇒ **PASS**。
- 日志/追踪评估：**不换 `tracing`**。现有 logger 的同步落盘是崩溃现场与“最后一条日志”
  的诊断前提（崩溃后文件里必须有那一行），换异步写或整体替换会削弱证据链；结论记入
  `docs/architecture/backend-modernization.md`（B4），本批无代码改动。
- Rust 测试基线 979 → **980**；全量 Rust **980/980**；E2E/真机 **NOT RUN**。
- 另补 1 条 **4.x 全实体语义保留**判据：身份/好友/会话/消息/群+成员/群文件/单聊与群聊队列/
  文件任务/文件队列/收藏/逻辑时钟/已读，v7→v11 后逐字段比对，并要求 `integrity_check=ok`、
  无悬空外键、备份快照表数一致；Rust 980 → **981**。

## [5.0.24] - 2026-10-19

### 优化：TCP 小帧合并写 + 分帧选型结论

- `transport::tcp::write_bytes` 对 ≤8KiB 的帧把「4 字节大端长度 + payload」合成一次
  `poll_write`：旧形状每帧固定两次小写，心跳/回执这类小帧会被 Nagle + 延迟 ACK 卡住
  最多 ~40ms。大帧（文件分块）仍分两次写，不为省一次调用复制整个载荷。线上字节不变。
- 新增 2 条判据（小帧必须 1 次 `poll_write`、大帧保持 2 次且两种路径字节一致）；
  实施前先跑到红（小帧实测 2 次），实施后 `transport::tcp::tests::` **12/12**。
- `tokio-util::codec` + `bytes` 评估结论：**不替换**。现有分帧只有约 30 行、已有 12 条
  字节级判据；`Framed` 只是把同一段逻辑搬进新依赖，而真正的延迟问题来自两次写，已在
  本批直接修掉、无需改协议或读循环。方案记入 `docs/architecture/backend-modernization.md`。
- Rust 测试基线 977 → **979**；E2E/真机 **NOT RUN**。

## [5.0.23] - 2026-10-19

### 重构：启动期错误类型改用 thiserror

- 新增 `thiserror@2.0.21`（MIT OR Apache-2.0，`rust-version = 1.77` 与仓库一致；依赖树里已有）。
- `InitError` 的 `Display` / `Error` / `From` 样板改由 derive 生成：`Sqlite` 走 `#[from]` +
  `transparent`；`Backup` 保留原单行日志文案；降级那只用 `downgrade_display` 保持单行技术描述，
  `downgrade_message` 的人话长文案一字未改。
- 新增 1 条 `Display` 判据（降级文案含两个版本号与"拒绝降级打开"；备份失败文案点名备份路径）；
  Rust 测试基线 976 → 977。方案见 `docs/architecture/backend-modernization.md`，E2E/真机 **NOT RUN**。

## [5.0.22] - 2026-10-19

### 加固：数据库迁移前一致性备份 + busy_timeout

- `db::init()` 在**任何 schema 写入之前**，对"需要迁移的已有库"执行 `VACUUM INTO` 一致性快照；
  随后以只读连接校验 `integrity_check=ok`、迁移前 `user_version`、业务表数量，任一不符即以
  `InitError::Backup` 中止（原库一个字节不改，备份保留供诊断）。fresh / 已最新 / 降级拒绝均不备份。
- 连接设置 `busy_timeout=5s`：备份、VACUUM 或其它短暂持锁时排队等待有上界，超时仍进入错误态。
- 新增 8 条迁移测试（快照完整性/数据保留、init 备份后迁移、fresh/current 不备份、降级不备份、
  `busy_timeout=5000`、每个起始版本重放保数据、损坏库拒绝且原文件不变、备份恢复后再次迁移）；
  Rust 测试基线 968 → 976。方案与分批见 `docs/architecture/backend-modernization.md`。
  E2E/真机 **NOT RUN**。

## [5.0.21] - 2026-10-19

### 修复：开发环境日志窗口白屏（虚拟列表 TDZ + 滚动容器漏 ref）

- 根因 1（dev-only）：`LogViewer` 的 `useVirtualizer` options 是 computed，Vue dev 构建会在
  setup 期间立即求值 `count: mergedRows.value.length`，而 `mergedRows` 声明在后面 ⇒
  `Cannot access 'mergedRows' before initialization`（TDZ），LogViewer 子树退化成注释节点；
  生产构建晚一步求值，所以只在开发环境白屏。把 `rows` / `mergedRows` 移到 `useVirtualizer` 之前。
- 根因 2（dev+prod）：独立窗分支的滚动容器漏了 `ref="logScroll"`（只有移动端分支有）⇒
  virtualizer 拿不到滚动元素，工具栏显示"N 条"而列表区永远为空。补上 ref。
- 回归：`logViewerVirtual.test.ts` 新增声明顺序与两个 `logScroll` 的源码判据；UI 探针新增
  `--only=logs` **3 条**（standalone 有虚拟行 / 只渲染视口附近 / 滚到底换页）。单点变异摘掉
  standalone 的 ref ⇒ **0/3 红**，恢复 **3/3**；全量探针 **341/341**；`npm test` **1060/1060**。
- 真实 Tauri dev 验证：日志窗口 136 → 226 条实时增长、列表可滚到底、关闭后从左侧栏
  「… → 日志」重开正常。

## [5.0.20] - 2026-10-19

### 重构：自研 i18n 引擎迁 vue-i18n

- 新增 `vue-i18n@11.4.16`（MIT，peer Vue 3）：`i18n/index.ts` 的 150 行手写「字典 + `{name}` 插值」
  引擎改走 vue-i18n composition 模式；本模块只保留产品级策略（偏好三态、系统语言检测、
  localStorage 快路径、`document.lang`）。`t()` 的调用点零改动。
- 迁移前对 **1003×2 条消息逐字对账**：998 条完全一致；5 条字面 `@` 触发 vue-i18n 的链接语法，
  词典改写为 `{'@'}`；`t()` 对缺失参数保留 `{name}` 占位（与旧实现及既有判据一致）。
- 新增 `i18n/compile.test.ts`：两种语言全部消息逐一编译 + 字面 `@` 文本断言；
  `i18n/index.test.ts` 17 条继续通过。`npm test` 1059/1059；全量 UI 探针 338/338。
- 体积代价：vendor 266.48 → 323.99 kB（gzip 80.78 → 99.62，**+18.84 gzip**）；main 不变。
  主要成本是 vue-i18n 的消息编译器；若后续要省回，可接 `@intlify/unplugin-vue-i18n` 预编译消息。

## [5.0.19] - 2026-10-19

### 重构：同窗口事件总线迁 mitt + v-html 安全清单

- 新增 `mitt@3.0.1`（MIT，自带类型）：`utils/appActions.ts` 从 `window.dispatchEvent(new Event(...))`
  改为类型安全的事件表 `appBus`；`APP_ACTION` 四处 + `navigate-to-contacts` 全部走 `emitAction`，
  订阅端改用 `onAction` 返回的解绑函数（组件卸载必须调用，避免重建后一次动作执行多遍）。
  Tauri 菜单事件仍由 `bindMenuEvents` 转成同一批动作，跨窗口/Rust 继续走 `@tauri-apps/api/event`。
- 新增 v-html 允许清单判据 `findVHtmlSinks` / `V_HTML_ALLOWED`：全仓只允许
  `ChatSearchDialog`（highlightText）、`LogViewer`（highlightText 生成的 row.*）、`CodeBlock`
  （hljs/escapeHtml）三处；测试同时钉住转义实现锚点与真实组件正控。审计确认 4 处 v-html
  全部按构造转义，未引入 DOMPurify（没有"渲染对端原文 HTML"的路径）。
- `shortcuts.matchAppShortcut` 返回类型收紧为 `AppAction | null`；`appActions.test.ts` 2 条钉
  投递/不串线/解绑；`npm test` 1058/1058；build main 308.65 / gzip 93.33、vendor 266.48 / gzip 80.78。

## [5.0.18] - 2026-10-18

### 加固：搜索结果的 IPC 返回纳入 Zod 校验

- `utils/validation.ts` 新增 `chatSearchGroupSchema` / `chatSearchMessageSchema`：会话分组 +
  嵌套命中消息逐字段校验；`kind` 刻意收任意字符串（对端可能比本机新，未知 kind 由
  `UnsupportedKindBubble` 渲染占位 —— 校验层不许把它判成坏行）。
- `api.searchChatHistory` 从 `invoke<ChatSearchGroup[]>` 编译期断言改为 `invoke<unknown>` +
  `parseIpcList(..., "search_chat_history")`；坏行抛错并带 `@ 0.messages.0.ts` 这类字段路径，
  查询进入既有错误态。
- `validation.test.ts` 新增 1 条（合法嵌套 / 未知 kind 放行 / 负 total / 缺字段 / 嵌套路径报错）；
  接线判据从三个入口扩到四个。`npm test` 1055/1055；`--only=search` 16/16 复跑。

## [5.0.17] - 2026-10-18

### 重构：搜索聊天记录迁 TanStack Query

- `ChatSearchDialog` 删掉手写的 `seq` 竞态守卫、`searching` / `searchError` 状态、150ms 防抖
  与两个筛选 watcher，改 `useQuery`：关键词 / 发送人 / 日期三件都进 query key，
  旧响应只会写回它自己的键；`enabled` 跟弹窗开关与空关键词，关着时不打 IPC。
- 新增 `utils/chatSearchQuery.ts`：`retry 0`（失败立刻给重试出口）、`refetchOnWindowFocus/Reconnect`
  关闭（本地 SQL 检索，不是远端缓存）、`keepPreviousData`（换筛选时旧结果继续显示）；
  发送人候选只从"当前键 + 非占位数据 + 无发送人筛选"的结果里汇总，避免把筛选后的结果
  误记成候选来源。
- 新增 `utils/chatSearchQuery.test.ts` 5 条：三键隔离、staleTime 0 重扫、并发合并、
  失败只尝试一次、占位数据可识别。
- UI 探针 `--only=search` 新增 1 条（共 16 条）：给 `searchChatHistory` 装上"慢/快"两档延迟，
  确认「慢」的响应晚到后页面仍是「快」的结果。单点变异（把关键词从 query key 里摘掉）
  实测 3 条红（含这条），恢复后 16/16。
- 行为保持：打开弹窗只发一次检索、输入 150ms 防抖、回车（已出结果 ⇒ 打开高亮项；未出 ⇒
  立刻重搜）、清空关键词保留筛选、失败空屏给错误 + 重试。

## [5.0.16] - 2026-10-18

### 重构：原生下拉全部迁 Reka Select

- 新增 `components/ui/SettingsSelect.vue`（Reka `SelectRoot/Trigger/Content/Item` 的薄适配）：
  触发器是 `button[role=combobox]`，面板吃 `.gosslan-menu`；当前项、勾选指示、键盘导航与焦点归还
  由库负责；不传 `name` ⇒ 不渲染隐藏的原生 `<select>`。
- 四处真实调用点（外观字体、网络网卡、网络中继策略、存储保留天数与配额）全部替换；
  `style.css` 删除已无消费者的 `.gosslan-select-wrap` / `.gosslan-select` / `.gosslan-select:focus`。
- 新增设计判据 `findNativeSelect`：扫描全仓 `.vue` 模板，模板里再出现原生 `<select>` 即失败；
  正控是往真实组件模板里注入一个 `<select>`（证明扫描器读的是模板，而不是一句假字符串）。
- 顺手修掉一条真实缺陷：`ToastList` 的全局 Esc 守卫经 Reka `ToastRoot` 的 **window** 监听对任何
  Escape 调 `preventDefault`，于是屏幕上有 toast 时 Dialog / Menu / Select 的 Esc 全部失效
  （探针栈实测 `ToastList.vue` 的 `onEscapeKeyDown`）。改回库默认语义：Esc 关闭 toast。
- UI 探针新增 `--only=select` 6 条：键盘 ↓ 打开、焦点落当前项、↓ 换项、Enter 选中且只抬一个新值、
  Esc 收起并归还焦点、鼠标真点开真命中（不是合成 click）。
- `npm test` 1049 通过 / 0 失败；`npm run build` 退出 0（main 308.24 kB / gzip 93.12；
  vendor 266.14 kB / gzip 80.65）。

## [5.0.15] - 2026-10-18

### 重构：应用内 Toast 迁 Reka Toast

- `useAppStore` 里手写的 `toasts` 数组 + 每条 `setTimeout` 删除；`toast()` 改经
  `utils/toastManager.ts` 调 Reka `createToastManager`，渲染由 `ToastProvider/Viewport/Root` 接管。
- 行为补齐：同一 kind + 文案按 id 去重并重置计时（连续失败不再叠一屏）；`limit=3`
  （超出条目 `data-limited` + `inert` 且隐藏）；停留时长仍是 success/info 3s、error 6s。
- 保留 Gosslan 的配色/图标/顶部安全区定位与 Tauri 系统通知通道；Esc 只在焦点位于某条 toast
  时放行，避免关弹窗/菜单时顺手抹掉失败提示。
- 新增 `--only=toast` 7 条；两次单点变异：摘 `limit` ⇒ 3 红、摘 Esc 守卫 ⇒ 2 红；还原后 7/7。
- `npm test` 1048 通过 / 0 失败；`npm run build` 退出 0（main 308.24 kB / gzip 93.12；
  vendor 240.72 kB / gzip 74.33 —— Reka Toast 原语进 vendor）。

## [5.0.14] - 2026-10-18

### 重构：图片预览的焦点语义交给 Reka FocusScope

- `ImageLightbox.vue` 删除手写的「打开时 focus 容器 / 关闭时手动还焦点」；Tab 环、焦点逃逸
  拉回、卸载归还改由 Reka `FocusScope`（`loop` + `trapped`）承担，业务手势 / 方向键 / Esc 出口不变。
- 顺带修掉一处真实缺陷：旧实现只把焦点移进容器，**Tab 会直接跑到背景页面**，并不是焦点陷阱。
- 新增 UI 探针 `--only=lightbox` 7 条：dialog 语义、Tab 进内容、正向/反向环、程序化逃逸拉回、
  ArrowRight 业务键、Esc 后 DOM 撤净且焦点回到 opener。两次单点变异证明判据会咬（摘 `loop`
  ⇒ 2 条红；摘 `trapped` ⇒ 1 条红；还原后 7/7）。
- `npm test` 1048 通过 / 0 失败；`npm run build` 退出 0（main 308.24 kB / gzip 93.12）。

## [5.0.13] - 2026-10-18

### 重构：日期/时间格式化收敛到 dayjs 单一入口

- `utils/time.ts` 新增 `fmtDateTime`（`YYYY-MM-DD HH:mm:ss`）、`fmtClock`（`HH:mm:ss`）与
  `fmtDateStamp`（导出文件名）；`LogViewer`、`DevDiagPanel`、`StorageSection` 三处手写实现删除。
- 诊断面板不再用 `toLocaleTimeString()`：它随 WebView 区域设置变化（12/24 小时、分隔符），
  同一份日志在 Windows/macOS/Android/iOS 上会长得不一样。
- 新增 `src/utils/time.test.ts` 2 条：固定形状（本地时区构造）与「三个消费点必须走统一入口」。
- `npm test` 1048 通过 / 0 失败；`npm run build` 退出 0（main 308.24 kB / gzip 93.12）。

## [5.0.12] - 2026-10-18

### 重构：表单与 IPC 边界运行时校验迁 Zod（mini 构建）

- 新增 `zod@4.6.7`（MIT），使用 `zod/mini` 摇树构建：同样的 schema 能力，打包增量
  vendor +6.85 kB gzip（完整版实测 +25.56 kB gzip，故不采用）。
- 新增 `utils/validation.ts`：群名/昵称 schema（trim 后非空、长度按 Unicode 码点，与后端
  `chars().count()` 同口径）、`GroupFileEntry` / `ShareEntry` 的 IPC 形状 schema，以及
  `parseIpcList()`（坏行抛出带命令名与字段路径的错误，让查询进入可读的 error 态）。
- `GroupCreateModal` / `ProfileSection` 改用 schema；`externalLinks` 的名称/网址校验改由同一个
  Zod 对象 schema 产出错误码，原表驱动用例不变。
- `api.listGroupFiles` / `api.requestShareTree` 从 `invoke<T>` 断言改为**真校验**：
  Rust 改字段而前端手写类型没跟上时，不再把坏数据塞进界面。
- 新增 `src/utils/validation.test.ts` 5 条（码点口径、IPC 行合法性、坏行报错、三个入口接线）。
- `npm test` 1046 通过 / 0 失败；`npm run build` 退出 0（main 308.24 kB / gzip 93.12，
  vendor 221.86 kB / gzip 68.32）。

## [5.0.11] - 2026-10-18

### 重构：共享目录迁 TanStack Query（Query 模式推广到第二个纯读面板）

- 抽出 `utils/panelQuery.ts`：按主体 id 分键的只读面板共用 `staleTime 0 / retry 1 / gcTime 5min`
  与失效半径；群文件面板改为复用同一策略，不再各写一份。
- `ShareDirectory.vue` 去掉手写的 `entries/loading/error`、`StaleGuard` 与两个 watch，
  改为按好友分键的 `useQuery`：切会话时旧树只会写回旧好友的 key；打开仍重拉；失败保留旧树。
- 树的归属随数据一起缓存（`snapshot.friendId`）：下载时不再读「点击那一刻的 activeConv」，
  切会话竞态在结构上无法把 A 的路径发给 B。
- 新增 `src/utils/shareTreeQuery.test.ts` 2 条（分键 + 快照归属、慢 A 后到不覆盖 B）；
  新增 `--only=share` 6 条真渲染判据（打开、切好友、慢响应后到、下载归属、切回缓存快照）。
- `npm test` 1041 通过 / 0 失败；`npm run build` 退出 0（main 308.01 kB / gzip 92.99）。

## [5.0.10] - 2026-10-18

### 重构：异步数据层试点 TanStack Query（群文件面板）

- 新增 `@tanstack/vue-query@5.104.4`（MIT）。`createWindowApp` 给**每个窗口**装一份 QueryClient：
  `retry 1` / `retryDelay 0` / `refetchOnWindowFocus false`；staleTime/gcTime 由具体查询自带。
- `GroupFilesPanel.vue` 去掉手写的 `files/loading/failed/loadError`、两个 watch 与
  `gid !== props.groupId` 过期守卫，改成按群分键的 `useQuery`：切群时 A 群的慢响应只会写回 A 群的 key；
  关掉再打开仍重拉；刷新失败保留旧清单；同一 key 的并发请求合并。重试入口与两条错误态（有旧数据/无旧数据）不变。
- 新增窄订阅 `api.onGroupFileActivity`（`file-done/failed/cancelled` + `gfile-` 的
  message-received / group-message-acked / message-status-changed）：面板开着时只失效当前群，
  文件落盘、新群文件与「已送达 N/M」不再等重开面板；关面板时成对退订。
- 新增 `src/utils/groupFilesQuery.test.ts` 5 条（分键、staleTime 0 重拉、并发合并、失败保留 + retry、
  失效半径）与 `--only=files` 8 条真渲染判据（打开重拉、切群隔离、事件失效、失败保留、恢复、退订）。
- `npm test` 1039 通过 / 0 失败；`npm run build` 退出 0（main 307.80 kB / gzip 92.90，
  vendor 200.45 kB / gzip 61.47 —— vendor 增量即 Query 运行时）。

### 重构：设置页单选与字号滑杆迁 Reka

- `SegmentedControl.vue` 从手写 `role=radiogroup/radio` 按钮改为 Reka `RadioGroupRoot/RadioGroupItem`：
  roving focus、方向键、选中态与禁用语义交给库；保留尺寸、配色、徽标与 `modelValue` 契约。
- `ChatStyleSection.vue` 的字号滑杆改为 Reka `SliderRoot/Track/Range/Thumb`：方向键/Home/End/点击
  由库处理；保留五档圆点视觉、`aria-valuetext`（`px · 文案`）与 `setChatStyle` 落库。
- `rekaPrimitives.test.ts` 钉住 RadioGroup/Slider 的入参形状与「不许退回手写 role/pointerdown」；
  新增 `--only=segmented` 8/8、`--only=slider` 8/8。

### 修复与收敛：重复提交、重复检索与剪贴板

- 新增 `useSubmitGuard`：`GroupCreateModal` 建群、`ProfileSection` 保存资料在请求在飞时不再重复发起；
  `GroupTasksBoard.saveDraft` 补同形闸门。
- `ChatSearchDialog` 打开时先置 `opening`，关键词/筛选 watcher 不再对初始值多发一次 IPC（`--only=search` 15/15）。
- `useClipboard` 与 `LogViewer` 的复制改走 VueUse `useClipboard({ legacy: true })`，
  删除手写 `navigator.clipboard` / `execCommand` 回退。

## [5.0.9] - 2026-10-18

### 重构：设置开关迁到 Reka Switch

- `SettingsToggle.vue`（设置/网络/添加好友共 9 处）从自绘 `button role=switch` 改为
  Reka `SwitchRoot/SwitchThumb`；role、aria-checked、Space/Enter 与禁用语义由库负责，
  Gosslan 只保留尺寸/配色/pending 小转圈和必填可访问名 label。
- 迁移中撞到一处真实 API 差异：Reka 的 Vue 版 Switch 是 `modelValue/update:modelValue`，
  不是 Radix 的 `checked/update:checked` —— 写错不报错、点开关无反应。已改正并由
  `rekaPrimitives.test.ts` 钉住入参形状。
- 新增 `--only=switch` 4 条真渲染判据（role/name、初始 aria-checked、点击 emit、禁用不 emit）。
- `npm test` 1030 通过 / 0 失败；`npm run build` 退出 0（main 307.27 kB / gzip 92.55）。

## [5.0.8] - 2026-10-18

### 重构：其余四处手写 role=menu 全部迁到 Reka DropdownMenu

- `ConversationList` 的「+」菜单、`NavRail` 的「更多」菜单、`TodoPickField` 的状态/优先级/类型
  三格下拉、`GroupTasksBoard` 的行内状态菜单，全部改走 Reka `DropdownMenuRoot/Trigger/Content/Item`。
  开关、点外部、Esc、↑↓/Home/End 与焦点归还交给库；`useExclusivePopup` 全局互斥与滚动收起保留。
- 群任务看板用入口右缘/下缘作为**虚拟锚点**，贴边翻转交给 floating-ui；不再手算 top/bottom，
  也不再自建 `popupPlacement`。
- 新增聚合判据：全 `src/components/**/*.vue` 不再出现 `role="menuitem"`；新增 `--only=todopick`
  4 条真渲染判据（开菜单、↓ 跳过禁用项、回车发值并收起）。
- `npm test` 1029 通过 / 0 失败；`npm run build` 退出 0（main 307.27 kB / gzip 92.55）；
  `--only=tasksrt` 14/14；`--only=todopick` 4/4。

## [5.0.7] - 2026-10-18

### 重构：搜索筛选菜单迁到 Reka DropdownMenu

- `ChatSearchDialog.vue` 的发送人/日期两个筛选菜单从手写 `role=menu` + 绝对定位 + 按钮开关
  改为 Reka `DropdownMenuRoot/Trigger/Portal/Content/Item`；互斥收进 `onSenderOpen/onDateOpen`，
  条目用 `@select`，外观仍走 `.gosslan-menu*`。
- 菜单 `:modal="false"`：筛选菜单不能把搜索框焦点抢回菜单（实测模态焦点陷阱会让随后 ↑↓ 落空）。
- Portal 到 body 后用 `z-[80]`，并给搜索探针补「菜单在嵌套 Dialog 的 aria-hidden/pointer-events
  下仍可命中」判据（`--only=search` 14/14）。
- `npm test` 1026 通过 / 0 失败；`npm run build` 退出 0（main 309.27 kB / gzip 93.39）。

## [5.0.6] - 2026-10-18

### 重构：右键菜单外壳迁到 Reka DropdownMenu（去掉自建焦点/键盘/外点内核）

- `ContextMenu.vue` 不再手写 Teleport、document click、window keydown、↑↓/Home/End 循环与估算高度的
  贴边内收：鼠标坐标作为 Reka `DropdownMenuContent` 的虚拟锚点，定位、翻转、点外部、Esc 与
  roving focus 全部交给库；本仓只保留坐标入参、`.gosslan-menu*` 主题和关闭后的焦点归还。
- 四个业务右键菜单（消息、会话、联系人、收藏）的条目改成 `DropdownMenuItem` + `@select`，
  分隔线用 `DropdownMenuSeparator`；外观与 z 序不变，键盘高亮补 `data-highlighted` 配色。
- 修掉迁移中暴露的一处真实退化：菜单内容不能再写 `fixed` —— fixed 子元素不贡献 popper
  wrapper 尺寸，wrapper 量到 0×0，floating-ui 的贴边翻转会静默失效；新增源码判据钉住。
- 新增 UI 运行时探针 `--only=ctxmenu` 12 条：坐标原点、7 个条目、↓/回车选中、Esc、
  点外部、焦点归还、右下角翻转全部在真渲染里验证。
- `npm test` 1025 通过 / 0 失败；`npm run build` 退出 0（main 309.12 kB / gzip 93.35）；
  `--only=ctxmenu` 12/12。

## [5.0.5] - 2026-10-18

### 重构：通用弹窗从 Headless UI 迁到 Reka UI（A 类直接替换）

- `BaseModal.vue` / `ActionSheet.vue` 改走 `reka-ui@2.11.0` 的
  `DialogRoot/Portal/Overlay/Content/Title`；`@headlessui/vue` 的唯一消费者消失，依赖删除。
- 焦点陷阱、Esc、点外部、`aria-modal` 与关闭后焦点归还由 Reka 原语接管；本仓只保留
  窗口安全区、卡片/整页外观、键盘让位与「点一项即收起」。
- 修复迁移中暴露的两处真实几何问题：卡片形态内容根的空白区必须让点击穿到遮罩
  （Reka 内联 `pointer-events:auto`，用 `.gosslan-dialog-card` 覆盖）；内容层动画挂在
  `DialogContent` 自身后，探针必须在入场动画落定后再读几何。
- `npm test` 1017 通过 / 0 失败；overlay 探针 41/41；winsafe+search 33/33。

### 重构：运行日志长列表改用 TanStack Virtual（B 类真实业务试迁移）

- `LogViewer.vue` 的独立窗与移动页两条外壳共用 `useVirtualizer` + `measureElement`
  动态测高，不再整表 `v-for`；过滤变化回到列表顶部，避免短结果落在越界滚动位。
- 新增 `utils/logViewerVirtual.test.ts` 两条护栏：两条外壳都必须虚拟化、禁止退回整表渲染、
  过滤必须回顶。`npm test` 1021 通过 / 0 失败；build 退出 0。

### 重构：图片另存去掉保存链的 base64 IPC（P6 部分）

- 新增 Rust `save_media_as(msg_id?, cid?, destination)`：按消息或 content store 解析源文件，
  直接拷到用户选择的目的地；桌面/iOS 走 `std::fs::copy`（`spawn_blocking`），
  Android `content://` 复用 `ContentResolver` 分支。前端 `saveImageAs` 优先走源路径，
  源已清理/乐观消息未落库时回退原有字节路径。
- 图片**预览**早已走 `tauri::ipc::Response` 原始字节，本轮不再重复改造；真机 raw IPC 与
  SAF 行为仍未验证（NOT RUN）。
- `cargo check --lib` 退出 0；`cargo fmt --check` 退出 0；helpers Rust 用例 8/8。

## [5.0.4] - 2026-10-18

### 修复：图片预览窗口在 IPC 失败或空相册时静默白屏

- 新增 `utils/previewGalleryState.ts` 纯状态机：`loading / ready / empty / error` 四态，
  有旧内容时刷新失败保留旧图，关闭（`released`）清空供常驻窗口复用；IPC 加 8s 超时，
  迟到结果按代次号丢弃。
- `PreviewWindow.vue` 接入状态机：失败显示错误原因与「重试」，空相册显示明确空态，
  不再只留一个空壳窗口。
- 新增公共 `components/ui/StateBlock.vue`（加载 / 空 / 错误 + 重试），辅助窗口后续按同一入口迁移。
- 新增 6 条状态机单测；`npm test` 1015 通过 / 0 失败；`npm run build` 退出 0；
  `main` 310.01 kB（gzip 92.99）。

### 修复：图标入口判据的假绿 + 12 处直连迁移

- 判据 ㊵ 的正则 `[\s\S]*?` 会从文件里**前面的** `import {` 一路吞到 lucide 那条，
  最后一个名字带上 `import { ` 前缀而漏报：实测 `GroupFilesPanel` / `MergeCardModal` 等
  12 个文件直连 `Check` / `X` / `Loader2` / `RotateCcw` / `Trash2`，判据仍报 0 处。
  改为 `[^}]*` 只吃到本条 `}`，并补「多条 import 在前」的夹具。
- 12 处直连全部改走 `@/components/ui/icons`；入口新增 `AlertCircle`、`ImageOff` 供状态块使用。
- 10 处手写 SVG 逐处判定为**平台/产品专属图形**并保留：macOS 红绿灯与 Windows 11 窗口字形、
  NavRail 依赖“选中实心 + 内部镂空”的四个图标、iOS 专用返回 chevron；理由写在二期路线图。
- 真实树 195 份源码直连 0 处；`npm test` 1015 通过 / 0 失败；build 退出 0；
  UI 探针 262/265（3 条失败与基线完全同集合）。
- 二期路线图与迁移清单落 `docs/architecture/frontend-experience-roadmap.md`。

### 修复：辅助窗口与群文件面板的失败出口

- 群任务窗口：首屏/换群读失败改为「错误原因 + 重试」状态，不再只 toast 后停在“暂无任务”。
- 日志窗口：区分“无日志”和“读失败”；空屏时显示错误与重试，有旧内容时继续静默轮询重试。
- 网络设置：网卡枚举失败不再截断后续通道/端点加载，同一轮失败只提示一次。
- 网络诊断面板：首屏读失败不再只剩一个刷新按钮，显示原因与重试；已有旧快照时保留旧读数。
- 群文件面板：刷新失败保留已加载清单，只有一屏都没有才换成错误态；加载中不再隐藏已有列表。
- 收藏面板与链接列表：加载失败改为「原因 + 重试」，空态改走统一 `StateBlock`。
- 新增 `ui/ConfirmDialog.vue`：统一二次确认的标题/正文/条目/备注与取消/危险确认页脚；
  `busy` 时两键禁用且 Esc/返回不关闭。`StorageSection`（策略开启、立即清理）、
  `ResetSection`（恢复默认、清除聊天数据）、`ConversationList`（删除好友、删除聊天记录）
  共 6 处迁移，删掉各自的 `BaseModal` 手写页脚。
- 聊天主窗：消息首屏读失败不再伪装成“暂无消息”，改为错误原因 + 重试；store 新增
  `messageLoadErrors`，重试时回到骨架态。聊天记录搜索失败同样改为错误 + 重试。
- 图片灯箱：加载中显示独立文案；字节取到但浏览器解不出图时清掉裂图，显示原因与重试
  （按 msgId/cid 可重取），不再留一张破图。
- `npm test` 1015 通过 / 0 失败；`npm run build` 退出 0；`main` 311.12 kB（gzip 93.38）。

### 修复：群任务看板首屏的「假空态」与三个入口的重复 IPC

- 群任务看板（应用内弹窗与独立窗口共用）首屏读那份全表任务行时只有转圈与空态两档：
  IPC 一失败就显示「暂无任务」，既没有失败原因也没有恢复入口。现在按
  `loading / ready / error` 三态呈现，失败给「重试」；成员面板的任务摘要同样区分
  「加载中 / 读失败 / 确实没有任务」。
- `useChatStore.ensureGroupTodoRows` 的三个入口（看板 / 任务弹窗 / 成员面板）改为**单飞**：
  同一次打开只打一份 IPC；失败写进 `groupTodoRowsErrors`，不再产生未捕获的 rejection。
- 任一条取数口读成功都会清掉失败记录；事件重读在“从未读到过”时也记失败，
  避免看板永久停在加载态。
- 新增 `utils/todos.todoRowsLoadState` 纯选择器与 2 条单测（读到过优先于残留错误；
  空数组是合法的“确实没有任务”，不是还没读）。
- `npm test` 1017 通过 / 0 失败；`npm run verify` 17/17、退出码 0（18.5s）；
  `main` 311.96 kB（gzip 93.55）。

### 重构：聊天主窗与撤回确认收编 ConfirmDialog

- `ChatWindow` 的换钥同步、删除好友、批量删除与 `MessageItem` 的撤回确认共 4 处改走
  `ConfirmDialog`：取消/确认页脚、尺寸、`busy` 禁用与 Esc 行为只剩一份实现。
  换钥同步是主题色主按钮（`danger=false`）；删除好友正文保留危险色昵称，走默认插槽。
- 群公告删除仍是“公告查看弹窗内的两段式确认”，不是独立确认框，保留并写明理由。
- `npm test` 1017 通过 / 0 失败；`npm run verify` 17/17、退出码 0（17.9s）；
  `main` 310.02 kB（gzip 93.43）。

### 工具：本地门禁拆出最长一步（`npm run verify:local`）

- `scripts/verify.mjs` 新增 `--skip-guard-sweep`：本地只跳过「护栏非空转」整步
  （2026-10-18 实测 843.1s，占 23 步全量层 922.2s 的 91%），其余 22 步照跑；
  起跑与汇总各留一条醒目记录，CI 与 `--group release` 拒绝该开关。
- `package.json` 新增 `npm run verify:local`（= `--full-gate --skip-guard-sweep`）：
  实测 22/22、退出码 0、64.0s。**发版/推送前仍跑完整的 `npm run verify:full`。**
- 修复 `db_hold` 排队测试的启动竞态：旧写法先发信号后 `lock()`，系统忙时等待线程
  可能先拿到锁（实测等待 0ms）；改为先确认持锁线程已握住、等待线程 `try_lock`
  失败后再放行，单测连跑 11 次全绿。

### 性能：P7 量具复跑（结论：不改码）

- `perf/probe.mjs` 自检通过后复跑 20k：滚动 p95 17.5 / 16.8 ms、`longFramesOver50ms` 0；
  整表前缀和一遍 1.3 ms。10 万档 `PERF_ONLY=calib` 为 1768 ms/遍，根因是
  `BUBBLE_CACHE_MAX = 50_000` 在 10 万条时整表 thrash，不是前缀和算法本身；
  产品消息缓存上界 1000 条/会话，到不了这一档 ⇒ `VirtualList` 不动。
- `file-progress` 源侧已有 250 / 1000 ms 节流，前端只做单条原地写、Vue 同一 tick 合并渲染
  ⇒ 不再叠 rAF 批处理（只增延迟与代码面）。
- 读数、命令与判据写进 `perf/README.md`；本条不改应用代码。


## [5.0.3] - 2026-10-18

### 重构：剩余实底危险按钮收编 + 形状判据

- `ChatWindow`（3 处）、`MessageItem`、`GroupTasksBoard`、`FavoritePanel`、`GroupMemberPanel`
  共 7 处手写实底危险按钮改走 `DangerBtn`；3 处尺寸本就一致，3 处顺带把
  `hover:opacity-90` 修正为 `danger-hover`，3 处由旧的 `py-2` 统一到校准后的 `py-1.5`。
- 新增判据 ㊶：`.vue` 模板里出现手写 `bg-[var(--gosslan-danger)]` 按钮即报；
  圆形图标徽标（`rounded-full`）与 `DangerBtn` 自身除外。真实树 84 份 `.vue`，0 处。

### 清理：拓扑栏与每 5 秒一次的拓扑 IPC 轮询

- 删除 `components/TopologyBar.vue`：84 份 `.vue` 中唯一零引用（无静态 import、
  无动态注册、无模板标签；README 与架构图中的出现只是目录树/清单文字）。
- `useChatStore` 随之删除 `topology` 状态、`refreshTopology` 与节流、
  `peers-updated` 上的触发，以及每 5 秒一次的 `setInterval`——这些代码的
  唯一读者就是该组件。`api.getTopology`、`types.TopologyInfo`、`topo.*` 文案同步删除。
- Rust 命令 `get_topology` **保留**（应用内只读诊断接口，无前端入口），
  在 `src/api/events.test.ts` 的 `DEAD_COMMANDS` 登记保留原因，IPC 门面判据仍然生效。
- `storeContract` 的定时器判据改为条件式：`init` 里若出现 `setInterval` 仍必须交给
  `scope` 保管；不再强制要求一个已被删除的轮询定时器。
- README / `AI_PROJECT_HANDOFF.md` / `docs/ARCHITECTURE-MAP.html` 的组件树与
  `peers-updated` 消费者同步改为 `chat.refreshPeers`。
- `npm test` 1009 通过 / 0 失败；`npm run build` 退出 0；`main` 310.67 kB
  （gzip 93.21，较 5.0.2 少 0.74 kB，与删除前持平——组件本就零引用、不在产物里）。

## [5.0.2] - 2026-10-18

### 重构：字节体积格式化收敛为一套

- `utils/format.ts` 的 `formatBytes` 成为唯一实现，补齐 TB 档；`utils/color.ts`
  移除 `humanSize`（体积格式化不属于颜色模块）。
- 5 个调用方（收藏面板、群文件、共享目录、文件气泡、存储设置）统一到
  `formatBytes`；显示差异仅两处：`<1KB` 由 `0.0 B` 变整数 `0 B`，GB 由一位小数变两位。
- 新增 `format.test.ts` 覆盖 B/KB/MB/GB/TB 与精度边界；Rust 侧注释同步指向新名字。
- `npm test` 1007 通过 / 0 失败；`npm run build` 退出 0；`main` 311.41 kB
  （gzip 93.24，与 5.0.1 持平）。

## [5.0.1] - 2026-10-18

### 重构：另存图片收敛为一个状态机

- 新增 `utils/saveImageCore.ts`：对话框 → 归一化目的地 → 取字节 → 落盘的唯一实现；
  桌面返回 null 与 Android reject 的取消都归一化为 `cancelled`。
- `ImageLightbox` / `MessageItem` 的 `saveImage` 改为薄接线；移除两份重复的
  `saveDestinationOf` / `urlToBase64` 逻辑与不再使用的 import。
- 新增 6 条单测：成功顺序 / 桌面取消 / Android 取消 / SAF `{file}` 对象 / 空值 / 非取消错误。
- `npm test` 1007 通过 / 0 失败；`npm run build` 退出 0；`main` 311.68→311.41 kB
  （gzip 93.37→93.23）。

## [5.0.0] - 2026-10-18

### 5.0.0 — 前端重构基线（设计系统、依赖治理与一处可靠性修复）

> 这是一次**向后兼容**的工程版本：协议、加密语义、SQLite 结构、消息状态机与传输链路零改动。
> 5.0 的 major 由产品负责人指定，用于给重构基线打一个清晰的路标，不代表破坏性变更
> （按仓库 SemVer 规则本应为 minor；此处是显式的产品决策，不是分类器失误）。

- **按钮**：`DangerBtn.large` 按 7 处真实确认弹窗校准；7 处危险确认按钮与 5 处主按钮
  改走 `DangerBtn` / `PrimaryBtn`，顺带补上 `tap-safe`（pad 尺寸此前逃过 `h-*` 判据）。
- **设计令牌**：修正 4 类漂移（字面圆角、6px 圆角、10px 正文、硬编码中性色）；
  新增字面圆角判据（静态与动态 `:class` 都扫，84 份 `.vue`，放行 `--gosslan-*` 与 `full`/`none`）。
- **依赖**：删除 `vue-easy-lightbox`、`clsx`、`tailwind-merge` 与 `utils/cn` 死代码；
  生产依赖 13 → 10；cascade 判据同步去掉已不存在的 `.vel-modal`。
- **图标**：新增 `components/ui/icons.ts` 静态具名入口（Check / Loader2 / RotateCcw / Trash2 / X）；
  21 个文件、22 处 import 改走入口；新增判据（192 份源码分母 + 入口导出阳性对照）。
- **可靠性**：`watchGroupTodos` 切群竞态用 `StaleGuard` 令牌修复；过期监听立即摘除，
  旧清理不再清掉新群的定时器；`storeContract` 增加接线判据与非空转对照。
- **验收**：`npm test` 1001 通过 / 0 失败；`npm run build` 退出 0；
  完整门禁读数见 `docs/architecture/refactor-roadmap.md` 与 `refactor-5.0-report.md`。

## [4.44.4] - 2026-10-18

### 修复：单聊/中继收文件后建卡片那一帧把整条电路锁死（真机 J2 连红 21 轮的根因）

接收端在**已经持有 db 守卫的作用域里**调了 `resolve_nickname()`，而它自己又取一次 `state.db.lock()`。
`std::sync::Mutex` 不可重入 ⇒ 持锁者就是等待者，那一帧永不返回：读卡器不再消费入站帧、`FileCompleteAck`
发不出去、发送侧 `file_outbox` 与台账停在 `active`，**只有重启才恢复**。两处同形形状都按仓内既有先例
（`group_file.rs` 那段带注释的 `drop(dbc);`）修：守卫在调用前结束，需要继续写库再重新取一次锁。
现场证据是带符号的 release 件 `/usr/bin/sample` 两拍同形的栈；`db 持锁观测` 之所以一行没有，
是因为那条只在**持有结束**时产一行。

- **判据扩了一条**：`scripts/check-lock-scope.mjs`（INV-P25）新增第四类——先全仓收"函数体里出现 db 取锁"
  的名字，再在每个 guard 存活期（同样认 `drop`）内找对这些名字的调用。夹具一正一反：未修的那棵树判红并
  点名两处、修完的树判绿；跨函数传守卫、字段改名、宏内取锁这三类看不见，已写进脚本头部与 INV-P25 的边界。
- 同批更新：`docs/protocol-invariants.md`（INV-P25 规则/判据/边界/必测矩阵）、`docs/ARCHITECTURE-MAP.html`
  那条 inv 行、`docs/stability-roadmap.md` 台账行、`scripts/verify.mjs` 该步的说明。

### 新增：发送侧与每条电路的可观测出口（不改任何判定，只让现场看得见）

- **发送成功那三处以前是 `.ok();` 吞掉的**：台账行写完、消息行点亮、outbox 行删除 —— 任一失败时界面没痕迹、
  日志也没痕迹。现在按 stage 各留一条有界错误（`send-transfer-done` / `send-message-delivered` /
  `send-outbox-dropped`），note 一律出锁之后再写；两条收尾路径抽成 `send_finalize_rows` 与
  `drop_sent_outbox_row`，由 Rust 用例直接驱动（不是复制一份 SQL 自测）。发送成功本身不新增噪声日志。
- **每条电路的两个时间戳**（最后一次写成功 / 最后一次读到完整帧并解析派发）现在有一个**应用内只读诊断出口**，
  诊断面板按连接显示。它只回答"卡在写侧还是读侧"这一格，不替代真机读数，也不冒充别的指标。
- **无障碍探针**（`scripts/ax-tree.mjs`）加了一次性按钮触发：按下界面上现成的控件之后再读无障碍树。
  不发消息、不触发重连、不改变应用状态，也没有常驻轮询。

⚠️ 这一批仍未覆盖的一格：`set_message_status` 把 SQL 的影响行数丢掉了，"消息行不存在"和"被状态单调闸拦下"
对外都返回成功。它不会让发送侧台账收不了口，但会让那一步的失败静默 —— 已知，另轮处理。
### 修复：发布版故障治理第一批四条（取证 / 台账留痕 / 进度终态 / 持锁读数）

承接 2026-10-17 那份只读审计（`d19c68d` 基线）。四条都是"让现场看得见、让状态说得清"，不改协议、不改传输状态机：

- **崩溃重启后取不到上一次故障**。`get_logs` 读的是内存环，于是最需要复制走的那一次恰好不在界面里。
  现在启动时把上一轮 `<stem>.log` 尾部与 `<stem>-crash.log` 的原生行（留痕 / 启动路标 / 崩溃块头）读进内存，
  「运行日志」页与"一键复制"直接带上。只读、有界（尾部字节 + 行数双上限），一个字节都不往盘上回写。
- **文件接收台账写坏了却一个字不留**。`network/file/receive.rs` 那六处 `.ok();` / `let _ =` 换成按 stage 留痕：
  主写入失败、主写失败但补偿成功、两次都失败三种分得开，并直说"该行可能仍停在 active"。note 一律出锁之后再写。
- **文件气泡永远显示"发送中 84%"**。进度只在 `active` 那一态显示；`pending` 说排队、`failed`/`cancelled` 说终态、
  认不出的状态绝不显示成已完成。状态口径收进 `src/utils/transferState.ts` 一份，composable 与气泡共用。
- **界面冻住时没有任何持锁读数**。`AppState::db` 换成 `db_hold::DbLock`：既有取锁写法一字不变，
  先放锁再记原子计数，超阈值（默认 500ms）每分钟最多一行。**等待与持有是两个数**（排队 800ms
  不许被读成"有人握了 800ms"，判慢只认持有）；`DbLock` 刻意不实现 `Deref`，所以不存在
  "把 `&state.db` 当裸 Mutex 传出去、那一段一次都不计"那条路 —— 文件接收收尾与「清除数据」
  那批删除因此都有了读数。VACUUM 分开报"等锁"与"执行"，不再吞掉错误。

判据：`logging::tests::previous_run_*`、`network::file::tests::ledger_*`、`src/utils/transferState.test.ts`、
`db_hold::tests::*`，每条都验过"改坏即 FAIL、恢复即 PASS"。台账见 `docs/audit/ledger-2026-10-17.md`。

## [4.44.3] - 2026-10-16

### 修复：群密钥还在路上时，不许对新成员弹一句"同步未完成"；并把十一种进群情况列成表

负责人追问"钩子各种情况应该都考虑到了吧……都不能报错"。逐条读代码盘下来，抓到一条真的会报错的：

- **密钥未到被报成失败**。新成员常常**先收到群消息、群密钥还在路上**（gossip 那一路会先把群记录建出来）。
  这一趟第一页就 `NoKey` 退出，而它无条件弹一句"群消息同步未完成，有成员在线时会自动重试"——
  把一个**正常的进行中状态**报成"办砸了"，而且原因还是错的（不是没人在线，是本机还没拿到密钥）。
  现在按"横幅露过面没有"来判：没露过面就只记一条 info、标记留在 `pending`（密钥落地后那把 60 秒
  清扫任务自己补上）；露过面就必须给一个 terminal，否则那条横幅收不掉、永远停在"正在同步"。
  判据 `a_key_that_has_not_arrived_is_not_reported_as_a_failure`（两行结局 + 两条接线计数，防"判据在、没人调用"）。
- 顺手纠正我自己先前一句判断：我把"空群/问不到就每 60 秒再问一遍"当成了一条浪费。读完那条臂之后
  它是**唯一的迟到补账入口**（一台都问不到 ≠ 没有历史），所以没动它，只在说明里写清它是什么。
- 新增说明 `docs/notes/group-history-sync-2026-10-16.md` §九：十一种进群情况逐条对上"走哪条臂 /
  用户看得见什么 / 哪条判据判它"，并如实登记三个缺口（其中三条"留 pending 不许写 done"的臂
  在 IO 外壳里、没有能构造 `AppState` 的单测）。

验证：`cargo fmt` 0 / `cargo clippy --features bluetooth -- -D warnings` 0 /
`cargo test --features bluetooth --lib` **926 passed 0 failed**（+1 条判据）——注意这三条都是在
**另一个工作区**（`git worktree`）里跑的：本机这个工作树此刻有别人正在进行的崩溃取证改动且编译不过，
不在我的提交里、我一个字没动。`npm run verify` 快速层 17 步 EXIT=0。版本 4.44.2 → **4.44.3**（五处同提交）。

## [4.44.2] - 2026-10-16

### 修复：那颗按钮按下去的头几秒什么都看不见；错误日志不许按住 db 锁；连点不许撒"已开始"

发版前对着自己上一批代码重读一遍，抓到三条（都不是编译器会拦的那类）：

- **点了没回声**：`started` 原本设计成不弹提示，理由是"按钮自己会变转圈、横幅会跟着动"——
  **那句理由是假的**。横幅与转圈都要等**第一条进度事件**，而跑一趟先要向最多 8 台各问一次摘要
  （每台最长 4s）才取第一页 ⇒ 中间这段窗口界面上什么都没有，用户读数就是"按了一枚没反应的图标"（⇒ 连点）。
  现在四种裁决**每种都有一句**，`started` 也给一句 transient 提示。设计说明 §六·补 里那句错的取舍
  连同理由一起改口，不是悄悄删掉。
- **错误日志按住全应用唯一的写入口**：`mark_history_pending` 留痕那句原本在 db 锁**里面**打
  （logger 是要落盘的）。改成先取结果、放掉锁再说——一条失败日志不该让正在发消息的那条路排在它后面。
- **连点不许撒"已开始"**：`in_flight` 读数与闸门之间隔着一段 await，两次快点头都可能看见"没在飞"。
  现在以 `spawn_sync` 自己的答案为准：被闸门拒掉就报 `already_running`，不报 `started`
  （撒出去的那句"已开始"在界面上既没有转圈也没有横幅兜着）。

验证：`cargo fmt` / `cargo clippy -D warnings` 各 0、`cargo test --features bluetooth --lib` 925 passed 0 failed、
`npm run verify` 快速层 17 步 EXIT=0（新增那个 i18n 键由"字面量 t() 必须命中真实 key + 双语键集合一致"两条判据兜）。

## [4.44.1] - 2026-10-16

### 修复：群历史那枚标记写失败不再静默（`mark_history_pending`）

 refactor 把手动与自动两格收成同一个 `mark_history_pending` 时，沿用了原来那句 `.ok()` ——
 而这一枚 `settings` 里的 `pending` **就是清扫名单的唯一输入**：它没写进去，结局是
 "这一群永远不会再被扫到"，界面上只停在"没历史"，日志里一个字都没有。
 现在改成 `if let Err(e) =` 留痕（这条是本仓"卡片落库静默族"允许名单里的那一种形状），
 并把话说清：要补历史得再点一次那颗按钮。判据 `the_manual_entry_shares_one_marker_home_and_one_spawn_gate`
 仍数到"写 pending 只有 1 个家"（把句子拆成多行不影响，`code_flat` 先去注释再抹空白）。

## [4.44.0] - 2026-10-16

### 新功能：群聊里每个人都能自己点一下「从群里补齐历史消息」

负责人 2026-10-16 追加那半句需求：已经在群里、但手里只有几条老版本同步来的记录的人，
也要能自己发起一次同步；而**自己就是最全的那位**点了它，扫描完只会补上本机没有的/错过的那几条，
其余一字不变。入口刻意低调（群按钮那一族最后一枚、暗一档），但功能是真的。

- 后端 `network/group_history.rs`：`decide_manual_sync` 是一张三读数的纯裁决表
  （有无群 / 在飞 / 候选数 ⇒ `started` / `already_running` / `no_source` / `no_group`），
  `request_manual_sync` 只是它外面那层薄 IO。**没有新的搬运形状**：手动那一路复用的就是常规那趟，
  而它游标起点本来就是 `after_seq = -1`（全量重扫）、落库按 `msg_id` 幂等 ⇒ "只补缺口"是**结果**而不是特例。
- 标记 `ghsync:group:<gid>` 的写入收成**一个**家（`mark_history_pending`，入群钩子与手动按钮共用），
  起跑出口还是 `spawn_sync` 那一处（两条新判据把这两格钉住，见 §六·补 那份证据清单）。
- `no_source` 时标记照写 ⇒ 有人在线后由那把 60 秒清扫任务自动补上，不需要再点一次。
  `started` **也弹一句**（同日晚改口）：原本的"不弹提示，因为按钮会变转圈"那条理由是假的 —— 转圈与横幅都要等第一条进度事件，而第一件事是向最多 8 台各问一次摘要（每台最长 4s），这段窗口里界面什么都没有 ⇒ 用户读数就是"按了没反应"。
- 清空边界与撤回墓碑照旧生效：手动重扫**不会**复活用户清掉的历史。
- 如实登记的边界：跨进程那一格仍无判据（harness 造不出"应用自己执行一次 IPC"那一跳，与本文件
  前面"跨实例建群那一半仍缺"是同一条），观感与"点一下真的补到了"归真机；真机判据五条已写进
  `docs/acceptance/stability-smoke-matrix.md` 那一格。设计说明见
  `docs/notes/group-history-sync-2026-10-16.md` §六·补。

### 文档：群历史那一轮的 AOCI 认知收尾（4 条新 Entry + 33 条整行重绑）

按 AGENTS.md 那条认知合同走了一次维护。`aoci` MCP 在这台机器上仍然起不来（stdio 进程 ready 之前退出、
`aoci maintain` 这个子命令在 CLI 里根本没有），所以走的仍是 CLI `update-entry` 逐条通道，
每条都带 `--source-sha256`（绑定当前文件字节）。

- **新增 4 条** Entry：`src-tauri/src/db/group_history.rs`、`src-tauri/src/network/group_history.rs`、
  `docs/notes/group-history-sync-2026-10-16.md`、`scripts/e2e/rounds/ghsync.mjs`。其中两条落笔时被预算闸挡回 ——
  S 字段按 UTF-8 字节 ÷3 计 token，重要度档位 **7=80 / 8=140 / 9=200**；闸给的处置是"在该档位内完整重写：
  压缩语义，而不是机械截断"，所以是逐条改写后重过 `--preview`，不是砍尾巴。
- **整行重绑 33 条** = 14 条本轮真的改了职责（群族臂表 11→13、卡片落库站点 13→14、`35 变体 / 38 臂`
  那套台账数字改成"由判据自己打印"、轮次册数不再钉死而挂现读命令）+ 19 条只把指纹绑回当前字节
  （逐字未变 ⇒ 不产生 diff，这也是下面那个 20/16 的来源）。
- 判据（现算，不抄）：`aoci --json check` 的 `code_stale` ∩ `git show --name-only --format= 13291fd` = **0**，
  `code_missing` ∩ 同一集合 = **0**；**全仓仍剩 35 条 `code_stale` 属别的会话的账，本轮不清**。
  索引净变化 `git diff --numstat aoci.code.txt` = 20 增 / 16 删（= 4 新增 + 16 行有实义改动），
  `aoci status` 现读条目 **620**、基线 **985** 文件；复跑 `grep -c ': F:' aoci.code.txt`。
- ★ 一条今天才学到的形状约束：**Entry 正文里不许出现 `|`**。它同时是 F/R/A/S 的字段分隔符，
  把"现读 `ls … | wc -l`"这种命令原样写进 S 会让整行被判 `fras_structure_invalid`（不是超预算，是结构崩）。

## [4.43.0] - 2026-10-16

### 崩溃取证：panic 单独落一份不参与轮转的现场 + `diag/` 同秒重复折叠（补记 `80b93ec` / `2356c39`）

两条都是"崩了却拿不到现场"这一族，用户 2026-10-16 真机实测驱动：

- **`logs/gosslan-crash.log`**：panic 钩子那条 `logger.error("panic", …)` 现在除了写主日志，还会同步追加
  ① `>>> panic @ 文件:行:列：消息`、② **崩之前最后 300 条运行日志（取自内存环，不取文件）**、
  ③ 版本号 + 平台 + release/debug + 设备指纹。主日志 512 KiB 就轮转、只留一代，
  而局域网自检同一秒对同一设备能写 5~6 条 ⇒ 那句 panic 结构上留不住（12:17 那次现场就是这么丢的）；
  现场文件不参与轮转，2 MiB 封顶整份重开，全程同步写、写完即关、任何失败静默（此刻正要 abort）。
- **`diag/` 同秒折叠**：同 target + 整行文本完全相同 + 同一个 epoch 秒 ⇒ 只留第一条。
  两条反向边界各有判据：**`warn`/`error` 永远不折**（本轮审计主题就是"失败必须看得见"）、
  **只管 `diag/` 这一族**（非 diag 的 info 重复照旧各留一条）。折叠表 512 键封顶整表重开，挂实例字段不挂全局 static。

判据与自证：`logging::tests` 共 12 条全绿、整包 `cargo test --lib` 920 passed / 0 failed、clippy 退码 0；
**八笔单点变异各红且只红对应那一条**（摘掉落盘调用→3 条、去掉版本号→1 条、摘掉折叠调用→wire 那条、
放宽到所有级别→warn/error 那条、去掉前缀范围→非 diag 那条、去掉封顶→上界那条…），还原后逐字节一致。
前置条件也被钉住：那条测试先把主日志**撑到必然已轮转**（断言 `.old.log` 存在），否则"现场还在"只是日志还没翻。

⚠️ **机制的边界要写平**（现场页 §9 实测）：它挂在 panic 钩子上 ⇒ **只接得住 `0xc0000409` 那一族**。
10-16 傍晚 4.40.9 第一次崩（17:53:42、`4.40.9.0`）是**另一种形状**：模块 `KERNELBASE.dll`、码 `0xe0000008`、
偏移两次完全相同 —— 那是**软件异常（有人主动 `RaiseException`）**，不是 Rust panic，
所以那次崩**不会**在 `gosslan-crash.log` 里留下块。那种死法只认带堆 dump（`DumpType=2`）与事件日志。

**这两笔为什么没带 `Version-Bump:` trailer**：提交时 `package.json` / `Cargo.toml` / `CHANGELOG.md` 正被同工作树
另一会话改着未提交，整本重写会把他们还没进 main 的用例名与文案一起带上 main（判据口径是"缺名 FAIL、多名只 WARN"，
反而造出一条真红）。当时经门禁现判 `L1`、判据 4「无声明」通过（退码 0）⇒ 不提档不产生红；
本条是对方落定、工作树干净之后补的账。

### 新功能：群信息同步 —— 新进群的人自动拿到群里的聊天与群任务

负责人 2026-10-16 一句话需求，其中打包了六条硬不变量（聊天+群任务都要、只给**新进群**的人、
从"群信息最早最全的那个人"取、**全程自动**、**无感**、同步中**可以有提示**且不**卡顿**）。
设计说明与逐条落点见 `docs/notes/group-history-sync-2026-10-16.md`。

形状：新成员入群后，向群里每个"在线、有直连、且升级到本特性"的成员各问一次**摘要**
（`group_history_request{limit:0}`，只回 `total` 与两个 `seq`，不含正文），按读数选出一台
"**最早**（`oldest_seq` 最小）→ 同起点比**最全**（`total` 最大）→ 按 id 定序"的来源，
然后按 `(seq, id)` 游标一页一页搬回来逐页幂等落库。摘要与取页共用同一帧、靠 `limit` 分型
⇒ 只新增两个帧类型（`group_history_request` / `group_history_reply`），没有第三个探测帧。
"为什么不能按角色猜群主"写在那本说明的第一节：`group_members` 没有 `joined_at`，
也没有任何人知道别人家里存了多少条。

四条最容易写反、今天已经各有判据的格子：

- **保留源机的 `ts`**，不照抄实时接收那句 `now_ms()` —— 照抄就把 800 条旧消息全显示成"刚刚"；
  同时 `observe_clock` 照样推进，否则本机之后发的消息会排到刚同步进来的历史**前面**。
- **不复活用户清掉的记录**：落库前逐条走既有那道 `group_message_blocked_by_boundary` 水位
  （只对气泡类生效，群任务/公告是 Card 类、各成员必须看到同一份 ⇒ 两个方向各有一条反证）。
- **`kind` 原样搬**、不走 `display_kind()`（它把 video/audio 折成 file 给界面用），
  否则同步来的那一条与实时收到的同一条在库里成两种 kind。
- **未读恒 0、已有会话行的 `last_ts` 一个字不动**：补 800 条历史不该变成 800 条红点，
  也不该把用户正在处理的会话顶到列表最前。

"不卡"落在这几处：取数与落库进 `spawn_blocking`（JSON+AEAD+base64 那半刻意留在锁外）、
应答帧进调度表 **Low** 档（INV-P20）、页间让出 120ms、进度事件一律在 db 锁**之外**发
（INV-P25）、前端只在打开着这一群时重查且最多每 1.5 秒一次。授权另开一个判据
`serve_allowed` 而**没有**复用 `content_serve_allowed` —— 后者第一支 `if is_friend`
对群历史是错的（群历史属于群，不属于好友关系）。

随行的两处实测发现（不是设想，是这一轮跑出来的）：`insert_group_file` 自带两道闸
（群要在册、**sender 也要在册**）⇒ 落库改成"群行不在就整页前置拒绝、单行台账认不上就数出来
并留痕"，`退群者发过的文件` 那种历史页不再会被一格打死；`delete_group` 现在要把
`ghsync:` 那个状态一起删掉 —— 漏了它的表现是被踢的人重新入群后**永远不再同步**，
而界面正好是一个空群。

判据（本轮全部实跑，读数见下）：新增 **34 条** Rust 用例（`db::group_history_db_tests` 16 条 +
`network::group_history::group_history_engine_tests` 18 条），整层 `cargo test --features bluetooth --lib`
实测 **922 passed / 0 failed**；清单基线随之 macos 922 / windows 910（现算
`node scripts/check-test-manifest.mjs`）。其中四条"接线判据"做过变异自证：
摘掉 `lib.rs` 的清扫接线、把入群守卫改成恒真、把完成标记提前到循环之前、
把页预算退回"只算条目不算台账"的旧写法 —— 四个变异各让**自己那一条**报红（同层其余不动），
`cp` 还原并核过 md5 一致后复跑全绿。
**跨进程那一半新增一轮 `--round=ghsync`**（本轮那一步 14 条断言；「轮次账」按整趟 32 条记 = 复用的基础旅程 18 + 本步 14，
挂在发版前那一层）：A 有全部历史、B 是"刚入群、一格都没有"的那一台，只预置那一枚 pending 标记，之后每一帧都由生产码自己发。实测两面：正向
`test-results/run-2026-10-16T06-13-46-944Z` **本步 14 条全绿**；反向 `--round=ghsync-lie`（等待用真 id、
判据读翻过的 id）`run-2026-10-16T06-16-45-936Z` **恰好 5 条红**、其余 9 条照绿。
⚠️ 那两趟**整层**各报 3 条 / 8 条红 —— 多出来的 3 条全在基础旅程的文件那一格（`A 侧 file_outbox` /
`send 终态` / `进度`），早于本轮也与本轮无关：同一形状见 `run-2026-10-15T14-05-11-097Z` 与
`run-2026-10-15T14-31-11-739Z` ⇒ 这台机器今天跑任何一轮都会带上它们，那一格今天单独立账、本轮没有顺手修它。
另有一处是**自己审自己**时抓出来的（写的时候没想周全，判据也没覆盖）：一页的字节预算原来只累计
正文条目、不把群文件台账算进去，而台账行数只受"这个群有多少文件"约束 ⇒ 一帧可以远越过 1.5MB，
而接收侧是**握着全仓唯一那把 db 锁**逐行插的 —— 那正好是这条需求要避开的卡顿，也是 INV-P23
「一份预算只有一个家」被破掉的样子。补法是两格：台账与条目共用同一份预算并同样封顶（装不下的
**数出来**、由服务端日志留痕，不静默少给），加上落库前先判"这一页是不是我要的那一页大小"
（超了就整页不收、换源重来 ⇒ 对端拿不到"决定本机卡多久"的权力）。

台账跟着改的四处（都是"新增一家必须来这里看一眼"的那类守卫）：`dispatch_tests.rs` 的群族分发臂 11→13、
卡片类落库点登记 13→14、`lib_tests.rs::all_db_src()` 补上新分册的 `include_str!`（漏了就是形状守卫的假绿）、
`docs/domains.data.mjs` 把 `network/group_history.rs` 认领进 transport 领域。
另顺手改掉一处**本已过期**的 prose：`protocol.rs` 里那句"`Message` 有 36 个变体"在 HEAD 就差了 2
（现算 38 → 本轮 40），改成不依赖具体数字的写法，不再留一个没人回填的手抄数。

本次动了应用码 ⇒ 五处版本号与 `Version-Bump: minor` 声明在同一次提交里带上，落到 **4.43.0**：
档位与这一格的具体算法都由机器给（`npm run version:classify` / `node scripts/semver.mjs ledger`），
欠的是三档 minor —— 本条 feat + 4.40.9 之后两条**只提交没提档**的 `feat(logging)`（`80b93ec` / `2356c39`）。
（本轮实测的一条工具坑：`scripts/semver.mjs` 不认 `--help`，`... release --help` 会**真的执行一次发版提档**
 并往 CHANGELOG 里插一个空节 ⇒ 问它"要升到哪儿"请用 `classify`/`check`，别给 `release` 拼参数。）

### 文档：Windows 闪退第一次拿到版本区间（4.36.0 不崩 / 4.39.4 崩）

用户 2026-10-16 晚给出两个装机读数，`docs/notes/windows-crash-capture-2026-10-16.md` 新增第 5 节把它落成可执行的分档：
区间实测 **23 笔**（`git rev-list --count v4.36.0..v4.39.4`），每一档都有已发安装包（x64 setup 4.4 MiB），
**测 `v4.39.1` 一档即可切半** —— 切口右侧只剩 3 笔动过应用码（`81a9f12` 单实例守卫 / `6514179` Windows 大文件不卡 UI / `1ad2866` 评审补的三处）。

机器核对过的四条（都挂在第 5b 节的复跑命令上）：区间**唯一新增依赖** = `tauri-plugin-single-instance 2.4.5`
（它在 Windows 上建一扇常驻隐藏窗 + 自定义 `WNDPROC`，第二实例用跨进程同步 `SendMessageW(WM_COPYDATA)` 把回调打进**主线程消息分发**）；
`panic = "abort"` 全平台且本区间未改 ⇒ 新增的任何一次 panic 都表现为"进程直接消失"；
但区间新增**生产码**行里 panic 可构造 **0 处**、整读进内存 **0 处**（尺子用 `--numstat` 逐文件恒等核对过，同把尺在测试段能找到 72/34 处）；
`DB_VERSION` 全程 = 11 ⇒ **往回装老版本不会撞"数据比程序新 ⇒ 拒绝启动"那道闸**，这是能用已发版本做二分的前提。

另记两个会造出假读数的坑：插件 `semver` feature 默认关 ⇒ mutex/窗口类名不带版本号，4.39.2/4.39.4 互斥
但与 4.36.0/4.39.1 **不互斥**（混着装会出现两个托盘图标 + 两份 mesh 身份）；换档之间先读上一次崩溃的事件日志（不要钱）。

本次只改文档，不动代码 ⇒ 不做版本提档。

## [4.40.9] - 2026-10-16

### 4.40.8 那一版群收尾的事务其实一句都没落库：缺 `tx.commit()`，默认 drop 即回滚（⑥ 的第二半）

`network/transport/group_file.rs` 群接收收尾把三张台账收进了 `dbc.transaction().and_then(|tx| write_ledgers(&tx))`，
但闭包末尾**没有 `tx.commit()`**。rusqlite 的 `Transaction::new_unchecked` 把 `drop_behavior` 初始化成 `Rollback`
（锁定版 0.31.0 `rusqlite-0.31.0/src/transaction.rs:127`，`finish_()` 在 `!is_autocommit()` 时按该行为回滚）⇒ `tx` 在闭包结束即整段回滚，
而 `and_then` 拿到的是 `write_ledgers` 的 `Ok(())` ⇒ `wrote` 永远是 Ok ⇒ 那条"失败留痕 + 逐句补写"的 Err 分支
**结构上不可能触发**。净效果比 4.40.8 修之前更糟：改前三处各写各的、至少常态能落库；改后名义上"同一事务"、
实际上三张表一句都没写，而 UI 与 `GroupFileCompleteAck` 都按成功走。单聊那一家 `network/file/receive.rs:876`
闭包末尾有 `tx.commit()`（当时现数全仓 23 处 `.commit()`；4.40.9 现读改成两个口径分开写：**文本出现 32 处 / 排测试分册 22 处**，因为补账那一格又加了一次显式 commit），群这一处是漏的那一个。

改法（最小）：闭包末尾补 `tx.commit()` —— `write_ledgers(&tx)?; tx.commit()`。

护栏 `lib_file_tests.rs::group_receive_finalize_writes_three_ledgers_in_one_transaction_with_logged_fallback`
第②条从"必须包在同一个事务里"改成"包在同一个事务里**并显式 commit**"。
**这条护栏原来是个假守卫**：它的非空转只测了"换成裸写 `write_ledgers(&dbc)`"，从没测"有事务、没 commit"这一格 ⇒
861 条全绿的同时把 bug 钉成了规矩。成对变异实测（同一条断言只换被测源码）：未修源码上 `FAILED`（panic 在
`lib_file_tests.rs:548`）；补上 commit 后转绿。

### 稳定性体检第一轮：掐掉一条**按消息数增长**的 Windows 对象通道、补一格对端可控路径的边界、五家静默吞错改留痕、给 `messages.status` 的第二家补闸

起因是负责人的一句现场观察：**整晚只开着、不发消息也不操作，不崩；崩发生在收/发消息时，或他正在操作别的应用时，
而且可能连带带走别家 WebView2。** 这句话直接否证了"资源自然增长到顶"那一族 —— 挂着不动也该涨 ——
并把矛头收到"只有活动路径才跑的那段码"上。

**1）托盘图标：只在「有未读 ↔ 无未读」翻转时重设**（`tray.rs`）

旧写法每次未读数变化都重跑一遍整张图标的逐像素混合再 `set_icon`，**未读 3→4 时红点图其实是同一张**。
Windows 侧 `set_icon` = 新建一枚 `HICON` + `Shell_NotifyIconW`，而 `tray-icon` 在 `Shell_NotifyIconW` 失败时
**早退、跳过后面那次 `DestroyIcon`** ⇒ 句柄只增不减；图标/窗口这类对象走**每会话共享的桌面堆**，
这正是"我们崩、别家 WebView2 也被带走"能同时成立的那一类机制。改成翻转才动之后，一条消息洪水从
「每条一枚 HICON」降成两次（变红点、变回原图）。基准只在 `set_icon` **成功**时才记 —— 设失败就留在旧状态，
下次变化还会再来一遍，否则一次失败会把图标永久钉在错的那一张上。

用例两条（`tray::tests`）：翻转矩阵 + 真实序列 `0→1→…→8→0` 断言"只许三次重设"（第一次定基准），
把决策改回"每次都设"会当场数出 9 次。形状上用 `#[cfg_attr(target_os = "macos", allow(dead_code))]`
而不是整块 `#[cfg]`（照 `user_dirs.rs:26` 的反向写法）⇒ **mac 本地每次 `cargo test` 仍判得住这一格**，
不把证据全交给 Windows 腿。

**2）`open_file_native` 补目录边界**（`commands/files.rs`）

这条边界本仓早就有，只是漏在另一家身上：同文件 `delete_file` 上方的注释**自己写着**
"若哪天有 UI 把它接到消息里的 `path`（该字段由对端控制），没有它就会变成对端点一下删掉本机任意文件"，
删除侧照这句加了闸，而打开侧原先把前端来的字符串**原样**交给系统默认应用。链路现读是通的：
`MessageItem.vue:610` / `GroupFilesPanel.vue:127` → `utils/localFile.ts:29` → `api/index.ts:285` → 这里。
⇒ 一个过了 Hello 验签但被盗用/恶意的**好友身份**发一条带 `path` 的消息，本机的人点一下气泡就会打开任意路径。

改法：canonicalize 后只放行本应用自己管的四格（downloads / cache / favorites / 合并转发暂存 share），
**拒绝必留痕**（`file` 类目）——真机有没有合法用例被挡住，只有那条日志知道。
判定时顺序不能反：**边界用 canonical 结果**（能解掉 `..` 与符号链接），**交给系统的仍是原路径** ——
Windows 的 `canonicalize` 返回 `\\?\C:\…` verbatim 形式，而这条链在 Windows/Linux 上走
`tauri_plugin_opener` → `ShellExecuteW`，**`ShellExecute` 不支持 `\\?\` 前缀**
（macOS 走 NSWorkspace、Android 走 FileProvider 才与它无关）。把 canonical 直接递出去，
买到的是"边界严了、但你最常按的那个『打开』在 Windows 上死了"。
判据抽成纯函数 `path_under_any`，并让 `delete_file` 也改调它（不留第二个家）；
五条用例里最关键的一条是**按分量比对**：`downloads_evil/x` 不许被 `downloads/` 放行
（随手写成字符串前缀就会放过它），另有一条"空清单一律不放行"拦"canonicalize 失败退化成空表 ⇒ 边界被静默打开"。

**3）五家"卡片类"落库失败从静默改成留痕**

`transport/group_file.rs:126`、`transport/relay_file.rs:464`、`transport/handle_file.rs:512`、
`commands/group_announcements.rs:340`、`commands/share.rs:227` 原先都是 `db::insert_message(...).ok();`。
要说准范围：**主消息接收路径不是这样**（`handle_messaging.rs` 带 `?`、失败会拆链），
静默的是文件卡片 / 中继收齐卡片 / 群公告卡片 / 合并转发这几家 ⇒ 后果是"文件已在盘上、聊天里没那张卡、日志一字不记"。
**行为一字未改**，只补 `logger.error`；target 全部复用已有名字（`group_file`/`relay`/`file`/`group`/`chat`），不新造类目。
`check-invariant-hooks` 判的是"钩子绑没绑"，判不到"这一格留没留痕"——那一半门今天仍然不存在，这一条是留痕不是判据。

**4）`messages.status` 的第二家裸写补上同一道闸**（`db/messages.rs`）

`set_message_status` 上方注释点名的那条竞态（Ack 因 outbox 补发晚于 ReadReceipt 到达 ⇒ `read` 不许被回退成 `delivered`）
**原来只在一家上成立**。分母现算，全仓写 `messages.status` 的只有三处：`db/read_receipts.rs` 写 `read`（前进，无问题）、
`set_message_status`（有 `NOT IN ('read','delivered','recalled')` 闸）、**`update_message_content` 一句 `status = ?3` 没闸**。
最后这家的调用点是 `network/transport/group_file.rs:472`（群文件 Done）⇒ 走的正是"收消息时才跑"的那段码；
它不解释闪退，但它是同一族**静默错账**：已读会被路径回填打回未读。

闸只加在 `status` 上（`CASE WHEN status NOT IN (…) THEN ?3 ELSE status END`），**content 照旧无条件回填** ——
把路径一起挡掉就退回"预览缺 path"那个老形状，所以两个方向必须一起判。`failed`/`cancelled` 仍按既有口径当软终态允许前进。
用例一条（`db::tests::update_message_content_backfills_path_without_regressing_read`），与既有那条
`…_backfills_path_for_preview` 配成一正一反。**成对变异实测**：修复态 2 passed → 用正则把 `CASE` 换回裸
`status = ?3`（脚本自证注入 1 处）⇒ **恰好只有新那条 FAILED、旧那条仍 ok** → 还原后再 2 passed。

**自动化读数**：`cargo fmt` 退 0、`cargo clippy --features bluetooth --lib -- -D warnings` 退 0、
`cargo test --features bluetooth --lib` **871 passed / 0 failed**（本轮累计 +8 条：5 边界 + 2 托盘 + 1 状态闸）、
`verify-guards.py --list` 退 0（这次搬家没把注入锚点带坏）、`check-test-manifest.mjs` 复跑退 0，
测试名基线双边补齐（**macos 871 / windows 859**，跨平台差额由源码门控背书）；
`node scripts/verify.mjs` 快速层 17 步全绿。另补一份全仓此前**没有**的现场取证手册：
`docs/notes/windows-crash-capture-2026-10-16.md`（日志抢证 / WER / 事件日志三条 / 句柄计数采样与判读表）。

**仍然没验的，写清楚**：
① 真机 Windows 未验 —— 上面那条 HICON/`DestroyIcon` 的路径在**外部 crate** 里，本机连编译面都不在；
本轮做的是"把按消息数增长的那条通道掐短"，不是"证明桌面堆耗尽就是根因"。
② `panic = "abort"`（全平台生效）+ release 无 stderr + `strip = true`，根因判读仍要靠 `lib.rs:154-175`
那条 panic hook 落进运行日志的 `channel="panic"` 行 —— 已登记为"负责人这两天抓一次回来"。
③ CSP 这一格**故意没动**（`tauri.conf.json` 仍是 `"csp": null`）：五入口各有外链 script、前端 53 处 `blob:`、
预览走自定义协议 ⇒ 配错**静默白屏**，属必须真机验的一类，负责人选"单独一轮再上"。
④ 4.40.8 那版群收尾「台账实际是空的」这一格**只在跑过 `2de9264` 之后那版的机器上成立**：
本轮更正 —— `git tag --contains 2de9264` 空、`git ls-remote --tags origin` 最新 `v4.39.4`，
而发布流按 tag 触发 ⇒ 没有任何已发布安装包带那笔未 commit 的事务（线上旧版的缺账来自它前面那个
「三处写各吞各的错」的形状，来源不同、修法同一份）。存量补账本轮已做，见下面那一节。

### 存量补账走方案 A：群台账一次性后台作业（不做成迁移），新写的那段事务被自己的正向用例当场抓红

上一节登记的那一格（文件在盘上、三张台账一张都没有 ⇒ 这台不算种子、别人拉不到，而对账扫描器的谓词
捞不到「行根本没写成」）现在有了补的路。设计前提与五种反证在
[`docs/notes/group-file-ledger-backfill-2026-10-16.md`](docs/notes/group-file-ledger-backfill-2026-10-16.md)，
那一节末尾另记了实现期对本文两处更正（路径不必扫目录、判据来源换成 `group_files.sha256`）。

落点：`network/file/ledger_backfill.rs`（+ 判据册 `_tests.rs`）、`db/messages.rs::list_gfile_message_rows`、
`lib.rs` setup 里那一格作业。四条口径：

1. **不是迁移**：补账唯一的判据是整份 SHA-256，而群文件能到 GB 级；迁移在启动路径上同步跑，
   就是把 INV-P34 那一族已经数到十二家的同一个根因亲手装回起点（负责人点的正是这一条，选了 A）。
   形态因此是「启动后 20 秒起一次性后台作业 + settings 一个开关」，整趟跑完才写开关 ⇒ 中途崩下次重来，
   而每一条写幂等。
2. **三张都收口的行一次盘都不碰**：候选闸是三个走索引的点查（recipient / `is_transfer_done` /
   `content_transfers` 那一行），排在任何磁盘动作之前 ⇒ 健康机器跑这一趟的代价是一次 SELECT。
3. **哈希不握着库锁**：`gfile_ledger_repair` 收的是调用方在阻塞线程池里算好的 `Result<String, String>`，
   不是自己就地算 —— 本仓只有一个 tokio runtime，而 `state.db` 这把锁上排着消息收发与所有会读库的命令，
   GB 级哈希握着它几秒就是那几秒整条链一起等。形状判据按「全册只这一处整文件哈希」钉住它不被搬回去。
4. **认不上就一格都不写**（同名同大小、内容差一个字节的那一份被明确拒掉），路径失效同样不写；
   recipient 行不在 ⇒ **不造它**（那是「群外 state」，权限归 Offer 那一段），另两格照写并留一条 warn。

判据实测（七条新用例，全部本轮真跑）：正向补齐 + 补完不再进候选、哈希差一个字节 ⇒ 四格断言全不写（并把
「声明 ≠ 实测」两个 hex 原样带进日志）、路径失效 ⇒ 同上、第二次补不许多插行、候选闸四种形状
（健康 / 本机是发送方 / 还没落盘 都不进；卡片写着 path 却对不回 `group_files` ⇒ 只能数进孤儿，
因为「存量还剩多少补不了」没有这个数就是零条证据）、INV-P34 那条按格形状。
另跑四笔单点变异（每笔只改一处、跑当时那整册 **877** 条、逐笔还原后 `cmp` 确认逐字一致）：删 `orphan += 1` → 候选闸 1 红；
把哈希搬回 async 体就地算 → 按格那条 + 分母那条 2 红；哈希闸放宽成永远放行 → 对不上那一条 1 红；
把 `tx.commit()` 换成 `Ok(())` → 正向 + 幂等 + 候选闸 + 按格 4 红。⚠️ 顺带量到一件事：
**直接删 `tx.commit()` 那一行在本仓这处写法下编译失败**（闭包尾部变成 `()`）⇒ 登记的是**能编译**的那条形状，
别把编译器的运气当守卫。
第七条是**接线判据** `group_ledger_backfill_is_wired_once_at_startup_after_the_run`：`lib.rs` 那一格 spawn 如果被删，其余整册（当时 878 条）全绿而补账永远不会再跑（静默失效那一类）。它钉调用点只 1 处、完成标记只认常量名不认手抄字面量（现数 2 处 = 读一次 + 写一次）、由 `spawn(async move {})` 驱动、**跑完整趟才写标记**（次序）。两笔变异实测：写标记那处换成手抄键名 → 计数红；「跑作业」与「写完成标记」两段换序 → 次序红。为什么这条不套 INV-P34 那句「交出点与慢活之间不许 .await」：
本作业在 spawn 之后**先 sleep 20 秒**再动（让首屏、局域网自启、`.part` 清扫先跑），那个 `.await` 是刻意排在调用前面的 —— 第一次就跑红过，红在判据自己，改的是判据不是产品。

⚠️ **前两条第一次跑是红的，红在我自己身上**：新写的 `gfile_ledger_repair` 又漏了一次 `tx.commit()`，
与这轮在修的 `2de9264` 是同一个形状，被刚写下的正向用例当场报「recipient 仍是 sending」。
这条判据族的价值第一次是在作者自己身上验证的，不是"读过觉得它对"。

读数（**这三节的最终整册以现读为准**：七条新用例全部在册之后是 **879 通过 / 0 失败**；下面这些 877/878 是各次跑当时的整册数，保留是为了让每条结论对它那次跑负责）：
`cargo test --features bluetooth --lib` **877 通过 / 0 失败**（+6）、`cargo fmt --check` 退 0、
`cargo clippy --features bluetooth --lib -- -D warnings` 退 0；INV-P34 分母判据现算从 16 处/11 册变到
**17 处/12 册**，两处登记值与 `docs/migration-ledger.md` 第 13 行、`docs/protocol-invariants.md` 那条法
一并改齐（顺带修掉本文里那两处 stale 的「13/11」—— 判据当时登记的实数是 16/11，抄文档一直对不上）。

**有一类结构性补不了（本轮现读登记）**：`scope == "todo"` 的群图按设计**不插卡片行**
（Offer 把插气泡包在 `if scope != "todo"` 里），而本作业的候选来源就是那些 `gfile-%` 消息行 ⇒ 这一类**看不见也数不出**。
4.40.8 若发生在待办图上，本轮补不了 —— 不是"选择不修"，是这条路上没有任何证据。要收它得从 `group_files` 那侧重开一格。

**仍然没验的**：这一趟没在真机跑过 —— 本机没有那批缺账的库，所以"存量确实被补上"只有单测判据、没有装机读数。
等 Windows 抓崩溃日志那一轮顺带现算：日志里那条 `群文件台账补账跑完：候选 N、补上 N、跳过 N`，
配 `SELECT COUNT(*) FROM content_transfers WHERE direction='receive' AND path IS NULL`。
那一行日志现在带四个数：`群文件台账补账跑完：候选 N、补上 N、跳过 N、对不回身份的卡片 N`，
最后那个是本轮**补不了**的那一块（设计那节第 5 条）。
`list_gfile_ledger_gaps` 的**规模**也没量过（按卡片行数 × 三次点查握库锁），今天无读数 ⇒
若"跑完"那条迟迟不来，先量这一格，别先怀疑哈希。

### 稳定性体检第二轮：把「落库失败要看得见」这一族数完整（又找出三家），并给它配一条按形状扫全仓的判据

上一批改了五家卡片落库的静默吞错。这次先问的不是"还有没有"，而是**按形状数一遍**：
把五个名字（`insert_message` / `insert_message_if_new` / `insert_message_and_outbox` /
`update_message_content` / `fill_message_sha256`）在生产码里逐个取调用尾部，看那个 `rusqlite::Result`
到底去了哪儿。数到 **13 个落库点**，按四类分：向上报错 `?` / `.map_err` **4 处**（`commands/chat.rs` ×2、`commands/files.rs`、`commands/window.rs`）、`if let Err` 留痕 **6 处**、`match` 的 Err 臂留痕 **1 处**、
交给三态判据（`let inserted =`，Err 臂里留痕）**2 处** ⇒ **要留痕的是 9 处**：上一批改了 5 处，本轮又找出 **4 处**
—— 其中 **2 处是我上一批自己漏的第二面**、2 处是入站那两家（流量比原来那五家都大）：

- `network/transport/group_file.rs:472` —— 群 Done 回填 `content.path` 那一句仍然是 `.ok();`。
  上一批把**同一个文件里** `insert_message` 那一面改成留痕了，同一个收尾的另一面就在"已改"那行底下继续漏
  （本仓那条老账：同一开关的另一个面最容易漏）。它没写成 ⇒ `read_file_preview` 反查不到本地文件，
  而"已被清理"这个确定性失败判定会被前端**永久缓存** ⇒ 盘上有文件、气泡永远空白。
- `network/file/send.rs:70` —— `fill_message_sha256(...).unwrap_or(false)` 把"库报错"和"幂等跳过/缺行"
  压成同一个 `false`。`db/messages.rs` 顶上那句注释**本来就写着**"调用方不得把 Err 折叠成 false"，
  只是没人机器核对过；这一格的代价是合并卡片按空 cid 带出去 ⇒ 对端再也拉不回这份字节（v4.22.16 那族）。
  改成 `match`，Err 臂留痕后**仍返回 false**（返回值与行为一字不变）。
- `network/transport/handle_messaging.rs:145`（臂体在 `:154`）与 `network/transport/gossip.rs:898` —— 入站落库返回 Err 时
  行为是**对的**（不投递、绝不 Ack ⇒ 发送方 outbox 保留待补发），但日志一字不记。这两家比原来那五家流量都大。

四处都只补 `logger.error`（target 复用已有的 `group_file` / `file` / `dispatch` / `chat`，没有新起名字），
**行为一字未动**。顺带排掉一颗雷：日志 target 白名单只挡 Android 的 info 级进 logcat，
`Warn|Error` 一律进、落盘无条件（`logging.rs:248-251`）⇒ 这一族不是"写了看不见的假留痕"。

判据（这一族的**防复发**，之前完全没有）：`tests::card_message_writes_never_swallow_their_error`
（`lib_relay_data_tests.rs`，与 INV-P34 那条分母判据同册同形状）。它按**括号配对**取调用尾部，
不按行窗口也不按 `;` 切语句（多行实参是常态，`update_message_content` 那一句就跨四行 ——
本仓吃过"单行正则数跨行返回 0"的亏）；禁形 `.ok()` / `let _ =` / `.unwrap_or(_)` / 裸丢弃，
允许名单只有四种：`?`、`.map_err`、调用前是 `if let Err(e) =`、或交给三态判据（`let inserted =` /
`let backfilled =`）。`.unwrap()` / `.expect()` **故意不在名单里**：那会 panic 在 `reader_loop` 或命令体上，
比留痕更糟。两条非空转设计：**站点总数钉成 13**（放宽尺子或新增一家不登记 ⇒ 立刻红），
以及把内联 `#[cfg(test)]` 段整段抹掉后再数（不抹会把 `db/{groups,clocks}.rs` 里**五处**正当的测试 `.unwrap()` 报成生产缺陷（现读：`db/groups.rs:434/502`、`db/clocks.rs:120/168/179`；上一版写「六处」是把一处 `network/file/send.rs` 的生产调用误算进了测试） —— 而"判据一片假红"的下一步通常是有人把它放宽）。

三笔单点变异实测（每笔只改一处、跑这一条用例、逐笔还原后 `cmp` 确认逐字一致）：
把第八家退回 `.ok();` → offenders 红；把第九家 `match` 的 Err 臂留痕摘掉（`Err(_e) => false`）→ offenders 红；
把判据自己的 `NAMES` 少认一个名字 → 分母那条红（13 → 12）。三条边界如实写在判据注释里，不装作它管一切。

收尾按 AGENTS.md 那条认知合同走了一次 AOCI 维护（本会话没有注册 `aoci` MCP，走的是 CLI 的 `update-entry` 逐条通道，每条都带 `--source-sha256`）：**新增 3 条**（`network/file/ledger_backfill.rs`、`ledger_backfill_tests.rs`、`commands/files_tests.rs`），**就地改准 5 条被本轮证伪的旧条目**（`network/file.rs` 的「切成五册 / 主文件 398 行」、`commands/files.rs` 的「只允许删除下载目录内」——现在是两侧共用一个谓词、四个托管目录、`db/messages.rs` 的状态闸第二个家与新读者、`transport/group_file.rs` 的「三张台账同事务且必须 commit」、`lib_relay_data_tests.rs` 的册职责），并顺手按工具自己的字典把两处规模档位改准。S 字段有按档位给的 token 预算（本轮实测：L 档 200、DP8L 那条 140），超了就整条拒收 ⇒ 不是截断，是重写到预算内。
索引净变化现算：`git diff --numstat aoci.code.txt` = 8 增 / 5 删（=3 新增 + 5 整行替换），`aoci status` 的条目数 616、基线 981 文件。

台账同步刷新（都是现算，不抄）：`include!(` 缝合点 **113**（本轮 +3）、生产码 `let _ =` **356 处 / 67 册**、
`.ok();` **110 处**，并写明这三个是**观测值不是缺陷清单**。本轮**不新造 INV**（这条属可观测性纪律，
挂进 `protocol-invariants.md` 要连钩子登记、例外、图里 inv 快照一起改六处，而它今天的实际价值已被上面那条判据兜住）
—— 理由连同第 8~12 行一起登记在 `docs/audit/ledger-2026-10-16.md` §5。

### 稳定性体检第三轮：两路只读审查回来以后，先补我自己那条判据的假绿，再补被查出的一条 P1

这一节的四条全部来自**独立复核**，不是我自己又看了一遍：两路只读子代理（一路读逻辑、一路做判据与登记对账）
加我自己对每条结论的复现。全程没跑过编译以外的一件事，且都限定只读。

**已修**：

1. **P1 —— 完成标记是无条件写的**（`lib.rs:534` 之前）。补账作业里两条提前返回（候选扫描失败、扫描任务被中断）
   与任一条台账写失败，都不影响标记照写 ⇒ **一次 SQLITE_BUSY 就把这台永久钉成"不再补账"**，
   把一次临时故障变成一个不可恢复的决定。加 `GfileLedgerBackfillStats::incomplete`（三处置位），
   `lib.rs` 用 `if stats.incomplete { 留痕; return; }` 挡在写标记之前；那句与实际不符的注释改成
   「标记的语义是**有一整趟跑到底**」。
2. **P2 —— 接线那条 `#[test]` 我落在了 `mod` 闭合之后** ⇒ 没有 `#[cfg(test)]`，**会被编进 release 产物**，
   还带着 `include_str!("../../lib.rs")` 把整份 lib.rs 烤进二进制。它逻辑正确、跑也绿，纯粹是位置错。挪进 mod ⇒
   全名多一段，两份基线同步；⚠️ 顺带量到一个工具形状：`--sync-baselines` **只增不删**，改名后另一条腿留着旧名，
   被"跨平台并集"那条判据抓住时它报的是「macos 少一条」而真因是 windows 多一条 —— 只能手工删那一行才平。
3. **P2 —— 候选扫描在 async worker 上握着全仓唯一那把 db 锁**。审查给的"LIKE 不走索引、整表扫"这个**前提我否证了**：
   用**应用里那台引擎**（rusqlite / `libsqlite3-sys 0.28.0`）现读 `EXPLAIN QUERY PLAN` =
   `SCAN messages USING INDEX sqlite_autoindex_messages_1`，与本机 CLI 3.50.6 同解，`ORDER BY msg_id` 免排序。
   但结论仍成立（全索引扫代价随消息总数长、且握锁）⇒ 整段进 `spawn_blocking`（闭包内取锁，照同段 `.part` 清扫那格的形状），
   并把这条执行计划钉成用例 `candidate_query_is_index_scanned_by_the_engine_we_ship`（用了自动索引 + 不许出现 `USE TEMP B-TREE`）。
4. **⚠️ 我这条新门判据自己是假绿的，被变异例行公事抓出来**：断言原本写「找得到 `if stats.incomplete {`」，
   而 `lib.rs` 那句日志三元式 `if stats.incomplete { "否" } else { "是" }` 含同一串 ⇒
   把门改成 `if false`（可编译的破坏形状）之后**判据仍然绿**。改成钉**出现次数 == 2**（三元式 1 + 门 1），
   再取"写标记之前最后一次出现"定位那道门判次序。复跑同一笔变异现在红并写着"现数到 1 处"。
   这条与既有那条「存在性断言是半个守卫」同形，但这次是**我在同一轮里新写的一条**，值得单独记。

还顺手清了两处**文档/注释与实物相反**的账：

- `commands/window.rs` 的 `window_close` 注释写着「其余（设置/日志/群任务，均不常驻）直接销毁」，实物是 `AUX_TASKS_RESIDENT = true`（现读四常量 WINDOWS=false / LINK=true / TASKS=true / PREVIEW=true）。这违反的正是 `commands/logs.rs:175` 自己写的规矩——「每扇的取舍理由写在各自常量上，别在这里再数一遍，数一遍就会过时」。新注释**不再点名**，改指常量。
- `docs/audit/ledger-2026-10-16.md` §4 从「代理报、尚未自验」逐条改成带现读结论的表；改的过程中**我自己上一条复跑命令被打脸两次**：① 挂在「11 个 `message-received` emit 点」后面那条 `grep -rn 'emit("message-received"'` 只得 **10** —— 生产码是 `emit(` 换行再写事件名的跨行形状，行式正则天然漏一条（台账里现在行式／跨行式并列，并标明哪个是假数）；② 上一版写「`useChatStore.ts` 三次整表**其中** 5 次逐行 `JSON.parse`」，现读该文件 `JSON.parse` = **0 次**，那 5 处真身在 `src/utils/`（`messageHeight.ts:136/161`、`messages.ts:81/268`、`fileMeta.ts:22`）——**数是从子代理来的真数，文件是我拼上去的**。教训：验数要连「这数在哪个文件」一起验，给复跑命令要站在读者的位置原样跑一遍。

**只登记、不改的**：`scope == "todo"` 的群图按设计不插卡片行 ⇒ 补账结构性看不见那一类（上一节已写）；
`ledger_backfill.rs` 头部缺「搬家同批必须做的两件事」那句成例提醒，已按 `network/file/send.rs` 的形状补上。

对账结果里**复算与我一致**的部分（不是白跑：它们否证了我文档里三处 stale 数）：卡片落库判据的分母 **13** 与四类拆分
（上抛 4 / `if let Err` 6 / `match` 1 / 三态 2）、INV-P34 的 **17 处 / 12 册**（含 12 项登记的排序与绝对路径排序后逐格一致）、
两个新册在 `include!`、`file_src_for_guards()`、两份基线（该册 8 条用例名两平台逐字对得上，复跑：把 `test-baseline.*.txt` 里含 `gfile_ledger_backfill_tests` 的行与源码 `#[test]` 名单做双向差集，两侧都应为空）、`domains.data.mjs` 里的登记。
被改准的：`protocol-invariants.md` 与 `migration-ledger.md` 各有一处仍写"十一处/十家"；两处把那条按格判据写成
`tests::` 前缀（真名是 `network::file::gfile_ledger_backfill_tests::…`，指不到实物）；"全仓 23 处 `.commit()`"改成两个口径
（文本 32 / 排测试分册 22）；"六处正当的测试 `.unwrap()`"实为**五处**（我把一处生产调用误算进测试）；
台账"共 6 笔变异"改成按族拆开计数；`include!` 三处口径那句 110 → 113。

读数（全部本轮现跑）：`cargo test --features bluetooth --lib` **880 通过 / 0 失败**、`clippy -D warnings` 0、`fmt --check` 0、
测试清单守卫 0（macos 880 / windows 与并集一致）、文档硬数字与 `file:line` 两道对账各退 0；
判据侧另有两笔新变异：门改成 `if false` → 接线那条红；补账册摘掉一条 `incomplete` 置位 → 同一条红（各红各的）。

## [4.40.8] - 2026-10-15

### 审计第九轮：群文件收尾的三张台账收进同一事务（⑥），失败那一半留痕但不许停在中间态

`network/transport/group_file.rs` 的群接收收尾（`handle_group_file_done` 成功分支）此前把三张台账各写一次、
错误各吞一次：`update_group_file_recipient` 与 `record_local` 用 `let _ =`、`upsert_transfer` 用 `.ok()` ⇒
`content_transfers` 那一行**可能根本没被构造**（群侧这一行就是在这里首次写的）。而对账扫
`outbox_sweep.rs::list_reconcilable_content` 的谓词要求内容层**已有一行**且 `path IS NULL` ⇒「行根本没写成」
它捞不到 ⇒ 这一格**没有兜底**：盘上有文件、台账不知道，这一台不算种子，别人再也拉不到。
单聊那一家在 2026-10-13 真机第 7 条（`file_transfers` 说 done、`content_transfers` 没有 ⇒ 每次建链整批再投）
之后已经是「同一事务」，群这一处是同一个形状的第二家 —— 这正是指令 §四要求分开证明、不许靠重启恢复的那类。

改法（最小、可回滚）：

- 三处写收进**一个闭包**（只有一份 ⇒ 补写不会和事务里那半边漂开），整体放进 `dbc.transaction()`；
- 事务失败 ⇒ 打一条 `group_file` warn（带 `transfer_id`），再退回今天的形状逐句补写。
  **不选「整体不动」**：收件方与 `file_transfers` 不收口会把气泡停在「文件确实已在盘上但永不完成」那一格
  （§3.2.C），而那一格只能靠重启恢复 ⇒ 等于用一个新故障去修一个旧故障；
- 失败时 `GroupFileCompleteAck` 仍按今天的 `success = true` 发出 —— 这是既有协议语义，本轮**不改**（改它
  会让发送端把已落盘的文件判成失败，属于协议语义变更，需单独设计评审）。因此这一格留下的已知缺口是：
  事务与补写都失败时，对端仍会以为这台已完成而不再补投 ⇒ 需要真机读数才知道实际发生频率。

护栏 `lib_file_tests.rs::group_receive_finalize_writes_three_ledgers_in_one_transaction_with_logged_fallback`：
窗口按两条注释锚切（不用定长窗口），正向钉「闭包一份 + `dbc.transaction().and_then(|tx| write_ledgers(&tx))` +
三处写各出现恰好一次 + Err 分支里有 warn 且 warn 之后有补写」，反证钉 `.ok();` 不许回来。
**非空转实测**：把事务换成裸写 `write_ledgers(&dbc)` ⇒ 恰好在「必须包在同一个事务里」那条报红；恢复后全绿。

本轮同批被既有护栏拦下一次并据此改形：`group_receive_finalize_slow_work_runs_off_the_async_worker` 按数量钉
「recipient 与 `file_transfers` 的终态写各恰好两处（一失败一成功）」，我第一版把三处写在补写里又手写了一遍 ⇒
该守卫判红。这个红是对的：**两份手写迟早少一张表**。改成闭包后那条既有守卫一字未动、读数仍是 2/2。

自动化读数：`cargo test --features bluetooth --lib` **862 passed / 0 failed**，
`cargo clippy --features bluetooth --lib -- -D warnings` 干净，测试名两平台基线同步（macos 862 / windows 850）。
真机双端未验证：本轮造不出「事务中途失败」的真实注入通道（要 SQLite BUSY 或磁盘错误时机），
所以「修复后群文件不会再丢种子行」只能等 §五 那条新 warn 在现场出现与否来判读。

## [4.40.7] - 2026-10-15

### 审计第八轮：入站 accept 的两格静默拒绝补现场证据（⑪），并用量具否掉「空转」这条假想危害

现象仍在问题 B 这一族（「对端在列表里可就是连不上，要双方都重启才恢复」）。`network/transport.rs` 的 accept
循环里此前有两格 `… else { continue }`：accept 自己报错、以及入站并发许可（上限 128）占满 ⇒ **一行日志都不打**，
磁盘上没有任何东西能把「TCP 建连失败」与「本机把自己拒了」分开（指令 §五要求这两格必须分得开）。

这轮先把「要不要加退避」这条量掉，因为它是这格的假想危害：

| 量具（本机 macOS，压 `RLIMIT_NOFILE` 后让 N 条连接进 accept 队列再 accept） | 读数 |
| --- | --- |
| 队列 1 条：`accept()` 报 errno 24（EMFILE） | 之后 poll **不再报可读**；腾出 fd 再 accept 得 **errno 35（EAGAIN）** ⇒ 那条已建好的连接被这次失败的 accept **吃掉**了 |
| 队列 2 / 4 / 8 条 | 就绪次数 **1 / 3 / 7**（每失败一次吃掉一条）、cpu/wall **0 / 2 / 15 / 1%** ⇒ **不是空转** |
| 锁定版本源码核对 | mio 1.2.3 `mio-1.2.3/sys/unix/selector/kqueue.rs:127` 注册带 `EV_CLEAR`（边缘）；tokio 1.53.1 `TcpListener::poll_accept` 对非 `WouldBlock` 的错误直接 `Poll::Ready(Err)` ⇒ 既不重唤醒也不自旋 |

⇒ 结论反过来用：**这一格不加退避、不改循环结构**（量具否证了假想危害，写上去的就是没被测过的东西），只补
「分类 + 节流 warn」。`accept_failed` 带 `kind` 与 `raw_os_error`：Windows 上句柄耗尽的错误码要和 macOS 的 24
分开证明，不能凭「精简系统」下结论（§四.3），所以原始码直接进日志。`inbound_full` 带被拒地址与剩余许可数。
两者都走现成的 `log_throttled(…, 10_000)`，复用既有 `logger.warn("link", …)` 通道，不新增磁盘高频写。
分类用 `raw_os_error()` 而不是 `ErrorKind::TooManyOpenFiles`：后者在 rustc 1.98 仍 unstable
（`io_error_too_many_open_files`，实测编译报 E0658）。

护栏落在 `transport/listen_tests.rs`（分册之 15「监听口平台语义」）新用例
`inbound_rejects_are_logged_not_silent`：按字面锚取 accept 循环体为窗口，正向钉两处节流与两条 warn 及 EMFILE
原始码分类、反证钉两格静默形状（`… else { continue }`）不许回来、分母钉这个循环里 `.warn(` 恰好两处。
**非空转实测**：把 `accept_failed` 那整个日志块删掉后重跑，护栏在第一条正向断言处报红（`0 passed; 1 failed`），
恢复后 `861 passed; 0 failed`、`cargo clippy --features bluetooth --lib -- -D warnings` 干净。
为什么是源码护栏而不是行为测试：accept 循环在 `tokio::spawn` 里吃 `Arc<AppState>`（要真实 tauri `AppHandle`，
单测造不出来），`dial_tests.rs` 的 `lan_dial_failure_is_logged_not_swallowed` 是同一条先例。
测试名两平台基线同步登记（`--sync-baselines`）：macos 861 条、windows 849 条，差额全部由源码门控背书。

顺带把三条只读到「没做」的账登记清楚（本轮不动码、各写理由）：⑥ 群收尾那一格三个写库动作各自吞错且不在同一
事务，而对账扫的谓词要求 `content_transfers` 已有一行 —— 群侧那一行正是在这里首次构造 ⇒ **判为无兜底**，本轮
按事务收拢（另节）；③ 每片两次取 `file_receivers` 是顺序不是嵌套、无故障证据 ⇒ 不动；⑧ `transport.rs` 的
`eprintln!` 所在函数拿不到 logger 且整段 `#[cfg(windows)]`，本机与 Android 门禁都编译不到 ⇒ 改了也无法自证，
留待连着 Windows 编译验证一起做。

## [4.40.6] - 2026-10-15

### 审计第七轮：INV-P34 的「第十一格」——设置里点「清除数据」时，整棵树删除还钉在 worker 上

现象仍在问题 A 这一族（「界面卡死或部分功能失效」），触发点是**用户在设置窗口点「清除数据」**。
这条不是猜的：同一函数上半段的注释里就写着负责人实测「点「清除数据」→ 设置窗口卡死、点不动」，
4.39 那一轮为此把**库删除**改成分批 + `tokio::task::yield_now()`；本轮读到下半段才发现
**文件删除那一半从来没动** —— 同一根因在同一个函数里被修了一次、留了一次。

| 证据 | 实物 |
|---|---|
| 违规形状 | `commands/favorites.rs` 的 `clear_all_data`（async 命令）体内直接 `std::fs::read_dir` + `remove_file` + **`remove_dir_all`** 遍历 `cache_dir`、`downloads_dir`、`favorites_dir` 三个目录 |
| 为什么这是 GB 级 | `downloads_dir` 正是接收文件落地的地方、`favorites_dir` 装着收藏复制出来的副本；整棵树删除的耗时**按数据量**，不设上限 |
| 为什么钉住 worker | 本应用只有一个 tokio runtime，所有 `#[tauri::command]` 与网络任务同池（4.40.5 那节已用锁定版本源码把这条钉死：宏把同步命令体也塞进 `async_runtime::spawn`） |
| 生产码里这个名字共几处 | `grep -rn "std::fs::remove_dir_all(" src-tauri/src` 现数 **12 处**：8 处在 `#[cfg(test)]` 测试体内、1 处在 `Drop`（尺子不扫）、**3 处全在这一个 async 命令体内** |

**最小修改点**：把下半段三个目录的清理**整体**交给 `tokio::task::spawn_blocking`，抽出一个同步
helper `clear_dir_contents(dir, tag)`，并给它配 `unwrap_or_else(|e| Err(..))?` —— 线程池的 `Err`
不许被伪装成 `Ok`（INV-P34 规则 4）。**行为逐格恒等**：删的还是那三个目录、顺序不变、
`read_dir` 失败仍按原口径**立即**向上报 Err（不是吞掉、也不是继续猜后面）、单条删不掉仍收成
`{tag}: 路径 (错误)` 在末尾拼成同一条 Err、`notify_data_cleared` 的广播时机不变、那条带文件路径的
错误文案一字未动。回滚＝revert 这一笔。

**判据是先红后绿落下来的**（不是补的）：分母判据 `tests::whole_file_slow_work_never_runs_on_an_async_worker`
的 `PRIMITIVES` 从 8 个名字加到 **10 个**，两条红依次为 ——
① 加 `std::fs::remove_dir_all(` 那刻：`现数到 16 处、登记 13 处`；登记值改到 16 后红换成
`offenders 命中 3 处，全部点名 commands/favorites.rs [std::fs::remove_dir_all(]`（判据自己打印的家）。
② 搬完之后再跑：处数落回 **13** —— 不是回到原样，是**组成变了**：`remove_dir_all` 在受扫体内出现 0 次
（它搬进了同步 helper），新增的是 3 次 `clear_dir_contents(` 调用。

**这里正好撞上台账第 13 行写着的盲区①，而且这是它第一次真实命中**：尺子扫的是 async 体，
"把整份慢活抽进一个同步 helper"会让该名字在受扫体内归零 ⇒ 判据**判绿**。同一形状如果落在
"抽了 helper 却直接在 async 体里调它"上，光登记 `remove_dir_all` 是拦不住的。所以第十个名字登记的
是 **helper 自己的名字** `clear_dir_contents(` —— 以后谁把它搬回 async 体就地调，分母当场红。
**反例能力（本轮实测）**：把其中一格改成 spawn_blocking 之前的直接调用（单点变异）⇒ 判据红在处数那格
（`现数到 17 处、登记 16 处`）；offenders 那一格被前一条 assert 先挡住**没打印**，所以这条变异只验到
"会红"，没验到"红得有名有姓"——这点如实记着，与 4.40.4 那笔"处数与 offenders 两处都红"不同。
变异体已逐字节还原（`diff -q` 与自备份一致）。

**读数（全部裸取退码，不经管道）**：`cargo fmt --check --all` 退 0；`cargo clippy --features bluetooth -- -D warnings`
（门禁第 19 步那条原命令）退 0；`cargo test --features bluetooth` 全目标 **860 passed / 0 failed**（lib 860、
bin 0、doc 1 ignored）；分母判据绿且现数=登记=13、家=11 册。
⚠️ 记两条我自己踩过的：① 一开始把 clippy 退码接在 `| tail` 后面 ⇒ 拿到的是 `tail` 的 0，屏幕上还印着
48 个 error；② 那 48 个 error 来自我**自造的** `clippy --lib --tests`，而门禁那条命令是绿的、
`src-tauri/tests/` 这个目录根本不存在 ⇒ 认结论只认门禁原命令，别拿自己拼的命令行当读数。

**这一格仍然买不到的**：尺子认的是**名字**，`remove_file` / `read_dir` 这类"与读 8 KB 配置字面同形"
的小活儿照旧不进清单（进了尺子就成噪声，台账第 13 行第 ③ 条盲区原样保留）。本轮只新增了两个名字。

**登记但这一轮没动**：⑪ `network/transport.rs:231` 的 accept 错误臂一律静默 `continue`（本机实测
`TooManyOpenFiles`/os 24 ×128 次零日志，最小诊断补丁形状已给出，等推送窗口）、⑩ 收藏那条 `?` 出口
不留删副本、③ 每片两次 `file_receivers` 抢锁、④ 落库节流与事件节流共用 `last_report_ms`、
⑥ 群 done 失败不落 `Incomplete`、⑦ 预览 IPC 的两半真机读数、⑧ `set_abortive_close` 的 `eprintln!`、
⑨ UDP 两处 `let Ok(..) else { continue }`。

**交付状态**：这一格是「已修改 + 自动化判据已落」，**不是**「生产已修复」——负责人真机上点一次
「清除数据」（ downloads 里先放几个 GB 级文件 ）才是收口证据；本轮双端读数仍为零。



## [4.40.5] - 2026-10-15

### 审计第六轮：⑦ 那格从"要真机才判得动"变成"形状已判、量级有下界"，另登记两处只查到没动的

**这一轮零应用码**（只改 `docs/protocol-invariants.md`、`docs/migration-ledger.md` 第 13 行、本节）。

**先记门禁读数**（`npm run verify:full` 在 tip `c5737d7`，日志 `/tmp/v4399.log`）：23 步**红 1 步**
——红的是第 14 步 Change Budget，红在**未推送范围**的判据 3（重复犯案那格），属已知历史欠账，
不是本轮造出来的；其余 22 步全绿，含第 22 步护栏非空转（前端子集，838.1s）与第 23 步 Android
编译门禁（16.2s），总 913.2s，`VERIFY_EXIT=1`。⚠️ 后台完成通知报的是**启动器**的退出码 0，
不是这条链的 ⇒ 认结论只认日志里那行 `VERIFY_EXIT`。上一轮那条"护栏注入步被历史欠账牵着红"
的接缝病在这份读数里已经消失（第 22 步绿）。

**⑦ 的形状判定（问题 A 的前端那一半，此前我写过"要真机才判得动"，那句太重了）**：读**锁定版本**
的 crate 源码（`src-tauri/Cargo.lock` 现算 tauri 2.11.5 / tauri-macros 2.6.3），三件事是源码里写死的：

| 依据 | 事实 |
|---|---|
| 那份 ipc 下的 protocol.rs 第 392 到 405 行 | 响应体是原始字节时，`target_os = macos/ios` **无条件**走 `responder_eval`（把响应序列化进一段 JS 源码再 eval）；只有非 mac/ios **且** 自定义协议没被前端逐请求上报为 blocked，才走 Channel→自定义协议（前端直接拿 ArrayBuffer） |
| 同那份 crate 的 ipc 下 mod.rs 第 133 到 140 行 + format_callback.rs 第 83 到 89 行 | 序列化形状 = `serde_json::to_string(&Vec<u8>)` ⇒ **一字节一个十进制数**；那份 mod.rs 第 54 到 56 行的文档自己就写着"number array 比 base64 更慢" |
| `src/utils/filePreview.ts:191` 那句注释 | 「mac 上是 number[]、其余平台是 ArrayBuffer」**与源码一致** —— 此前它只是口头说法，现在有据 |

**顺出的一处欠账（同一条根因常有第二个家）**：这一族不是 `read_file_preview` 单独一格，是**三格一家**，
同一条 15 MiB 封顶：`commands/helpers.rs:189`、`commands/favorites.rs:239`（`read_favorite_preview`）、
`commands/favorites.rs:303`（`read_content_preview`）；前端对应也是**三个归一点**：
`src/utils/filePreview.ts:148`（`loadThumbPreview`）、`:196`（`loadFilePreview`）、`:242`（`loadContentPreview`）。
复跑：`grep -rn "max_bytes.min(15 \* 1024 \* 1024)" src-tauri/src --include="*.rs"` 与
`grep -n "new Uint8Array(raw)" src/utils/filePreview.ts`。

**量级（本机 V8 一次读数，是**下界**不是真机读数）**：把 `serde_json` 那个形状原样喂给 JS 再量解析成本 ——

| 载荷 | 元素数 | 注入的 JS 源串 | JSON.parse | new Uint8Array | 合计 | ArrayBuffer 对照 |
|---|---|---|---|---|---|---|
| 512 KiB（代码预览上限） | 524,288 | 1.8 MiB | 15.3 ms | 0.5 ms | **15.8 ms** | 0.0 ms |
| 200 KiB 缩略图 | 204,800 | 0.7 MiB | 4.6 ms | 0.2 ms | **4.8 ms** | 0.0 ms |
| 2 MiB 常见图片 | 2,097,152 | 7.1 MiB | 63.1 ms | 3.0 ms | **66.1 ms** | 0.0 ms |
| 5 MiB 大图 | 5,242,880 | 17.8 MiB | 183.3 ms | 6.4 ms | **189.7 ms** | 0.0 ms |
| 15 MiB（三格共同的封顶） | 15,728,640 | 53.6 MiB | 576.8 ms | 40.0 ms | **616.9 ms** | 0.0 ms |

每次探针都自校"往返字节一致"（首末字节 + 长度全等），ArrayBuffer 那条是同一次运行里的对照。**两半仍没量**，
不许读成"已测出真机耗时"：① 真机是 JavaScriptCore，且它还必须先解析那段 53.6 MiB 源串本身 ⇒ 616.9 ms 只是下界；
② 那段源串**交给 webview 的那一步**发生在主线程，那一半本轮既没证实也没推翻。另有一条边界要写清：
JS 跑在 WKWebView 的 WebContent 进程，这六百多毫秒表现的是"窗口里点没反应、图不画"（问题 A 后半句
"部分功能失效"），**不是**"拖窗口没反应"——后者是 INV-P34 那一族（tokio 被 GB 级慢活钉住、饿死开窗命令）。

**真机回验步骤（问题 A 这一格，负责人做一次就能收）**：macOS 上让对端发来一张 12–15 MiB 的图片，
在本机 devtools 控制台把一次 `await invoke('read_file_preview', { msgId, maxBytes })` 用
`performance.now()` 前后夹住打印；再连点侧栏/输入框记录"从点击到有反应"的间隔。⚠️ 开着 devtools
本身就吃主线程，读数会**偏高**，只能当上界用。

**登记但这一轮没动（两处，都是"查到了没修"）**：
⑩ **收藏失败会留下一个没人登记的文件**：`commands/favorites.rs:177` 的
`db::insert_favorite(...).map_err(\|e\| e.to_string())?` 这条出口**不删**刚刚复制进收藏目录的副本，
而同一函数里 `if !inserted` 那一臂是显式删的 —— 两个臂对同一件事两种结局。收藏目录没有孤儿清理
（`favorites_dir` 的读者只有 `commands/channel.rs`、`commands/favorites.rs`、`state.rs`；
`remove_favorite` 只删登记过的那条 `media_path`；`cache_cleaner` 从已登记的 content 出发）。
磁盘满那一半本轮**实测过**：8 MB 的 MS-DOS 卷里 `std::fs::copy` 一个 40 MB 文件 ⇒
`kind=StorageFull raw_os=Some(28) msg=No space left on device (os error 28)`，目标文件留下
**7,340,032 字节**的半份。修法就四行（那条 `?` 改成先 `remove_file(&dst)` 再返回，注释与 `!inserted`
那一臂同口径 + 一条 warn），没动的理由不是"太重"，是**账**：未推送范围已经红在判据 3，
再加应用码提交会把那格红推得更远，而这一格的新形状判据要另起一个 `include_str!` 视图。
⑪ **入站 accept 的错误臂静默**：`network/transport.rs:231` 的 `let Ok((stream, peer_addr)) = accept else { continue }`
对**任何** accept 错误都一样处理 —— 不退避、不分类、**一条日志都不打**。本机探针（照同一形状写，非阻塞 std）
读数：把 `RLIMIT_NOFILE` 压到 1 之后，accept 队列里 149 条挂着的连接产生 **128 次**
`kind=TooManyOpenFiles raw_os=Some(24)`，全部被那条臂吞掉。含义有两层：其一，这类错误**有可分类的
`ErrorKind`**，所以"按 `TooManyOpenFiles` 单独限频打一条 warn"这个最小诊断补丁写得出来、不需要字符串匹配；
其二，如果 FD 真被耗光，端口就不再接受任何入站连接，而日志里**零线索** —— 这正是 §4.2 问的
"是否存在必须重启应用才能释放的状态"的形状。**但**我没证生产会走到这里：FD 耗尽的前半截（接收器表项 +
文件句柄 + `.part` 永不回收）已在 4.39.x 修掉，本轮没有任何真机 FD 读数 ⇒ 置信度只到"形状已证实、
触发条件待验证"。要收这一格，先要的是**读数量**：Windows 那台 X-Lite 上跑一次"连续传 20 个文件 +
断网重连 10 次"，同时记录进程句柄数（任务管理器"句柄"列或 `Get-Process -Id <pid>.HandleCount`），
句柄单调上升不回落 ⇒ 前半截还在；平了但仍然连不上 ⇒ 才轮到 ⑪ 这条臂。

**顺带修掉两处文档自身的缺陷**：`docs/migration-ledger.md` 第 13 行那句"尚未证实"把锚点写成了
`commands/helpers.rs:177` —— 那个行号是**隔壁的 `media_present`**，`read_file_preview` 在 `:189`
（file:line 引用对账只查引用存不存在，查不出指错格，所以这类错不会自己冒出来）；
`docs/protocol-invariants.md` 那条边界段结尾把"别把本条读成…"同一句写了两遍（一版用单引号一版用双引号），
已合并成一句。

**交付状态（按 §七 的口径，不许越级）**：以上全部落在 1「已发现但尚未修改」与 3「已通过自动化验证」
之间 —— 第 3 类只到"文档与实物对齐"这一层。**真实双端读数本轮仍为零**，问题 B 一侧没动一行码，
⑪ 与 ⑦ 都还在等负责人那两次真机量。


现象仍在问题 A 这一族（「接收端界面卡死或部分功能失效」）。4.40.4 写分母判据时，我把
`#[tauri::command(async)]` 挂在**同步 fn** 上的命令判成"已经在运行时之外"，据此把
`commands/group_todo_media.rs` 排除在法条之外。本轮读锁定版本源码，这条前提是错的：

| 依据（锁定版本，不是 latest） | 事实 |
|---|---|
| `tauri-macros-2.6.3/src/command/wrapper.rs:249` | `ExecutionContext::Async` 一律生成 `respond_async_serialized(async move { 函数(...) })` —— 同步命令的**函数调用就在 async 块里** |
| `tauri-2.11.5/src/ipc/mod.rs:375` | 那个 future 由 `crate::async_runtime::spawn` 投递 ⇒ 命令体跑在 **tokio worker**，不是阻塞线程池 |
| 同文件 `wrapper.rs:264` 的 `kind = "sync_threadpool"` | 只是 tracing 标签，不承担调度语义 —— 我上一轮正是被它误导 |
| 本仓 `src-tauri/src/lib_window_tests.rs:225` | 那条守卫自己的注释早就写着同一句依据；我没读它就把例外写了进去 |

于是"例外"变成漏网。按形状现数（排除测试册、去重）：全仓 121 处 `command(async)` 标记里 **79 处挂在同步 fn 上**，
其中体内出现整文件级慢活的 5 处逐行核过属性紧贴 `pub fn`，三处无体积上限或属同一法条管辖：
`commands/helpers.rs:7 copy_file`（另存为，拷任意大小接收文件）、`commands/favorites.rs:103 add_favorite`
（收藏，`std::fs::copy` 拷**原文件**、全仓唯一无上限的一格）、`commands/group_todo_media.rs:46 todo_image_meta`
（整图 SHA-256，被 10 MiB 体积闸管住 —— 有界也不开例外，理由写在函数注释里）。另外两处预览
（`read_file_preview` / `read_favorite_preview` / `read_content_preview`）都被同一体内
`max_bytes.min(15 MiB)` 管住，登记为**契约**而非尺子管辖。

修法与前三轮同一条：只换执行线程（`tokio::task::spawn_blocking` + 命令改 `async fn`），状态机、错误文案、
返回类型一字不动；前端零改动（`src/api/index.ts:313`、`:342` 本来就是 `invoke(...)` 吃 promise）。
登记项 ⑦ 随之**降级**：`read_file_preview` 不在主线程、且有 15 MiB 上限，原假设"界面线程上做 15 MiB"
这一半已被源码证伪；剩下要真机量的只有前端那半（15 MiB 字节进 JS 后解析/Blob 化的主线程耗时）。

判据侧扩了一格（不是新写一条）：`tests::whole_file_slow_work_never_runs_on_an_async_worker` 的体起点
从只认 `async fn` 扩到也认"紧贴 `command(async)]` 的同步 `fn`"，PRIMITIVES 由 7 个加到 8 个（`std::fs::copy(`）。
分母随实测前移：**现算 13 处 / 11 册**（新增 `commands/favorites.rs`、`commands/group_todo_media.rs`、`commands/helpers.rs`），
`std::fs::read(` 有意不数 —— 它与"读一份 8 KB 配置"字面同形，数进来尺子就成噪声。
先跑等价尺子定作用面：它在"今天的规则"下复现已提交断言的 10 处 / 8 册 / 0 offenders（阳性对照通过），
扩展后报出恰为那三处 ⇒ 断言数字不是猜的。变异配对实测：把 `copy_file` 退回旧形状（同步 fn + 直接 `fs::copy`，
可编译）⇒ 那条判据红且**只点名** `commands/helpers.rs [std::fs::copy(`（命中 1 处），恢复即绿。
测试名未增删 ⇒ 两份基线文件不动（860 / 848）。

同轮另两处：`scripts/guard_cases/toolchain.py` 里 force push 那条护栏用例的范围钉死（它此前被未推送
历史的预算欠账牵着红，机格还印成"源码或环境已被破坏"）；移动端编译门禁本机首次跑通（`aarch64` 两档 0 warning）。

**没动的**：判据 3 的重复犯案红灯照旧（transport 在未推送窗口第 4 次 + 21aa0dd 缺 `Version-Bump:`），
它要的是分片推与补声明，不是再改代码；问题 B 一侧本轮零改动；登记项 ③④⑥⑧⑨ 仍在原处。

## [4.40.4] - 2026-10-15

### 全链路稳定性审计第四轮：INV-P34 那一族的**剩余四家一次搬完**，并把"同一条根因会长新家"钉成分母判据

**根因（已证实，与 4.39.3 / 4.40.1 / 4.40.3 同一条）**：Tauri v2 只有一个 tokio runtime，
`#[tauri::command(async)]` 的开窗命令与网络收发排在**同一个 worker 池**里；文件生命周期上任何
"整份文件级"的同步慢活（整份 SHA-256、完成片那次 `sync_all()`、改名/跨卷整份 copy）写在 async 路径上，
就是把界面按秒级钉住 —— 用户 2026-10-14 真机原话「传 3.x GB 那一段，点设置没窗、拖窗口没反应」。

**这一轮收掉的四家**（都在中继链上，前三轮只搬到直发与直收）：

| 家 | 位置 | 那一格在干什么 |
|---|---|---|
| ① 发送前整份哈希 | `src-tauri/src/network/file/relay_push.rs:67` | 中继推送共享目录里的文件，哈希整份 |
| ② 完成片的整盘 fsync | `src-tauri/src/network/transport/relay_file.rs:163` → `file_relay.rs` 的 `add_chunk` | **最糟的一家**：`sync_all()` 整份，同时**攥着 `relay` 全局锁** ⇒ 一边钉 worker、一边让别的传输的分片排队 |
| ③ 收齐后整份校验 | `src-tauri/src/network/transport/relay_file.rs` 的 `hashed` 那一格 | 流式 SHA-256 整份 `.part`（本机实测 ≈ 1 GB/s ⇒ 3 GB ≈ 3 秒） |
| ④ 校验通过后落盘 | 同文件的 `moved` 那一格 → `move_received_file` | 同卷 rename；跨卷退化为**整份 copy + remove** |

**改法**：四处都是**纯执行上下文搬迁**（`tokio::task::spawn_blocking` + `.await` + 兜住 JoinError），
状态机、调用顺序（写盘→fsync→校验→落盘）、错误出口、协议字段**一字未改** ⇒ 可单点回滚。
②的 JoinError 落进 `ChunkOutcome::Rejected`：那份文件已不可能补齐，终态与"形状不合法"同一条出路
（换源重取），代价是那行日志前缀「分片形状不合法」会跟着一条内部错误 —— 拆成第四支要动
`ChunkOutcome` 枚举，这一轮不动它，如实记在这儿。

**为什么不再补一条点状守卫，而是补分母**：这条根因已复发**四次**，而按文件/按函数锚定的守卫对新分册、
对新函数一律看不见 ⇒ 下一次复发照样全绿（4.40.3 就是这么漏掉续传那一格的）。所以这一轮加两条：

- `tests::relay_file_lifecycle_slow_work_runs_off_the_async_worker` —— 四格各钉三件事：包进了池子、
  **等它跑完了**（紧跟 `.await.unwrap_or_else(`）、旧写法没回来；另把 `handle_relay_chunk` 里的池化次数
  钉成相等（不是 `>=`）——新增一处忘了包就红，逼作者要么搬要么登记。
- `tests::whole_file_slow_work_never_runs_on_an_async_worker` —— **INV-P34 的分母**：遍历
  `src/**/*.rs`（跳过 `gen/`、`*_tests.rs`、`tests.rs`），对每个 `async fn` 体用一条词法可判的规则
  「慢活调用前面最近的一次 `spawn_blocking(` 与它之间不许出现 `.await`」；慢活清单是
  `sha256_file_hex( / sync_all() / add_chunk( / resume_receive( / finish_receiver_into( /
  finish_group_receive_into( / move_received_file(`；现算 10 处、落在 8 册，两处都钉相等 + 一条
  "文件数 > 100"的阳性对照（尺子空转时 offenders 也恰好为空 —— 那正是本仓最怕的假绿形状）。

**判据非空转（三次单点变异，块体字面取自文件、不凭记忆抄）**：
① 发送前哈希退回 worker ⇒ 两条都红，点守卫点名"中继发送前的整份哈希"那一格、分母守卫点名
`network/file/relay_push.rs`；② `add_chunk` 退回 worker ⇒ 两条都红，各自点名"中继重组"那一格与
`network/transport/relay_file.rs`；③ **包了但丢掉 JoinHandle** ⇒ **只有点守卫红**、分母守卫仍绿
（这一条是量具买不到的那一半，写在用例的注释里而不是装作它管得到）；三次还原后复跑都是绿。

**本轮自己踩到的三处尺子错（都改的是尺子，没动被量对象）**：
① 第一版分母守卫把"注释过滤"写成了 `.map(str::trim_start)` ⇒ 每一行的第 0 列都变成 `}`，
函数体在**第一个内层花括号**处被腰斩，`--list` 之外的一切读数归零，而 offenders 恰好为空 = 假绿；
现算读到 0 处而 python 同规则读到 10 处，才把这条抓出来（正解：判注释时剥前导空白，**留下的那一行保持原样**）。
② 变异脚手架两次编译不过 ⇒ 按纪律记为**无效读数**重做，没有把"编译失败"当成"判据抓到了"。
③ 写锚点时凭记忆猜了一个 `}))` 的收尾，实际是单个 `)` ⇒ 落笔前用脚本把扁平化原文打出来核了一遍。

**第三次是本仓那道「注入锚点静态核对」替我兜住的**：全量层第 10 步在 0.3s 内报红 ——
「中继收文件的哈希必须对组装后的明文算」这条护栏用例的注入锚点写的是旧那一行（`let actual_hex = match file::sha256_file_hex(&part_path) {`），而我把那一格改成了`spawn_blocking(...).await` 再 match ⇒ 锚点字面失效（一条测试都没跑就抓住，省下整轮 20 分钟）。已把锚点换成「交出 → await → 兜底」那三行（全 `network/` 树现数唯一），坏法仍取「整读进内存 + digest」（`?` 必须包在闭包里 —— 处理函数返回 `()`，裸 `?` 编译不过）。复跑两条都过：`python3 scripts/verify-guards.py --list` 退 0（静态核对），`--only 中继收文件的哈希` 退 0（改坏即 FAIL、恢复即 PASS）。教训并入既有那条纪律：**按形状钉的判据，搬家式修复要同批改注入锚点**。

**治理同步**：`docs/protocol-invariants.md` 的 INV-P34 补上这两条钩子并把"边界"那一格从
"还剩四家"改成"四家已搬 + 分母守卫的两处买不到的地方"；`docs/migration-ledger.md` 第 13 行
把同一条根因的家清单更新为"已收口 + 新增家必须登记"；`docs/domains.data.mjs` 与
`docs/ARCHITECTURE-MAP.html` 的 `inv` 快照本轮无新增 id ⇒ 未改（改过才要两处一起动）。
Rust 基线随新用例前移：macos 858 → 860、windows 846 → 848（两份都由 `--list` 现算差集补，不是手加计数）。

**验证到哪一步（诚实版）**：`cargo test --features bluetooth --lib` 860 passed / 0 failed、
`cargo fmt` 退 0、`cargo check --features bluetooth --lib --tests` 退 0。⚠️ 但**效果**只在真有一个
GB 级文件走中继时发生：单元测试钉的是执行上下文形状，双实例 harness 不制造"中继链上的整份校验窗口"
⇒ 现在的状态是"已修改 + 判据已自动化"，**不是**"生产已修复"。真机回验（两台同网段，任选一台当中继接收方 B）：
① A 向 B 中继发送 600 MB 以上文件（两台之间无直连、需借道时最能暴露这一族）；② 在 B 上
**边收边点设置 / 拖窗口 / 切聊天** —— 修复前在"收齐那一瞬"卡数秒，修复后应立即响应；
③ 传完立刻发一条普通文本，确认消息通路未被大文件挤掉；④ 跨卷场景（下载目录与 `.part` 不同卷）单独再走一遍④那一格。

**登记但这一轮仍未动的**：③ 每片两次 `file_receivers` 抢锁、④ 落库节流与事件节流共用 `last_report_ms`、
⑥ 群 done 失败不把 content 落到 `Incomplete`、⑦ macOS `read_file_preview` 的主线程形状（要真机量
15 MiB 图片预览才判得动，本轮既没证实也没推翻）、⑧ `set_abortive_close` 的 `eprintln!`、
⑨ UDP 读那两处 `let Ok(..) else { continue }`。问题 B 一侧本轮**零改动**：修复已在 4.40.2 之前落地，
缺的是 X-Lite 真机读数，不是代码。

**整层门禁重跑的读数（2026-10-15 18:48，`npm run verify:full`，退 1，828.9s）**：23 步里 20 绿、2 红、1 未跑。
第 14 步 Change Budget 红是**已报的历史欠账**（判据 3：transport 在未推送窗口里第 4 次 ⇒ 249927f/eccfe40/2dc1850/21aa0dd；
判据 4：21aa0dd 动了四个版本清单却没写 `Version-Bump:`）。**新的一条不在代码里**：第 22 步护栏非空转 89 条只红在
最后那条 `force push 后 before 不可达`，而它红的半边是"恢复源码之后必须 PASS"—— 这条用例为了跑到被守的那段
（`check-change-budget.mjs` 的 `beforeGivenButUnreachable` 分支带 `!fromJson`，用 fixture 就整段不执行）
必须用真实 git 范围，于是默认候选链替它取了 `origin/main..HEAD`＝**未推送范围**：判据 3/4 的历史欠账直接把它拖红，
机格还把它印成「源码或环境已被破坏」，归因指错了地方（本用例守的是"范围来源"，不是"这批提交合不合预算"）。
修法是**把它的范围钉死在一段已推送旧提交**（`--range 73d9e20~1..73d9e20`，一条 docs 单提交 ⇒ 三道判据恒绿 ⇒
注入态只会因为被守的那格红），与上一条 [88/89]（修 fixture 接缝）同属接缝病、同一个家。现算：
`verify-guards.py --only "Change Budget"` 退 0、11 条全部"改坏即 FAIL、恢复即 PASS"；`--list` 退 0。
**这条修复不改变第 14 步的结论**：欠账还在，仍按三条分片推（分片后每次 CI 判的是 `before..sha` 那一小窗）。

**移动端编译门禁（23 步里最后那一步）在本版首次本机跑通**：`bash scripts/check-mobile.sh --bluetooth` 退 0，
`aarch64-linux-android` 两档（默认 feature / `--features bluetooth`）各 0 warning。它证明的是本轮三处
`spawn_blocking` 搬家在 android 的 cfg 路径上编得过、没引入新 warning；**不**证明 §4.4 的第 6 项（Windows ↔ Android
真机建连）—— 那一格仍然只能等真机。本轮汇总里它之所以是「未跑」，是第 22 步 fail-fast 带下来的，不是 skipReason ——
现算 `rustup target list --installed` 含 `aarch64-linux-android`、`~/Library/Android/sdk` 在，所以本机跑得动这一步。


## [4.40.3] - 2026-10-15

### 全链路稳定性审计第三轮：问题 A 的第三家 —— 续传时整份 `.part` 前缀的校验不再钉住 async worker

这是 4.40.1 登记的 ②（"同一根因的第三家"），本轮收掉。前两家是单聊收尾（4.39.3）与群收尾（4.40.1），
它们交出的是**完成时**的慢活；而 Offer 分支里 `from_bytes > 0` 那一格交出的是**续传开始时**的慢活，
所以"传到九成断链、对端来续传"这一路一直还在钉 worker 上。

**现象**：大文件传到一半断线，对端带 `from_bytes` 来续传时，接收端有几秒到几十秒
"点设置没窗、拖窗口不动"，续传完成后又自己恢复（这正是它难被归因的形状 —— 它不是永久卡死）。

**根因与证据（三处连读）**：`transport/handle_file.rs:189` 就地调用 `file::resume_receive(...)`，
而它（`file/receive.rs:89`，哈希循环 127-153）要把 `.part` 前缀**逐块整份**喂进 SHA-256，
前缀最长就等于整个文件；调用它的 `handle_message`（`transport.rs:1024`）是 `async fn`，
全仓六个调用点（`queue_policy.rs:232` / `dial.rs:618` / `transport.rs:726` / BLE 三处）
**都是就地 `.await`、没有一处 spawn 出去** ⇒ 这段哈希就钉在一个 tokio worker 上，
而同一个 runtime 上还排着所有 `#[tauri::command(async)]`（开设置窗 / 日志窗）。

**本机实测的量级（`python hashlib` 同 256 KiB 分块尺寸现量，非本仓那段循环，只作数量级）**：
256 MiB / **0.26 s ≈ 1 GB/s**（SHA 硬件加速 + 热缓存）。⇒ 3 GB 前缀约 3 秒，
精简 Windows 的冷盘上还要再乘一次读。**这条数字不是验收阈值**：本仓没有真机大文件基线，
不编阈值，只把"为什么这一格值得交出 worker"量出来。

**修法（只动执行上下文，状态机一字未改）**：续传那一格整体交给 `spawn_blocking`，
线程池的结果用 `unwrap_or_else(|e| Err(...))` 落成 Err 走**既有的拒绝出口**。
顺序不变：校验跑完才注册接收器、才回 Accept；本连接后面的分片在这期间本来就读不进来，
所以"让出 worker"既不新开竞态窗口，也不改变发送端等到 Accept 的时长。
收侧只交出**续传臂**（新建接收器那一臂不哈希，没必要动）。
⚠️ 已知边界：阻塞线程池默认上限 512 线程，多单并发续传会各占一个池线程 —— 这是本改动的意图
（把等待从 worker 挪到池），不是遗漏。

**判据 1 条（`tests::resume_prefix_hash_runs_off_the_async_worker`，七个判据面）**，
六笔单点变异各红对应那一条（逐笔只红一条、控制组绿、每笔还原后按 sha 核对工作树）：
退回同步调用 → `lib_file_tests.rs:427`；线程池中断被写成 `unwrap_or(Ok(..))`（假装成功 =
回 Accept 却没注册接收器，整单静默死掉）→ `:443`；删掉逐块喂校验器（放行被改过的前缀）→ `:489`；
多出第二个生产调用点 → `:464`；退回整份 `std::fs::read` → `:494`；
**同一句话挪到续传臂之外** → `:448`（这条是位置判据：出现次数一点没变）。

**三处探针的尺子错（都改探针，不改被判的代码）**：
① 第一版把重复调用点插在**臂尾表达式之后** ⇒ 语法错、编译失败 —— 而编译失败不能算判据抓到，
那一笔当时被记成 `bad=1`；改插到臂首后才成为有效探针。
② 补跑时两笔都报 `ANCHOR count=0`：我把 12 空格缩进的行按 16 空格去匹配 ⇒ 锚点为空、
脚本按设计一个字没改，控制组"绿"在这里**只证明什么都没动**，不证明判据有效。
教训还是那条：锚点必须现读原文（含缩进），不凭记忆。
③ 数 `--list` 的名字用了 `[A-Za-z0-9_:]+`，会把**中文测试名整条筛掉** ⇒ 差点报成
"基线里多了一条 `gossip_group不受好友检查影响`"；改成按 `: test` 后缀取名字，858 条一次对上。
④ 反面判据必须去注释才跑：`resume_receive` 里那句"这曾经是 `std::fs::read(&tmp_path)`"
就写在注释里，带着注释跑反面判据会当场假红（而正面判据带着注释会假绿 —— 两个方向都得防）。

Rust 基线随新用例前移：macos 857 → 858、windows 845 → 846（两份都是
`cargo test --features bluetooth --lib -- --list` 现算的差集补的，不是手加计数）。

**这一笔另外补了一条不变量（INV-P34）+ 台账第 13 行。** 为什么必须补：Change Budget 的判据 3 在
第三笔同领域 patch 上亮了红（`transport` 在最近五个"修补形状"提交里出现三次：`21aa0dd` / `2dc1850` /
`eccfe40`）。它判的不是"这次改大了"，而是"同一个根因连着修三次 ⇒ 缺一条不变量与一个单一事实来源"——
这个判断是对的，而且上一轮我自己就把"未推区间同领域已有两条 patch 形状提交时该交回负责人推送"写进了
那个脚本的注释，这一轮没照它做。所以正解不是再补一条点状守卫，而是把"文件生命周期的 GB 级慢活只许在
阻塞线程池里跑"写成 **INV-P34**（钩子 = 上面那三条具名判据；`node scripts/check-invariant-hooks.mjs`
现算「34 条全部绑定」），并在台账第 13 行登记"哪几处已搬、哪几处仍在旧家、下一次收口必须一次搬完 +
数分母而不是再加点状守卫"。连带同步 `docs/domains.data.mjs` 的 transport / files 两份 `invariants`
清单与 `docs/ARCHITECTURE-MAP.html` 里那段 `inv` 快照（两份手抄不同批改就会分叉），图过
`node --check`；`check-doc-numbers` / `check-doc-citations`（66 处 `file:line` 全部落在真文件真行）/
`check-domain-map` / `check-invariant-exceptions` 各退 0。
⚠️ **判据 3 那条红不因为这一笔消失**：它读的是未推送范围，只有"下一次推送的新范围"或负责人明确接受
才会清掉；**不许**为了消红去改领域映射或窗口大小。

**同一轮里量到但没改的（原样登记，不夹进这次发布）**：① 中继收发的整文件哈希与
`move_received_file`（同一根因的第四、第五家）、③ 每片两次 `file_receivers` 抢锁、
④ 落库节流与事件节流共用 `last_report_ms`、⑥ 群 done 失败不把 content 落到 `Incomplete`、
⑦ macOS WKWebView `read_file_preview` 的 `number[]` 主线程解析（本轮**没有**证实也没有推翻那条
"`number[]`"的说法 —— 静态读 `@tauri-apps/api/core.js` 与 tauri 2.11.5 的注入脚本没给出决定性证据，
要判它得真机量一次 15 MiB 图片预览的主线程耗时）、⑧ `set_abortive_close` 的 `eprintln!`、
⑨ UDP 读那两处 `let Ok(..) else { continue }`。

**验证到哪一步（诚实版）**：`cargo test --features bluetooth --lib` 858 passed / 0 failed，
`cargo fmt -- --check` 退 0，判据的非空转由上面六笔变异证明。⚠️ 但**效果**只在"真有一个 GB 级
`.part` 前缀要续传"时发生，单元测试钉的是形状、双实例 harness 不制造网卡与断链后的续传前缀
⇒ 现在的状态是"已修改 + 判据已自动化"，不是"生产已修复"。真机回验（两台同网段任选一台为 B）：
① A 向 B 发 600 MB 以上文件；② 传到一半把 A 断网（或杀进程）；③ 恢复后 A 重发同一文件，
让 B 走续传那一格；④ 在 B 上**边续传边点设置 / 拖窗口** —— 修复前那几秒点了没反应，
修复后应立即响应；B 的 `file` 日志里那格留痕（"续传前缀长度与声明不符…"）形状不变。

## [4.40.2] - 2026-10-15

### 全链路稳定性审计第二轮：问题 B 的「出口重绑」与「LAN 拨号留痕」（4.40.1 登记的 ⑤ 收掉）

上一轮把三条已证实根因收掉后，登记了七条没动的。本轮收其中**两条**，都是负责人那句
「要双方反复重启应用才能恢复」的直接候选：

**1）发送出口的网卡/IP 只在 `spawn` 那一刻解析一次 ⇒ 本机 IP 一变就永久失声（4.40.1 的 ⑤）。**
`network/discovery.rs` 的 `bind_udp_reusable` 必须把发送 socket 钉在具体 LAN IP 上（那是躲开
VPN/虚拟网卡劫持出口的唯一办法），可它在整个进程生命周期里只绑一次。本机 IP 一旦没了
（DHCP 续约、切 Wi-Fi、休眠唤醒、精简镜像上网卡服务重启后重排），子网广播 + limited 广播 +
组播**三条路同时** `EADDRNOTAVAIL`；而收侧那只绑 `0.0.0.0`，照旧听得见 ⇒
**我看得见别人、别人从此找不到我，且本进程永不自愈，只能重启应用** —— 与问题 B 的形状一致。
现在发送 socket 进了一个可换的 `SendCell`：广播循环数「三路全灭」的连拍，
到 `SEND_SILENT_REBIND_ROUNDS`（3 轮，自适应周期下约 15~60s）就重新 `find_lan_interface()`、
在新接口上建 socket、**先加组播成功**再换、并把诊断里的 `bound_ip`/`selected_interface` 一起改掉；
收侧那只刻意不换（0.0.0.0 不受网卡变化影响）。三条「不换」判据都是刻意的：
**手动模式不替他改配置**、**没探到可用网卡时不拆手里唯一那只**、**还是同一个 IP 就不原地拆建**。
`who_has` 的回包与接收循环读的那只 socket 也都改成**每轮现取**，否则会停在退役的旧 fd 上。

**2）LAN 拨号失败被 `let _ =` 吞掉 ⇒ §五 要求区分的「TCP 建连失败」在日志里根本没有。**
`transport/dial.rs::ensure_link` 此前对 `connect_to_peer` 的结果一字不打（注释写的是"失败是常态"）。
常态的是**去重命中 / 在途 / 并发满**那三种，`Failed` 不是 —— 而问题 B 的现场恰恰是
「对端在节点列表里、可就是连不上」，当时磁盘上零证据，只能靠猜是发现没发现到、TCP 连不上、
还是握手没回。现在 `Failed` 那一格走一条**节流 30s** 的 warn，内容原样带上
`DialOutcome::Failed` 的字符串（它本来就写明了阶段：`连接失败:` / `连接超时（5s）` /
`握手发送失败:` / `握手读取失败:` / `握手超时（5s）` / `首帧不是 Hello`），
不在这里再分类一次 —— 同一个判断有两个家是这仓库踩过的坑。
身份不符 / 验签失败仍由 `connect_to_peer` 内部那条 warn + 诊断事件负责，这里不重复。

**同一轮里量到但**没改**的（登记，不夹进这次发布）：** 上一轮 ①②③④⑥⑦ 六条原样仍在
（中继收发整文件哈希与 `move_received_file`、`resume_receive` 整份 `.part` 就地哈希、
每片两次 `file_receivers` 抢锁、落库/事件共用 `last_report_ms`、群 done 失败不回落 `Incomplete`、
macOS WKWebView `read_file_preview` 的 `number[]` 主线程解析）。本轮新增两条：
⑧ `network/transport.rs:533` `set_abortive_close` 失败走 `eprintln!` ——
`logging.rs:209` 注释写明 release 无控制台，那行**永远看不见**，而它预告的正是
「59992 被 TIME_WAIT 占死 ⇒ 重启后 bind 失败」这条生产故障。不改的理由有两条：
一是**没有任何现场证据**表明 `set_linger` 真失败过（按约束"所有修改必须能追溯到故障证据"）；
二是它是 `#[cfg(windows)]` 的签名改动，本机这条腿编译不到它（还牵到 `listen_tests.rs:81`
那条 Windows 专属用例），改错了要等 Windows CI 才炸 ⇒ 收益不抵风险。
⑨ 接收循环那两处 `let Ok(..) = res else { continue }`（`discovery.rs` UDP 读）：
Windows 上对端端口不可达会以 `ConnectionRefused`/`WouldBlock` 形态反复回来，
现在的写法既不计「读失败」也不留痕。是否真的是现场噪声，需要 Windows 真机日志判，本轮不猜。

**判据（4 条新增，全部实测反例）：**
`network::discovery::tests::broadcast_streak_counts_only_full_silence`（只有三路全灭才累计；
任一条腿能用就归零；饱和加不回绕；阈值不许写成 1）、
`network::discovery::tests::send_egress_rebind_keeps_manual_dead_and_same_ip`（三条不换 + 一条该换，
四臂逐条）、
`tests::discovery_send_egress_rebinds_after_sustained_silence`（源码形状：三路 OR 成 sent_any、
连拍进阈值、到点真调 `reprobe_send_socket`、`manual` 由配置现推、
**接收循环 / 首次广播 / 周期广播 / 按需探测四条发送路径各按形状钉住"现取"**、
**先加组播后换**、诊断跟着改、两种结局各一条留痕、不许重建收侧 socket、
`streak = 0;` 与 `cell.swap(` 按数量恰好各一处）、
`network::transport::tests::lan_dial_failure_is_logged_not_swallowed`（`Failed` 必须被接住、
节流在 warn 外面、旧的 `let _ =` 形状不许回来、本函数只许一处 warn）。

⚠️ **这条判据是第一版写完才发现半空的**（值得记下来）：那版对"现取出口"只数了
`send_cell.current()` 的**出现次数**（==4）。变异 M9 把那一行整体挪到 `loop` **外面** ——
次数一点没变、代码却退化成永久快照，跑完 12 笔时那一笔是**绿的**。
⇒ 数量判据量不到位置；补成三条按形状钉的连续串（`loop{letsend_socket=send_cell.current();` 等）
之后 M9 才红。教训与仓内那条老规矩同源：**「有断言」≠「被证明会失败」**，
分母要含"合规写法的形状"，不是只含个数。

**12 笔单点变异各红对应那一条**（`bad=0`，逐笔只红一条、无连带）：
`next_fail_streak` 两臂对调 / 删手动那一臂 / `manual` 写死 true / 阈值写成永不触发 /
到点不调 `reprobe_send_socket` / 加组播失败也照换 / 重绑不更新诊断 `bound_ip` /
动手那轮不清连拍 / 接收循环取到循环外（**第一版判据抓不到，补形状后才抓到**）/
探测那臂拿回旧快照 / LAN 拨号失败退回 `let _ =` / 留痕被 `if false` 关掉。
跑完逐笔还原，`git status` 复核工作树只剩本轮那 5 个业务文件。
（探针自身的两处尺子错也记一下：`--list` 的名字含 `::`，用 `split(":")[0]` 会把每条都切成模块首段
⇒ 4 条"找不到"、脚本按设计一个字没改；`cargo test` 在测试失败时也打 `error: test failed`，
上一版把它当编译错误 ⇒ 每笔多出两条假象。两处都改探针，不改被判的代码。）
Rust 基线随新用例前移：macos 853 → 857、windows 841 → 845（两份都是
`cargo test --features bluetooth --lib -- --list` 现算的差集补的，不是手加计数）。

**验证到哪一步（诚实版）：** 本地 macOS 上 `cargo test --features bluetooth --lib` 全绿；
上面这些判据的**非空转**靠单点变异证（每笔只改一个点、跑整套、红了哪几条逐笔记下，
跑完逐笔还原）。⚠️ 但这条修复的**效果**只发生在"运行期本机 IP 真的变了"的时候，
而这在单元测试与本仓的双实例 harness 里都造不出来（它测的是运行中链路，不模拟网卡变化）
⇒ 现在的状态是**已修改 + 判据已自动化**，不是"生产已修复"。
真机复现步骤（负责人侧，两台同网段机器任选一台）：
① 记下 A 的日志行 `diag/discovery_started: send_bind=<IP>`；
② 在 A 上换 IP（关 Wi-Fi 再开 / 换一次路由器 DHCP / 唤醒睡眠）；
③ 看 B 的节点列表：修复前 A 会**一直消失直到 A 重启**，修复后应在 3 轮广播内（约 15~60s）
自己回来，A 的日志里出现一行 `diag/discovery_rebind: <旧IP> -> <新IP> bc=... iface=...`；
④ 若只看到 `diag/broadcast_stuck_error`（没换成）就是三条「不换」判据命中了，
把那一行的 `manual=` 与 `探测=` 两个字段贴回来即可定位，不需要猜。
另一格同法回验：防火墙黑洞场景下，A 的日志现在应出现 `[lan] 拨号未成功 peer=… ep=…：连接超时（5s …）`
（每 30s 至多一条）——修复前这一格一个字都没有。

## [4.40.1] - 2026-10-15

### 全链路稳定性审计：三个已证实根因的修复（问题 A 群文件收尾 + 问题 B 两处「非重启不可」）

负责人 2026-10-15 下了一道以真实故障为中心的审计指令（问题 A：传大图/大文件时接收端界面卡死；
问题 B：局域网连接不稳、要双方反复重启应用才恢复）。本轮**先取证后改码**，收掉三条源码级已证实的
缺陷；每条都做了「旧绿·新红」成对变异，且还原后逐字节比对。

**1）群文件收尾的 GB 级慢活仍钉在 async worker 上（问题 A 同源缺陷的第二家）。**
4.39.3 只把单聊那份 `finish_receive` 交给阻塞线程池，群那一份
`network/transport/group_file.rs` 的 `handle_group_file_done` 里 SHA finalize + `sync_all()` +
rename 仍然直接在 `reader_loop` 的 tokio 任务里跑 ⇒ 传大群文件时"点设置没窗、拖窗口不动"会原样复发
（4.39.4 评审第四条登记过、当时按范围没动）。现在这段整体落到新抽出的
`network/file/group_receive.rs::finish_group_receive_into()`，由 `spawn_blocking` 驱动，
错误出口与状态机一字未改。
顺手抓到第二个不对称：群那四个失败出口里 **只有 SHA-256 那一格漏了 `db::upsert_transfer`**
⇒ 校验失败后 `file_transfers` 那一行永远停在 `active`（另三格写 `failed`）。收成一份收尾后
不可能再单独漏，并由新守卫按**数量**钉住（recipient / transfer 各恰好两处：一失败一成功）。
`file_tests.rs` 里那五条群用例原本是各自重写一遍操作序列的**抄本**（生产码改坏它们不红，
与本册 `receive_group_chunk` 已改掉的假覆盖同一种病）⇒ 现在直接驱动生产函数。

**2）写失败的链路不摘除 ⇒ 单向黑洞、只有重启才恢复（问题 B 已证实）。**
`transport/queue_policy.rs::writer_loop` 遇到真 socket 写失败只 `mark_conn_failure` 一次就 `break`，
链路仍留在 `state.links` 里。此时本机读半若还活着（对端心跳照收 ⇒ peer 显示在线、45s 读活性看门狗
不 reap，`is_healthy` 对 1 次失败也判健康），后果是三件事叠死：`try_send` 永远返回"连接已关闭"、
消息只进 outbox、`ensure_link` 因 `has_lan_path` 为真而**永久拒绝重拨**。上面 `:113` 的注释本来就写着
"照旧走判死+拆链"，是代码没跟上注释。现在失败格与 watchdog 判死走**同一条出口**：点亮该链路的
`cancel` ⇒ `reader_loop` 一起退出、由它那份按 channel 精确摘除（空了才删 key、mesh 层同步注销），
另加一条节流 warn 留痕。

**3）自动开启局域网通道失败后本进程再也不试 ⇒ 冷启动赶在网卡就绪前就永久离线（问题 B 已证实）。**
`lib.rs` 的启动块只调一次 `start_from_prefs`，`Err` 只落一条 error 日志。而 auto 模式下
`discovery::spawn` 会在 `find_lan_interface()` 这一刻找不到可用网卡时**硬失败**
（`resolve_bind_ip` 的 `ok_or("auto mode: no eligible LAN interface found")`），
UDP bind / `join_multicast_v4` 失败同样让整个通道起不来 —— 开机自启跑在 DHCP 拿到地址之前正是这个形状，
精简过的 Windows 镜像上驱动/服务起得更晚。失败之后既没有监听也没有 announce，此后没有任何一处会再试
⇒ 唯一出路是重启应用；两台机器同时冷启动就成了"要双方都重启"。
现在按 5s → 10s → 20s → 30s 封顶重试，每轮**现读** `lan_enabled`（用户关掉就立刻收手，
不得替他联网）、并检查通道是否已被别人（设置页 / harness）起来（起来了就不插手）。
节奏与停止条件都是 `network/mod.rs` 里的纯函数，各有正反两臂判据。
⚠️ 已知边界：`start()` 本身没有单飞锁 —— 若用户恰好在重试 tick 那一瞬手动开启，仍可能与重试并发
（这个竞争在两次手动开启之间本来就存在，本轮没扩范围去补它）。

**同一轮里量到但**没改**的（登记，不夹进这次发布）：** ① 中继收发的整文件哈希与 `move_received_file`
（`transport/relay_file.rs`、`transport/relay_push.rs`）仍在 async 路径上，是同一个根因的第三、第四家；
② `resume_receive` 对整份 `.part`（可达 GB 级）的分片哈希仍由 reader 任务就地跑
（`file/receive.rs:127-153` ← `handle_file.rs:190`）；③ 每片到达时同一份 `file_receivers` 锁被抢两次
（`receive.rs:519-522` + `handle_file.rs:358-374`）；④ 落库节流与事件节流**共用同一个** `last_report_ms`
⇒ 分片间隔 ≤250ms 时那条 500ms 断点续传检查点几乎不写，而检查点一写又把紧跟着的那条进度事件钳住；
⑤ `discovery` 的网卡/广播地址/组播出口只在 `spawn` 那一刻解析一次，运行期没有任何重解析点
（`find_lan_interface` 生产侧唯一调用点在 `discovery.rs:322`）⇒ 会话中途换 IP / 虚拟网卡重排后
发送侧长期 `broadcast_error`，而收侧（绑 0.0.0.0）还听得见 ⇒ 双双失联且不会自愈；
⑥ 群 done 失败的四格都没把 content 那张表从 `Active` 落到可重取的 `Incomplete`
（`fail_taken_group_receive` 只做中途/断链那一族）⇒ 要不要收由负责人拍板；
⑦ 前端一处待真机定量：`read_file_preview` 走 `tauri::ipc::Response`，macOS WKWebView 上按仓内自己的
注释是 `number[]` JSON ⇒ 最大 15 MiB 的图片要在主线程 JSON.parse + 复制一份
（`commands/helpers.rs:177-196`、`src/utils/filePreview.ts:191-196`），这是接收端唯一还在的
主线程嫌疑点，静态量不到大小。

**判据（4 条新增 + 1 条改口，全部实测反例）：**
`group_receive_finalize_slow_work_runs_off_the_async_worker`（慢活在 `spawn_blocking` 里、摘表形状、
终态写入按数量恰好两处、核心函数拿不到 `group_file_receivers`）、
`network::transport::tests::writer_socket_failure_cancels_and_logs_before_break`（拆链 + 留痕只许出现在
真写失败那一格；`Local`/`Stopped` 两格不许点亮 cancel）、
`lan_autostart_backoff_grows_then_caps_at_thirty_seconds`、
`lan_autostart_stops_when_running_or_switched_off`；
`autostart_env_never_overrides_an_explicit_lan_off` 的锚点按新形状改口，**判据意思一个字没变**
（开不开仍只由 db 里的 `lan_enabled` 决定，且必须在启动块里现读）。
七笔单点变异各红对应那一条（把慢活写回就地 await ⇒ 守卫红而五条行为用例全绿 —— 这条格只有形状守卫量得到；
删 `cancel_tx.send(true)` / 把它挪进 `Local` 格 / 把重试的 `enabled` 硬编成 true / 停止条件去掉 `enabled` /
`rename` 短路 / 失败终态少写一处），跑完逐笔还原。
Rust 基线随新用例前移：macos 849 → 853、windows 837 → 841（两份都是按
`cargo test --features bluetooth --lib -- --list` 现算的差集补的，不是手加计数）。

⚠️ **仍未验证（这次也没有）**：Windows 真机与 X-Lite 真机。上面 2)、3) 两条的因果链是源码级 + 单测级证据；
"冷启动竞态"和"单向写死"在真机上到底是不是负责人遇到的那一次，需要他按
`docs/stability-roadmap.md` 里新登记的复现步骤回验（两台机器同时开机自启、以及一台拔网线另一台继续发）。
本地双实例 harness 覆盖不到这两条（它测的是运行中链路，不是启动时序，也不是原生窗口线程）。

## [4.40.0] - 2026-10-15

### Added（单聊「窗口抖动」）

工具栏新增「抖动」按钮（仅单聊，Zap 图标，3s 冷却）：点一下，**对方整扇窗口抖一下**（仿 QQ）。
修用户实测报的「点抖动居然弹的是我自己的窗口」——旧版点击时会先抖**自己**的窗口（乐观反馈），本版去掉自抖。

- **整窗抖动**：抖动＝移动**整扇 OS 窗口**（新增 Rust 命令 `shake_window`，±10px 共 7 步后回位）——
  CSS 只能移动页面内容、移不动窗口。移动端没有可移动的独立窗口，退回聊天区 CSS 动画
  （`gosslan-shake`，遵循 `prefers-reduced-motion`）。
- **只抖不弹**：抖动帧复用既有 `remind` 传输（不新增消息类型），载荷加可选 `shake: true` 标记 ⇒
  接收端只**拉起窗口＋抖动**，不弹强提醒的系统通知（用户 2026-10-15「抖动就可以了，不要接强提醒的弹窗通知」）。
  普通强提醒行为不变、载荷逐字节不变（新字段带 `skip_serializing_if`）。
- 入口与语义仍沿用强提醒：接收端三态回执（S3 自动 / S4「我知道了」）不变；接收端 1.2s 节流防连抖。
- 托盘新增「勿扰模式」勾选项（复用通知总开关，供一键静音）。
- 协议：`RemindPayload` 增一个可选 `shake` 布尔字段（旧端忽略未知字段，向后兼容）；契约图登记 `shake_window`。

### 验证记录

- `cargo test --features bluetooth`、`npm test` 通过；新增载荷往返用例 `remind_payload_shake_flag_roundtrip`
  与前端接线 /「只抖不弹」守卫。
- 真机（本机双实例 `--instance 1/2`）：点抖动 → 对端**整窗抖、不弹通知**，发送方无自抖。

## [4.39.4] - 2026-10-14

### 4.39.3 那笔热修的事后评审补的三处（两处是我自己造出来的坑）

独立评审（`superpowers:requesting-code-review`）读完 `a28e37e..6514179` 的 diffs 报的四条 Important，
逐条回到源码复核后收掉三条，第四条按范围只登记不改码：

- **双击的第二下不再进 OS 的模态拖拽循环**（`TitleBar.vue`）。上一版只删了 `!isMac` 早退、
  另起了 `@dblclick`，但 caption 的 `mousedown` 每次都调 `startDragging()`，而 tao 在 Windows
  把它落成 `ReleaseCapture()` + `WM_NCLBUTTONDOWN/HTCAPTION` ⇒ 主线程进 Win32 模态移动循环，
  那一次 `mouseup` 被系统消费掉，WebView 合成不出 click，`dblclick` 就可能**永远不来** ——
  照那个形状交付，"Windows 双击最大化"这一条有变成死代码的风险（`data-tauri` 的
  `e.detail` 同样不可信，所以判据只用 `mousedown` 的时刻差）。现在第二下直接翻缩放、不起拖拽；
  `dblclick` 通路保留（macOS 今天就走它，结果不变），两条用时刻去重 ⇒ **一次双击只翻一次**
  （翻两次＝放大又还原，界面上看就是"点了没反应"，与原本报的缺陷长得一模一样）。
  判据：`标题栏按下：第二下必须翻缩放，不许再进 OS 拖拽循环`、`双击的两条缩放通路必须去重`。
- **`.part` 那道跳过改成"后缀 + mtime 还新鲜"**（`outbox_sweep.rs`）。上一版按后缀跳过的 path
  取自 `file_transfers.path`，而那一列只有**改名落盘之后**才写（`fail_taken_receive` 里原话
  「不能把 .part 写进 path」，中继那份是 `<id>.relay.part` 也从不进这一列）⇒ 后缀真正命中的是
  **用户本来就把文件叫做 `xxx.part`**（浏览器未完成的下载、分卷包都是这后缀）的成品文件，
  于是那一行台账**每轮都被跳过、永远对不上账**，每次建链整批重投 —— 正是 B2 要杀的那个永动来源。
  真正的在途另有 `file_receivers` 那份 `transfer_id` 兜着。用例
  `inflight_part_files_are_skipped_but_a_part_named_deliverable_is_not_starved` 两个方向都钉（
  新鲜 mtime ⇒ 跳；十分钟没动 ⇒ 必须放行）。
- **锁作用域判据补上 `placed(` 这个标记**（`lib_window_tests.rs`）。原清单里漏了它，
  把 `placed(&win)` 整段挪回创建锁里仍然判绿，而需求说的正是"锁内只做必要的创建逻辑"。

**评审的第四条没改码**（按"不许自行扩展范围"）：群文件收尾 `group_file.rs` 的 `sync_all()` + rename
仍是上一版修前的同一个形状（跑在 async 执行路径上）。单聊这条已解，群那条**症状会在传大群文件时复发**，
已登记为后续任务，不夹进这次发布。

**判据的反例能力是实测过的**，不是论证：五笔单点变异各红对应那一条
（helper 退回只看后缀 → ⑦；循环退回只看后缀 → 清扫器形状判据；`placed` 挪回锁内 → 锁作用域判据；
删掉第二下早退 → 第二下判据；去掉去重 → 去重判据），跑完逐笔按字节还原。
⚠️ 其中第一版 `placed` 那笔变异**当时是绿的**，查下来是变异脚本自己的缺陷（删除用的模式是刚插入
文本的子串，把移动后的那行也吃掉了）—— 改成先删后插才红在 `lib_window_tests.rs:842`。

⚠️ **仍未验证（这次发布后也没有）**：Windows 真机。用户明确"不自己测了"，所以
「双击标题栏放大/还原」「传大文件期间点设置/拖窗口」这两条只有源码级与单测级证据；
原生窗口行为量不到。

## [4.39.3] - 2026-10-14

### Windows：大文件收尾期间窗口操作失灵（开窗/拖拽/双击）—— 运行时阻塞修复

用户 2026-10-14 真机：从 Mac 往 Windows 传一个 3.x GB 的文件，Mac 端进度 100%、单勾灰，
Windows 端"还没接完"，而**这段时间里点设置没窗、拖标题栏不动、双击标题栏不放大缩小**；
另一台没在传的 Windows 拖拽是正常的。要求是「用户的当前操作优先级第一，异步的活一律不许挡住界面」。

根因不是协议，是三处运行时归属，加一条与忙无关的功能缺失：

- **收尾的 GB 级 `fsync` 钉住了 async worker**：`finish_receive` 里的 SHA finalize + `sync_all()`
  + rename 原本直接在 `reader_loop` 的 tokio 任务里跑（那段代码自己的注释就写着
  「600MB 的 fsync 是秒级慢活，而它跑在 reader_loop 里」）。所有 async 命令（含开窗那些
  `#[tauri::command(async)]`）排在同一个 runtime 上 ⇒ worker 被占满就是"点了没窗"。
  现在整体交给 `tokio::task::spawn_blocking`，错误出口与状态机一字未改。
- **30s 清扫器的整文件哈希也在 async 路径上，而且只按条数封顶**：`content_file_matches` 每 tick
  最多 8 条，但**条数界管不住字节**（8 个 GB 级候选 = 单轮几十 GB 读盘）。现在同样进
  `spawn_blocking`，另加两道界：单轮**字节**预算 256 MiB（第一条恒放行，否则超大候选会被永久饿死，
  那一行台账停在可恢复态 = B2 要治的那个"每次建链整批重投"），以及**跳过在途的那半截**
  （`.part` 后缀，或 `file_receivers` 里仍有同一个 `transfer_id`）。30s tick 与 8 条上限不变，
  outbox 语义一字未动。
- **建窗那把不可重入锁的作用域太大**：`ensure_aux_window` 原先在持 `AUX_WINDOW_CREATE_LOCK`
  期间做 decorate + 摆位，而摆位要问窗口自己的外框/所在屏（`tauri-runtime-wry` 的 `getter!`
  是 `rx.recv()`，**真等主线程**）⇒ 主线程一忙就带着创建锁挂住，四扇辅助窗一起点不开。
  现在闭包拆成 `build`（锁内，只有建窗）+ `placed`（锁外，摆位/decorate/显示），
  锁内的存在性判定换成只读管理器表的 `get_webview_window`。竞态那一路不再重复摆位（归建它的那个创建者）。
- **Windows 双击标题栏没有任何通路**（与忙无关）：`TitleBar.vue` 的双击处理器第一句就
  `!isMac` return，注释声称"Windows 由 tao 的拖拽区原生处理"—— 而 `data-tauri-drag-region`
  这个属性全仓只在注释里出现过、模板从来没有；tao 0.35.3 也没有 `WM_NCLBUTTONDBLCLK` 处理；
  本应用所有窗口 `decorations:false`，Windows 上根本没有系统标题栏。现在两平台走与绿灯
  同一个出口（`windowToggleMaximize`），"能不能最大化"仍由后端 `MAXIMIZABLE_WINDOWS` 白名单判。

判据（4 条新 Rust + 2 条新前端，全部实测过反例）：
`aux_window_create_lock_scope_never_waits_on_the_main_thread`（按花括号切出每处持锁块，块内出现
`outer_size(` / `current_monitor(` / `recenter_aux_window(` 等即红）、
`sweeper_whole_file_hash_runs_off_the_async_worker`、`receive_finalize_slow_work_happens_outside_the_receiver_lock`
（新增"慢活必须在 spawn_blocking 里"那一格）、
`reconcile_byte_budget_bounds_a_round_without_starving_oversize_files`、
`inflight_part_paths_are_skipped_before_any_disk_read`、
「标题栏双击不许按平台早退：Windows 也必须能最大化」、「双击与绿灯共用同一个缩放出口」。
四笔单点变异（把 getter 塞回锁里 / 两处写回成就地跑 / 删掉字节预算判定）各自只红目标那一条；
两笔前端变异（塞回 `!isMac`、绕过包装函数自己调命令）同样各红各的。
Rust 基线随新用例前移：macos 845 → 849、windows 同步。

⚠️ 仍未验证/仍未解决：**Windows 真机复验**（传一个大文件到收尾，看设置窗与拖拽是否全程可响应、
双击是否缩放）—— 浏览器层与单测都量不到原生窗口行为；「主线程在传输期间被什么直接占住」这一环
只有静态依赖源码（IPC 回调 = 主线程）与症状分叉（忙的那台失灵、不忙的那台正常）两条证据，
没有真机栈读数。另外每片到达时同一片两次抢 `file_receivers` 锁、进度事件被 500ms 落库钳住
这两格本轮未动。

## [4.39.2] - 2026-10-14

### 治理补齐：重复好友事件写成不变量、成员名字判据常驻化、领域图补登 P24–P33

只动文档与测试，**应用码零改动**。三格缺口 + 三尾项：

- **新增 `INV-P33`**（`docs/protocol-invariants.md`）：重复到达的好友申请 / 好友同意，同一进程内不许
  重复弹系统通知。契约按实物写：申请那一支的幂等键 = `pending_requests.insert()` 的旧值
  （`network/transport/handshake.rs:364`）经纯函数出口判定；同意那一支的键 = **持久**好友表
  （`get_friend` 在 `add_friend` 之前取值）；`emit` 每次都发是有意为之、写进规则里说明它不算违反；
  补发频率那一半归发送侧（30s 最小间隔）。
  ⚠️ **同节里如实登记了一个反例**：申请只活在内存里、库里没有那张表 ⇒ **接收端重启后**若对方仍在
  补发，同一条申请会再弹一次通知。所以这条的可信范围只到同一进程生命周期内，跨重启那一格留给负责人拍板
  （要收它得改应用码：申请持久化，或按申请人记一条持久的"已通知过"痕迹）。本轮没动。
- **成员名称判据常驻化**（`src/utils/memberName.test.ts` 新增两格）：「入口委托：nicknameOf 必须把判断
  交给 `memberName.ts` 那一个家」与「消费侧不再兜裸 id：头像取色名与资料页都止步于那一个家」。
  反例能力是实测的：八笔单点变异（插裸 id 短路 / 委托之后另起返回 / 委托整条改名 / 兜底措辞手打不走
  i18n / 取色名再接一次裸 sender_id / 返回处重新判名字 / 后端入口插 `return id.to_string()` / 后端委托
  降级成丢弃返回值）**各自只红目标那一条**，命中各自的断言消息，文件逐字节还原。
  ⚠️ 这些判的是**源码形状与纯函数结果**——全仓没有任何测试构造过 `AppState` 或 pinia store，
  所以**没有**入口级端到端覆盖，界面观感仍待真机复验。
- **迁移台账补第 12 行**（`docs/migration-ledger.md`）：成员显示名从"三个家"收成"一门语言一份纯函数 +
  入口只取数"，串上 `afd2dcd` / `fffc794` / `9539c2c` 与判据实物。同一行里记下**没收口的那一格的根因**：
  `friends.nickname` 全仓只有一个 SQL 写家且是覆盖式（`db/friends.rs:12`），两个调用点喂进去的都是**远端来源**
  的名字（一处是对端自报的昵称，一处是"同意那一刻解析到的那份"——可能是自报、申请里带的，也可能是
  「未知成员 abcd」），而没有任何面向用户的"改好友备注"命令 ⇒ 纯函数注释里那句"好友备注（我起的，最稳）"
  与数据面不符，"备注优先"挡不住对方改名（静态判据，未做真机读数）。
- **INV-P32 补 Required Test Matrix 四行**（正向一臂 / 反向三臂 / 已知边界一行），并把那条规则 3 的
  判据强度**改口成它真实钉的东西**：今天只要求"注册处的 `cfg` 字面量是三家桌面"+"`Cargo.toml` 里有这条依赖"，
  **不**比对两边平台清单是否同构 ⇒ 只改宽依赖那一节不会红，一致性今天靠注释 + 移动端编译门禁。
- **`docs/domains.data.mjs` 补登 INV-P24…P33**（此前这份名单停在 P23）：十条逐个按"本节正文或其钩子点名的
  实现/判据落在本域 `paths` 上"登记，并在注释里点名实物；`friendship`（`paths` 是空的）那条明确写出它的
  实现体跨 transport / platform / persistence 三域。
  ✅ `docs/ARCHITECTURE-MAP.html` 里那份 `DOMAINS` 快照的 `inv` 数组**已同步**（图上同样停在 P23 ⇒ 与真源不一致，
  按最小修复处理：只改七个领域各自的 `inv` 数组，逐域逐序与 `domains.data.mjs` 现算相等；图的其他快照字段
  与页头 HEAD/版本标记**没重取**，也没那个必要 —— HEAD 仍是 `247ed8c`）。改完 `node --check` 那段内联 JS 退 0。

## [4.39.2] - 2026-10-14

### 加好友不再连弹好几条；第二次启动不再多出一个完整程序

用户 2026-10-14：「正常聊天时，群内加好友会弹出很多个；点了一下那个弹窗，又弹出另一个聊天主框，
等于同时启动了两个程序；连续多条加好友的弹窗也有问题」。这是**两个根因**，都在后端。

**根因一：接收端没有「这条申请我是不是已经握着了」的判据。** 好友申请没有回执，发送端在
每次建链补全**和每轮心跳**（`dial.rs` 的 `HEARTBEAT_INTERVAL_SECS = 5`）都会补发一次，而每份补发
必须是**新 `message_id`** 的信封（复用旧 id 会被对端两层去重直接丢弃，那正是"丢了没人知道"的前提）⇒
接收端 mesh 去重与 `GossipEngine::is_new` **结构上看不见重复**。而 `handle_identity.rs` 的直连分支与
`gossip.rs` 的跨跳分支各自把 `pending_requests.insert(..)` 的返回值丢掉 ⇒ 每 5 秒算一次"新申请"、
各 emit 一次事件、各弹一条系统通知。这正是 2026-09-28 给 `FriendAccept` 修过的**同一个形状**
（那条的注释原话：判据只在一条路径上修就会"同一件事两种行为"），申请这一条是没修的双胞胎；
且 `pending_out_requests` 当时是 `HashSet`，结构上就没法像 `pending_out_accepts` 那样限频。

- 两条路径收成一个家 `apply_friend_request`（登记 → 事件 → 留痕 → 通知都在这一处），
  通知由新的纯函数判据 `friend_request_arrival_decision(首次)` 门控：**事件照发**（前端按 `from`
  幂等替换，不会堆多条），**通知只在第一次**；重复到达留一行日志。
- 发送端限频：`pending_out_requests` 改成 `(首次登记时刻, 上次补发时刻)`，补发前走纯函数
  `friend_request_flush_decision` —— **只设 30s 最小间隔，不设次数上限也不设放弃窗口**
  （申请等的是"对方做人"，加上限等于偷偷废掉「对方离线时暂存、上线后自动补发」那条承诺）。
  两半都要：只做接收端，BLE 仍会被每轮心跳刷满。
- ⚠️ 与同文件里公钥那条 `peers 优先`、以及 `friend_accept_flush_decision` 的"3 次 / 2 分钟窗口"
  都不是一件事，注释里写明不许合并。

**根因二：全仓没有任何单实例守卫。** 一个进程内**造不出**第二个聊天主框 —— `main` 只来自
`tauri.conf.json` 那一份声明，`WebviewWindowBuilder` 只有 `commands/logs.rs` 五处辅助窗在用，
前端 0 处 `new WebviewWindow` ⇒ 看到两扇主框只能是**两个进程**：各自一份主窗、托盘图标、
数据库句柄和 mesh 身份，同一条好友申请被两个进程各弹一次（这也放大了根因一）。
现在装上 `tauri-plugin-single_instance`：第二次启动不建新窗，改为把已有主窗叫到前台。
出口只认开发/测试的多开变量（`GOSSLAN_INSTANCE` / `GOSSLAN_AUTOSTART=1`）—— 双实例 E2E 是本仓
唯一能证跨进程行为的一层，守卫不许把它关掉；依赖与注册处的 `cfg` 都限死在 mac/windows/linux 三家
（上游不支持 android/ios，装上移动端编译失败），并且有一条判据钉住两边一致。

判据（新增 5 条 + 2 条按新形状改写，全部变异实测）：`friend_request_arrival_notifies_only_the_first_time`
（首次/非首次成对）、`pending_friend_request_reflush_is_spaced_not_per_heartbeat`（5 秒内不发 /
首次机会立刻发 / 一天后仍发，钉住"不设上限"这条与 accept 的差别）、
`every_friend_request_path_notifies_only_on_first_sighting`（两条路径都走进那个家 + 事件与通知各只一处发起点 +
**门控输入必须是 `prior.is_none()`**）、`friend_request_survives_a_dropped_link` 新增三格（补发必须调那个判定、
Nothing 必须立刻返回、成功必须记下本次时刻、间隔常量 30s 不许改成 0）、
`second_launch_focuses_the_running_app_instead_of_duplicating_it` + `second_instance_exit_is_only_the_dev_multi_open`
（形状 + 真值表两条一起：形状管得住"注册处走了函数"，真值表管得住"函数被改宽成恒放行"）。
实测红面：兜底判定硬编码 / 判反 / 少一条路径 / 不记补发时刻 / 间隔改成 0 / 出口恒放行 /
第二次不叫已有主窗 / 无条件注册 八种各红对应那一条。
**两处顺带修掉的量具缺陷**：`friend_request_survives_a_dropped_link` 原先用 `&src[i..i+1200]` 定长**字节**窗口
取函数体，中文注释下边界会落在码点中间（本次实测 `not a char boundary` 直接 panic），改用
`rust_fn_body` 按花括号配对切；`crate::notifications::show` 的点数判据从 3 收到 2（两条申请路径合并的结果），
并把"为什么这里可以更小"写进消息 —— 漏一条路径由那条"两条都走进家"的判据负责，收窄不放过缺陷。

验证：`cargo test --features bluetooth --lib` = 845 passed / 0 failed（840→845，基线 `--update` +
`--sync-baselines`，现读 macos 845+3 / windows 833+15 差额均有源码门控背书）、`cargo fmt --all` 与
`cargo clippy --features bluetooth --lib -- -D warnings` 退 0、`npm test` = 985 passed / 0 failed（未动前端，
`onFriendRequest` 本来就按 `from` 幂等替换，界面不会堆条目）、`node scripts/check-doc-numbers.mjs` 与
`node scripts/check-test-manifest.mjs` 通过。

### 同一次修复的收尾（同一版内）：注入锚点跟着搬家、护栏加三条、单实例写进不变量

- **CI 第一次跑红了**（`前端测试 / 清单 / 构建` 第 10 步「护栏注入锚点静态核对」0.8s 就退）：
  我改源文件的同时改坏了两处注入锚点 —— `transport.rs` 那条还指着
  `if auto_accept_if_already_friend(state, &from).await {`（已被搬进家、变量名变成 `req.from`），
  `commands.rs` 那条还指着旧的 `.insert(peer_id.clone());`（现在是 `entry(..).or_insert((now, 0))`）。
  **这正是那条静态核对存在的意义**：锚点失效时注入注不上去，守卫会静默空转，
  而它守的恰恰是这次新加的判据。两处锚点都**从当前源码里现取**再写回（不凭记忆抄），
  并逐条跑过 `verify-guards --only` 确认"改坏即 FAIL、恢复即 PASS"。
- 三条新护栏 Case（231 → **234 条**，`docs/ARCHITECTURE-MAP.html` 里那个手写数跟着改）：
  通知门控的输入被硬编码、补发间隔常量被改成 0、注册处被绕过出口判定无条件注册 ——
  三种都是我今天手工变异验证过的形状，落成常驻用例，别人改回去会当场红。
- 用户随后把这条说成了产品规则（**正常使用只许一个实例；点 Windows 通知只回显已开的那个；
  测试时才允许多开**）⇒ 写进 `docs/protocol-invariants.md` 的 **INV-P32**，钩子两条 Rust 判据
  + 一条 guard case（`check-invariant-hooks` 现算 32 条全部绑定）。顺手修掉 README 里
  「INV-P01~P29」这个已经漂了两格的手写上界 —— 改成只认 `check-invariant-hooks` 现算。
- ⚠️ 如实记下没解决的一半：单实例插件按"同一个可执行文件/应用标识"分组，
  **不同 bundle 之间不去重**（dev 构建与已安装的 .app 同时开着仍是两个进程）。
  正常使用碰不到，真机验证与双实例调试时会碰到 —— 这一格留给负责人裁决，不当已解决写。


## [4.39.1] - 2026-10-14

### 后端那份名字判据：兜底不再返回设备标识（4.38.2 没覆盖到的另一半）

用户 2026-10-14：「任务列表操作记录名字同步，有时候还会显示设备名，会变」。4.38.2 把**前端**那两份判据
收成了一个家，但显示名其实有**三个**家 —— 后端 `member_notices.rs` 的 `resolve_nickname` 写着自己的顺序，
而它的兜底是 `device_id` 原文。它有 20 个调用点，拿它构造的全是**落库或推给界面**的文案：群系统消息
「X 加入了群聊 / 已被移出群聊 / 退出了群聊 / 成为新群主」、受众预告里"任务"那一格、错误串「X 不是群成员」、
会话摘要与文件到达通知。**所以界面里出现设备标识的那一半根本不在前端这条路上** —— 而系统消息是落库的，
对方后来改名也修不回历史里那一条。

- 顺序改成 **自己 → 好友备注 → 在线自报 → 请求里带的名字 → 「未知成员 + id 后四位」**，与前端逐格一致。
  旧顺序把「对方自报的昵称」放在「我起的备注」之前 ⇒ 同一屏上气泡写备注、系统消息写自报名（=「会变」）。
  ⚠️ 别把它和同文件里那条**公钥**的"peers 优先"混成一件事：公钥要的是最新那一份，名字要的是我认的那一份，
  两个方向本来相反（`pick_member_x25519_prefers_peers_then_friends` 钉的是前者）。
- 兜底不再返回裸 id：新增 `unknown_member_label`，中英两份与 i18n `common.unknownMember` 逐字一致。
- 三个来源一律先 `trim()` 再判空 ⇒ 顺带修掉旧代码里「请求名 / 备注是空串就原样返回」那一格（「」加入了群聊）。
- 判据抽成纯函数 `pick_member_display_name`（与同文件 `member_removed_action` 同一手法：把"容易漏一支"的判断
  做成可单测的纯函数），入口 `resolve_nickname` 只取数，并以该调用作为**函数体的返回表达式**。

判据（新增 6 条，每条都做了变异实测）：Rust 五条 —— 备注优先与"没有备注才轮到自报"成对、永不裸 id、
空白来源算「没有」（配一条只把备注换成真名字的反证）、自己那一支中英两份 + 空 id 返回空串、
尾巴位数与非 ASCII 不许 panic；`memberName.test.ts` 加一格跨语言契约（位数同值、中英措辞逐字对 i18n、
入口必须以纯函数调用为返回表达式）。实测红面：兜底改回 `id.to_string()` 只红 Rust 那两条；备注与自报调换
只红"备注优先"那一条；位数 4→5 / 中文措辞改掉 / 入口插一条早退 `return id.to_string()` / 委托降级成
`let _ = 调用; id.to_string()` 四种都红跨语言那一格 —— 静息态先跑一次确认判据本身不空转。
其中「委托降级」那一种最初测出来是**假绿**（只判"调用点还在"证明不了返回的是它），补了"必须是末尾表达式"
这条才咬住；那条注释留在测试里，免得下一个读者把这格放宽回包含性判断。

验证：`cargo test --features bluetooth --lib` = 840 passed / 0 failed（835→840，基线已 `--update` +
`--sync-baselines`，现读 macos 840+3 / windows 828+15 差额均有源码门控背书）、`cargo fmt --all` 与
`cargo clippy --features bluetooth --lib -- -D warnings` 退 0（clippy 把 `for + if let` 判成
`unnecessary_if_let`，改成 `.into_iter().flatten().find(...)` 之后复跑全套）、`npm test` = 985 passed / 0 failed、
`npx vue-tsc --noEmit` 退 0。

## [4.39.0] - 2026-10-14

### 自定义任务类型现在能挑图标（名字之外的那一半）

用户 2026-10-14：「任务类型自定义是可以自己输入，自定义类型名称，图标」。名字在 4.36.0 就落了
（`custom_category` + 服务端 `normalize_custom_category`），**图标一直没落** ——
看板行首与胶囊那枚对 custom 档恒画通用「标签」（`CATEGORY_ICON.custom = Tag`，注释写的是
"自定义类型没有专属语义"），也就是把"没有专属语义"当成了"不需要专属形状"。

- 线上加 `TodoPayload.custom_icon`，值是**白名单键名**（`TODO_CUSTOM_ICONS` 十枚），不是 emoji、
  也不是组件名：emoji 在 Windows/鸿蒙上可能落回方框，而组件名会把前端实现细节写进协议、
  对端拿到一个它没有的组件只剩空白。`#[serde(default)]` ⇒ 旧对端发的载荷读出来是空串，
  两端都画默认那枚（`TODO_CUSTOM_ICON_DEFAULT = "tag"`），混合版本是常态而不是异常。
- 服务端两处规范化与"名字"同一口径：**非 custom 档一律清空**（不留"普通任务挂一枚自定义图标"的半态）、
  custom 档只认白名单、表外值明确拒收不静默回落（和"类型/状态/优先级"那一族同一立场）。
- **老对端不认识这一格时的沿用**（carry）与自定义名同一条规矩：两端各一份 ——
  Rust `latest_todo_def` 与前端 `carryAbsentTodoFields`，两边一起改，判"没说"的口径都是
  "键不存在 **或** 值本端读不出合法值"。少改一边就是"对方改一次状态，我挑的图标被抹回默认"。
- 成员窄档（只归档 / 只还原 / 只认领）三条判定各补一个 `custom_icon` 比较：漏一条，
  "改图标顺带归档"就能顺着窄档口子被非创建者做成（这条是判权面，不是显示面）。
- 选择器只有一份：`TodoIconPicker.vue`，看板草稿与详情弹窗两个入口共用。
  两个编辑器各写一排按钮就会开始不一致（同一判据两个家）。每枚带 `tap-safe` + `aria-pressed` +
  中英两份可读名称。

判据（新增 4 条，都是双向/带对照的）：`todoCustomIcons.test.ts` 三条（映射与白名单**双向**一致、
默认键在表内、每枚都有中英两份文案键 —— 少一枚就是屏幕上有个无名图标）；
`messageKinds.test.ts` 加一格跨语言对账（TS 与 Rust 的白名单同序同值 + 默认值同一个）；
Rust `custom_icon_is_normalized` 钉三个容易写反的方向（表外值必须拒、没给落默认、非 custom 清空且**不**落默认）。
另外两条既有守卫当场把我拦住并各修掉一处：`夹具载荷的键必须盖住 TodoPayload 全部字段`
（`scripts/axTodoFixture.mjs` 漏了 `custom_icon`）与 `小尺寸可交互元素必须带 tap-safe`
（选择器按钮 h-7 没加）。这正是它们存在的意义：新字段接一半，界面上就是"选了没反应"。

⚠️ 有意没做的一格：**图标变化不写进操作记录文案**（名字变化写）。那一行给的是"这条任务变成了什么"，
十枚图标各写一句会让流水变成图标说明书；要加得先想清楚呈现形态，那是产品决定。

档位：新增能力、向后兼容 ⇒ `Version-Bump: minor`（4.38.2 → 4.39.0，五处版本清单同提交）。
改动落在 `protocol.rs`（敏感文件）⇒ 标题带 `[impact]`。
验证：`cargo test --features bluetooth --lib` = 835 passed / 0 failed、`cargo fmt --all --check` 与
`cargo clippy -- -D warnings` 退 0、`npm test` = 984 passed / 0 failed、`npx vue-tsc --noEmit` 退 0、
`node scripts/check-test-manifest.mjs` 通过（新测试文件已登记、基线已 `--sync-baselines`）。



## [4.38.2] - 2026-10-14

### 成员名字：不再退化成设备标识，也不再"每次看都不一样"

用户 2026-10-14：「任务列表操作记录名字同步，有时候还会显示设备知名，会变」。查出两条独立的根因：

- **「显示设备名」**：`chat.nicknameOf()` 查不到这个人时**返回裸 `device_id`**（界面上就是一串
  `gosslan-…`），而群任务面板/详情弹窗/成员面板走的是另一份 `useMemberProfile`。
  两份的顺序一样、**兜底不一样**（那边返回 id、这边对自己返回「我」）⇒ 同一个人同一屏可以两个写法。
- **「会变」**：群成员表只存 `device_id`（`group_members`），全库**没有 peers 表**，
  在线节点的昵称只活在内存里（`chat.peers` 来自 `get_peers`）⇒ 非好友的群成员一离线就查无此名，
  名字随"此刻能不能查到"来回跳。

做法：

- 判据抽成纯函数 `utils/memberName.ts`（自己 → 好友备注 → 在线自报 → 最后一次见到的名字 →
  「未知成员 + id 后四位」，**永不返回裸 id**）。`nicknameOf` 与 `memberProfile` 都走它 ——
  两个家收成一个家，`memberProfile` 现在只管头像与在线。
- 新增本机名字缓存 `utils/memberNameCache.ts`（与 `announcementDismiss` 同一立场：只用于显示、
  不参与任何信任判断、读失败退空表、写失败静默）。上限 240 条、见过来就重插、超了裁最老的。
  **没有真变化时返回 `null` ⇒ 一次存储都不写**（`refreshPeers` 反复跑，直写就是每 333ms 落一次盘）。
- store 里**三个** `peers.value` 整表赋值点全部接上记名，并有一条按形状数的覆盖面判据
  （新增第四个写入点而漏接缓存时它会红，而不是等用户再看见一次"名字会变"）。
- 顺手拆掉两个把裸 id 又接回去的调用点（消息行头像取色、表情回应条的 `|| id`）——
  判据既然永不返回空，再接一次就是把第二条兜底写进第二个家。

判据：`utils/memberName.test.ts` 12 条 + `utils/memberNameCache.test.ts` 10 条，成对交付
（查得到/查不到、有备注/没备注、有昵称/没昵称、有快照/无快照各只换一个输入；
覆盖面那条带阳性对照 —— 两个 0 也算相等是假绿）。验证：`npm test` = 980 passed / 0 failed、
`npx vue-tsc --noEmit` 退 0、`node scripts/check-test-manifest.mjs` 通过（两份新测试文件已登记进 `test` 清单）。



## [4.38.1] - 2026-10-14

### Windows：开着不动过会儿自己就关了（4.38.0 的回归，已修）

用户 2026-10-14：「win 最新版在打开情况下不动，有可能软件崩溃掉，过会自己就关了」—— 而且是**无声**的：
运行日志里一个字都没有。

- **根因**：4.38.0 修「每次建链整批重投」时加的内容台账对账（`transport/outbox_sweep.rs::content_file_matches`）
  用**一次整读整份文件**再算 SHA-256，而它跑在**无人操作的 30 秒空闲 tick** 上（清扫器每 tick 最多取 N 条候选）。
  一份几百 MB 的收件文件会让进程瞬间占用 ≈ 文件大小的内存；**分配失败在 Rust 里是 abort 不是 panic** ——
  panic hook 不记、release 又开着 `panic = "abort"` 且 `strip = true`，所以表现就是"过会儿自己关了、日志干净"。
- **修法**：改成 `File::open` + 定长缓冲（`FILE_CHUNK` = 256 KiB）循环 `read`/`update`，与本仓
  `network/file/receive.rs`（续传前缀校验）和 `network/file/relay_push.rs`（逐片读盘）同一立场 ——
  那两处早就为同一个形状修过一遍。摘要不符/读失败仍判"不可用"，交给下一 tick，不谎报 complete。
- ⚠️ **为什么它当时全绿通过（这条比修复本身更重要）**：那两处老缺陷各配了一条**按文件锚定**的反证
  （`guard_cases/file_transfer.py` 的「建发送记录前不得整读文件」、`transport_network.py` 的整读注入档），
  所以在新分册里重新引入同一形状时，守卫根本看不见新文件 —— 门禁全绿、缺陷照发。
  新增按**形状**扫全集的守卫 `tests::transport_src_never_whole_file_read`：读 `transport_src_for_guards()` 那份
  生产码视图，任何一处出现整读盘字面量就红（阳性对照：视图里必须至少有一处流式读盘，否则是尺子读空了）。
  反向对照实测：把整读塞回代码 ⇒ 恰好这一条 FAILED（命中 1 处），还原 ⇒ 绿。
- 验证：`cargo test --features bluetooth --lib` = 834 passed / 0 failed；`cargo fmt --check` 与
  `cargo clippy --features bluetooth -- -D warnings` 均退 0。

### 任务弹窗里不再叠第二条滚动条

用户 2026-10-14：「任务面板操作记录，不要在内置滚动条」。详情弹窗本来就整块在 `BaseModal` 的滚动区里，
里面又各套了一条 `max-h-* + overflow-y-auto` ⇒ 两条滚动条叠着，滚轮落到哪条取决于鼠标停在哪。
按形状数了调用点，**三处一起收**（只改他点名的那一条就是漏）：

- `TodoDetailDialog.vue` 的「操作记录」列表（原 `max-h-44 overflow-y-auto`）；
- `GroupTasksBoard.vue` 新建/编辑里「指派」那一格（原 `max-h-40 overflow-y-auto`）；
- `GroupMemberPanel.vue`「选择好友」那一格（原 `max-h-40 overflow-y-auto`）。

三处都改成随外层那一条滚。验证：`npx vue-tsc --noEmit` 退 0、`node scripts/check-ui-runtime.mjs --only=task` = 29/29 绿
（含"每种张数卡片真实高度 ≤ 估算"那两条，去掉内嵌 cap 后估高口径没被改坏）。


### 取证轮保留：失败轮那条"永远不删"补上了天数上限（仓库体积从 25 GB 收到 5.1 GB）

用户 2026-10-14：「清除一下这个项目文件夹无用缓存，防止文件夹无限扩大」。现量下来两处会只涨不收：
`src-tauri/target/debug` 18.5 GB（cargo 从不回收旧 hash 的那份，`cargo clean gc` 只管全局 registry 不管项目 target），
以及双实例 E2E 的历史轮次目录 —— **保留规则原本只管"通过的轮最多留 30 个"，失败轮是一个都不删**，
实测攒到 382 个目录 / 1.83 GB，而真正被在库文档点名的只有 22 个。

- 删了 `src-tauri/target/debug`（删前现证两条：`git check-ignore` 命中 + `git ls-files` 对它 0 个跟踪文件）。
  `target/release` **保留** —— E2E 与本地层跑的就是那份，重编一次 6m43s，删它省不了多少还直接拖慢下一轮。
- 失败轮加第二条出口（负责人拍板按天数收）：**超过 N 天（默认 7）且没被在库文档点名**的失败轮才进删除名额。
  四条立场一条没动：被文档点名的不删、`unknown`（没有 `summary.json` = 崩在半路）永不删、
  引用名单拿不到 ⇒ 一个都不删、反向模式（`--round=X-lie`）⇒ 一趟都不删。上限走
  `GOSSLAN_KEEP_RUNS` / `GOSSLAN_KEEP_RED_DAYS`，默认值只有 `retentionLimits()` 一处读。
- 判据从 8 格加到 16 格（每格只换一个输入），并**逐格打了穿**：五组单点变异分别只红对应那一条
  （其中"上限缺失"与"取不到年龄"两格第一版变异是空转 —— `30 > undefined` 本来就假，
  要同时把比较那行改成 `?? 0` / `?? 999` 才打得穿 ⇒ 这两格真正锁的是"双重 fail-closed"）。
  `--prune-selfcheck` 那条秒级入口顺手把"格数"改成判据自己数着印，不再抄写死的数字。
- 新增 `--prune-only`：一次性清账与轮末收尾走**同一份** `pruneOldRuns`（顺手把 `classifyRun`/`dirBytes`/
  删除循环都收进 `scripts/e2e/core.mjs` 一个家，原来驱动里那份与本条是同判据两处家）。
  实测：反向对照（两个上限放到 9999）删 0 个；真跑删 285 个、释放 1568.6 MB，`test-results` 1.83 GB → 287 MB。
  ⚠️ 一次写读数时把 `bytes/1048576` 标成了 GB（那是 MB），单位要在打印当场核对，别信标签。
- 清完复核：仍在盘上且被文档点名的目录 = 22 个（与清前的引用普查同数）⇒ 没救走任何一份被引用的证据。
  复跑：`ls -d test-results/run-* | wc -l`、`du -sh test-results`、`node scripts/e2e-multi-instance.mjs --prune-selfcheck`。


## [4.38.0] - 2026-10-14

### 桌面窗口：macOS 绿灯与双击标题栏终于有反应了

用户 2026-10-12 实测：macOS 上点绿灯、双击主窗口标题栏**都完全没反应**，而全屏那颗是好的 —— 看着像权限被拒。

- **真根因不是权限**：判据 `is_maximizable()` 在 macOS 无边框窗上**恒 false**（本次按 `Cargo.lock` 那一份
  tao 0.35.3 源码逐行核过：`decorations:false` 建出的 styleMask 是 `Borderless|Resizable|Miniaturizable`，
  没有 `Titled` 位 ⇒ AppKit 的 zoom button 不存在 ⇒ 读它的 `isEnabled()` 直接返回 false，
  而 `set_maximizable(true)` 因为是"取到 button 才设置"也一并成了静默 no-op）。
  **能力一直都在**：`set_maximized` 里没有任何可最大化判据，且缺 `Titled` 位时它走的是
  `setFrame(visibleFrame)` 那条分支（原生 zoom 那条要求 `Resizable && Titled`），
  `is_zoomed()` 同样退回"比对 frame 与 visibleFrame"⇒ 放大与还原都真做得成，还原后读数也会变回 false。
  ⇒ 绿灯与双击标题栏共用同一个命令出口，所以**一处判据失真同时打死两个入口**。
- 判据换成**我们自己写进 builder 的显式配置**：新增 `MAXIMIZABLE_WINDOWS` 白名单（当前只放主窗口），
  与 `commands/logs.rs` 里那四处 `.maximizable(false)` 由新测试 `window_maximizable_matches_builder` 交叉核对
  （改一边忘另一边会红）；同时补进 `is_maximized` / `is_fullscreen` 等**命令内部真的会调到的** core 权限。
- 标题栏订阅 `onResized` 刷新最大化/全屏字形（原来只在挂载时问一次 ⇒ 点了按钮图标永远是初始样子），
  并在卸载时退订。
- 这两条新增的 Rust 用例纳入测试基线：`--update` 只补了本平台 ⇒ mac **809 → 811**，而 Windows 那份留空。
  ⚠️ **我先前据此写下"跨平台少 2 条只报 ⚠ 不报红"，那句在一分钟内被这条判据自己证伪了** —— 快速层第 1 步
  当场**报红**并给出出口（"这些用例在别的平台基线里存在、却没有一条 `target_os` 门控能解释"）。
  按它点名的修法补跑 `node scripts/check-test-manifest.mjs --sync-baselines` ⇒ macos 811+3 / windows **799**+15，
  两份基线都补齐，守卫转绿。教训形状：**"⚠ 的那条"与"红的那条"是同一工具的两条不同判据**，
  看见一条的措辞就推断整件的严重度，等于拿一个出口去猜另一个出口。
- ⚠️ 已知边界（tao 的行为，本机继承）：多显示器时这条 `setFrame` 用的是**主显**的 visibleFrame，
  而 `is_zoomed()` 比的是**窗口所在屏** —— 在外接屏上放大可能出现图标不更新、再点一次仍放大。
  这条只是登记，未处理。
- ⚠️ 本轮修复**自己留下的一格**（读实现时现抓到，登记未改）：`window_toggle_maximize` 里
  `let _ = window.maximize(); true` —— 系统真拒绝那次最大化时错误被吞掉，函数仍返回 `true`，
  而前端把这个返回值直接赋给图标状态 ⇒ 极端情况下"图标说已最大化、窗其实没最大化"。
  今天没有证据说这条路会被踩到（`maximize()` 在无边框窗上实测能成），所以**不在本轮改**：
  改法是"动作后再问一次真实状态再返回"，那要顺带决定"问不到时算哪一档"，属窗口面独立一格。

### 群任务卡片：点图片周围、点「查看更多」、卡片高度估算三处修完

- **点缩略图会「预览 + 任务面板」一起开**：上一轮为了让"点图片周围那一圈也能展开列表"把
  `@click.stop` 从图片带容器上摘了下来，但没人接手拦这次点击 ⇒ 冒泡进了卡片主体（它自己就是个
  `role=button` 挂着开面板）。改由**缩略图自己**在可点那一支 `stopPropagation` ——
  点图片只看图、点图片周围照常展开面板。这条正是运行时探针**已有**的判据先读出红抓到的
  （`node scripts/check-ui-runtime.mjs --only=task`）。
- **「查看更多」会把"直达这条任务"冲掉**：那颗按钮排在命中区①**之内**（底部「查看任务」在①之外），
  不加 `.stop` 就会在 `open(todoId)` 之后再冒一个不带任务号的 `open-panel`。已补 `.stop`，
  并把判据从"有 emit open"收紧为"只有 open、且 open-panel 零次"。
- **卡片高度估算被写成"有无图"一刀切**：改成按可见上限算一整块之后，1 张图的卡白占两行、
  5 张以上又漏掉「查看更多」那一行（前者是空洞、后者是虚拟列表遮挡 —— 两个方向都是缺陷）。
  现在按**这一条自己的张数**算行数并计入那一行；探针加了"张数 / 图片带 / 查看更多 / 真实高度 / 估算"
  的实测表，六种张数下 `估算 − 真实` 收敛成同一个常数。共享常量仍只有一个家（`utils/todos.ts`）。
- 弹窗布局三条（用户同日实测）由运行时几何判据钉住：标题行不许被 flex 压扁、操作条必须在滚动区**之外**
  且钉在卡片底部、正文左右净留白对称（右侧扣掉滚动条实占宽度再比 —— 经典滚动条与 macOS overlay
  滚动条两种环境下都成立）。并各带一条**就地撤掉修复 ⇒ 读数必须变**的反面对照，防止判据空转。
- 顺带修掉 4 处**探针自身的错判**（它们会把产品读成缺陷、或把缺陷读成绿）：数缩略图时数到的是卡片主体
  （恒为 1）；靠"没有 svg 的按钮"认「查看更多」（那颗自带箭头 ⇒ 永远选不中，退化成点了别的按钮）；
  两次估算共用同一个 `msg_id`（高度缓存键是 `fontSize|msg_id` ⇒ 第二次读到第一次的缓存，读出"有图==无图"）。

### 单聊收不到消息：先补上能归因的那两行日志

用户 2026-10-12 报「刚加的好友，能看到互相在线，但我发的群聊和单聊手机端都收不到」。核完代码的第一条结论是
**这份日志当时无法证明任何事**：单聊走 gossip 信封这条路，而这条路**收到并解开之后一行日志都不打**
（`群消息@输入` 那句被 `kind == Group` 挡着）⇒ "手机日志里没有"与"没收到"长得一模一样。

- 补上单聊的正向到达留痕（记 id 与 kind，不记正文/昵称，与群聊那条同一口径），
  以及**定向给本机却解不开**时的告警，并带上"本机是否存有对方密钥 / 与信封自报是否一致"两个布尔量。
- 已核清的两条事实（都读了实现）：发送端那句 `try_send result=true` 只代表**进了本机发送队列**，
  没有链路时那个分支还写死 `true`，随后状态就被写成 `sent` ⇒ 界面的"已发送"不等于对方收到；
  单聊有 `ChatAck`（解开并落库才回），所以"到底送达没送达"本身是可查的。
- 本轮另补一行**发送端**留痕：库里那把与在线自报的那把不一致时（本机取库里那把）记一条 warn。
  没有它时"我发的他收不到"在发送端日志上完全看不见，而对端解不开又是不回送达确认的静默丢弃。

**已核清的事实**（逐条读了实现，不是推测）：

- 单聊到达**本来就不打日志** ⇒ "手机日志里没有"既不能证明收到、也不能证明没收到。这是本轮补日志的唯一理由。
- 定向给本机却解不开的加密单聊信封：不落库、不通知界面、**也不回 ChatAck**（三处早退都静默）。
- `try_send result=true` 只代表进了本机发送队列；没有链路时那个分支还写死 `true`，随后状态被写成 `sent`。
  界面确实有"已送达"这一档（双勾）—— 但 `MessageReceipt.vue` 的注释断言"写出去≈对方收到、这状态一闪而过"，
  而这条故障形态恰恰是**永远停在这一档**，所以那句前提在这里是不成立的（本轮只登记，未改文案）。
- 好友公钥的取用在仓内有**两套顺序**：1:1 密封与直发解密是"库里那份优先"，
  而界面安全码与群密钥分发是"在线那份优先"。⇒ 两份不一致时**"安全码对得上"不证明消息解得开**。
- 库里那份"只填空、绝不覆盖"（唯一覆盖式写入要求用户显式确认），检测到变化时的动作是
  **在聊天里插一条 ⚠️「身份密钥发生变化，已保留原密钥未替换」**，不是刷新。
  顺带更正一处**与实现相反**的注释（它写着"会自动刷新、一个广播周期内收敛"）。

**根因已定**（下面第 1 条被代码、他本机库、他两端日志三个来源分别对上；第 2、3 条是被证据降级/排除的历史候选，
留着是因为它们记着"为什么不是密钥那条路"）。修法两刀都**未做**，等独立一轮。

1. **现在的头号候选 = 内容服务在接收循环里等"自己那条链路"的应答（自死锁，不是慢）**
   —— 本轮把先前那句"最坏 15 秒的队头阻塞"**升级**成"必定走满 15 秒"，因为读完两侧实现后
   等待的对象正是被自己堵住的那条循环：接收循环**单帧串行**（`queue_policy.rs:204` 就地
   `handle_message(...).await`），而 ContentRequest 那一臂（`handle_share.rs:65-83`）发的
   `FileOffer` 之后 `timeout(15s, rx)`（`file/send.rs:204`）等的 `FileAccept`/`FileReject`
   **要由同一条连接的 reader_loop 读回来** ⇒ 应答结构上读不到。
   同文件的下载请求那一臂（`ShareFileRequest`，`:195`）却是 `tokio::spawn` 出去的 ⇒ 同一个问题两种写法。
   群聊与单聊在直连时都是 `Message::Gossip` 帧，排在同一个循环后面（`transport.rs:1197-1199`），
   **心跳/Hello 也在同一个 match**（`:1094`）⇒ 一次文件服务会让"消息进不来"和"我还活着也读不到"同时发生。
   ➕ **他给的两端日志里自带一组对照，27 个样本零重叠**（逐 `tid` 把 `offer SENT` 与它**自己**的应答相减现算）：
   手机侧用户在界面选的那 15 单（从命令/outbox 起，接收循环空闲）accept 等待 = **14 单 0 秒 + 1 单 1 秒**；
   电脑侧自发的 5 单同样**全 0 秒**；而手机侧服务那 14 条内容重试的 7 单（从 handler 里起）
   **7/7 全部超时，每单恰好 15.0 秒**（第 8 单落在日志截断之后，所以可见的是 7 不是 8）。
   同一条链路、同一个对端、同一段发送代码，两种起点、相反结局 ⇒ "对端慢/网络差"这类解释被当场排除。
   ➕ 两处让它**永不收敛**的账（都读了实现）：① 应答到达时 waiter 早被超时摘掉，而
   `handle_file.rs:287-295` 的 FileReject 臂是 `if let Some(tx)` **没有 else** ⇒ 那帧被静默丢掉，
   本机永远学不会"对方其实已经有"；② "要不要再拉一次"住在 `content_transfers`（按 **cid**：
   `status IN ('queued','active','incomplete')`，`content/store.rs:156-167`），而"本机已收完"住在
   `file_transfers`（按 **transfer_id**：`db::is_transfer_done`，`handle_file.rs:91-93`）——
   AlreadyHave 那一支回完帧就 `return`（`:112-129`），两边谁也不回写对方 ⇒ 同一台机器上
   "我有完整字节"和"这条还没收完"**同时成立**，每次建链再投 14 条（重试那份账自己也在
   `transport.rs:962-983` 无条件 `record_failure`），直到封顶才停。
   ★ **第②条已在用户本机库里读到实物**（10-13 只读打开 `gosslan.db`，`mode=ro`，未写）：
   `content_transfers` 20 行里有 **14 行 `direction='receive' AND status='incomplete'`、`received` 全是 262144、
   `path` 全 NULL**，而这 14 个 `transfer_id` 在 `file_transfers` 里**全是 `done`** ⇒ 两张表各执一词被直接观察到。
   其中 2 行 `received` 已**等于** `size` 却仍未收口 ⇒ 缺的写入点被钉死：`touch_received` 只推进 `received`
   （`content/store.rs:208-222`），这条路上没人写 `path` + `complete`。
   `attempts=2` 对上 `MAX_CONTENT_RETRIES=8`（`content/policy.rs:14`）、`next_attempt_at` 早已到期
   ⇒ **还剩 6 轮风暴排在队里**，每轮 ≈ 14 × 15 s 的手机侧入站阻塞；下次建链应当整批重投（可验证的预测）。
   ➕ **缺失的那个写入点已经定位到具体调用点**（这一步把上面"两边谁也不回写对方"那句欠精确的说法收紧了）：
   单聊接收这条路上 `content::store` 只有三处调用 —— `file/receive.rs:581` `touch_received`（只推进字节数）、
   `file/receive.rs:651` `record_failure`、`transport/handle_file.rs:238` 在 Offer 时登记一条 Active（`path: None`）；
   **收尾成功那一步没有任何一处把内容收口成 complete + path**。`record_local` 全仓 5 个调用点
   （`transport/group_file.rs:460`、`transport/relay_file.rs:395`、`commands/group_announcements.rs:235/:278`、
   `commands/group_todo_media.rs:77`）**全部在群文件 / 群公告 / 待办 / 中继那几条路上，单聊那一条不在里面**
   ⇒ 台账里那 14 行永远停在"incomplete + 无 path"，而 `content/store.rs:156-167` 正是按这个状态决定要不要再拉。
   ➕ 这条缺陷有**第二个可见症状，而且他的日志里已经出现**：`find_source`（`:173-188`）要求 `path` 非空才算"本机有这份内容"，
   所以手机反过来向电脑要同一份内容时，电脑会答"本机没有该内容"——日志 20:28:13 那句
   `ContentRequest：本机没有该内容 cid=b9e8df92…` 里的 **b9e8df92 正是那 14 行中的一行**（电脑其实有那些字节，
   `file_transfers` 那单是 done）。⇒ 同一个洞两头咬：拉的人永远拉不完，被拉的人答"我没有"。
   ⚠️ 修法第②刀因此有了最小形状：**在 1:1 接收收尾成功处补一个 `record_local`**，口径照抄群文件那处（不是新抽象，
   是把已有的一环接上）。第①刀（把内容服务搬出接收循环）仍然必须做 —— 否则"对方真有、我没有"这种**合法**的拉取
   也一样读不到自己的应答、照样 15 秒超时。
   ⚠️ 边界：这条解释"那几分钟到不了/很晚到 + 链路被判死重连"，**不自动等于永久丢**（outbox 会补发）。
   ⚠️ 修法本轮**未做**（两刀，都不引入同链路并发）：**①** 内容服务搬出接收循环 = **每对端一个串行的后台服务队列**
   —— 同一对端仍一次一单（`pending_file_accept` 那个单键注册不会被并发踩到），但应答读得到 ⇒ 这条路径
   改完**第一次能真正成功**，而不只是"不那么慢"；直接 `spawn` 会把"同一连接多路并发传文件"变成既成事实，不走那条。
   **②** "对方已完整收下"必须能**回写拉取台账**（把该 cid 判完成、停止重试），并给那句被
   `let _ = try_send(...)` 丢掉的发送留痕。
   ⚠️ 验证缺口（现数）：`scripts/e2e/` 全册（含 `core.mjs`）搜 `ContentRequest` **0 命中** ⇒ 双实例
   E2E 没覆盖这一格，改它得配一轮新判据（正向：建链后的内容重试必须真送达；反向：服务期间另一条链路的
   聊天必须在有界时间内被读到），跑现成的 gfile 轮证明不了。
   ➕ 为此**只加了一把量具**（不改行为）：接收循环给每次 `handle_message` 计时，单次 ≥3s 且过 5s
   节流时打一条 `[link] 入站处理占用接收循环 …ms`。`cargo fmt`/`clippy -D warnings` 退 0，
   `cargo test --features bluetooth` **811 passed**，并用重编出的 debug 二进制跑了一遍真双实例
   `test:e2e:gfile`（退 0、28 条断言全绿，产物 `test-results/run-2026-10-13T04-06-38-773Z/`）。
   **读数：那行一次都没出现，而这个负读数证明不了任何事** —— 那一轮从头到尾没有 ContentRequest
   （该轮 **10 份实例日志里 `content` 与 `ContentRequest` 均 0 行**，逐文件 `count` 现算），
   也就是那条 15 秒就地 await 的分支根本没被走到；通道本身是活的（A、B 两份 stdout **各有 7 行**
   `[link] 建链`），所以不是"日志没接上"。跑的那份二进制确实带着量具：`summary.json` 的
   `binary` = `target/debug/gosslan`（mtime 与起跑同一秒），`grep -ac inbound_head_of_line` = 1
   —— 阳性对照用同一条命令打已知会打印的 `offer SENT`（1）与一个不存在的词（0）。
   ⚠️ 这里差点被自己的尺子骗一次：先用 `strings -a | grep -c "入站处理占用接收循环"` 拿到 **0**，
   差一步就据此判"这轮跑的是不含量具的旧二进制、整段实测作废"。真实原因是 `strings` 只提取可打印
   ASCII 字节串，**UTF-8 中文每字节 ≥0x80、被当终止符 ⇒ 中文字面量对这把尺子结构性不可见**；
   换成同一条编译单元里的 ASCII 常量（那处节流的键名）才拿到真读数。
   它只说明一件事：**正常的本机一轮里没有任何入站处理越过 3 秒**。量具自身的"能打印"仍**未被证明**：
   `reader_loop` 是本文件私有、`queue_policy.rs` 没有 `#[cfg(test)]`，而现成的 19 份轮次分册里
   没有一格会触发长入站处理 ⇒ 要证它得靠新那轮 ContentRequest 判据，或在真机那次故障现场抓这条日志
   —— 这把尺子买的就是现场，不是 CI。
2. 原先排第一的"发送端握着过期公钥"**基本作废**：两端建链都是 `new_peer=true`，而密钥冲突核对
   恰恰只在"新建 peers 条目"时跑 ⇒ 两把若不同，聊天里**应当**有那条「⚠️ 身份密钥发生变化」。
3. 判这几条谁对，只缺一格读数：**电脑上看那几条的勾是单勾还是双勾**（双勾＝已收下，问题在
   显示/通知侧；单勾常驻＝真没被接受）。

### 按 cid 拉内容这条路径终于能跑通了：入站自死锁、两张台账分叉，外加一条被实测推翻的判据形状

上面那条根因（第 7 条）的**两刀都落了**，并给这条路径第一次配上跨实例判据。范围严格止于
「文件传输与入站阻塞」：不动加密与身份信任、不重构网络架构、不碰无关 UI。

- **① 内容服务搬出接收循环 = 每对端一个有界串行队列**（`transport/queue_policy.rs` 新增 `FileService`，
  `FILE_SERVICE_QUEUE_CAP = 8`；`handle_share.rs` 那一臂改成投队列）。
  为什么是"每对端一个、内部串行"而不是裸 `tokio::spawn`：`pending_file_accept` 那张表只按
  `transfer_id` 单键登记，同对端并发服务会互相踩掉对方的等待者 —— **这不是推论，是本轮实测到的第二种死法**
  （同机 LAN + Routed 两条链路各服务一次同一个 tid ⇒ 15 秒的等待塌成一串瞬时失败，
  旧二进制日志里同一秒内 `offer SENT` 与 `offer TIMEOUT/REJECTED` 成对刷屏）。
  队列语义按合同逐条配齐且每条都有用例：非阻塞 `try_send`；同 cid 合并（`Merged`）；满 ⇒ `RejectedFull`
  **显式拒绝 + 带上当前深度的留痕**（不是"warn 完就丢"）；`ServeWorkerGuard` 按 generation 比对 ⇒
  **旧 worker 退场不会把新 worker 踢掉**；断线 ⇒ `close_peer` 丢掉发送端 ⇒ worker 自然退出、整条 entry 注销
  （不留永久占位的 map 条目）；worker panic ⇒ 走同一个 Drop 收口。
  ★ 容量恢复的重新调度路径**是既有的、不是新造的定时器**：`retry_incomplete_content` 此前只有 Hello
  一个调用点（现数），稳定链路上被拒的那一条就永远不再被请求 ⇒ 把它挂进 `Message::Heartbeat` 那一臂
  （同一臂里已经有 7 个 flush，是产品既有的"链路确实活着"的机会）。自带 `should_retry_now` 退避闸与
  `MAX_CONTENT_RETRIES=8` 封顶，不是"未经证明的周期性后台重试"。
- **② 完成状态一致性：收尾那两张表写进同一个事务**（`file/receive.rs` 的 `finish_receiver_into`）。
  只有"字节数够、SHA-256 等于 cid、`sync_all` 成功、唯一名重查之后 `rename` 成功"这四件全成，
  才在 `db.transaction()` 里一次写 `file_transfers = done` + `content::store::record_local(complete + path)`；
  **事务失败退回今天那份单写** —— 宁可让内容台账留在可恢复名单里（下次再验一次），
  也绝不给出"台账说 complete 而盘上没有验证过的整份文件"。
  这一刀补的是全仓那个最隐蔽的洞：`TransferStatus::Complete` 的唯一构造点在 `record_local` 内部，
  而 `record_local` 的 5 个调用点（群文件 / 群公告 / 待办媒体 / 中继）**没有一个在 1:1 接收收尾这条路上**。
- **③ 那 14 行已经分叉的台账由代码自己收口，不手改用户库**（`transport/outbox_sweep.rs` 新增一趟，
  每 tick 最多 8 条，跑在既有 sweeper 的 30s 循环里；取锁一律短暂、哈希放在锁外）。
  口径按合同：`JOIN file_transfers` 找出「文件台账说 `done`、内容台账说 `incomplete` 且 `path` 为空」的行，
  **先把文件真读一遍验 size + sha256 == cid**，验过才补 complete；验不过记 `FailReason::Local`
  保持可恢复状态（不宣布完成，也不删行）。
  ★ **已经在用户那份库上现读过一次（只读打开 `gosslan.db`，一个字节都没写）**：对账查询命中 **14 行**
  （合计 **235.7 MB** 要真读一遍验 SHA），**逐行 `stat` 出文件、字节数相符、sha256 与 cid 全部相等 ⇒ 14 行全都会被判"补成 complete"**，
  验不过记 `Local` 的那一支这次是 0 行；这 14 行同属一个对端（id 尾 `1cb88c`），且**这 14 个 cid 在本机任何一行里都没有 `path`**
  ⇒ "两头咬"不再是只靠一条日志行推的：他手机上那次「本机没有该内容」的**全部 14 个原料**都在这里。
  ⚠️ 这一格仍**没有**写"他的库已经自愈"：现读证明的是"查询命中 + 验证会过"，
  而"下一次启动后那 14 行真的变成 complete"要等他跑带修复的版本（sweeper 每 tick 8 条 ⇒ 两 tick 收完）。
- **④ 不再静默吞掉关键异常**：`handle_file.rs` 的 `FileAccept` / `FileReject` 两支过去是
  `if let Some(tx)` 没有 else ⇒ "应答到达而本机已经不在等它"这条事实**日志里一个字都不留**，
  而它恰恰是区分「对端没答」与「对端答了但我读不到」的唯一读数（本轮就是靠它把死法②抓出来的）。
  现在各补一条 5s 节流的 warn，只记 id / peer / 字节数，不记正文。
- ➕ 顺手量到一个**别再用错当证据**的事实：接收侧的 `file_transfers` 行**不是**"建起接收器"那一步写的
  （旧行为跑完 12 单，B 侧只有 1 行、却有 12 个 `.part` 与 12 行 active 的内容台账）。
  判"对端确实应答过"改用接收目录里的脚印（`.part` 或终名文件），因为 `handle_file.rs` 是
  **先建接收器（开 `.part`）再 `try_send(FileAccept)`** 在同一个臂里 —— 有脚印就一定发过应答。

**门禁实测（本轮收尾现跑）**：`npm run verify` 快速层 **17 步全绿（16.7s）**；
`npm run verify:full` 全量层 **23 步全绿（744.1s）** —— 含 `cargo fmt`/项目 clippy 门/`cargo test`、
测试清单守卫、**89 条护栏的非空转注入验证（686.6s，改坏即 FAIL、恢复即 PASS）** 与
移动端编译门禁（Android，16.4s）。注入跑完后逐处现读，本轮新加的 7 个标记
（`FILE_SERVICE_QUEUE_CAP` / 收尾事务那段 / `list_reconcilable_content` / 两条 `*_no_waiter` 节流键 /
`content_serve_full` / 心跳臂里那次 `retry_incomplete_content`）每处仍恰好命中一个文件，
脏路径数与内容清单未变 ⇒ 注入的写回是原样的（mtime 会变，这是那一步的既有副作用）。
⚠️ 快速层里那条 `Change Budget` 报「1 步零覆盖」不是本轮造成的：本轮**没有提交**，
`origin/main..HEAD` 为空 ⇒ 它按设计说出"没判到东西"，`--range` 才有读数。

**Rust 侧判据**：14 条新用例（6 条队列 + 3 条收尾 + 5 条对账）。
`cargo test --features bluetooth --lib` ⇒ **825 passed / 0 failed**；
`cargo fmt --check --all` 退 0；项目规定的 clippy 门 `cargo clippy --features bluetooth -- -D warnings` 退 0；
两份测试清单基线按工具自己的出口登记（`check-test-manifest.mjs --update` + `--sync-baselines`）⇒
macos **825** / windows **813**（这一对在下面那节「群聊那一半」之后又各 +1 ⇒ **现值是 macos 826 / windows 814**，两处都由同一个工具现算，别抄这里的数）。

**跨实例那一轮新建**（`scripts/e2e/rounds/contentpull.mjs`；登记五处：分册的 `export const MODE` /
驱动的旗标 + import + 分发 / `check-doc-numbers.mjs` 的 `MODE_LABEL` / `package.json` 正反两跑 /
`verify.mjs` 的 local 层 + 验收矩阵「轮次账」，现算 **内容拉取轮 27 条断言**）。
这一格以前的跨实例判据是**零**：`scripts/e2e/rounds/` 全册（含 `core.mjs`）搜 `ContentRequest` 建册前 0 命中，
而所有既有"文件"轮走的都是**发送侧主动 offer** 那条管道（`file_outbox` → flush），
与"请求侧按 cid 拉、服务侧回发"只有收尾代码相同、入口完全不同。
形状：A 的盘上有 12 份完整字节（`content_transfers` 有 `path` = 拥有即授权的原料），
B 逐份留一行 `receive / incomplete / path NULL / 退避已到点`（复刻真机那 14 行的形状）
⇒ 上线后由生产侧的 Hello 臂与心跳臂**自己发出真帧**，harness 不伪造任何一帧。
★ 第一份刻意给到 40 MB：溢出是"提交比服务快"的结果，窗口必须由**实测的服务耗时**撑开而不是碰运气。

三面实测（同一份判据）：

> ⚠️ 跑这三趟时踩到一条环境事实，值得记：`verify:full` 里的护栏注入是「改坏 → 跑 → **原样写回**」，写回会把 `.rs` 的 mtime 推到当下，而攒提交期间工作树本来就是脏的 ⇒ E2E 那条「二进制不许比源码旧」的 pre-flight **退 2 拒跑**（它的豁免分支要求 `src-tauri/src` 与 HEAD 内容一致）。处置只有一条：`cargo build --release --features bluetooth` 再跑，**不许放宽那条门**。退 2 也不是判据红，别混着读。

| 跑法 | 结果 | 现场 |
| --- | --- | --- |
| 旧行为（从 abb99f8 现编的那份，产品码逐字节等于 HEAD，只把 harness 换成新册） | **9/30 条报红**：12 份一份都没取回 · B 侧 12/12 已应答而 A 侧读到 accept **0 行** · 23 行满额超时 · `.part` 12 个 · 可恢复 12 行 · 「永远取不到的那一单不许卡住同对端其余各单」也红 · **断线那一格连「腾出手来开始服务第二批」都做不到**（90s 内一次都没开始 ⇒ 上一批的满额握手还占着入站；那一趟因此在第一条前置判据后就地收住，只执行到 30 条） | `test-results/run-2026-10-13T13-06-15-658Z`（已从旧树搬进本仓；更早两趟的记录在 `run-2026-10-13T10-17-34-075Z` 与 `run-2026-10-13T11-59-12-278Z`） |
| 新行为（当前工作树现编的 release） | **32 条全绿**：从建链到 12 份全部到位 **4807 ms** · 溢出留痕 1 行（5s 节流，一行不代表只拒一单）· 重投行数 16 之后两个心跳周期不再增长 · 文本落库 4305 ms；**服务方半路被 SIGTERM 之后，第二批 4 份 40 MB 由重起来的连接取完，15.4s** | `run-2026-10-13T13-05-25-808Z` |
| 反向 `--round=contentpull-lie`（只翻判据读的那两份值：期望摘要 + 期望台账终态） | **恰好 2/32 报红**，其余 12 条照绿，而"实际"列里印着真相 `读数 ["complete"]` ⇒ 红来自断言本身 | `run-2026-10-13T13-13-57-617Z` |

⚠️ **一条判据形状被自己的 RED 推翻**（记下来防再犯，完整形状见验收矩阵那一格）：
这一轮第一版把「入站被占死多久」写成"A 进入第一次服务后 30 秒内那条文本要落进 A 的库"，
在旧二进制上量到 **5300 ms ⇒ 假绿**；更早一版把它放在停机预置里，量到 **1 ms ⇒ 也是假绿**。
两个成因都是真的：① B 的 Hello 臂里 `flush_outbox` 排在 `retry_incomplete_content` **之前**
⇒ 停机写好的那条文本天生排在所有请求前面，量到的是"帧到达的先后"而不是"入站被占住多久"；
② 两条链路各自阻塞、链路一抖就双双走进"同一个 tid 被两次注册"那条瞬时死法 ⇒ 15 秒的等待根本不成串。
⇒ 这条路径上**墙上时间不是可靠判据**，改判"谁答了 / 谁没读到"这一对确定性读数，耗时只如实打印。

★ **同一条自死锁也解释了那 6 条 1:1 `failed`**（把他两端日志与他库的 `ts` 对齐后现算出来的，日志口径是本地 UTC+8）：
  那 6 条文本写在 **20:36:23–20:36:25**，而手机那半份日志在 **20:36:11 / 20:36:27 / 20:36:42 / 20:36:57 / 20:37:12**
  反复打出「`ContentRequest` → `offer SENT` → `offer TIMEOUT/REJECTED`」这一段（整份手机日志里这类事件 52 条，
  其中 7 条是满额超时、其余是秒级的瞬时失败 ⇒ 两种死法都在这台真机上出现过），
  也就是**那 6 条文本落库的那一两分钟，手机的入站正被自己的内容服务占着** ⇒ 它读不到对端发来的文本，
  发送侧的 outbox 就在 120s 判死里把它们点亮成 `failed`。
  ⚠️ 这是**时间对齐 + 机制同源**的证据，不是逐条 msg_id 的因果链（日志里没有"某条文本被某条链路拒收"这种行）；
  ⇒ 修完之后这一格的可观察预测（**还没在他机器上验过，别读成已验证**）：
  同一条链路上"一边在按 cid 拉大文件、另一边连发普通文本"不该再把任何一条点亮成 `failed`，
  而 `--round=contentpull` 里那条「内容与方向都对」的文本判据就是这条预测在 harness 里的替身。

⚠️ 仍未覆盖 / 未做（不许读成已验证）：
① 真机那 14 行**启动之后**的终态（命中与 SHA 验证已现读，见上面那条 ★；还缺的是"跑起来真的收口"这一格，
   要等他启动带修复的版本后再现读一次那两份库）；
② 「本机没有该内容」那一支**本轮已补进同一轮**（第 N+1 个 cid 是现造的随机 32 字节、盘上根本不存在，A 侧也故意不写那一行 ⇒ `find_source` 必然取不到）：服务方必须明着说一句「本机没有该内容」，那一行**不许**被写成 complete、盘上不许出现假文件，而且这个永远取不到的 cid **只该消耗自己的 attempts 退避**——不许卡住同对端其余各单（实测它 21 秒里自己吃掉 4 次 attempts，其余 12 份照样全部到位、接收目录零残留）。
③ 群成员作为种子被拉（`find_source` 的群分支）在新队列上的跨实例覆盖 —— 群文件轮不测拉取；
   （合同点名的另一格**已经补上**：「旧连接不许阻塞新连接 / 队列里没开工的作业不许变成永久占位」现在有跨实例判据 —— 服务方在第二批 4 份 40 MB 的第一份在飞时被整个杀掉，重起来之后剩余各单必须全部落盘且逐份 sha 对得上，且补齐它们的必须是**新连接**的日志（`stashLogs` 把旧日志整份移走，所以那里数到的行只可能来自重启之后）。旧二进制在这一格的前置判据就红：90 秒内根本没腾出手开始服务第二批。）
④ **「取消」这一格本轮已更正：它不是欠账，是这层没有那个对象**（原先这句写着"单条作业的显式取消没有接到队列"，
   放在"仍未覆盖"里 ⇒ 只扫列表的人会去补一个界面上没有东西可指的取消入口）。现读接口面三条为证：
   `FileServeJob` 的字段只有 `cid/peer_id/transfer_id/path/from_seq/from_bytes`（**无**取消句柄）；
   `FileService` 公开面恰好七个 `new/submit/start_worker/has_worker/queued_len/unregister_worker/close_peer`；
   `PeerQueueState.tx` 的注释自陈关停方式 —— `queue_policy.rs:330` 原文
   **被 close_peer 丢掉 ⇒ 收端自然结束 ⇒ worker 退出**（关停不靠轮询）。
   ⚠️ 源码里**没有**反引号：我照自己抄进台账的那句「被 \`close_peer\` 丢掉…」去检索时 0 命中，
   那是本会话第四次自造正则假阴性（前三次见交接文档那条「数一个集合要先和工具自己打印的分母对账」）。
   ⇒ 这层的取消语义**就是**整条对端通道被关（断线 / 退出 / worker 崩），两个出口各有具名用例
   （`a_retiring_old_worker_does_not_kick_the_new_one`、`worker_exits_and_unregisters_after_shutdown_and_panic`）；
   "同一条内容不被排两次、跑完才放开"另有 `ServeTicket::Merged` + `queued: HashSet<cid>` 两件。
   产品那侧的"取消发送"从来不进这条队列（走 `send_file_from_path_at` 内部那条 `cancel_rx`，
   由 `file_cancel_keys_are_scoped_per_recipient` 等钉着）；
⑤ 版本号、提交、tag、发布一律**未做**（合同：停在可审查的结果上等他拍板）。
   现状请现读，别抄这里的数：`git status --porcelain | wc -l`（脏路径数）、
   `git log --oneline origin/main..HEAD | wc -l`（未推送提交数）、`git tag --points-at HEAD`（本轮没打新 tag，
   挂在 HEAD 上那个 `v4.37.1` 是 10-12 既有的）。

### 群聊那一半也修了：GroupAck 终于把「对端收到了」写进自己的库

同一句用户诉求（「加好友后电脑端发的群聊/单聊手机端收不到」）里，**群聊那半边不是投递失败，是发起方自己的终态从没落库**。
现场是只读现算他那份 `gosslan.db`（一个字节没写）：`group_outbox` **0 行**，而 **16 条群消息**
（9 text + 5 todo_update + 1 todo + 1 reaction）的 `messages.status` 永远停在 `sent`；
同一时段对端自己的已读标记 `group_reads.last_read_ts` 停在**最后一条本身**（12:36:19.873，也就是 `23f9e9d0…` 那一行）。
⚠️ 这一句原本只是"时间比较"，**证据等级不够**；10-13 深夜换成两条**正面读数**：
① 手机侧的入站行（`gossip.rs:684` 打的 `群消息@输入 msg=<id>`）与电脑侧 `群消息已回送本机窗口 msg=<id>`
   逐 `msg_id` 求交集 = **11 条正面命中**（这些条手机确实处理到了）；
② 更要紧的是那个标记**不是对端自报的时钟** —— 现读 `handle_group.rs:33-46`：它是拿回执里的 `last_read_msg_id`
   **回查本机 `messages` 表**（限 `sender_id = 本机 AND conv_id = 'group:<gid>'`）取那条的 `ts`，
   而 `1791808579873` 正是本机库里 `23f9e9d0…` 那一行自己的 ts ⇒ **对端点名了它 = 它收到了这条**
   （同批更早的 4 条按 ts 顺序渲染，也在它的视野里）。
⛔ 同时记一条纪律（我在这条上翻过一次车）：用户给的是**节选日志** —— "这件事一旦发生就必然打"的
   `[ACK] 已持久化 ⇒ 回执` 在两半都 **0 条**，而电脑库里有 26 条 `delivered`/`read`（只能由回执点亮）
   ⇒ 这份日志必然不完整 ⇒ **"手机日志里少了 5 条"这种缺席型读数没有证明力**（我中途据此判过"那 5 条没送达"，已作废）。
⇒ 队列行不是被超时清扫器删的（`finalize_expired_message` 判失败会同时写 `failed`），而是被 **GroupAck** 删的
⇒ **对面真收到了**，缺的只是本机这一次写入（⚠️ 这句现在**只覆盖群聊那 16 行**；
"真没送到"的是另一族 —— 电脑库里那 **6 条显式终态 `failed` 的 1:1 文本**。
   （等级要说准：`failed` 是**发送侧**的正面读数 —— 120 秒没等到回执，比日志缺席硬一档；
   而"手机那侧当时到底处理没处理"在本机无从直读，靠的是机制推断 —— 手机 20:36:11 起 7 轮满额 15 秒
   `offer TIMEOUT`（这 6 条的发送时刻 20:36:23–25 正落在区间里）+ 回执从没回来过。两半合起来才是这条结论。）
旧形状里 `handle_group.rs` 的 GroupAck 臂只「删队列 + emit 前端事件」，
而前端的 `onMessageAcked` 只在内存里 advance 一次 ⇒ **一重启就退回单勾**，用户读成"收不到"，
而本仓的不变量写着「消息状态的唯一真相源是 `messages.status`」（INV-006/P15）。

★ **归因后来在同一张表里拿到了一条天然对照**（2026-10-13 只读现算，比"推断"硬一档）：本机自己发的群消息按
`msg_id` 前缀分成两族 —— **7 行 `gfile-*`**（群文件气泡，终态由**文件完成那条写入点**点亮）全部 `delivered`，
**16 行十六进制 msg_id**（9 text + 5 todo_update + 1 todo + 1 reaction，终态**只有** GroupAck 那条路能点亮）
全部停在 `sent`。⇒ 同一时段、同一个对端、同一张表，走"另一个写入点"的那族前进、走 GroupAck 的那族一条没动 ——
缺的正是这一处写入，而不是"消息没投递出去"。复跑：
`sqlite3 -readonly ~/Library/Application\ Support/com.gosslan.app/gosslan.db "SELECT kind,status,substr(msg_id,1,7),COUNT(*) FROM messages WHERE conv_id LIKE 'group:%' AND sender_id='gosslan-3c3a50b7f85a4' GROUP BY kind,status,substr(msg_id,1,7);"`（21 组）
（`gossip.rs:577` 那条 `set_message_status` 是 **1:1** 的 ChatAck（守 `outbox` 表），不碰群行 —— 别把它读成群的第二条写入路径）。
⚠️ 同一份库现在（10-13 现读）仍是 **14 行 `receive`/`incomplete` + 这 16 行 `sent`**，且文件 mtime 停在
**10-12 20:30** ⇒ 带修复的那份他**还没跑过**，"自愈"那条预测尚未被真机验证。

- 修法口径**逐字照抄 1:1 那一臂**：`db::set_message_status(&dbc, &msg_id, "delivered")`，
  它的 `WHERE status NOT IN ('read','delivered','recalled')` 自带"只前进不回退" ⇒ 第二个成员后到的 Ack
  不会把已经 `read` 的行退回 `delivered`；也没有引入"按成员数聚合"的新语义（前端本来就是收到任一 Ack 就 advance）。
- ★ 这一条同时把既有那条「不许被判成 failed」照出是**半个守卫**：它禁的是 `failed`，
  对"停在 `sent` 不动"完全无感 ⇒ 补的是同一条队列的另一半读数，不是把同类检查再数一遍。
- **判据两条**：Rust 侧形状判据 `group_ack_advances_sender_message_status_like_dm_ack_does`
  （带**阳性对照**：先断言 1:1 那一臂这次写入还在，否则"两边都没有"的世界里判据会假绿）——
  先跑出真 RED：群侧那条在 `lib_delivery_shape_tests.rs:596` panic，对照那条同时通过；
  跨实例侧在群聊轮补一条「A 侧这几条群消息的终态必须由对端 GroupAck 点亮进真库」⇒ 群聊轮现算 **37 条断言**。
- 三面实测（同一份判据）：旧二进制 ⇒ **恰好 1/37 红**，实际值就是用户库那个形状
  `["sent","sent","sent","sent","sent","sent"]`（`test-results/run-2026-10-13T11-00-05-132Z`，其余 36 条照绿）；
  新二进制 ⇒ **37 条全绿**（`run-2026-10-13T11-01-19-596Z`）；反向 `--round=group-lie` ⇒ **`9/37`，红数没涨**
  （新那条读真 id ⇒ 反证档里照绿，`run-2026-10-13T11-01-33-639Z`）。
- 基线：新增 1 条 Rust 用例 ⇒ `check-test-manifest.mjs --update` + `--sync-baselines` ⇒ macos **826** / windows **814**；
  `cargo test --features bluetooth --lib` **826 passed / 0 failed**，`cargo fmt --check --all` 与项目 clippy 门各退 0。
  这一刀落地后**两层门禁都重跑过**（不是沿用上一节那次数）：`npm run verify` **17 步全绿、退 0**；
  `npm run verify:full` **23 步全绿 / 退 0**（含 89 条护栏非空转注入与 Android 编译）。
  之后那条 30 秒判据被推翻、跨实例轮补到 11 格 ⇒ 两层又各跑第三遍：**17 步退 0 / 23 步 1014.6s 退 0**。
  注入跑完再逐处现读：本轮 8 个标记每处仍恰好命中它自己的文件 —— `set_message_status` 那条命中 1:1 与群两处，
  正是判据要钉的「两臂口径一致」那个形状。
- **运行时层（macOS 真 WebView 无障碍树）对着重编后的产物各跑了一遍**（`npm run -s verify:ax` 退 0：
  内容树挂上 `AXWebArea=1`、节点 33、带可访问名 18、可操作控件 12 按钮 + 1 输入框）。
  这一层读的是 `src-tauri/target/release/gosslan`（mtime 现读 2026-10-13 20:50:23），那份二进制里
  `strings -a … | grep -c` 现算三个 ASCII 标记各为 **1**：`content_serve_full`（A 段每对端串行队列）、
  `inbound_head_of_line`、`file_accept_no_waiter`（④ 那条迟到应答诊断）⇒ "启动没被本轮改动弄坏"这一条
  现在覆盖的是**含本轮 Rust 那一侧**的构建，不再只是界面侧改动。
  ⚠️ 同时记一条量具痕迹，防下一次误判成"源码又被动过"：跑完之后 `src-tauri/src` 下有 5 个 `.rs` 的 mtime
  晚于那份二进制（现读 21:35–22:06），其中 `commands/channel.rs` / `commands/favorites.rs` /
  `commands/settings.rs` 按 `git status` 是 **clean vs HEAD** ⇒ 那是护栏注入器把原文**逐字节写回**的脚印
  （时间戳新、内容未变，`npm run verify:full` 的注入那一步跑完就是这个形状）。它的后果只有一个：**直接**
  `npm run test:e2e:*` 那条路上那道前置门会拒跑（`scripts/e2e-multi-instance.mjs:339-370` 现读 ——
  它的"只是 mtime 抖动 ⇒ 放行"那条豁免要求 `src-tauri/src` 与 HEAD **内容完全一致**，而本轮工作区脏
  （条数**别抄**，现算：`git status --porcelain | wc -l`；其中 `git status --porcelain -- src-tauri/src | wc -l` = **16** 个 `.rs` 未提交 ⇒ 豁免那条路走不到，只能拒）。而 `npm run verify:e2e`（local 组）不受影响：
  它自己第 1 步是 UI 运行时探针、**第 2 步就是 `cargo build --release --features bluetooth`**
  （`scripts/verify.mjs:581-594`），编完二进制自然最新 ⇒ 单跑一轮之前先重编；
  若重编是 cargo 的 no-op、二进制 mtime 原地不动（项目记忆里记过这个形状），
  再加一句 `touch src-tauri/src/lib.rs` 逼它重链。**别放宽那道门。**
- ⚠️ 仍**没**判的一格：用户那 16 行在他下次启动带修复的版本**之前**不会自己前进（这一刀修的是"以后"，
  不是历史行的回填 —— 回填要决定"已删的队列行算不算收到过"，那是另一个决定，没做也不假装做了）。

### 附件日志里那条 `window.destroy not allowed`：预览窗不再让依赖替它销毁窗口

用户那份电脑端日志（2026-10-12 20:27:39）有一条 `[前端 rejection] window.destroy not allowed.
Permissions associated with this command: core:window:allow-destroy`。它在我们的源码里查无此调用
（`grep -rin destroy src/` 现算 **0 命中**），根因在依赖的实现里 —— 现读 `dist/assets/tauri-*.js`
（@tauri-apps/api **2.11.1**）：`onCloseRequested` 的包装是
`await handler(l); l.isPreventDefault() || await this.destroy()`
⇒ **handler 不 `preventDefault()` 就等于授权库去销毁那扇窗**。全 `src/` 里注册 close-requested 的只有
`PreviewWindow.vue` 一处（分母现算），而它当时写成 `() => releaseAlbum()`，没拦。

- 为什么这是缺陷而不是"一条无害噪声"：Rust 那侧 `install_hide_on_close` 是 `prevent_close() + hide()`
  （那条形状判据在 `lib_window_tests.rs:618`）⇒ 预览窗**关闭即隐藏、常驻**，设计上从不该被销毁。
  眼下它靠"能力表里没批 `allow-destroy`"才没被销毁 —— **设计挂在一条没批的权限上**：
  哪天有人为别的目的放宽这条，第二次看图就不再秒开、还得重建整扇窗，而界面上不会有任何提示。
- 修法**一行**、不动权限：handler 里先 `event.preventDefault()` 再放相册（与 Rust 那半边的语义一致，
  不是新行为）。`src-tauri/capabilities/default.json` 现读仍**不含** `core:window:allow-destroy`。
- 判据：`src/utils/previewHosting.test.ts` 新增「注册了 close-requested 的窗口必须 preventDefault」。
  形状是"扫全 `src/` 找注册点 → **分母现算**（`>= 1` 才继续，扫不到就是空转）→ 按**括号配对**切出那一次调用整段
  （不用定长窗口，那会跨进邻居规则）→ 要求段内出现 `preventDefault()`"。
  两面当场实测：**改之前真 RED**（报错点名 `components/window/PreviewWindow.vue` 那一处），
  **改之后该文件 4/4 绿**；快速层 `npm run verify` **17 步退 0**，`npm test` 现算 **959/959/0**。
- ⚠️ 口径边界两条：① 判据只认**内联** handler，改成具名函数会红（报错里写了那时该怎么办，不许放宽成"文件里出现过就算"）；
  ② 这一条**没有**真机证据 —— 快速层里没有任何一层会启动 WebView 去点那扇预览窗，
  所以"rejection 从此不再出现"是**依赖源码 + 源码形状判据**的结论，不是运行时读数。
  ⚠️ 归属：这一刀改的是**前端**。当时（写这一节时）`target/release/gosslan` 还是 20:50:23 那份、不含它；
  **现已重挣** —— 23:46:26 那份新二进制的嵌入口径是 `dist/index.html` mtime **23:30:06 < 23:46:26**，
  且 `dist/assets/preview-*.js` 里 `preventDefault` 现算 **1**；对**新产物**重跑 `npm run verify:ax` **退 0**
  （`AXWebArea=1` · 节点 33 · 带可访问名 18 · 12 按钮 + 1 输入框）。
  ⚠️ 但它依旧只到"控件树读得到、启动没被弄坏"这一格：界面对不对、✕ 实际效果、键盘出口仍归人工（工具自己的三条边界）。

### 「打开添加好友」不再为 macOS 那条本来发不出去的 limited 广播刷 WARN（4.18.5 那条规则补上漏掉的另一臂）

把用户两端日志**逐条**过完（29 行 WARN/ERROR / 9 种形状）之后，剩下这一条是**能修**的：他 Mac 端
20:26:13 / 20:26:21 两条 `diag/broadcast_error: target=255.255.255.255:59991, error=No route to host (os error 65)`，
而同一批日志里 `diag/bc_directed` 每一轮都成功。

- **不是"网络坏了"**：4.18.1 早就记过根因（`docs/notes/changelog-archive.md`，socket 绑具体网卡 IP 时
  向 `255.255.255.255` 发会 `EHOSTUNREACH`，精确子网地址才是能用的那条），而 4.18.5 为此定了一条口径
  ——「子网广播成功时不再为 limited / multicast 的失败刷告警……原先每 5 秒两条 WARN 持续数分钟，
  把真正有用的信息淹掉了」。**问题是这条口径只落在了 `broadcast()` 一臂上**：
  `broadcast_probe()`（用户点「添加好友」时那次 who_has 探测）无条件推 limited 的结果 ⇒
  每次探测留一条 WARN。同一条规则的**另一个面**在"已改"那行底下继续漏 —— 日志环只有 500 条，
  淹掉的是诊断历史本身。
- 修法：`broadcast_probe()` 与 `broadcast()` 走同一个门（同一函数里先算 `directed_ok`，
  limited 的留痕包进 `if !directed_ok`）；**不改**协议、不改广播目标、不动权限。
- 判据：`broadcast_diag_suppression_covers_both_send_paths`（`lib_compat_gating_tests.rs`）——
  阳性对照钉"已经合规的那一臂必须被同一把尺子认成合规"（否则"两臂都没抑制"的世界里判据会假绿）、
  新钉那一半按 `rust_fn_body` + `code_flat` 取体（注释里复述规则不算数）、
  分母是 `let directed_ok =` 在整个文件里必须恰好 **2** 处。
  两面当场实测：**改前真 RED**（`lib_compat_gating_tests.rs:309` panic，报的就是探测那臂没抑制；
  对照那条同时通过 ⇒ 尺子本身是好的）；**改后** 该用例绿 + `cargo test --features bluetooth --lib`
  **827 passed / 0 failed**（其中按 `discovery` 过滤的 22 条全绿）+ `cargo fmt --check --all` 退 0
  + 项目 clippy 门 `--features bluetooth -- -D warnings` 0 条。
- 基线：新增 1 条 Rust 用例 ⇒ `check-test-manifest.mjs --update` + `--sync-baselines` ⇒ macos **827** / windows **815**
  （⚠️ 这只有那一刀；同一晚再往后受众闸那一格又 +6 ⇒ 最终树现算 **macos 833 / windows 821**，
  数一律现读 `wc -l src-tauri/test-baseline.macos.txt src-tauri/test-baseline.windows.txt`，别抄本行）
  （两条都按"上一版 + 这一条"现推，差额仍由源码门控背书）；快速层 `npm run verify` **17 步退 0**。
- ⚠️ **这条没有真机读数**：它是"日志里不该出现的那一行"，本机跑不出用户那台 macOS 的探测时序，
  所以交付形式是**源码形状判据 + 他日志的既有形状**，不是运行时对照。
  ★ **归属已重挣**（这一刀改的是 Rust 生产码 ⇒ 按"改动落在哪层就重跑哪层"整条链重跑，四步退码逐条现取）：
  `npm run verify:full` **23 步退 0**（第 22 步 = 89 条护栏非空转，第 23 步 = Android
  `cargo check --target aarch64-linux-android` 0 warning）→ `cargo build --release --features bluetooth` **退 0**
  （新产物 mtime 现读 **23:46:26**；`find src-tauri/src -name '*.rs' -newer <二进制>` **为空** ⇒ 它是最新那份）
  → **内容拉取轮 32 条全绿**（`run-2026-10-13T15-46-26-618Z`）→ **群聊轮 37 条全绿**（`run-2026-10-13T15-47-19-313Z`）；
  新产物里 `content_serve_full` / `inbound_head_of_line` / `file_accept_no_waiter` 三个标记现算各为 **1**。
  ⚠️ 一次量具自纠：我本想用 `strings -a <二进制> | grep -c 'plugin:window|destroy'` 证明预览窗那刀进了二进制，
  读数是 **0** —— 那**不是**"没编进去"，而是 JS bundle 在 Tauri 里压缩嵌入、`strings` 读不到 JS 字面量。
  换两条能证的：`dist/assets/preview-*.js` 里 `preventDefault` = **1**，且 `dist/index.html` mtime
  **23:30:06** 早于二进制 **23:46:26**（这份 dist 确实被嵌进了那次编译）。
- 清账里其余各条的下落（手机端后台广播被拒 = 系统行为、回前台 **20:35:56** 自愈；
  `好友同意回执补发结束` = 有界补发设计内、对面 **20:26:29 已收到**第一帧；
  BLE 三条 = 平台边界 + **他手机上「附近的设备」权限没给**；`ResizeObserver` 两端各一条 = 良性噪声）
  逐条写在 `AI_TASK_HANDOFF_CURRENT.md` 的「附件两端日志的 WARN/ERROR 全量清账」那一节，含复跑分母的脚本。

### 「谁能按 cid 取走内容」那道闸从臂里搬进纯核，并第一次有了 5 + 1 条判据

台账里原先有一条写错定位的欠账：「群成员作为种子被拉 = `find_source` 的群分支没有跨实例判据」。
现读 `content/store.rs:173-188` ⇒ **`find_source` 没有群分支**，它的谓词只有 `cid=?1 AND path IS NOT NULL`（"拥有"那一半）。
群成员那一臂在 **`handle_share.rs` 的授权闸**里，而它当时长在 `async` + 两道锁中间 ⇒ **五条边界一条都测不到**。

- 按本仓三条既有先例（`friend_accept_flush_decision` / `diag_event_from_send_result` / `should_keep_peer`）
  把判定抽成 `content_serve_allowed(is_friend, source_group_id, group_members, requester)`。
  ⚠️ **只搬判定、不改信任策略**（合同明写本轮不动加密与身份信任）：四种输入组合逐条与旧写法对照过 ——
  好友放行 / 非好友但内容所属群里放行 / 群行已不在 ⇒ **拒** / 内容没挂群 ⇒ **拒**，语义一字未变。
- 新增 `network::transport::content_serve_gate_tests` **5 条**：`friend_is_allowed_without_any_group`、
  `group_member_is_allowed_without_being_a_friend`（= C 从已收完的 B 拉这一格）、
  `stranger_in_another_group_is_denied`、`missing_group_row_is_denied`（写反成 `unwrap_or(true)` 就等于删群后陌生人还能取）、
  `non_friend_without_group_binding_is_denied`。
- 再加接线判据 `content_request_serve_gate_delegates_to_the_pure_kernel`（`lib_compat_gating_tests.rs`）：
  臂里必须恰好**一处**委托（分母取臂内计数，不数整文件 ⇒ 以后加用例不会碰红）、
  反面钉旧形状签名 `unwrap_or(false)`、阳性对照要求纯核定义本身在场（防"两处一起删掉"假绿）。
- **三条单点变异当场跑过**（有断言 ≠ 被证明会失败）：
  M1 兜底臂 `_ => false` → `true` ⇒ 恰好 **2 红**（两个"该拒"的边界），余 3 绿；
  M2 成员判定改恒真 ⇒ 恰好 **1 红**（`stranger_in_another_group_is_denied`），余 4 绿；
  M3 把判定**抄回臂里**（旧形状）⇒ 恰好**接线判据那 1 条红**（`lib_compat_gating_tests.rs:335`），5 条纯核单测全绿
  —— 这正是"只有单测没有接线"会漏掉的那一格。三次之后都从 /tmp 备份原样拷回，
  `diff -q` 现验**文件与备份逐字节相同**（不是"我觉得改回来了"）。
- 读数：`cargo test --features bluetooth --lib` **833 passed / 0 failed**（827 + 5 + 1），`cargo fmt --check --all` 退 0，
  `cargo clippy --features bluetooth -- -D warnings` 0 条；基线走工具出口 `--update` + `--sync-baselines`（只往上抬，无名字消失）；
  `npm run verify` **17 步退 0**。
- ⚠️ **跨实例那一格仍欠，但欠的东西变了**：不再是"判据本体没写"，而是**夹具要第三个实例** ——
  现读 `core.mjs:203` `INSTANCES = [1, 2].map(…)` 恰好两个，且互为好友由公共播种写入（`core.mjs:495` 的
  `INSERT INTO friends(…)`）⇒ 内容拉取轮现在走的是闸的**第一条臂**（好友放行），群成员那条臂在跨实例层还没走过。
  （那一轮的 `ContentRequest` 是生产侧 `retry_incomplete_content` 自己发的，不是手搓帧 ⇒ 测的是真接线。）
- 顺手补了契约图两处（`docs/ARCHITECTURE-MAP.html`）：`group-message-acked` 那行原来只写"删掉那个成员的
  group_outbox 行" ⇒ **图本身记录的就是 A-15 那个错形状**；`request_content_by_cid` 节点补上"服务侧不许在入站
  循环里 await 整条握手 + 每对端一条有界串行队列 + 受众判定在 handler 不在 `find_source`"。
  ⚠️ 这张图的 125 KB 内联 JS **没有任何门禁解析**（`arch-map-stats.mjs` / `check-doc-numbers.mjs` 都只做正则取数）
  ⇒ 改完自己跑 `node --check`（退 0），否则插一个未转义引号会**门禁全绿而图打不开**。

### 一处自造红（记下来防再犯）

本轮往 `scripts/guard_cases/frontend_ui.py` 加了 4 条非空转用例（**锚定口径现算**：
`grep -c '^    Case(' scripts/guard_cases/frontend_ui.py` ⇒ **49 → 53**；不带行首锚会多算一条，
因为该文件自己的说明行里就写着这个命令 —— 同批把那句"本册现数"从 49 改到 53），
护栏套件跑完只这一条红，且红得完全应该：`docs/ARCHITECTURE-MAP.html` 手写的
「护栏非空转用例 227」被现算成 231 ⇒ **加/删用例必须同批改那张图**。按该判据自己给的口径处理
（判据 E 这类"文档要给人看一个现状数"→ 改成现算值），并把 4 条用例的两种缺陷口径、
以及 `designGuards.ts` 里 ㊳ 第⑤条**原来只剩半句话**的报错文案一并补全。

## [4.37.1] - 2026-10-12

### 内存：图片预览缓存有硬封顶了，气泡不再整份加载原图

用户报桌面端主窗口 WebView2 进程 **601.7 MB**（进程组 781.4 MB / 8 进程）。排查后定位到两条确定的放大器，
本条修的是其中较大的一条 —— 图片预览缓存。

- **缓存按「累计字节数」封顶 60 MiB**（单张仍 ≤15 MiB，逐出时 `revokeObjectURL`）：
  原先那份 `Map` **既没有容量上限、也没有真正的回收出口**，条目里挂着的 objectURL 只增不减；
  条数这个维度本来就管不住内存（单张上限 15 MiB，取 K 张最坏是 K×15 MiB），
  且实测缓存条目自身的 V8 成本与喂进去的字节数无关（200 条只 +35 KB）⇒ 只能按字节封顶。
  新抽象落在 `utils/blobLru.ts`（两份预览缓存共用，LRU 命中重排、逐出/删除/清空/覆盖四条路都 revoke）。
- **修掉一处确定性泄漏**：`invalidateFilePreview` 原先只 `cache.delete` **不 revoke** ——
  每次失效都丢掉最后一个指向那条 objectURL 的引用，而 Blob 那坨字节永不释放。
- **生命周期联动**：会话被整块逐出（`MAX_CACHED_CONVS`）、清除数据（`clearAllData` / `resetAfterDataCleared`）
  都会释放对应预览；收藏面板关闭时释放那份独立缓存（原先只在「删单条收藏」时释放）。
- **气泡改走缩略图**：208px 的气泡不再吃 15 MiB 原图，改为解码后按需生成宽 ≤416px 的 JPEG（q85）；
  **GIF 不压**（保动画）、HEIC/解码失败/小图一律**静默回退原图**，任何失败都不阻塞发送与显示；
  点大图仍然读磁盘原图（`ImageLightbox` 走的是另一份缓存，缩略图只服务气泡）。
- **砍掉无收益的启动期常驻**：不再预热群任务窗（它 `AUX_TASKS_RESIDENT` 常驻 ⇒ 启动预热纯属白占约 23 MB；
  首开群任务付一次 1–2 秒，之后照旧秒开）。图片预览窗预热保留。
  ⚠️ 同步更正了 `prewarm_aux_windows` 注释里一句**过期表述**（旧话说「群任务窗 label 是 `todo-<groupId>`、
  预热没有确定性」——label 早就是固定常量 `WINDOW_TASKS`，理由不成立但结论仍成立，已改为收益口径）。

### 弹窗：窗口显示安全区（卡片不再被自绘标题栏压住）+ 滚动条留白

用户报「卡片弹窗顶部被自绘窗口标题栏压住」，并要求「窗口头部不是可显示区域，**所有窗口统一做好显示安全区**」。

- 新增全局变量 `--gosslan-window-safe-top`：桌面 = 自绘 caption 高度（Win 38px / macOS 28px 随平台自动切），
  移动端 = **0**（移动端没有 caption，靠 `env(safe-area-inset-*)`）。判据用 `html:not(.is-mobile)`
  而**不是** `.platform-mac` —— 后者只覆盖 macOS，Windows/Linux 桌面会拿不到安全区。
- `BaseModal` 卡片形态：遮罩层与滚动层顶部让开安全区，卡片 `max-h` 相应扣除（保留 `my-auto`，
  不许改回 `items-center` —— v4.37.0 已修过一次「超高内容顶部溢出到不可滚区」）。
- **补上一处漏掉的窗口**：`ImageLightbox` 的 `topInset` 原先只有独立预览窗在传，
  **主窗**那个全局实例一个都没传 ⇒ 桌面端整层铺到 (0,0)，右上角「保存/关闭」被 z-[85] 的 caption 压住。
  现在它默认读全局安全区变量（显式 prop 仍优先），主窗与预览窗一起成立。
- 滚动条留白：内容区右侧加 `--gosslan-scroll-gutter`（8px）。Win/Linux 那条常显 6px 细滚动条落进这段留白；
  macOS 是系统 overlay（不占宽）⇒ 只作呼吸感，两侧视觉仍对称。
- 同步核过其余 `fixed inset-0` 浮层（ActionSheet / GroupTasksBoard / TodoPickField / FavoritePanel /
  MobilePageFrame / MessageItem）：**逐格判定后确认不需要改** —— 它们是不可见的点击捕手、
  `aria-hidden` 遮罩、行内点击层或移动端分支，让位反而会留出点不着的缝。判定依据写进了
  `designGuards` ㊱ 的注释（第一版把 `absolute` 与"看不见的层"都算进分母，真实树报了 7 个、只有 1 个是真的）。

## [4.37.0] - 2026-10-12

### 好友重装/换新包后密钥变更：聊天内就地恢复，不用再删好友重加

- **场景**：对端卸载重装应用（或安装新包）后身份密钥重建，旧绑定导致双方消息、文件全部发不出去，
  此前只能「删除好友 → 重新添加」，某些情况下还必须重启应用。
- **换钥横幅**：后端在对端用**新私钥签名的 Hello 自验签通过**、但新公钥与 friends 表绑定不一致时，
  为仍是好友的对端登记一条「换钥候选」（纯内存态、同一对候选只提示一次）；单聊顶部出现黄色横幅，
  并在观察到新候选时实时推送（TCP/LAN/BLE 三条握手路径共用同一验签入口）。
- **同步新密钥（用户显式确认）**：横幅按钮 → 二次确认弹窗（明确提示自验签不能排除冒名、需带外确认是本人）
  → 两把身份密钥覆盖落库 + 清掉内存 peers 旧绑定，下一次握手即恢复，聊天里留一条系统提示；
  无法确认是本人时，横幅上可直接「删除好友」（沿用既有二次确认口径）。
- **安全**：绝不自动覆盖公钥（自动覆盖 = 任意同 device_id 的自报公钥都能冒充好友，E2EE 被击穿）；
  未签名的 UDP 广播冲突不登记；同步前复查候选存在与好友关系；只允许覆盖式写库走用户确认路径，
  原有「只填空、绝不覆盖」语义保持不变；删除好友与收到对方解除关系两条路径都清候选。
- **契约**：新增命令 `get_friend_key_rotations` / `sync_friend_keys` 与事件
  `friend-key-changed` / `friend-keys-synced`（已登记契约图 CMDS/EVENTS）；Rust 侧新增 3 条形态守卫
  与 5 条非空转注入用例。

### 修复：任务详情等长弹窗顶部被遮挡、滚不出来

- **根因**：BaseModal 卡片形态用 flex `items-center` 居中，内容高于视口时卡片顶部溢出到滚动容器
  可达范围之外（WebKit/Blink 经典 flex 居中坑）—— 任务详情很长时头部一块永远被挡住，只能往下滚。
- **修复**：改用 `my-auto` 居中 + `max-h` 约束，标题栏（含关闭按钮）固定、仅内容区滚动，
  再长的弹窗从头部到底部全部可达；全体卡片弹窗一起生效。

## [4.36.0] - 2026-10-12

### 群任务：做不了状态、全员操作记录、自定义类型、优先级图标形象化

- **新增任务状态「做不了」**（线值 `impossible`）：与「完成」同族的终态 —— 不进未完成徽标、
  首次标记记权威时间、满 7 天自动归档；发起人与被指派人都可设置，**发起人看到后可以手动归档**
  （归档门由「仅完成」放宽为「完成/做不了」），任何群成员也能从归档把它还原回待办。
  状态表 4 → 5 档（待办/进行中/延期/做不了/完成），看板新增独立分组（XCircle 中性灰图标）；
  创建人会收到「你创建的任务被标记为做不了」的提示，与原有的「已完成」提示同一条静默通道。
- **任务详情新增「操作记录」**：不新增协议字段、不动数据库 —— 直接从这条任务的全部
  `todo`/`todo_update` 事件逐帧 diff（创建/改标题/改描述/状态/优先级/类型/指派进出/归档/还原/删除），
  全员的每一次操作带操作人昵称与时间、最新在前。
- **任务类型支持「自定义…」**：类型三档扩为四档（任务/需求/缺陷/自定义），自定义名限 20 字、
  服务端校验非空与长度（非自定义档自动清空残留名），编号字母统一 `C`、行首通用 Tag 图标；
  自定义名随任务定义 LWW 同步，老对端不认识时沿用不抹平（与 priority/category 同一套 absent carry）。
- **优先级图标形象化**：紧急 = 闪电 Zap、常规 = 一横、不急 = 双下箭头（看板行首）。
- **跨语言契约与护栏**：TS/Rust 两张状态/类型表由 `messageKinds.test.ts` 逐项比对；
  Rust 侧归档/还原/认领三条成员窄档新增 `custom_category` 逐字比对，夹带改名过不去；
  新增 6 个 TS 用例与 4 个 Rust 用例。

### 修复：自己发的和对方发的图片都打不开（预览回归）

- **根因**：10-10 的 6853680 给消息行所有 `<img>` 统一补了 `loading="lazy"`，但图片气泡这张图
  在自己的 `@load` 触发前一直被 `hidden`（display:none）藏着 —— 懒加载只对参与排版的图发请求，
  display:none 的懒加载图永不发请求，于是状态永远停在加载中、5 次退避后显示「图片加载失败」，
  点击也只走重取、不开预览（自己发/对方发共用同一气泡组件，所以全挂）。
- **修复**：气泡图改回 eager（保留 `decoding="async"`，滚动性能不受影响 —— 虚拟列表本就只挂载
  视口附近的行）；新增静态锁（`img-eager-ok` 豁免白名单钉死只许 ImageLightbox 与
  MessageImageBubble 两支）+ 6 条真浏览器回归探针（有效 data URL 必须首轮 loaded、
  点击上抛 open、lazy 加回即红）。

## [4.35.2] - 2026-10-11

### 群任务实时刷新修复 + 任务卡片三个点击区域分离

- **修复：独立「群任务」窗口打开期间不实时刷新**。根因是数据源切换漏改一处：
  看板早在 51dac87 改成折叠全表读的 `groupTodoRows`（不再吃有上界的消息缓存），
  但独立窗口的 `message-received` 订阅（d0fff98 建）去抖后仍只重载 `messages` ——
  事件收到了、IPC 也发了，看板却一动不动，只有切走再切回（焦点兜底的全量重读）
  才更新。现在订阅去抖后以 DB 为真相**整表重读这一个群的任务行**
  （新增 `reloadGroupTodoRows`，与首屏读共用 StaleGuard 键）：其他成员新增任务、
  改标题/内容/负责人/状态、完成、归档都在 150ms 合并后落到看板；重复帧、乱序帧、
  重连补发只作为重读触发，不会产生重复任务、幽灵任务或旧状态回滚；更新不重置
  用户的筛选与已展开的详情；unlisten 后事件彻底失效，无残留订阅。
  应用内弹窗（移动端/桌面窗口创建失败回退）原本就随主 store 的批量合并实时更新，
  本轮补上的是桌面默认路径那扇独立窗口。
- **修复：群聊里任务卡片的点击区域只有底部按钮一处**。现在严格分成三个互不重叠的区：
  ① 卡片**底部操作条**点击仍直达**这一条任务**的详情（带 todo_id）；
  ② 卡片**主体**（头部/描述/指派人）点击只打开群任务面板，不直达某条，键盘 Tab +
  Enter/Space 同样可达（全局焦点环），描述里的 URL 链接只走外部打开、不弹面板；
  ③ 卡片里的**图片缩略图**只开统一图片预览，点击/键盘都不会冒泡成开面板或详情。
  未给整卡盖透明点击层，普通图片消息、合并卡片与其他消息行为不变。
- **测试**：UI 运行时探针新增「群任务看板实时同步」14 条行为判据
  （真浏览器挂真看板，从后端事件方向推 message-received，验证新增/改名/完成/归档/
  计数/去抖合并/旧帧不回滚/订阅可摘/重订阅自愈/重开与持久化一致），任务卡场景新增
  三区域鼠标+键盘+链接+图片 6 条（探针 212 → **231**）；两类新增判据均做了
  「改坏必红」的变异反证；双实例任务专项 E2E（`--round=task`）49 条断言在按当前
  源码重编的 release 二进制上全绿。

## [4.35.1] - 2026-10-11

### 强提醒复审加固：1:1 目标真实性、跨平台编译门禁与证据补全

- **修复：1:1 强提醒缺目标真实性校验**（此前只有群路径有）：发送侧现读消息表，
  remind 指向的原消息必须真实存在于本会话、remind_ack 指向的必须是本会话一行真实
  remind，否则明确拒发 —— 杜绝对方点开通知定位到「幽灵消息」。新增 Rust 形状护栏
  钉死这条出帧前校验（先压平空白再断言，防 cargo fmt 拆行导致假失败）。
- **修复：Windows / Linux 桌面通知在 `-D warnings` 下编译挂红**：通知组装函数的
  `extra` 参数只有 macOS 块读取（action 按钮文案），非 macOS 构建下是未使用参数；
  补零成本引用，双平台 clippy 全绿。同时把 `show_click_impl` 的参数统一为持有的
  `AppHandle`（三个桌面平台签名一致，Android 交叉编译形状不漂移）。
- **护栏：action 按钮只许挂在 macOS cfg 块内**：Windows toast / XDG 通知的正文点击
  本身就能回调，全平台加按钮会凭空改变每条通知外观且按钮成死键；新增前端接线守卫，
  按钮一旦移出 macOS 块即红。
- **修复：无 bluetooth 特性构建下 clippy 1.98 报 needless_return**（9 月既有代码，
  新版 clippy 加严后暴露）：`set_app_active` 改为「状态翻转才进入工作分支」，行为
  一字不变，两种特性配置 clippy 均零红。
- **证据补全（行为无变化）**：读 notify-rust 4.18 与 tauri-winrt-notification 0.7.3
  源码坐实 —— 应用从不设置 urgency，普通通知未指定声音时库输出
  `<audio silent="true"/>`（无声，既有行为）；强提醒显式指定 `Default`，映射为
  `Sound::Default`（输出空 audio 元素），由系统播放默认提示音。
- 4.35.0 小节所记前端测试终值「914」实为 **915**（898 → 915，净 +17），以本条为准；
  Rust 单测 803 → **804**（新增 1 条形状护栏）。

## [4.35.0] - 2026-10-11

### 强提醒（第 3 阶段）：发起入口、强提醒标识、系统通知与点击定位（首个用户可见版本）

前两个阶段（4.34.0 / 4.34.1）落了可靠性核心与群投递接线，本阶段把功能交到用户手里；
不新增数据库列/表/迁移，普通消息的未读 / 预览 / 发送状态一字未改。

- **发起入口**：自己已成功发出（sent/delivered/read）的文本、图片、文件、代码、
  合并转发、群任务、群公告、投票，右键菜单与移动端长按面板新增「强提醒」；
  自聊、发送中 / 失败 / 已撤回的消息不提供入口。1:1 默认提醒对方；群聊必须
  **显式勾选成员**（第一版绝不默认全群），弹窗里至少选 1 人才能发送。
- **气泡下方五态标识**：待送达 / 已送达 / 已提醒 / 已确认 / 发送失败，发起方看
  「最慢一台设备」的总览，群里悬停标识可看每台设备各自状态；接收方在未确认前
  显示「我知道了」，点一下才点亮 confirmed（S4 只能由用户主动触发）。
- **接收侧提醒链路**：绕过普通消息 1.5s 去抖合并，到达即提醒；按 remind msg_id
  会话内去重，重复帧 / 重连不重复响。群聊只对 actors 名单内、且**当前仍在群内**
  的成员生效（发起后被移出群不再被提醒）；总开关关闭、或正在前台查看该会话时
  不振不弹。S3「已提醒」自动回执与本地通知是否弹出严格解耦，不把通知 API
  成功当成对方已收到。
- **点击定位原消息**：桌面端点系统通知唤起窗口、打开会话并自动翻页定位到被提醒
  的那条消息；移动端经通知 extra 走同一路径。定位不到时明确 toast 提示，不静默。
- **macOS 点击通道补齐**（此前整条缺失，只有 Windows 能点）：notify-rust 的
  NSUserNotification 后端必须挂一个 action 按钮、同步投递才会真的等待交互；
  点横幅正文与点「查看」按钮都路由到打开动作；默认声音改用
  `NSUserNotificationDefaultSoundName`（传 "default" 会被当成不存在的声音文件）。
  按钮文案随界面语言，后端自发的好友申请通知同口径补上。
- **Android 强提醒专属通知通道**：High 重要级（横幅 + 锁屏可见），振动跟随
  应用设置（通道按开关创建，变化时 remove+create 重建，Android 不允许原地改振动）；
  通道没建成时退回系统默认通道，不让通知整条丢失。**声音的平台边界**：
  tauri-plugin-notification 2.x 的通道只能挂自定义 raw 音频、无法静音，因此
  Android 通道声走系统默认，由用户在系统通道设置里关（应用内声音开关只控桌面端），
  设置页文案已如实说明；振动只由通道承载，不再叠加 navigator.vibrate（否则震两遍）。
- **设置页新增两个开关**：强提醒声音、强提醒振动（iPhone 与桌面不支持应用内振动，
  文案如实说明）；两开关都受通知总开关统辖。设置组脚注如实告知：紧急通知的
  Dock 弹跳 / 任务栏闪烁不受系统勿扰开关影响。

### 平台边界（如实记录，未做虚假承诺）

- **iOS**：工程从未 `tauri ios init`，无构建目标，本轮不产出也未验证 iOS。
- **Android 后台**：未接前台服务（manifest 里只有模板注释），应用进程被系统
  回收后收不到任何消息级通知；强提醒与普通消息一样只在应用存活、链路连通时可达。
- **macOS 新通知框架**：仍走已废弃的 NSUserNotification（notify-rust 默认后端），
  通知归属与样式在 Ventura 之后的系统上可能显示为旧样式；切到
  UNUserNotificationCenter 需启用 notify-rust 的 `preview-macos-un` 特性，留待后续。

### 测试与验证（第 3 阶段新增/重跑的证据）

- 前端新增 `remindFlow.test.ts` 11 条接线守卫（受众门控 / 当前成员复核 / S3 与
  本地通知解耦 / 抑制矩阵 / 移动端权限+通道+msg_id / 桌面 opts / 双端点击路由 /
  发起入口状态门 / 折叠分发 / 受众弹窗）；`messageKinds` 补 2 条、`reminders`
  补 4 条边界（无发起行的回执、群全败才失败、1:1 格子自动补）。898 → 914 全绿。
- 修正群总览折叠与自身注释不一致处：原实现「任一设备 failed 总览即失败」，
  现按「全部设备 failed 才失败；部分有高证据时取非失败格里最慢的一相」。
- **UI 运行时探针 212/212 全绿**；顺带修复探针自身在 vite 6 下的假超时
  （启动横幅打到 stderr 且 "Local" 与 ":" 之间夹了 ANSI 码）。
- 改动后 Rust 单测、`cargo clippy --features bluetooth -- -D warnings`、
  `cargo fmt` 均零红（含无 bluetooth 特性的编译）。

## [4.34.1] - 2026-10-10

### 强提醒（第 2 阶段）：群提醒复用群消息内核，跨进程判据钉死

本阶段只落**离线投递与确认的接线**，仍无任何用户界面入口（发起入口、强提醒标识、
通知与点击定位在第 3 阶段）；不新增数据库列/表/迁移，普通消息四态一字未改。

- **群提醒复用已注册的 `send_group_message`**（新增 `remind` / `remind_ack`
  两个 kind 臂），与第 1 阶段 1:1 复用 `send_message` 同形 —— 不新增「注册但没人
  调用」的隐形命令（该门禁零容忍），也不新增协议消息类型。
- **「仅提醒指定成员」是载荷层语义**：群帧共享群密钥 + gossip 广播，物理上全体
  成员收到同一帧；只有载荷 `actors` 里点名的设备允许触发强提醒与回执，其余成员
  收到但不提醒。**第一版绝不默认全群。**
- **受众出帧前现读校验**：目标消息必须是本群时间线上真实一行；`actors` 按当前
  成员劈分（名单去重保序），空有效受众（含全部离群）一律拒发。
- **用户确认与传输 Ack 严格分层**：`remind_ack`（stage：`alerted`＝接收端已触发
  提醒处理；`confirmed`＝用户点「我知道了」）出帧前现读成员身份并要求 target
  是本群一行真实 `remind`；传输层 `GroupAck` 只删 outbox 行，不是确认也不是已读。
- **成员变化后受众跟着走**：移人 / 退群处理先删指向离群者的待补发 `group_outbox`
  再改成员表；本人被移出时群与群密钥一起清 —— 迟到的旧帧解不开、也不能确认。
- **已知边界（不是本阶段能消灭的）**：离线期间被移出的成员在收到治理帧之前仍
  持有旧群密钥、可能消费在途帧；多设备确认的身份聚合口径仍待负责人拍板（a/b）。

### 测试

- Rust 新增 3 条跨进程接线护栏（内核复用 + 受众校验 / 回执与 GroupAck 分层 /
  成员变化后的受众），800 → 803；无 bluetooth 特性同样全绿。
- **222 条全量非空转护栏在本阶段代码上重跑通过**（改坏即 FAIL、恢复即 PASS，
  裸退码 0），前端 898 条全绿，clippy/fmt 无告警。

## [4.34.0] - 2026-10-10

### 强提醒（第 1 阶段）：提醒身份、六态折叠、幂等与受众校验

本阶段只落**可靠性核心**，无任何用户界面入口（发起 UI、通知与消息定位在第 3 阶段）；
普通消息的发送/送达/已读/失败语义一字未改，也没有新增数据库列、表或迁移。

- **两种静默 kind**：`remind`（发起，载荷 `{target, actors}`）与 `remind_ack`
  （回执，载荷 `{target, stage}`），登记于 `protocol::WIRE_KINDS`（Silent：不进时间线、
  不计未读、不弹普通通知）与前端 `messageKinds.ts`；两侧清单由契约测试逐项比对。
- **六态折叠**：pending / delivered / reminded / confirmed / failed 由
  `src/utils/reminders.ts::foldReminders` 从消息行折叠；S3（alerted）只证明接收端设备
  已处理提醒，**不等于用户看到或确认**；S4（confirmed）只能由用户主动「我知道了」点亮。
- **只进不退 + LWW**：回执按 `(seq, msg_id)` 元组裁决，旧 seq/乱序/重放不能把
  confirmed 拉回；同一回执重复投递幂等；本地 failed 后若又收到更高证据（帧其实送到了）会翻案。
- **1:1 门控是承重件**：对端不声明 `FLEX_DM_KIND` 能力位时禁止发帧（2026-10-10 实测：
  不门控则旧端收到带未读的「[不支持的消息]」且无确认通道），本侧直接判失败、不排队撞门。
- **群受众校验**：`partition_remind_actors` 按当前在册成员把名单劈成有效/无效；
  第一版不默认全群，成员权限变化后必须重新校验。

### 测试

- Rust 新增 6 条（载荷解析/默认值、stage 校验、词表映射、Silent 分类、1:1 门控、受众劈分）。
- 前端新增 14 条 `reminders.test.ts`（六态、LWW tie-break、幂等、群每设备状态、失败翻案）。

## [4.33.43] - 2026-10-10

### 修复 #22：群主改名后的新群名现在会落到离线成员那行**已存在**的会话

负责人 2026-10-10 拍板"修复"，并把边界钉死：复用现有群资料更新机制、**只更新已经存在的会话行**、
不新增会话行、不改群关系同步语义、**不改协议也不改库结构**。落地就是这一条约束下的最小形状。

- 根因（现读，不是推测）：新群名**其实早就到了离线成员那台机器** ——
  `transport/pending_keys.rs` 重递群密钥时带的是**当前名**，`handle_group_key` 也已经校验过
  "只有群主能推"并把它写进 `groups.name`。**唯一没跟上的就是聊天列表那一行**（那是另一份去规范化出来的名字）。
  所以这不是"要不要新造一条同步机制"，而是"要不要把已经收到、已经认证过的那个名字落到会话行上"。
- 改法：`handle_group_key` 在 `upsert_group` 之后**复用 `db::rename_group`**（群主本机改名、改名帧到达、
  关系同步三条路共用这一个家，不在这里写第二份 `UPDATE conversations`）。
  它更新会话行用的是 `UPDATE` ⇒ **没有会话行时一个字都不写**，
  那条"关系同步 ≠ 聊天同步"的既有不变量原样成立。
  另加一道闸：只在帧里**真的带了群名**时才同步 —— 空名会走 `resolve_group_name` 的兜底，
  把「群聊 g-xxxx」这种占位名写进会话标题就是在制造新故障。
  （这一格还顺手暴露一个编译期事实：`group_name` 在构造 `display_name` 时已被搬走，判空必须搬到前面取 ——
  第一次编译就是 E0382 报的，不是后加的顾虑。）
- ★ **负责人点名要的反向判据，其实早就存在**（差点按旧记录重做一遍）：
  `db::group_rename_tests::group_relation_sync_does_not_create_conversation`（清库重装语义）与
  `existing_conversation_survives_group_relation_sync`（不删不重复创建），加上跨进程那一条
  `scripts/e2e/rounds/gcrash.mjs:140`「B 不许因为这个群凭空多出一行会话」。
  本轮**没有新造这一格**，只补了缺的那一半 —— **正向**：会话行存在时群资料与会话必须是同一个名字。
- 新增两条用例（`cd src-tauri && cargo test --lib` 现读 **778 passed / 0 failed**，裸退码 0）：
  ① `db::group_rename_tests::group_relation_sync_refreshes_title_but_never_creates_a_conversation`
  （一正一反同册：重装现场 conversations 必须还是 0 行；有会话时两处同名且仍只有 1 行）；
  ② `tests::group_relation_sync_updates_existing_conversation_title_but_never_creates_one` ——
  **接线判据**，读 `handle_group_key` 那个函数体自己：必须有 `db::rename_group(...)`，
  且函数体里不许出现 `ensure_conversation(`（那条不变量原先**只有一句注释**守着，现在它是判据）。
  为什么必须有第二条：①判的是 `rename_group` **会不会**做对，而 #22 的缺陷恰好是"**没人调它**"——
  任何"函数自身正确"的测试都发现不了。同 `group_keys_always_precede_group_messages` 那条的理由。
- 两次单点变异各红对应那一条（脚本跑完自己把现场还原并打印 `现场还原 = True`）：
  **M1 摘掉那次调用** ⇒ 接线那条 rc 101 红、行为那条**仍绿**
  （⇒ 两条判据不是彼此的别名，这正是接线判据存在的理由）；
  **M2 在函数体里塞进 `ensure_conversation(`** ⇒ 接线那条红。
- **不新增用户设置**：这条修复没有任何开关，行为变更本身就是用户要的（列表标题不再停在旧名）。
- ⚠️ 仍然没被判到的一半：**跨进程"改名帧到底有没有离开本机"**依旧没有判据
  （`final-architecture-review` §七 取数纪律第 6 条那句仍然成立）。
  本轮挣到的是"新名到达之后会落到已存在的会话行"这一格，不是整条跨进程旅程。
- 清单基线 `--update` + `--sync-baselines`：macos **790 → 794**、windows **778 → 782**。
  ★ 差额是 **4 不是 2**：其中 2 条是本轮新增，另外 2 条
  （`commands::tests::aux_windows_are_kept_inside_the_monitor_work_area`、
  `commands::tests::recenter_aux_window_actually_uses_the_placement_rules`）**早就在跑、只是从没登记过** ——
  这条清单对"跑了但没登记"只警告不判红（既有口径），所以它不会被任何一次红提示过。
  逐行 diff 已核：**只增不删**（`git diff -U0 -- src-tauri/test-baseline.macos.txt | grep -E "^[+-][a-z]"`）。

### 稳定性：五项决策落定 + 8 条 `[plan]` 提交已推 + 222 条全量护栏在同一最终提交上重新挣得（2026-10-10）

负责人一次答完五项（预览缓存按累计字节封顶初始 60 MiB / #22 群主改名要修且只更新已存在的会话行 /
代码消息暂不加列 / Persistence 暂不加只读连接 / 中继暂保留严格拒收但必须给可识别的兼容性失败原因），
并把稳定性任务逐条点名。**这一节只记账，不动任何应用码。**

- **推送**：8 条 `[plan]` 提交（`c8fe9ee…1cdb42b`）已推上去。推送前逐条核过分支、远端与提交关系：
  `git branch --show-current`＝`main`、`git remote -v`＝`git@github.com:wenzo001/gosslan.git`、
  `origin/main` 由 `339fea4` 前进到 `1cdb42b`、`git rev-list --count refs/remotes/origin/main..HEAD`＝**0**。
- **★ 全量护栏非空转整跑（分母现读，不抄文档）**：命令 `python3 scripts/verify-guards.py`（不带参数＝全量层），
  跑在最终提交 `1cdb42b`（跑前 `git status --short` 为空、跑后仍为空，树 `6bc148e`）。
  起跑前那行自己打印的分母：**222 条用例的注入锚点都在各自文件里恰好命中一次，且每条都声明了 fail-hint**；
  结论行原文：**「✅ 其余 222 条护栏都通过了非空转验证（改坏即 FAIL、恢复即 PASS）」**；
  **裸退码 `RC=0`**（在 `python3 …` 之后同一 shell 里 `$?` 裸取，不经过任何管道）；
  失败详情：**无**（整份日志里 `❌` 计数 0，日志 129,722 B 落 `/tmp/guards222.log`）。
  耗时 ≈58 分钟：起跑 07:41:53Z → 日志最后一写 08:39:44Z
  （复跑读数 `stat -f '%Sm' -t '%Y-%m-%dT%TZ' /tmp/guards222.log`；那两个时刻来自同一台机器同一个进程，
  不是"起跑时刻"配"我读到它的时刻"）。
  ⚠️ 那句后台通知报的 "exit code 0" 属于**启动器**，不属于这一轮 —— 判这轮只认上面那个裸取到的 `RC`。
- **发布清单那一格按现读重核**（候选 SHA＝`1cdb42b`，与 `origin/main` 同点）：
  五处版本号逐处现读全为 **4.33.42**；`npm run version:check` 裸退码 **0**
  （它自己打印"自 `baebd18` 共 17 个提交（真欠的档位 无 —— 范围内全是零影响提交）"），
  `npm run version:classify` 裸退码 **0** ⇒ **任务第 6 条（纯计划提交不升版本号）由这两条命令现证，不靠口头**。
  远端 CI 匿名端点现读：`x-ratelimit-remaining: 3`（**所以这不是"限额耗尽返回空名单"那副形状**）、
  `total_count=12` ⇒ 9 条 `completed/success` + 3 条 `skipped`（那三条是"挂到 GitHub Release"，非 tag 事件本就不跑）；
  此前一直抖的 `build-windows (aarch64-pc-windows-msvc, arm64)` 这一趟是 success。
- **不做的三件按点名执行**：**没打新 tag**（本地与远端最高仍 `v4.33.31`，现读 `git tag --sort=-v:refname` /
  `git ls-remote --tags origin`）、**没重出安装包**（盘上那份现读是 `Gosslan_4.31.27_aarch64.dmg`、
  `Info.plist` 同为 4.31.27 ⇒ 比代码旧 15 个版本号，这是**已知且刻意不动**的状态，不是新发现的缺陷）、
  **没动签名决策**（`security find-identity -v -p codesigning` 现读 **0 valid identities** ⇒ 这些包仍不是可分发件）。
- **`GroupTasksBoard.vue:71-72` 那句过期注释本轮一字未改**（按点名），并把"未来改它之前先重核判据 3"落成两条现读：
  当前推送窗口 `refs/remotes/origin/main..HEAD` 空 ⇒ Change Budget 自己打印**「零覆盖：跑了，但没有任何 commit 可判
  （退出码 2 ≠ 通过 0）」**、判据 3 那行是「本次窗口 0 个 ⇒ 无可判定的重复」；
  而 CI 真正判过的那一段（`GOSSLAN_BUDGET_STRICT=1 GITHUB_EVENT_NAME=push … --range 339fea4..1cdb42b`）
  逐条打印 **8 条全为豁免或 L2 ✓**、无一条红 ⇒ **main 上今天没有挂着的 Change Budget 红灯**。
  ⚠️ 读数口径写死在这里：**"窗口空"不是"判据过了"**，两者不能互换。

### 需求登记：聊天强提醒 —— 第 0 阶段只做审计与设计（新增 `docs/strong-reminder-plan.md`，**零实现代码**）

负责人新增一条完整需求（高于普通通知优先级的"强提醒"：发起 → 送达 → 提醒 → 显式确认 → 失败六态，
参考飞书触达 / 钉钉重要提醒 / QQ 即时交互），并明写**第 0 阶段只审计和设计、暂不写代码**、
且**不与上面那 8 个 `[plan]` 提交混提**。这一节就是那条登记的落地点。

- 新增 `docs/strong-reminder-plan.md`，README 的 AI 约束入口表与 `docs/AI_ENGINEERING_INDEX.md` 各挂一行
  （断链＝约束失效，这条本仓定过规矩）。文档内容按点名交付：**架构图 / 最小变更方案 / 兼容策略 / 风险清单 /
  测试矩阵**，另加一张**六态 ↔ 唯一写入点**表（把"传输 Ack ≠ 用户确认 ≠ 事情已完成"写成可判的归属）。
- ⚠️ 取证方式：护栏整跑正在注入并还原源文件，所以这份审计**全程不读工作树**，
  一切现状句子取自 `git show 1cdb42b:<path>` 并逐条挂复跑命令。
- 三条会改变设计形状的现读事实（都是"已经存在"或"确实不存在"，不是推测）：
  ① **「紧急程度」这件事已经有一个家** —— `src/utils/notifyUrgency.ts`（34 行，注释原话「刻意不收第三个」）
  是判"这批通知值不值得让 Dock 弹跳/任务栏闪烁"的唯一判定点 ⇒ 强提醒应当成为它**第三个被点名允许的来源**，
  而不是新写一套打断规则；
  ② **引用一条消息、带自己状态的小控制消息已有三个现成家**（`reaction` / `pin` 是静默消息 + 前端折叠，
  `recall` 另有一张权威 G-Set 表），三者都走**与普通群消息完全相同**的 outbox + gossip 可靠管道 ⇒
  "复用现有消息 ID / Outbox / Ack / 去重 / 加密"这条路是**存在**的，最小变更方案据此立成"2 个 kind、不加表不迁移"；
  ③ ★ **验收项「多设备确认状态能够正确合并」落在一条结构性缺口上**：全仓身份是 `device_id`
  （`group_members(group_id, device_id)`、Ack/ReadReceipt 都判 `to != state.device_id`），
  而 `userId` / `same_user` **零命中**、代码里唯一出现"多设备"字样的地方是日志前缀（`logging.rs:167`）
  ⇒ **没有任何"同一个人的多台设备"之间的状态同步机制**。这条我没有自行决定，已写成待拍板项。
- 另外两处"确实不满足"也照实登记：**声音**全仓零实现（`notify-rust` 的 `.sound()` 从未被调用、
  无 `new Audio`/`rodio`，设置键只有 `notify_enabled` 与 `notify_show_content`）；
  **通知点击只带 `conv_id`**（而带翻页的消息级定位链 `locateMessageInConv → locateMessage` 早就通），
  且**点击回调只在 Windows 实现**，macOS/Linux 把 `on_click` 丢掉 ⇒ 那半是缺口不是能力。
- 未结论的两格明写在文档里：**未知 kind 的降级形状**要跨实例实测（自制帧投给按旧词表解析的对端、
  读它自己的日志与 DB），**多设备口径**待负责人拍板 ⇒ 第 1 阶段之前先把这两格填掉。

### 探针 / 判据（#23 收口：输入框那两张「往上长」的面板第一次被真布局量到，20 条两台引擎各 212/212）

C 批第 4 件「要不要补真布局 harness」我按现读确认它是**真缺口**之后做掉了（工单 #23）。
判断依据不是感觉：探针当时的挂载清单里只有 `EmojiPicker`（单独挂）—— 而 `MessageComposer` 那两张面板
（表情面板、@ 候选列表）**都不走 Teleport**，是 `absolute bottom-full` 往上长、留在输入框卡片里面，
单独挂组件时"往上长"没有参照物 ⇒ 视口上边缘被切、被中间层卡片裁掉这两型真实缺陷一条都量不到。

- 新增一段 `node scripts/check-ui-runtime.mjs --only=inputpanel`（20 条，全绿）：
  宿主壳只把卡片压到视口底部（真实聊天窗里它就是 flex 最后一项），**不给组件加新属性、不改产品码**
  （为可测性加 `data-*` 也算动应用码，这条本仓付过一次版本号）；几何读数全部复用现成的
  `floatLayer(sel)`，不在探针里开第二份几何家。夹具只补了 `onSend`（DOM 上只有 token，名单在载荷里）。
- 判到的：真点击 ⇒ 表情面板挂在**卡片里面**、整个在视口内、底边在按钮顶边之上、中心点归它自己接、
  再点收起不留残层；真输入一个 `@` ⇒ 候选列表浮出、在卡片上方且在视口内、方向键 + 回车真选中
  （编辑器落下带 `data-mention-id` 的 token）、再按回车发出且**载荷里带 `mentionIds`**、发完清空无残留。
- ★ 两次可逆单点变异，各自都带"证明它不是别人的别名"：
  ① 把输入框卡片自己改成 `overflow:hidden` ⇒ 中间层裁切必须被报出来，**而 `inViewport` 仍为真**
  （⇒ 裁切那条不是视口那条的别名；这一型缺陷只看得见这一条，光判视口会放它过去）；
  ② 把面板整块推到视口下方外 ⇒ `inViewport` 必须翻假。@ 那条另有反空转：把 `@` 换成普通字符必须不出现。
- ⚠️ 一处我自己写错的期望（第一次跑就红）：把 `floatLayer` 的 `clipped` 原样当"有祖先裁到我"判 ⇒
  这个桌面壳的 `body` 本来就写死 `overflow:hidden`，两张 absolute 面板必然把它数进来（那几族
  Teleport 到 body 的 `fixed` 面板之所以干净，是因为 helper 对 `fixed` 跳过裁切判断）。
  改成排除壳层、只判**中间层**，并把排除前后都打进读数 —— 排除的理由写在代码注释里，不只是把红消掉。
- 回归（都现跑、裸取退码）：`--only=inputpanel` 20/20；整段全跑 **CfT 153 ⇒ 212/212**、
  **Brave 155 ⇒ 212/212**（分母 192 → 212 就是这 20 条）；`node --check` 两份脚本退 0；
  `npm run verify` 快速层 17 步退 0；`node scripts/check-doc-numbers.mjs` 退 0。
- 同批改口：验收矩阵第 23 行那句「两块都既无运行时判据、也不能写成已验」按现读改掉，
  但**留着仍然欠的那一句**——「软键盘在不在、那 184px 会不会被键盘顶掉」是设备行为，桌面 headless 判不了 ⇒
  仍归 Smoke-11 人工；`scripts/verify.mjs` 那一步的 `why` 补第 ⑤ 条。
- 本层仍是 **local 组、CI 不跑** ⇒ 报结论时属本地手工背书，别升级成 CI 判据。

### 文档 / 台账（roadmap N7 那一格的「零命中」是过期读数；顺带记全量层已挣得，以及一条复核方法）

现读发现的第三类漂移（不是代码错、是**台账行没跟着回写**）：`docs/stability-roadmap.md` 的 N7 那一格
一直写着「`::selection` 与 `accent-color` 零命中（只有 `caret-color`）」，而
`grep -n "::selection" src/style.css` ⇒ `:484` 有、`grep -n "accent-color:" src/style.css` ⇒ `:494` 有，
守卫就是 `designGuards` 第 ⓪ 节（用例 `designGuards.test.ts:40` + 那条防误伤的 ㉚）。
两行 CSS 早在 **4.30.2（2026-09-27）** 就落了，只是当时没人回写这行表格；那句"零命中"描述的其实是
**2026-10-09 之前那个形状** —— 两条被塞进 `input,textarea,…{…}` 的括号里、被嵌套编译成后代选择器
从而整条匹配不到东西（那一半的正确诊断在归档条目与 `style.css:478-480` 的注释里）。
⇒ 行已按现读改成「已落地 + 位置 + 复跑命令」，并把这一格踩过的两回一起写进去（防止第三回）。

★ 同一条方法这一轮被验证了三次：**动任何一条台账项之前，先按它自己的名词 grep 现读代码与 `docs/acceptance/`**。
这样核出来的"其实早就做了"共五条（600 MB 档、#76 判据②、@ 红点的界面判据、中继流式接收 `274d42e`、
离线撞号收敛 `resolveTodoNumbers`），照着旧台账做会**白跑两轮**。仍待负责人点头的六件、以及故意不动的两件
（`GroupTasksBoard.vue:71-72` 那句过期注释 —— 改它要占版本号并把 presentation 的 patch 计数推得更深；
今天改的 N7 是 `*.md` ⇒ 不占版本号）都登记在项目记忆那本台账的开头一节。

门禁归属（现跑、裸取退码）：`npm run verify:full` 结论行「✅ 全部门禁通过（23 步，共 788.4s）」退 **0**
⇒ 今天动过的 `scripts/verify.mjs`（起跑前自扫）与 `scripts/check-ui-runtime.mjs`（按键发法 + 四条新判据）
至此有齐了**快速层 17 步 / 本地层 21 步 / 全量层 23 步**三层背书。⚠️ 但全量层里那一步是
「护栏非空转（**前端子集**）」⇒ **护栏 222 条整跑**（`python3 scripts/verify-guards.py` 不带参数）与
**远端 CI** 都**不在**这三格里：整跑约一至两小时、由负责人挑窗口；CI 要等这批推送之后按 sha 现读。
`node scripts/check-doc-numbers.mjs` 退 0。

### 修复 / 门禁（本地层从早上起就在加载期崩：`why` 那串散文少了六个 `+`，而 `node --check` 看不见）

发现过程本身就是账：想补跑本地层拿证据，`npm run verify:e2e` **第一步都没跑**就抛
`TypeError: "…" is not a function`（`file://…/scripts/verify.mjs:506`）。

形状：模板字符串链里少一个 `+` 时，下一行的字面量会被解析成**标签模板**（`` A`B` `` ⇒ 把 B 当 tag 调
`A(B)`）⇒ **语法完全合法**（本机实测 `node --check scripts/verify.mjs` 退 0），只在求值那行抛运行期错。
后果分三层看才明白为什么一整天没人发现：那段 `why` 属于**本地层那一步**，快速层与 CI 都不构造那个数组元素
⇒ 快速层绿、CI 绿、本地层红。归属：`git show` 逐 sha 查，缺 `+` 自 `da3ff6a` 那一批文案改动起就在，
今天 N19/pinkb 两段散文各加了一行 ⇒ 一共六处。

- **修**：`scripts/verify.mjs` 那六行各补回 `+`（只动 `why` 的散文拼接，一步的判据与命令都没改）。
- **锁**：同文件加一段**起跑前自扫**（`scripts/*.mjs` 与 `perf/*.mjs`）：一行以反引号收尾且不以 `+` 收尾、
  下一行以反引号开头 ⇒ 具名红并列出 `文件:行`，在任何一步之前 `process.exit(1)`。
  刻意排除 `,` / `;` / `)` / `]` 收尾的相邻字面量（数组元素、多参数）与注释行。
  为什么锁在 runner 自己身上而不是 designGuards：designGuards 是纯字符串判据、不读文件，
  而这条缺陷**只在跨文件文本形状**上才看得见；放 runner 起跑前 ⇒ 每一层（含 CI 那层）都先过它。
- ★ 非空转两条都现跑（中间还抓出我自己一次"补丁脚本静默失败 ⇒ 那条读数根本不作数"）：
  注入档（把第 543 行结尾的 `+` 摘掉，改后**先打印该行证明文件真改了**）⇒
  `node --check` 仍退 **0**（这把新尺子要挡的就是它），`node scripts/verify.mjs --list` 退 **1**
  并点名 `scripts/verify.mjs:543`；恢复档 ⇒ `--list` 退 0、扫描零命中。
- 回归（都现跑、裸取退码）：`npm run verify` 快速层 17 步退 **0**（新扫描在链上跑过）；
  `node scripts/check-doc-numbers.mjs` 退 0。
  ✅ **本地层整跑随后已挣得**（同日晚些，`npm run verify:e2e` 裸退码 **0**，结论行原样
  「✅ --group local 那一组通过（21 步，共 876.3s）」、日志里 `❌` 计数 0）—— 这一跑本身就是那条缺陷的
  收尾证据：修之前它连加载都过不去。⚠️ 那个秒数只当本机当场读数（这一层的用时随负载大幅漂，
  记录上有过 872 / 1527 / 2349 s 几档，各自属于自己那次跑）；步数以
  `node scripts/verify.mjs --group local --list` 现算为准，别抄这一行。
- 顺带一条会漂的口径：`why` 那些散文**没有机器守卫**（这条扫描只判拼接形状，不判内容），
  加/减判据、换夹具形状都要同批改口 —— 今天这条缺陷正是这么藏了一整天。

N23 那一格第一次有数，而且结论把"按条数封顶"这条打法判掉了）

`perf/previewHeap.mjs`（量具八的采集端）落地并跑通 —— 它走**产品那份缓存**：只把 `api.readFilePreview`
（Tauri 读字节那条命令）换成"当场生成本地字节"的替身，其余 `new Uint8Array` → `new Blob` →
`URL.createObjectURL` → `cache.set` 全是生产码。前后各拍一份 V8 堆快照，交给 `heapDelta.mjs` 归并相减。

现读四趟（同一台 Mac、同一台 CfT 153.0.8010.12、每次都是预热 8 条之后才拍第一份）：

| 喂进去 | V8 侧增量 | 每条均摊 | 节点数变化 |
|---|---|---|---|
| 200 × 64 KiB = 12.5 MB | +35.1 KB | ≈180 B | +699 |
| 200 × 512 KiB = 100 MB | +35.2 KB | ≈180 B | +701 … +705（这一档四趟） |
| 200 × 1 MiB = 200 MB | +35.2 KB | ≈180 B | +701 |

两条结论都不是引来的：
- **缓存条目自身很便宜**（≈180 B/条 ≈ 3.5 个节点），其中大头就是那 200 条 objectURL 字符串
  （`native system / ExternalStringData` +14.6 KB，外加每格 `string blob:http://…` +52 B）；
  标量那一路互点（`usedJSHeapSize 2.88 → 2.91 MB`）⇒ 不是解析器造的数。
- ★ **增量与喂进去的字节数无关**（12.5 MB 与 200 MB 都是 +35 KB）⇒ `self_size` 不计 Blob 外部内存
  这一句从文档里的免责声明变成了一把尺子的**阴性对照**。于是 N23 那条"上限"的形状变了：
  **条数上限管不住字节** —— `IMAGE_MAX_BYTES = 15 MiB` 是单条上限，取 K 条最坏就是 K × 15 MiB
  （K=30 ⇒ 450 MiB），要封顶得按**累计字节数**，而字节数不用测，它就在载荷里（`FileMeta.size`）。

★ 这台量具自带一条自证，且它的失败形状也实测过：每条新增缓存项会留下一格唯一的
`string blob:http://…` 节点 ⇒ 判据是「格子数 == loaded 条数」。正常档 ✅ 200/200、退 0；
注入档（把 200 次调用只打向 8 个 msg_id）⚠️ 8/200、退 **1**，并把那份 `+1.3 KB / 每条 7 B`
当场判为不作数 —— 没有这条自证，那份假数就会被当真数抄进文档，这是它存在的全部理由。
副产物：200 次调用命中 8 条缓存 ⇒ 增量只有 +1.3 KB，说明**去重路径本身不涨内存**
（N23 要治的是"条目只进不出"，不是"重复读同一张"）。

⚠️ 没做也不许被读成"已排除"的那几格：真照片字节（合成字节只证形状不证成本）、"挂着不动几小时"那条曲线
（归 `PERF_MEM_STEPS=60000` 档，本机仍未跑）、Detached DOM。**动码这一格停在等负责人点头** ——
缓存自己按字节逐出并 revoke 会改变可观察行为（被逐出的图要重读一次才出来），
而回收出口照旧只能有一个（消费者加 revoke 会退回 2026-09-21 记着的那个已修缺陷）。

三条试过并放弃的路写进 `perf/README.md`，防止下一个会话再走一遍：CDP `Fetch` 注入 COOP/COEP 换
`measureUserAgentSpecificMemory` ⇒ 导航被 pause 后 `continueResponse` 一发失败就整趟卡到 240 s 预算；
另配一份 vite config 加那两个头 ⇒ 没有 alias 与 vue 插件，`@/api` 解析不到（项目的 vite 配置
不为一次测量而改）；renderer RSS 当粗上界 ⇒ **剂量对照判死**（喂 12.5 MB 涨 130 MB、喂 200 MB 只涨 11.8 MB，
完全不跟剂量走；第一版还漏了"两次读数之间多出一个 renderer"这个洞，修掉后仍不跟剂量走）。

同批：roadmap **N23 行**改成"有数了、方向也改了、动码等点头"，**N26 行**的 ②③ 两小格就地改口
（heap snapshot 那一半已接上，仍欠真图字节与 Detached DOM），`heapDelta.mjs` 加了 `IS_MAIN` 守卫
（它现在同时是库 —— 被 import 就 `process.exit(2)` 会把调用方一起带走）。
数字一律不进门禁：这一台与 perf/ 其余那几台同口径，读数用来定位，不钉红。

回车风暴定标到一条字面量，发法改成只激活一次，两台引擎整跑各 192/192）

上一节留下的那两条红今天修完了，而且**产品码一字未动** —— 缺陷在按键合成层。

四档发法在同一支 `--only=reaction` 上逐档实测（CfT 153；读的是 capture 阶段计数器：按完那一瞬间的激活数、
以及空等 1 秒后的自持增长）：

| 发法 | 按完 | 空等 1 s 自持增长 | 表情选择器 |
|---|---|---|---|
| `rawKeyDown`（**带 text**）+ `char` + `keyUp`（旧档） | 28 | **+558** | false |
| `rawKeyDown`（带 text）+ `keyUp` | 24 | +411 | false |
| `rawKeyDown`（**不带 text**）+ `char` + `keyUp` | 1 | 0 | true |
| `keyDown`（带 text）+ `keyUp` ← **落这档** | 1 | 0 | true |

⇒ 触发条件被夹到一条字面量上：**`rawKeyDown` 自己带 `text`** —— 这台引擎随即进入自持重复，
补发单独 `keyUp` 也不终止（旧文档里那句"逐条 await 会按住不放"是同一个家族的另一面，纪律 1 已按实测改口）。
两档都合格时选消息更少的那条 ⇒ `key()` 现在只发 `keyDown`(带 text) + `keyUp`，不再发 `char`。

新增 4 条判据（`keyOnce`：表情入口 2 条 + 取消置顶 2 条）＝「一次按键只激活一次」+「空等 1 秒不再增长」。
计数器必须挂 **capture** 阶段（被测元素普遍带 `@click.stop`，冒泡-phase 的计数器什么都读不到 —— 这条
是当场差点让我写出假判据的地方）。非空转一正一反都现跑：

- 反（单点变异，只把 `keyDown` 改回 `rawKeyDown`）⇒ reaction 那两条当场红，整支 `--only=emoji,reaction,pinkb`
  读到 **50/55**，且既存的 emoji「恰好一次 select」也一起红 ⇒ 新判据不是装饰，而这套套件本来就有这个闸门；
- 正（恢复）⇒ 回到全绿，`--only=reaction,pinkb` 28/28。

★ 一条**没被证明的东西**明写在 `keyOnce` 注释里：同一发变异下 **pinkb 那两条仍绿** —— 那颗 ✕ 按完就离开
DOM，重复没有作用对象 ⇒ 那一对守不住这型风暴，只算"更弱的一条"。§12 里那条 pinkb 可信度更正**仍然成立**，
不许因为加了计数就把它读成"两处都证明了"。

整跑终态（都现跑、都退 0）：CfT **192/192**（153.0.8010.12）与 Brave **192/192**（155.0.8059.40）。
分母 188→192 就是这次新增的 4 条。

顺带落一条收尾卫生：探针退出前会把 `5199 / 9444` **等到真让出来**（有界 10 s，到点仍占着才打印归因）。
成因今天实测到：连着三趟被上一趟留下的 CfT 顶成前置红 —— 那条前置红判得对，但它咬的是自己人
（饱和的 renderer 拆除慢）。⚠️ 这条兜底今天没被真正需要过（最后一趟 500 ms 内就让位、等待循环没走到分支），
所以它是**有界兜底**，不是被证明的修复；被证明的是"前置红会咬"那一半。

把"环境起不来"从静默等改成三型具名红 —— 其中一型根本不是"起不来"，是假绿）

今天两次拿不到结论，都不是产品的事：

- 一次 `--only=pinkb` 卡在那里十几分钟不回，只能人 kill。**退出码要说清是谁的**：后台通知写的是
  "exit code 0"，而它属于链尾那个 `tail`；探针自己的真实退码在日志里 —— `PINKB_RC=143` ＝ SIGTERM。
  根因形状是 `Cdp.send` **没有任何预算**（回包不到就永远等）。
- 更早一轮的现场更坏：`9444` 上是 09:56 那次被中断的探针留下的 headless CfT（ppid=1 的孤儿），
  它**仍然挂着 `type=page` 指向 `5199` 上那个同样残留的旧 vite** ⇒ 新跑起来的探针会连到
  **几小时前那份构建**上去采数，判据照样打绿。这不是"起不来"，这是**假绿通道**。
  本机同一晚数到 **3 个孤儿 root**（10:00 / 10:38 / 10:49 各一批）。

落的四件（全在 `scripts/check-ui-runtime.mjs`，应用代码一字未动）：

1. **起跑前探两个端口**（`5199 / 9444`），占用即具名红，并打出"谁在占"的核对命令与
   为什么不能"换个端口接着跑"—— 实测 **0.09 s** 报出（改之前这一型会一路跑到"绿"）。
2. **起不来时分型打印读数**：浏览器路径 / 来源 / `--version` / 我起的那个进程的结局 / 端口是否有人监听 /
   最后一次尝试；预算 `GOSSLAN_PROBE_CDP_WAIT_MS`（默认 20 s）可调，进程当场退出则**提前break**不再空等。
   「进程已退出 + 端口无人监听」两条同时成立时直接给出"并入了已存在实例"这个修法提示。
3. **单次 CDP 调用 45 s 预算**（`GOSSLAN_CDP_CALL_MS`）：报的是"哪条调用没回包"，并把这一格记成**没跑**。
   默认给到 45 s 是因为 vite 冷编译那一次 eval 真会慢 —— 这条守卫要挡的是"永远不回"，不是"有点慢"。
4. **正常路径打引擎版本**（`· 引擎：Chrome/153.0.8010.12｜协议：1.3｜来源：playwright 缓存…`）。
   ★ 这一条今天立刻兑现了价值，见下面那条归因。

非空转（三型各自实测，不是设计推演）：`GOSSLAN_CHROME=/usr/bin/false` ⇒ **0.82 s** 具名红，读数里
`已退出 code=1` + `端口无人监听` + 并入提示；`GOSSLAN_CHROME=<一份 sleep 脚本>` ⇒ **8.9 s** 具名红，
读数里 `到预算点仍在跑（pid …）` 且**没有**并入提示（⇒ 两型确实长得不一样）；
`GOSSLAN_CDP_CALL_MS=1` ⇒ **1.3 s** 具名红并点名 `Runtime.enable`。三条都退 1、都走 finally 把这次
起的东西清掉（跑完端口为空）。正例：干净环境下 `--only=pinkb` **12.65 s** 跑完 8/8。

★ 顺带用这条新读数归因了一起**跨引擎**的红（以前只能靠猜）：整支全段在 CfT 上是 **186/188**，
红的是 `--only=reaction` 里"按回车真打开了表情选择器"那两条；同一支换成 Brave 是 **16/16 绿**。
中间那次隔离诊断量到的形状是：焦点模拟开着时对那颗 `<button data-reaction-entry>` 发一次 Enter，
页面里出现**自持的 click 风暴**（capture 计数空等 1 s 仍从 2262 涨到 3188 ≈900 次/秒，补发单独 keyUp
也没终止）⇒ "开/关切换"型读数在这台引擎上变成掷硬币；同一次诊断里 `picker=true` 出现过，
加上 Brave 全绿 ⇒ **不是产品键盘缺陷**，是本仓那套三事件发法在这台较旧的 CfT（153）上不成立。
已登记为任务 #20（要修得碰共用的 `cdp.key()` ⇒ 影响十处 Enter 断言，另起一轮整跑背书）。
⚠️ 由此带出一条**可信度更正**：`pinkb` 那句"真按回车之后那条从置顶条上消失"对重复**不敏感**
（撤完置顶那颗 ✕ 就没了，后续重复没有作用对象）⇒ 它不许在"Enter 只触发一次"这个意义上被引用。

⚠️ 两处不许读过头：① 那次十几分钟的卡顿**未归因** —— 同一档在干净环境 12.65 s 跑完，
本改动只保证"以后不会再静默"，不保证它不再发生（再出现时日志会点名是哪条调用）；
② 端口前置只查 `127.0.0.1`，当天 `[::1]:9444` 上那个残留就是这么躲过核对的 ⇒ 挡的是最常见那一型，不是全部。
`scripts/verify.mjs` 里这一步的 `why` 同批改口（散文口径要跟着判据形状走）。
本层仍是 **local 组、CI 不跑** ⇒ 报结论时它是本地手工背书，不是 CI 判据。

### 量具（A3：N23「只差实现成本」那一半付掉了 —— 堆快照归并器落地，快照仍未采）

roadmap N23 从登记那天起就卡在一个**没有工具**的位置上：量具四（`PERF_ONLY=mem`）读的是标量曲线
（GC 后堆、DOM 元素数、`JSEventListeners`），能判"有没有随步数累积的上行台阶"，**判不出长出来的那一截
是什么东西**；而要答后一半就得解析 V8 堆快照 —— 一份是 20~80 MB 的 JSON + 定长整型数组，
DevTools 手点既不可复现也没法逐格对账。⇒ 那一格一直只能写"未测量 ⇒ 不写百分比也不写『泄漏』"。

- **落的是纯工具**：`perf/heapDelta.mjs`（量具八）。两个动作 —— ① 把一份快照按 `type+name` 聚合
  `self_size`（不建整图 ⇒ 内存 ≈ 文件本身，不是建图那种 3~5×）；② 把两份聚合表**按 key 对齐相减**，
  新增格与消失格都单独标出，排序键是**差的绝对值**（"变小最多"同样是归因要看的信号）。
  复跑：`node perf/heapDelta.mjs before.heapsnapshot [after.heapsnapshot]`，归并按 `--group`、行数按 `--top`。
- **它自带对账三正三反，且反例才是价值所在**：`node perf/heapDelta.mjs --selfcheck`（**条数只认它自己
  打印的那行结论**）。三条反例＝文件被截断（`nodes` 长度不是字段数整数倍）、字段改名（V8 格式变了）、
  根本不是 `.heapsnapshot` —— 三种都必须**当场抛**，因为一把静默算出错数的尺子比一把报错的尺子坏得多。
  正例里含一条容易写错的：`detachedness` 那一列**有就用、没有也不能报错**（新旧 V8 不保证都有）。
- ★ 两处**我自己的期望值错**（红的是样本不是解析器，都写进了代码注释）：① 手写最小快照时把
  `node_types[0]` 当成"每个字段的种类数组"，V8 的惯例是它就是 `type` 字段的枚举名；
  ② 排"谁变最多"时期望写成按带符号大小排，于是 `-80` 那格"该在后面"。
- ⚠️ **这一格没有因此变成"有数了"**：快照**一份都没采过**。两个环境成因记在任务 #19 —— 探针并入用户
  已开着的浏览器实例时 `9223` 无人监听、要等满预算才报错（该改成几秒内响亮失败并打印来源+版本+端口）；
  换到 Chrome for Testing 后 `HeapProfiler` 这条域一次没跑过。**阻塞的位置从"缺工具"挪到了"缺采集"**，
  N23 仍留在验收报告"开着且有明确阻塞"那个桶里，桶的算术不变。
- ⚠️ 这把尺子读不到的那一半一并写死（防止下一次拿它当结论）：V8 的 `self_size` **不含**字符串 /
  `ArrayBuffer` 的外部内存 ⇒ **图片 Blob 很可能正好在不含的那一半**；"谁拽着它不放"（GC root 路径）
  要全图 BFS，这台刻意不做。
- **应用代码一字未动**：改方向照旧只有一条 —— 缓存自己按条数上限逐出并 revoke（`filePreview.ts` 头两句
  记着为什么消费者不许 revoke），而那条改动要等"每条约占多少"有数。
- 同批文档三处（同一结论不许只写一处）：`perf/README.md` 新增量具八那一节（含采快照的 CDP 配方与
  "今天卡在哪"）、roadmap **N23 行**改口为"量具就位、快照未采"、验收报告
  `docs/acceptance/native-experience-round-1.md` 新增 §11（写明桶不变、阻塞位置变了）。

### 门禁 / 判据（CI 在 `da3ff6a` 上唯一那条红的对账与处置口径）

- **红的就是那一条**：CI（frontend 组 833s）18 步里 17 绿，唯一 ❌ 是第 14 步 Change Budget，
  报 `presentation: 5 次(baebd18, 7c4c084, 0e21c1f, 943e5fb, 6fb4ba3)`；同一次 CI 里
  「护栏非空转（前端子集）803.0s」报的是**其余 81 条全过**（含本轮新挂的 4 条注入档）⇒
  红与质量信号无关，是"攒了一批未推提交"的形状。
- **逐条对过账**（不是"我觉得互不相干"）：那 5 条分别是 N21 守卫 / N21 修复 / N22 骨架 / N19 键盘 / N11 收口，
  文件交集只出现在两类地方 —— hub 文件 `src/utils/designGuards.{ts,test.ts}`（**每加一条护栏都算一次
  presentation 补丁**）与 `MessageItem.vue`/`ChatWindow.vue`（三条改的是三个不同行为）。
  ⇒ 判据没坏，但它对"一次攒多条"必然起反应；而这类红**推上去就改不动**（不改写历史是硬规矩）。
- 处置口径写进了门禁自己的规范注释（`scripts/check-change-budget.mjs` 头部，不改算法）：
  **未推区间里同领域已有 2 条 patch 形状提交 ⇒ 就把应用码提交交回负责人推送**；
  已推上去的只有两条正路——下一次推送的新范围窗口自然清空（已实测：
  照 CI 的 `GOSSLAN_BUDGET_STRICT=1 + GITHUB_EVENT_NAME=push` 判 `origin/main..HEAD`
  ⇒ "窗口 0 个 / 无重复犯案"，待推这 5 条都不带 `Version-Bump`）或负责人明确接受这条信号。
  **不许**为了消红去动领域映射或窗口大小。

### 量具 / 判据（A1：本轮新加的四条判据各补一条"改坏真实文件"的注入式非空转用例）

按本仓标准（㉝ 那次是合成反例 + 注入档两条一起交的），只在 `designGuards.test.ts` 里挂合成反例
**低一档** —— 合成 fixture 证的是"尺子认得这个形状"，注入档证的才是"今天这份真实文件正被它守着"。
CI 那一层的结论行（`✅ 其余 81 条护栏都通过了非空转验证`）只数 `scripts/guard_cases/*.py` 里的 Case，
所以这四条挂上之前，新判据在台账里等于不存在。

- **㉞（图片盒高度只能从常量取）** 挂进 `guard_cases/frontend_ui.py`：往 `MessageImageBubble.vue`
  的骨架 class 里塞回一个 `h-32`。实跑 `python3 scripts/verify-guards.py --only "图片盒把高度写成"` ⇒ 退 0，
  结论行「改坏即 FAIL、恢复即 PASS，且红由声明的那条判据报出」；证据是注入态 142 条测试里
  **恰好 1 条红**（`㉞ 真实树：MessageImageBubble 与 messageHeight 现在这一份必须合规`）、其余 141 绿，
  恢复后工作树 `git status` 无残留。fail-hint 取的是判据自己打印的那句「高度工具类」。
- **㉟（视图层不许自己算平台/悬停能力）** 同册再挂一条：注入用的就是 `MessageReactionBar.vue`
  搬家**之前**那份原样写法（`typeof window !== "undefined" && window.matchMedia("(hover: hover)")`），
  不是我编的形状。实跑 `--only "视图层自己算 hover"` ⇒ 退 0，结论行「改坏即 FAIL、恢复即 PASS，
  且红由声明的那条判据报出」，hint 取判据原文那句「视图层里裸写了」。
  配套把 `designGuards.test.ts` 里 ㉟ 那条真实树用例的失败输出改成**带判据原文**（原来只推
  `文件:行号` ⇒ 红能定位但说不出守的是哪一格，注入档的 hint 也匹配不上）。
- **⑥ 收紧的那一半（`role="button"` 不给可聚焦性）** 挂进同一册：注入的就是 **N19 改掉之前那段原样代码**
  （`git show 7c4c084^` 里那颗置顶 ✕：`span role="button"`、无 tabindex、嵌在 `<button>` 内）——
  从 git 取原文而不是我手打，避免"锚点凭记忆写"那一族错。实跑 `--only "没有 tabindex"` ⇒ 退 0，
  「改坏即 FAIL、恢复即 PASS，且红由声明的那条判据报出」；手工逐条取证据：**注入态 142 条里恰好 1 条红**
  且红的正是真实树那一条（`src 下所有可点击元素都能用键盘触发（含 ⑥ 补上的那一半…）`），
  另外两条合成用例（放行名单、⑥ 的洞）各自仍绿 ⇒ 不是"多打了几条红"；恢复后 142/142、被注入文件 `git status` 无残留。
- **②-2b（`.kb-reveal` 那一家必须有**两份**）** 挂进同一册：注入 = 从 `src/style.css` 的
  `@media (hover: none)` 块里删掉触屏那份。实跑 `--only "只留一份"` ⇒ 退 0；手工取分布：
  注入态 142 条里 **2 条红**（`真实的 src/style.css 级联顺序正确` 与
  `N19：.kb-reveal 那一家缺任一份都要报`）⇒ 同一份文件被两把尺子读到，这是**重复的家**而不是误伤
  （两把各判不同的东西：前者管整张级联顺序，后者管这一家的两份齐不齐），恢复后 142/142、`git status` 无残留。
- 条数同步是**被机器逼出来的**，不是我记得改：加完第一条后 `node scripts/check-doc-numbers.mjs` 当场报
  「文档硬数字漂移 1 处：ARCHITECTURE-MAP.html 手写 218 = 现算 219」⇒ 按现算值改图那一格
  （这正是 AGENTS/记忆里"增删 Case 必须同批改图"那条规矩今天真的在生效的样子）。

### 量具 / 探针（A2：N19 当时记成"浏览器内没量过"的那一半，现在量到了）

- 新增一段 `node scripts/check-ui-runtime.mjs --only=pinkb`（8 条判据）：**真挂 `ChatWindow.vue`**，
  用 store 自己的 `enqueueMessage` 走生产那条路种一条置顶（不是手写 DOM），然后
  **真按 Tab** 直到焦点落进那颗「取消置顶」（读 `document.activeElement` 与 tagName=BUTTON）、
  聚焦后 `opacity` 为 1 且 `pointer-events: auto`、**真按回车**之后那一条真的从置顶条上消失（✕ 数 1 → 0）。
  最后带一次可逆单点变异：把那颗 ✕ 按回 `display:none`（= 旧那一族的藏法）⇒ 二十五次 Tab 都落不进去，
  撤掉内联样式又回到布局里 —— 没有这一格，上面那两条 Tab 判据可能是恒真的。
- ⚠️ 唯一的替身是 transport 边界那一条：`api.pinGroupMessage` 换成"立刻回一份形状正确的 pin 记录"。
  这不放松任何东西——真投递本来就不在这格的判据里（那是双实例 `--round=group` 的活），
  而替身之后 `enqueueMessage → foldPinned 折叠 → 置顶条重渲染` 每一步都是生产码。
  仍未证的只剩真机：键盘在 WKWebView / WebView2 上到不到得到（Smoke-11 那一档）。
- 同批改口三处，不留悬空指路句：`scripts/verify.mjs` 那一步的自描述与名字登记了 pinkb 段、
  roadmap N19 那一格把"浏览器内没量过"改成"已补上、只剩真机"、
  验收报告 §10 的 N19 那一条同样改口（那份报告正文其余部分一字未动）。
- ★ 本轮在这段探针上又踩了两次自己写过的坑，都写进代码注释：
  ① **模板字符串里的注释不许有反引号**（我为了"统一"把整段反引号一刀切掉，连定界符也删了 ⇒ 整份文件
  变成 Node 去 import `/src/api/index.ts`）⇒ 只准删**内容里**的，定界符要留；
  ② `cdp.eval` 的表达式少一个右括号会让**页面里**抛 SyntaxError，长得像"产品挂了"；
  ③ headless 动画时钟不推帧这条第二次照面（读到 opacity 0.967863）⇒ 这一段的过渡在读数前冻掉，
  并把"冻掉了"写进判据（`frozen === 1`），不然它哪天不生效也没人知道。
- 顺带一条环境事实：这一段第一次跑红在 `Port 5199 is already in use` —— 是本人前面被中止的探针留下的
  孤儿 vite（`lsof` 现读 ppid=1、命令行是本仓 `vite dev --port 5199 --strictPort`），
  确认身份后 kill 掉才继续；探针自己"vite 提前退出 1"这条报得对，红的是脚手架不是产品。

### 量具 / 文档（首轮验收报告补一节追加：N11 / N19 / N22 从"等人拍板"移进"已交付"）

- `docs/acceptance/native-experience-round-1.md` 末尾新增 §10：正文一字未改（含我自己数错的 21→29 与那条假"新增依赖"），
  只把三格的归属改到落地态 —— 桶的算术现算仍是 29：已交付 13→**16**、半落地 2→**1**（只剩 N27 真机那一半）、
  有阻塞 10→**8**。复跑 `grep -cE "^\|\s*(\*\*)?N[0-9]" docs/stability-roadmap.md`。
- 门禁读数换成这一轮现跑的：`npm test` 884 / 0 失败，designGuards 142 / 0 失败，
  全量 UI 运行时探针 **180/180**（新增的 `--only=imgskel` 那 7 条在内；CI 不跑这一层 ⇒ 属本地手工背书）。
- ⚠️ 唯一仍红的还是 Change Budget 判据 3（未推区间里 presentation 反复打补丁，本轮三笔都是 `Version-Bump: patch`
  ⇒ 这条被推得更深一点）；它没有自动出口，处置方式仍等负责人定。

## [4.33.42] - 2026-10-10

### 原生体验 / 应用代码（N11：平台与输入能力的判定收进唯一一个家，并加一条"视图层不许自己算"的判据）

- 逐类读完 `src/components` 里那批 `isMac|isIOS|isAndroid|isWindows|isMobile` 命中后归的家（**这条结论不是靠 grep 数量猜的**）：
  绝大多数走的是两个**既有正门** —— `app.isMobile`（useAppStore 那份"平台优先、宽度兜底"，Android 首启事故换来的顺序）
  与 `utils/platform.ts`；组件里**裸写**能力探测的只剩 1 处：`MessageReactionBar.vue` 自己调
  `window.matchMedia("(hover: hover)")`。而 CSS 该表达的那一族本来就在 CSS 里
  （`@media (hover: none)` / `(pointer: coarse)` / `prefers-*` / `env(safe-area-inset-*)`）。
- ① 那一处收进 common layer：`utils/platform.ts` 新增 `canHoverByMedia(mm)`（纯函数，可单测）与运行时 `canHover`
  （无 matchMedia 的环境按"无 hover"，与 isMac 同一套守卫口径）。判据走**媒体查询**而不是 UA：
  窄窗口的桌面仍是 hover 设备，宽屏的手机不是。
- ② 新判据 **designGuards ㉟** `findRawPlatformCheckInViewLayer`：视图层出现 `matchMedia(`、`navigator.userAgent`、
  `navigator.platform`、`navigator.appVersion`、`navigator.maxTouchPoints`、`@tauri-apps/plugin-os` 任一即报。
  三类注释（HTML / 块 / 行）各逐字符遮成空格后再扫 ⇒ "注释里提到这个 API"不再被当成作用点（㉝㉜ 同一课，行号不漂）。
  `navigator.clipboard` / `navigator.share` **不在名单**里：它们不是平台判定，扫它们就是造假红。逃生阀 `platform-check-ok`。
  真实树分母由用例自己打印（2026-10-10 现数：视图层 **80 份 .vue / 43 份走 common layer / 裸写 0 处**），
  变异对照把旧写法塞回组件当场报一条，反面三例（clipboard、行注释、逃生阀）都不报。
- ③ 顺带修掉一处**拿字面量当判据**的旧断言：`reactionRoster.test.ts` 原本钉的是组件源码里那串
  `window.matchMedia("(hover: hover)")` —— 那是"存在性断言"当守卫的半个守卫：**搬家搬得对它反而红**。
  现在钉的是"从 common layer 引 canHover"，而"不许自己算"那一半交给 ㉟（它有分母与变异对照）。
- 口径写进 `docs/design-guidelines.md` **§10.3.1「平台与输入方式只有一个家」**与 `platform.ts` 注释：新写的**先问 CSS 能不能表达**，
  只有 JS 逻辑必须知道这件事时才走 `utils/platform.ts`；布局模式一律 `useAppStore.isMobile`。
- ⚠️ 没做的那一半（如实记着，不是遗漏）：走正门的组件里仍有若干 `app.isMobile` 的三元 class 绑定
  （例如 `pb-[calc(4rem+env(safe-area-inset-bottom))]`）理论上可整族下沉成 CSS 变量 + 媒体查询，
  但那属于重写样式层、与"不进行大规模架构重构"冲突，且**没有一条测量**说明现在这样在真端上更贵 ⇒ 本轮不动。
- 门禁（2026-10-10 现跑）：`npm test` **884 例 0 失败**；UI 运行时探针 `--only=roster,reaction` **59/59**
  （这一处改动影响 hover 弹名单那条通道，所以跑的是那两段，而不是只跑新写的那一段）；
  `npm run verify` 唯一红仍是 Change Budget 判据 3（本轮开工前就红着，无自动出口）。

## [4.33.41] - 2026-10-10

### 原生体验 / 应用代码（N19：悬停才现出来的操作，键盘必须走得通）

- 原先四处"靠悬停暴露操作"逐处读过一遍，结论分两半：
  **TitleBar 那三颗不需要动应用码** —— `src-tauri/src/menu.rs:170-196` 的窗口子菜单本来就有 ⌘W / ⌘M /
  maximize / fullscreen，而 `lib_window_tests.rs` 的 `cmd_w_is_handled_by_our_own_menu_item` 钉着
  "⌘W 必须是我们自己的项"；把它登记成键盘缺口是我原先**没去查原生菜单那一层**留下的错。
  真缺口两处：表情回应入口写的是 `hidden group-hover/msg:flex`，而 `display:none` **连可聚焦性一起去掉** ⇒
  Tab 永远跳不到；取消置顶那颗是嵌在 `<button>` 里的 `span role="button"` 且没有 tabindex
  （折叠态与 `+N` 展开态**各一份** —— 展开态那份连 roadmap 都没数到）。
- 新开一家 CSS：`style.css` 的 `.kb-reveal`（常驻布局 + opacity 藏，悬停 / `:focus-visible` / `:focus-within`
  / `.kb-reveal-on` 显形，`pointer-events` 跟着开合）与 `.kb-reveal-on`（面板 teleport 到 body 时焦点不在
  入口自己身上，靠它保持显形）。触屏兜底同写在 `@media (hover: none)` 里，**opacity 与 pointer-events 两条都放开**
  （只放 opacity 就是"看得见却点不着"）。桌面"悬停才现"那句要求没变。
- 置顶那颗 ✕ 从"button 里套 role=button 的 span"拆成**同级真 `<button>`**（两份形状一致，折叠态带 `.kb-reveal`）。
- 护栏补的是**它自己缺的那一半**，没另开新号：designGuards ⑥ 原先判据是"role、tabindex、键盘事件任一命中就放行"，
  于是 `role="button"` 单独存在照样过 —— 而 role **不给可聚焦性**。现在静态 button 类 role 无 tabindex 且无键盘事件即报；
  动态 `:role` 不报（推断不出值），`contenteditable` 与 `role="dialog"` / `role="textbox"` 这类容器角色也不报
  （按 82 份 .vue 现数：收紧后只命中那颗 ✕；去管那两处就是造两条假红）。真实树分母现数 **10 个"非交互标签 + 动作 @click"**，全绿。
- `checkStyleCascade` 新增 ②-2b：`.kb-reveal` 必须有**两份**（块外的基础那份 + `@media (hover: none)` 内的兜底那份），
  少任一份都报；两份都拿真实 `style.css` 做单点删改实测会红。顺带把那条定位媒体查询的写法从
  `indexOf("@media (hover: none)")` 改成按形状匹配 —— **我新写的注释里就含这个字面量**，
  indexOf 落在注释上 ⇒ 真实文件当场假红（红的是判据自己）。
- 运行时探针 `--only=reaction` 加到 15 条（全段 180/180 绿）：**真按 Tab** 焦点落得进那颗入口、聚焦后自己显形、
  **真按回车**真打开表情选择器、面板开着时靠 `kb-reveal-on` 保持显形，
  并带「把入口按回 `display:none` ⇒ Tab 再也落不进去」的**可逆单点变异**（证明那条键盘判据会咬，不是恒真）。
- ★ 三条本轮现学的夹具事实（都写进了代码注释，别再重探）：① Enter 必须带 `text:"\r"` —— 本仓 `cdp.key`
  只有给 text 才补发 char，而 `<button>` 的回车激活走 char（只发 rawKeyDown+keyUp 时焦点在按钮上也不会有 click）；
  ② **headless 的动画时钟不推帧**：`.kb-reveal` 的显形带 transition，全量跑时 `getComputedStyle` 读到的是动画起点
  （单独跑 0.9987、整段跑 0，而 pointer-events 已是 auto —— 它不参与过渡），所以读数前把 transition 冻掉，
  这一格判的是级联规则落没落到元素上，不是动画本身；③ 模板字符串里的注释**一个反引号都不能有**
  （本轮踩了两次，两次都是整份文件语法错）。
- ⚠️ 没量到的那一半：置顶 ✕ 只在结构层（真 `<button>` + ⑥ 的真实树）与 CSS 家上守住，浏览器内没量过 ——
  它要 ChatWindow 配真置顶消息；键盘真机能到达 WKWebView / WebView2 一律未证（Smoke-11 那一档）。
  已知并接受的成本：桌面每条可回应消息多一个 Tab 停靠点。
- 文档：`docs/design-guidelines.md` §10.3 从"触屏那一半"扩成"触屏与键盘是两个缺口"，检查清单同批改口；
  roadmap N19 那一格换成落地态含复跑口径。

## [4.33.40] - 2026-10-10

### 原生体验 / 应用代码（原生体验 N22 剩下那半落地：图片行的"估算 288 / 骨架 128"两个数并成一个）

- 改的是一处**结构性不一致**：图片容器定宽 208px（`w-52`），载荷里**没有原图尺寸**
  （2026-10-10 现读三处：`useMessageFile.ts:41-52` 的兜底字段、`types.ts:220-228` 的 `FileMeta`、
  `src-tauri/src/commands/group_announcements.rs:318` 那份 `json!` ⇒ 只有 name/path/size/sha256/subtype），
  所以真实高 = `min(288, 208 × 原图高/原图宽)` 只能解码后知道；而骨架此前写死 `h-32` = 128，估算端写死 288
  ⇒ **每条图片行挂载即被实测纠正（点亮 `heightVersion` ⇒ 整表前缀和重算，N10 那笔账），加载完成再变一次**。
- 落法＝三个数收成一个：`utils/previewMetrics.ts` 新增 `IMAGE_BUBBLE_HEIGHT = 288`（估算 / 加载预留 / `<img>` 上限共用）
  与 `IMAGE_PLACEHOLDER_HEIGHT = 128`（终态紧凑占位）；`utils/messageHeight.ts` 删掉本地那份 `IMAGE_BUBBLE = 288` 改引常量
  （与 `MessageCodeBubble.vue:45` 用 `CODE_CLAMP_HEIGHT` 同一手法，本仓既有规矩）；
  `MessageImageBubble.vue` 的 `h-32` 与 `max-h-72` 两处字面量改成 `:style` 绑常量，图标 `h-6 w-6` 改 `size-6`；
  `MessageItem.vue` 那条「已被清理」占位同样改引 `IMAGE_PLACEHOLDER_HEIGHT`（并把那句"与骨架一致 h-32"的旧注释改对）。
- 得到的 / 付出的：顶到上限那一档（竖图 / 手机截图）**加载完成零跳变**，且挂载那一次不再需要实测纠正；
  代价换到横幅图那一侧（16:9 真高 ≈117px ⇒ 完成时收缩约 171px，原来是先空 160 再长 189）。
  这一取舍原记为"观感取舍 ⇒ 人工验收，不自决"，2026-10-10 由用户指名 N22 拍板 ⇒ 方向选"预留取上界"。
- 守面两条各挡对方挡不到的一半：`designGuards.ts` ㉞ `checkImageBubbleHeightSources`
  （图片盒里出现 `h-*` / `max-h-*` 高度工具类即报、估算端自留副本即报、没引常量即报；注释里的字面量不算，
  逃生阀 `image-height-ok`；真实树分母现数 图片盒 7 个 class 属性 / 0 处违规 —— **CI 跑这层**）
  + 运行时探针 `scripts/check-ui-runtime.mjs --only=imgskel` 7 条（挂**真组件**量**真矩形**：h=288 / w=208 /
  `<img>` max-height=288 / 落 failed 后 h=128，外加一次单点变异"把骨架按回 128 ⇒ 立刻判红"与它的可逆恢复 ——
  **CI 不跑这层**，两条合起来才覆盖完整）。
- ⚠️ 两条本轮现学的夹具事实写死在 `perf/README.md` 与本节，免得下一个人再试：
  ① "内容永不完成的 blob" 让 `<img>` 停在加载中是**错的** —— `URL.createObjectURL` 当场抛 overload，
  本探针第一次跑就是这条红的（红的是夹具不是产品）；② 隐藏态那张 `loading="lazy"` 的 `<img>`
  在这台账具的资源计时里出现 **0 次请求**，所以 failed 态由代投 `error` 事件走满组件自己的 5 档退避得到 ——
  **不许**据此推产品侧的懒加载行为。
- ⚠️ 仍未量：那一跳在真机上的毫秒代价（`perf/README.md` 已注明本台数字偏乐观）。固有尺寸那条杠杆仍按
  不可违反约束第 5 条排除（要动消息协议）。

### 量具 / 文档（原生体验 N10：把"50k 与 100k 之间那条折线"量到底，顺带发现**我公布的占比用错了尺寸**；**应用代码一字未动**）

- **补的是第八轮欠的那格**（"50k / 100k 两档的直接量"）。`PERF_ONLY=calib node perf/run.mjs <n>` 同机现跑：
  50k **3.5 ms**、60k **1113.7 ms**、100k **1899.2 ms**（同日另一批记的是 1831 ms，同量级）。
  ⇒ 拐点夹在 **5 万与 6 万之间**，"落在 5 万与 10 万之间"那句可以划掉了。
- ★ **我自己给的算术被这一档推翻**：分解"越过 `BUBBLE_CACHE_MAX` 后只有越界那 (n − MAX) 条每遍吃冷成本"
  预测 60k ≈ **380 ms**，实测 **1113.7 ms ⇒ 差 2.9 倍，这个分解是错的**。
  能站住的只到形状层：一越过上限，**每条均摊**统一跳到 18.5–19.0 µs（60k 的 18.56 与 100k 的 18.99 同档），
  总量随后随 n 线性走。`messageHeight.ts:79` 的 `= 50_000` 与拐点同值仍**只是数字吻合**——
  要证因果得把上限临时调到 12 万复跑，那是动被量对象的码、另起一轮 ⇒ 这一格继续记"未证"。
- 🔴 **改口的主体是我先前公布的那句占比**：`perf/README.md` 与 roadmap 原来写"20k 这一档（聊天页真实量级）
  整表重算 ≈2.6 ms，占一帧 16%"。**"聊天页真实量级"这半句是错的** ——
  `useChatStore.ts:911-912` 的 `PAGE_SIZE = 100` × `MAX_PAGES = 10` 把每会话加载上界钉死在 **1000 条**
  （`:617` 另写 `MAX_CACHED_CONVS = 8` 整块逐出），共享的 `bubbleCache` 最坏 ≈ 8000 个键，
  **离 5 万上限还有 6 倍余量** ⇒ 那条悬崖**产品够不到**；n=1000 的直接量是 **0.1 ms/整表一遍**。
  ⇒ N10 判"不动"的依据换成"**够不到**"而不是"占比小"，两处文档同批改口（同一句话复制在两处是老毛病，见 roadmap 该行）。
- 边界照旧：夹具页数字不是生产聊天页；只有 Chromium 一档；数字**不进门禁**，只作同机同构建前后对照。
- 门禁：`npm run verify` 17 步 = 16 绿 / 1 红（第 14 步 Change Budget 判据 3，HEAD 上就红）。

### 量具 / 文档（原生体验 N22 剩下那半：把"等一条判据"改成"已证明现有量具给不出这条判据"；**应用代码一字未动**）

- **这一格原本写的是"要先有一条「估算与实测一致」的判据才动"，读起来像方法还没定**。现读完夹具后改成有证据的结论：
  **那条判据不可能来自量具一**。证据三条（2026-10-10 现跑）：`img` 标签在 `perf/vlist.ts` 与 `perf/vlist.html`
  里**零命中**，`createObjectURL`、`.src =` 同样零命中（退码 1）；图片行实际是写死 `height:272px` 的占位 div
  （`perf/vlist.ts:157`）；而它上面那两行注释（`:153-154`）自己就写明"行形态与高度估算的假设对齐，
  否则重叠/空隙只是 harness 的 artifact"。⇒ 这里"实测 == 估算"是**构造出来的恒等**，
  拿 `accuracy()` 去证明"尺寸提示（width/height、aspect-ratio）补得对"是循环论证。
- **为什么值得单独记一次**：这不是"还没做"，而是**把一条会指挥下一个会话的前提证伪了** ——
  原本下一个人可能照着那句话去夹具上跑一遍 accuracy 并报一个数，那个数是假的（量的正是夹具自己的假设）。
- **阻塞口径随之改口**：从"方法未定" ⇒ "**本台结构上给不出这个读数**"，要动这一格需要真聊天页上真解码的图
  （需 Rust 后端与真数据），或给占位块注入真实固有尺寸的**另一条独立夹具**。
- 落笔位置：`perf/README.md`「与真实聊天页的差异」末尾新增 ★ 段（含复跑命令），roadmap §12.6.1 的 N22 那一格同步改口。
- ★ **同一次探针的第二半把生产侧几何读完了，并撤回我自己上一条给的理由**（这部分静态可判，不需要跑起来）：
  `MessageImageBubble.vue:97` 容器定宽 `w-52`（208px）+ `:120` 的 `max-h-72 w-full object-contain`（288px 上限）
  ⇒ **拉伸不会发生**，所以我上一条写的"补错方向会把图片拉伸，属正确性问题"是错的，当场撤；
  而 `:107-109` 的骨架是 `v-if` 的**另一个节点**（`h-32`＝128px），加载前 `<img>` 不在 DOM 里
  ⇒ 属性推出来的 aspect-ratio 无东西可预留 ⇒ **给 `<img>` 补 `width`/`height` 对这一格是惰性的（零作用）**，
  不是"有风险"。顺带算清不一致的形状：真实高度＝min(288, 208×原图高/原图宽) 而估算恒为 288
  （`messageHeight.ts:24-25` 配 `:99-100`）⇒ **288 是上界不是猜测**，只有高/宽 ≥ 1.385 的竖图落得准，
  横图与方图必然偏差；一条图片行从挂载到稳定至少两次高度变化（128 → 真实）。
  字号那侧不影响：`useAppStore.ts:329` 用 `--gosslan-msg-size`（px 变量）而不是 root font-size，
  `src` 下那两份 `.css` 里挂在 `html` 或 `:root` 选择器上的 `font-size` 声明现数 **0**。
- **两条"看着能改"的路都堵着**：① 把估算改小到 128 去对齐骨架 —— `messageHeight.ts:1-2` 那份契约写明
  低估会让相邻消息互相遮挡，等于把空洞换成重叠，是更坏的方向；② 让图片消息自带固有尺寸 —— 协议/存储字段，
  按不可违反约束第 5 条（不许为视觉效果动协议与数据库）排除。剩下的只有"换骨架占位策略"一条纯渲染改动，
  而"少一次跳变"对"每行多 160px 灰块"是观感取舍 ⇒ 记为人工验收，不自决。
- 边界：本轮**没有改任何应用码**（`<img>` 尺寸提示判为惰性所以不补；估算常量按上面的契约保持 288）；
  文档改动，不动应用码、不提版本号。复跑：
  `grep -n "w-52\|h-32\|max-h-72\|object-contain" src/components/message/MessageImageBubble.vue`。

### 文档（原生体验首轮建设的最终报告落地；**应用码一字未动**）

- 新增 `docs/acceptance/native-experience-round-1.md` —— 总指令 §十一 那九项的落点，并在 `README.md`
  的目录注释与 `docs/AI_ENGINEERING_INDEX.md` 里登记（**约束文档必须有入口，断链＝约束失效**）。
  它明写"未验证"的四档平台与"未测量"清单，不是验收通过文件。
- ★ **报告第一次现数把清单分母数错了 8 行**，落笔前自查抓到：清单行有**两种单元格形状**
  （N1–N8 是 `| N1 …`，N9–N29 是 `| **N9 …**`），按 `^| \*\*N` 数只看得见 21 行。
  正确口径 `grep -cE "^\|\s*(\*\*)?N[0-9]" docs/stability-roadmap.md` 现数 **29 行、编号 N1–N29 无缺号**。
  分桶随之改：已交付 13 / 结论是"不动"4（N8 N10 N13 N24）/ 半落地 2（N22 N27）/ 开着且有阻塞 10。
  这条口径连同"只按 `**N` 数会少 8 行"的提醒写进了 `AI_ENGINEERING_INDEX`，防止下一个 AI 再数错。
- 报告的依赖结论是**解析两份 package.json 比集合**得出的（`dependencies` 13→13、`devDependencies` 9→9，
  零新增零移除）；先前用 grep 数"依赖行"时 `"version": "4.33.39"` 会被误命中，
  那次假阳性（报成 1 条新增）已经写在报告正文里当作反面教训，没有抹掉。

## [4.33.39] - 2026-10-10

### 原生体验 N21 的另一半（领域 I）：把「顺手写回 `?? []`」钉成静态判据 ㉝ —— 一正一反都实测过；**动了应用码**

- **为什么必须补这一格**：上一版（4.33.38）落的是修复本身，守卫欠着。那处收益（真消息行一帧 27.6 → 16.6 ms）
  可以被一次 `:reactions="reactionMap.get(item.msg_id) ?? []"` 静默退回 —— 构建不报错、界面看不出、旧测试全绿，
  因为 `emptyList.test.ts` 钉的是**常量的性质**（同一对象、冻住），不是**调用点引没引它**。
- **新增 ㉝**（`src/utils/designGuards.ts`）：`findFreshEmptyArrayProp` 只看四个**列表型 prop 绑定名**
  （`:group-reader-ids`、`:reactions`、`:chips`、`:mention-names`），绑定值里出现 `[]` 字面量就报；
  `countListPropBindings` 打印这条尺子**看得见多少个绑定**（真实树那半的阳性对照 —— 名字被改掉时判据会瞎，
  分母必须自己说话）。名单外不管，避免误伤别处合法的 `[]`。
- **三条判据**（`src/utils/designGuards.test.ts`）：正向 3 处字面量报 3 条；反面三例（引共享常量 /
  名单外的 `:rows="[]"` / 写在 `<!-- -->` 里的字面量）都不报；真实树扫 `components/ChatWindow.vue` +
  `components/MessageItem.vue` 并断言违规为 0。本次现数读数 **2 份文件 / 7 个列表型 prop 绑定 / 0 条违规**。
- **一正一反交付**：单点变异把 `ChatWindow.vue:1266` 那处写回 `?? []`（其余一字不动）⇒
  `node --test --experimental-strip-types src/utils/designGuards.test.ts` 报 **134 项 / 133 过 / 1 红**，
  红的恰好是真实树那一条，且消息里直接点名 `components/ChatWindow.vue:1266`；
  用备份 `cp` 还原后 `cmp` 报字节一致，复跑回到 134/134。
- **反面用例当场戳出的一处真缺陷**（改的是判据不是数据）：第一版没遮注释，把 prose 里写的 `[]` 也算进分母，
  于是「注释里的字面量不许算」那条反面用例红给自己看了。修法沿用本文件 ㉜ 那条 `<img>` 判据的现成写法 ——
  把注释正文逐字符替成空格而不是删掉，行号才不漂。
- ⚠️ **这条判据买不到哪一半**（别读成「已锁死」）：
  ① 它判的是**字面量在不在绑定里**，不判**数组身份** —— 谁把它改成 `:reactions="reactionsFor(id)"`
     而函数里每次现造新数组，这把尺子看不见；那一半只有量具一（`?row=msgitem` 对 `?row=msgitem-const`）能量，
     而它是手动复跑、不进门禁。
  ② store 侧 `useChatStore.ts:739` 的 `groupReaderIds`「空则返回共享常量」**没有机器判据**：
     静态扫表达不了「空的时候必须是同一个对象」，要钉住只能补行为用例（调用它比 identity），
     而本仓 `src/stores/` 下现算 0 条 store 测试夹具 ⇒ 登记为剩余半边，不为这一格新建一层工程。
  ③ 它仍是**源码级**判据，不是界面证据（约束 9）：真聊天页帧数只有 Chromium 一档量过，其余引擎与真机未测。
- **版本**：`designGuards.ts` 按本仓 `isAppCodePath` 口径属应用码（`^src/` 且非 `*.test.ts`），
  与 N15/N16/N22 那三次同形 ⇒ 本版走 patch，五处版本号同提交。

## [4.33.38] - 2026-10-10

### 原生体验 N21（领域 D/E/I）：消息行那两条「每次都是新空数组」的 prop 收成共享常量 —— 真消息行一帧 27.6 ms 回到 16.6 ms；**动了应用码**

- **为什么不是 `v-memo`**：上一格只量到「真行比合成行贵 9.2~10.9 ms/帧」，没说清贵的**是哪一半**。
  现在同一台量具有第四档（`?row=msgitem-const`：props 对象仍然每次现构造，只把两条数组值换成共享常量），
  与旧的三档在**同一个 vite 进程、同一个 headless Brave、同一份构建**里逐档复跑
  （n=3000、每步 800 px、冷启动 60 步 + 向上 300 步、视口 22 行）：
  `synthetic` 16.7 → `msgitem` **27.6** → `msgitem-const` **16.6** ms（cold p50）。
  ⇒ 那 10.9 ms **全部来自数组身份**（`[] !== []` ⇒ Vue 浅比较恒判「这条 prop 变了」⇒ 整棵子树重新 patch），
  不是组件本身的渲染成本 ⇒ 补 `v-memo` 那张依赖清单**换不到东西**，而它有「漏一条 prop 就内容不刷新」的真实风险
  （本仓现场：`ConversationList.vue:525` 当年漏 `linkOf()`）⇒ **判为不做**，落这处小一倍的改动。
- **生产里恒新的就是两条**（逐条数过 `ChatWindow.vue` 那个调用点：其余 props 是 computed 或原始值）：
  `:group-reader-ids` 的 `.map()` 结果与三元 `: []`、`:reactions` 的 `?? []`；
  另有 `MessageItem.vue` 里 `:chips="reactions ?? []"` 与两条 props 默认值工厂各造一次。
- **改法**：新增 `src/utils/emptyList.ts`（一个家，两条**冻住**的空常量）+ 上面 5 处改指它。
  冻结是这处共享的唯一护栏：消费方全是只读（`MessageReactionBar` 用 `find`/`v-for`、`MessageReceipt` 用 `slice`/`length`），
  一旦有人原地改它，同一份脏数组会同时挂在所有消息上 ⇒ 宁可当场 `TypeError`。
- **验证（都在这一份工作树上现跑）**：`npm run verify` 16 绿 / 1 红，唯一那条红是 Change Budget 判据 3（在未推链上早已复现、非本次引入）；
  新增 `src/utils/emptyList.test.ts` 三条全过（同对象 / 冻住且原地 push 与 `length=1` 各抛一次 / `[] !== []` 那条语言事实）；
  `vue-tsc --noEmit` 与 `npm run build` 绿。**跨进程那一层（`--group local`）另跑，结论写在下面那条边界里。**
- **这台量具与这轮验证买不到的**（别从上面那行数字往下推）：① 三档读数来自**夹具页**，
  不是真聊天页（真页要 Rust 后端 + 真数据，本机没有 ⇒ 生产那一侧的帧数今天没有数）；
  ② 只有 Chromium 一个引擎，WebView2 / WKWebView / Android WebView 各自记未测；
  ③ p95 没回到同档（16.6/20.9 vs 合成 16.7/18.4）⇒ 尾帧还留着一条没归因的差；
  ④ **守卫缺口（诚实登记，本轮没补）**：没有任何判据挡得住「有人把那两处写回 `?? []`」——
  新测试钉的是常量自己的性质，不是那两行调用点。下一刀的形状＝`src/utils/designGuards.ts` 里一条
  「消息行调用点不许现构造空数组」的形状判据 + 一条会红的变异用例（照 N22 那条 <img> hint 判据的做法）。

### 量具 / 文档（原生体验 N21：真 `MessageItem` 那行的成本第一次有数，一帧 +9.2 ms 全部来自「props 每次都是新的」；**应用代码一字未动**）

- **给量具一加了两个档位**（`perf/vlist.ts` 的 `?row=`）：`synthetic` 是历史那套等价结构模板，
  `msgitem` 挂**真的 `MessageItem.vue`**、props 按 `ChatWindow.vue:1254-1269` 那个调用点的形状每次现构造，
  `msgitem-stable` 同一棵真组件但**按 msg_id 复用同一个 props 对象**。三档同机同构建同参数比。
- **2026-10-10 第一批对照（n=3000、每步 800 px、冷启动 60 步 + 向上 300 步、headless Brave、视口 12 行）**：
  cold p50 **16.7 → 25.9 → 16.7 ms**、cold p95 **18.3 → 30.3 → 18.9 ms**
  ⇒ 真消息行把每帧抬 **+9.2 ms（约 +55%）**，而**只把 props 换成稳定对象**就整格送回基线
  ⇒ 那 9.2 ms 不是组件本身的渲染成本，是「props 恒新 ⇒ 整棵子树重新 patch」的成本；
  N21 那处改动（给消息行补 `v-memo`）第一次有了**收益上界≈全部那 9.2 ms/帧**。
- **判定：登记为「值得做」，本会话不动应用码。** 真改动必须按语义数全**十条会变脸的 prop**
  （漏一条就是「内容变了却不刷新」，本仓有现场：`ConversationList.vue:525` 当年漏 `linkOf()`），
  且要配一条「每条 prop 都在 memo 依赖里」的守卫 ⇒ 单独一次改动、不与视觉同车（约束 10）。
- **这台量具买不到的三半**（写清楚防止从那张表往下推）：① `msgitem-stable` 是**上界不是方案** ——
  它永久缓存 props，会把已读人数/回应/置顶/高亮这些真变化一起冻住，且内存随条数涨，真 `v-memo` 不缓存对象；
  ② 只有 12 行在视口里，行数多的设备与大窗口绝对值更大；③ 无 Rust 后端时图片/文件行有 **4 条**
  被 catch 住的 `[filePreview] ... reading invoke` 日志（环境 artifact，也正好坐实了「合成档偏乐观」那句）。
- ★ **顺带记一条自己踩的形状**：想用的 `memo()` 在这个 Vue 版本**没有这个导出**，而**静态 import** 一个
  不存在的导出会杀掉整个页面模块 ⇒ 第一版**三档报的是同一个** `reading 'n' of undefined`
  （`window.__perf` 压根没赋值）。三档读数一样先怀疑探针，别写成「三档结果相同」（同一族教训：
  变异探针所有读数一模一样＝探针根本没生效）。改成动态 import 后 `synthetic` 档立刻恢复原读数。
- 性能数字**不进门禁**；这一档只在 Chromium 一个引擎量过，其余平台各自记未测。

### 量具 / 文档（原生体验 N26：长跑从「两个端点」扩成 12 个点中间序列，顺带修掉一条死读数；**应用代码一字未动**）

- **量具四加了一条开关**：`PERF_ONLY=mem PERF_MEM_STEPS=3000 PERF_MEM_BLOCK=500 node perf/run.mjs 20000`
  每 500 步采一次（默认仍是每方向 300 步＝旧那批端点形状，同条件可比）。它答的是 §七 第 10 项与 §八
  「长时间运行」那一格最难的一半 —— **有没有东西随步数上行**。
- **2026-10-10 现读（n=2 万、headless Brave / Chromium，上 3000 + 下 3000 步）**：GC 后堆在
  **7.15–7.26 MB** 之间来回、末值比首值**低 0.16 MB**；DOM 元素第一个点之后**恒 108**；
  `JSEventListeners` **十二个点全是 8**；长帧 up 0 / down 1；`offsetsRebuilds` 两方向各 ≈2698.7
  （每步一次整表重算，与 N10 同一条）。中间有一格 `Nodes` 瞬时 381、下一格立刻回 205 ⇒
  **那是瞬时读数不是台阶**（拿单点峰值当趋势是这一格最容易犯的错，写进 README）。
- **修掉一条死读数**：原先打印的 `churn.upFrames` / `downFrames` 读的是 `scrollTest()` 返回值里
  **不存在的 `frames` 键** ⇒ 永远是 `null`。一个从来不会非空的字段挂在输出里比缺字段更坏
  （读的人会以为"帧数没采到"）；现在打真有的 `steps / wallMs / longFrames / offsetsRebuilds`。
- **不动码**：这一格的答案是"没有随滚动累积的东西"，所以没有要修的东西 —— 量具的职责是把这句话
  从推断换成读数。
- **仍未测的三格照旧明写**：① **小时级**挂着不动的曲线（这台滚的是 100 s × 2 墙钟，
  要那条曲线得把 `PERF_MEM_STEPS` 提到 60000 量级另跑，**今天没跑过**）；
  ② 真图 / Blob-ObjectURL / **Detached DOM** 三个数本量具读不到（要 heap snapshot 解析）；
  ③ N23 那个预览缓存上限要等 ② 有数才定得下来。
  ⚠️ 这一档是**同一页已经滚过的状态接着滚** ⇒ 绝对堆高**不与同日旧那批（7.12→7.48）比**，
  它只判"这一跑内部有没有上行趋势"。性能数字一律不进门禁（随机器负载漂）。

### 量具 / 文档（原生体验 N25：「页面隐藏期间那条 5 秒刷新实际跑了几次」第一次有数；**应用代码一字未动**）

- **第七台量具落地**：`node perf/background.mjs`（新文件，零依赖、走 CDP）。它量的是 §七 必测行为第 7 项
  「应用后台恢复 / 页面重新显示」里**一直只有假设没有数**的那一半 —— roadmap N25 原先登记的不是"没跑过"，
  而是**连方法都没有**（那一格写的是"隐藏窗口 5 分钟，用开发者工具记录定时器触发次数"，那是给人做的动作）。
  现读（同一台 Mac、headless Brave、读**真实应用页** `/`）：前台 20 s 内 `useChatStore.ts:2228` 那条 5 秒刷新
  **4 次＝一条不差**；隐藏 330 s 内只有 **16 次**（按 5 秒应发生 66 次）—— **前 60 秒仍满速 12 次，
  节流落在隐藏后 60–120 秒之间，之后每分钟 1 次**；回到前台又 4 次。
  ⇒ 「要不要给它补 `document.hidden` 门」这条判定从"常识"换成有上界的实测：**最多省掉那 12 次往返**，
  之后浏览器自己就降到 1 次/分钟 ⇒ 维持"登记 + 不动 store"（约束 1/5），`useChatStore.ts` 一字未改。
- **阳性对照 = 注册本身**：开跑先要求看到一条 `delay=5000` 且回调源码含 `Topology` 的注册，
  看不到就退 1 打印"读数作废"。没有这一条，「隐藏期间 0 次」和「这条定时器在这一环境压根没起来」完全同形。
  成立前提也写进文档了：`App.vue:86-93` 两条 init 各自兜底（`app.init()` 失败也照样跑 `chat.init()`），
  所以浏览器里没有 Rust 后端也能走到注册那一步。
- **两把独立的尺互校**：页内 shim 记的回调次数（在应用脚本之前包一层 `setInterval`，只转发、注册一次）
  与 CDP 侧 `Runtime.exceptionThrown` 的条数（完全不碰页面）**逐档相等 4/4、16/16、4/4，
  连 30 秒一段的增量都相等**；修尺子前后两跑的数字全同 ⇒ 这台量具读数可复现。
- **顺带接上「页面重新显示」**：两向翻档各投递到 **1 次** `visibilitychange`。
  ⚠️ 那只代表"事件到了这一页"（量具自己那只监听记的），**不证明**应用侧 `onVisibility` 那条自愈路径跑对了 ——
  那一半仍归 N20 与真机。
- **这一台自己修过的四处尺子**（形状比结论更容易复发，逐条写进 `perf/README.md`）：
  ① shim 第一版先 `real.apply` 注册一次、改完 `arguments[0]` 又注册第二次 ⇒ **双重注册，次数假一倍**；
  ② 窗口级异常计数只取末段 `drain` ⇒ 打印成"16 次触发 / 0 条异常"，看着像两把尺打脸，实际逐段相等；
  ③ 「翻进隐藏那一次 `visibilitychange`」的取样点放在翻转**之后** ⇒ 那条计数**结构性恒 0**，
  第一版据此几乎要写成"事件没投递到页面"（第 37 条那个"判据非空转要先跑坏版本"的老形状，这次是我自己的取样点）；
  ④ 速率拿"窗口秒数"当毫秒除 ⇒ 印出 **2909 次/分钟** 这种荒唐数，改成一律用真实墙钟现算。
- **两处会漂的手写台数就地改掉**（都是我自己前面几轮留下的）：`perf/README.md` 开头那句「两台量具」
  换成**七条清单本身当分母**（新增一台就往这里加一行），另一处「数一下文档里有几个 `## 量具` 小节」
  判成**假尺**（量具三/四 不是那个形状、量具一还有自己的子小节，数出来是假数）⇒ 改成指向那份清单。
  另：CHANGELOG 历史条目里把 `calibrate()` 错叫成「第四台量具」（它是量具一的第四个 API，`mem` 才是第四台）
  —— 只改这一处措辞，条目不搬。
- **边界（读到这里要停手）**：① 只有 **Chromium 一个引擎**，WebView2 未实跑、WKWebView / Android WebView
  的后台定时器策略各家不同，一条证据都不许外推（约束 12）；② 「另开一张标签遮挡」≠ 桌面窗口最小化
  ≠ 移动端切后台（后两者还叠加"WebView 有没有被系统整个挂起"）；③ 性能数字**不进门禁**（随机器负载与
  浏览器版本漂），只作同机同构建的改前/改后对照。

### 量具 / 文档（原生体验 N29：低性能设备那一档第一次有数；**应用代码一字未动**）

- **第六台量具落地**：`PERF_ONLY=throttle node perf/run.mjs`（走 CDP `Emulation.setCPUThrottlingRate`）。
  §七 必测行为第 9 项「低性能设备上的关键交互」此前 perf/ 四台的帧数**全是这台 Mac 满速下的数** ⇒ 那一格没答过。
- 现读（n=2 万、每档 up+down 各 150 步、**每个条件先重载再设速率**）：基线 p50 16.6 / 长帧 0；
  降频 4× p50 54.9（up）/ 49.6（down）、长帧 132 与 49；降频 6× p50 77.4 / 84.6、长帧 **149/150 两方向都是**。
  三档的 `offsetsRebuilds` 与 `estimateCalls` **逐字相同** ⇒ 慢机器不会让它多算，只把每帧按比例抬贵；
  而这一条路径上**没有任何为低性能设备准备的降级**（无自适应档位），掉帧就是线性放大。
- 自己抓出并修掉的量具缺陷：第一版不重载页面，降频档白拿到基线刚暖好的行高缓存
  （`offsetsRebuilds` 21.19 vs 基线 131.82 —— 看着像"降频后少干了 6 倍活"，其实是暖缓存假象），
  且基线只跑了 up 一个方向。现在每个条件都冷启动、up 与 down 各一遍、顺序逐字一致。
- 阳性对照沿用「定长工作」思路：`calibrate(3)` 在降频后必须真的变慢（实测 2.46× / 4.79×，判据 > 1.5×），
  不采信就退 1 报「读数作废」。⚠️ 也因此「4×/6×」只能读成两档递进，CDP 倍数不等于标称倍数。
- **N10 那一格补一条边界**（不推翻结论）：它原先那句「快机上重算只占一小截」用的是快机的数；
  现在有降频档的按比例推算（6× 下整表重算约 13-14 ms/帧、占 77 ms 的五分之一，大头仍是渲染与布局）⇒
  「不值得动 VirtualList」这个结论不变，但它依赖的前提第一次被写清了。
- `design-guidelines.md` §11.5 流畅度那格的「测不到的」跟着改口：低端设备从「未测」改成
  「只有同机模拟降速的数（含 4×/6× 两档），实机仍未测」。数字**不进门禁**。

### 量具 / 文档（原生体验 N28：窗口缩放不跳位第一次有运行时读数；**应用代码一字未动**）

- **第五台量具落地**：`PERF_ONLY=resize node perf/run.mjs`（`perf/run.mjs` 新增一支 + `perf/vlist.ts`
  多一个 `?fit=1` 档位）。它量的是 §七 必测行为第 7 项「窗口缩放」里 **N9 那两条自检看不见的那一半**：
  容器跟上视口之后，用户正在读的那一条会不会被跳走。
  现读（同一台 Mac、headless Brave `--disable-gpu`、n=2 万，两跑）：视口 900→560→900→1200 四档，
  阅读态锚点行与它的亚像素偏移 **四档全同**、`scrollTop` 一字未变；贴底态 900→420→1200 三档 `bottomGap` 恒 0
  ⇒ 这一态本来就是对的，**没动一行组件码**，量具的职责是把它钉住。
- **阳性对照 `linkageOK`**：缩放后容器 `clientHeight` 必须真的变过，否则整轮读数作废并退码非 0。
  没有这一条，「锚点没跳」完全可能来自「根本没缩放过」——`fit=1` 之前那个形状（容器写死 700px）
  是**结构性测不到**，不是"测过没问题"。
- **一处我自己写错的名字已改**：第一版把"撤掉 CDP 视口覆写之后"那一格命名成 `back900`，实测撤覆写后轮询
  12×500ms `innerHeight` 仍停在 1200（`afterClearVp.landed=false`）⇒ 改名并如实打印 `landed`，
  把「回到真实窗口尺寸那一态仍未测」写进 `perf/README.md` 与 roadmap N28，不留一个错名字当判据。
- **`design-guidelines.md` §11.5 两处过期声明在同一提交里改口**：流畅度那格补上「无布局跳跃」现在有现算判据；
  稳定性那格原写「长时间运行后的内存曲线：未测量」，已被 2026-10-10 的量具四推翻 ⇒ 改成
  「600 步已有数 + 小时级长跑 / 真图 / Detached DOM 三格仍未测」。
- **顺带抓到一条一直在待推链上的红（不是本次改动引入）**：`npm run verify` 第 3 步「不变量钩子守卫」
  报 `INV-P31:1305 钩子解析失败：不认识的钩子形态「docs/design-guidelines.md」`。
  现算归属：`git show 1fc30e9^:docs/protocol-invariants.md` 里那一行**已经带着**那个反引号 token ⇒ 红早于本次；
  只在整跑快速层时才露出来（之前跑的是 `--only` 子集）。
  修的是**文档不是判据**：钩子行只留两个真会跑的名字，§11.6/§11.9 那两处散文口径挪回正文并注明
  「不是可跑钩子」。修后 `node scripts/check-invariant-hooks.mjs` 退 0、打印「31 条全部绑定」。
- 性能数字**不进门禁**（随机器负载漂，钉成红只会造出假红），只作同机同构建改前/改后对照。
- **另一条红如实记在这里（不是本次引入，也没被本次洗白）**：`npm run verify` 第 14 步 Change Budget 判据 3
  在**当前 HEAD** 上就报 `presentation：最近 5 个修补形状提交里出现 5 次`（现跑 `node scripts/check-change-budget.mjs`
  退 1，范围 `origin/main..HEAD`）。逐条对过那 5 条改的产品文件：`src/components/message/*.vue`（N22）、
  `MobilePageFrame/FavoritePanel/BaseModal`（N16）、`ChatWindow.vue`（置顶行热区）、`BaseModal.vue`（焦点归还）、
  `style.css`（选中色）—— 是同一个「原生体验」工程里 5 格互不相干的格子，不是互相修；但其中 `BaseModal.vue`
  确实被两条各自改过一次（安全区 / 焦点归还，两个行为）。**门禁令没被改动、提交没被改写**，
  要不要按它建议③「拆独立分支」由负责人定；本轮之后剩下的格子要么阻塞在真机要么等拍板，不再往里加 presentation 补丁。

### 量具 / 文档（原生体验 N26：内存与长时运行第一次有量具、有数；**应用代码一字未动**）

- **第四台量具落地**：`PERF_ONLY=mem node perf/run.mjs 20000`（`perf/run.mjs` 里新增一支，走 CDP 的
  `HeapProfiler.collectGarbage` + `Performance.getMetrics`，**不给页面加任何钩子**）。
  现读（同一台 Mac、headless Brave `--disable-gpu`、n=2 万，两遍逐字段一致）：连滚 600 步，
  堆 GC 后 **7.12 → 7.48 MB**（第二轮只 +0.05）、DOM 元素 **60 → 120 后第二轮一格没动**、
  `JSEventListeners` **三轮都是 8** ⇒ 这条路径上没发现随滚动累积的东西；
  ⚠️ 这只到 600 步，**小时级长跑仍未测**，真图与 Blob/ObjectURL 条目、Detached DOM 这三个数本量具读不到。
- **量具自己坏过一次，形状是"字段名写错就长得像正常"**：`Listeners` 这台 Chrome 根本没有（真名
  `JSEventListeners`），读回 `null`、两减之下 delta 还是 0 —— **看起来完全正常**。与 §INV-P31 那条
  "假绿"家族同形，已写进 `perf/README.md` 量具四那一节。
- **roadmap N26 那一格**从「未测量（方法也未定）」改成「方法已定 + 第一台量具已跑」，
  并写明还欠哪两半。性能数字**不进门禁**，只作同机同负载前后对照。

### 量具 / 文档（原生体验领域 I 补测 + N12 第一次有数；**应用代码一字未动**）

- **第三台量具落地**：`perf/latency.html` + `perf/latency.ts` + `perf/latency.mjs` ——
  CDP 真鼠标事件打到一个真实挂起来的 `BaseModal`（带 pinia、带 `@/style.css`），量「`click` 被交付 →
  弹窗面板第一次带上计算样式那一帧」。今天首跑（同一台 Mac、headless Brave、`--disable-gpu`、vite dev）：
  基线 n=12 **p50 15.5 / p95 17.4 ms**，100 ms 长任务对照 n=6 **p50 102.6 ms**（位移 87.1）⇒ 灵敏度对照过、
  出帧自证过（截图 6/6、窗口内 rAF 29 次）。roadmap 的 **N12 从「未测量」改成有数**；分辨率就是一个采样帧（≈16.7 ms）
  这条限制写在 `perf/README.md` 量具二那一节，防止被读成帧内快慢。数字**不进门禁**。
- **量具自己坏过五种形状**都记进了 `perf/README.md`，并把「吞掉自己判据的输入 = 造假红」与
  「一次性 rAF 探针证明不了这段时间在出帧」两种形状补进 **INV-P31 规则 4**（那条原本只写了"要先自证出帧"，
  没写自证本身会怎么坏）。
- **领域 I（性能/内存/渲染）审计登记为 N21–N27**，六条待办 + 一条非缺陷：消息行没被 `v-memo` 挡且两条 prop
  每次父级渲染都是新构造的（N21，成本未测量）、图片行没有固有尺寸提示而估算是常量 288（N22）、
  预览缓存无容量上限且 `filePreview.ts` 里没有真正的 revoke 出口（N23，内存占用未测量）、
  **行内不存在过度绘制**（N24 判为非缺陷并作废"该加 `will-change`/`contain`"这个念头）、
  5 s 拓扑刷新不看 `document.hidden`（N25，代价未测量，`LogViewer.vue:107` 是做对的对照）、
  内存与长时运行**连量具都没有**（N26）、减少动效在自动化层无判据（N27）。
  没量的格子一律写"未测量"，没编数。
- **减少动效那一条从"没测"变成"有一半数"**（roadmap N27 改成半开）：`perf/latency.mjs` 加了一组
  `Emulation.setEmulatedMedia` 对照，判据三件一起 —— 仿真点亮、**撤掉要能退回**（退不回来就是恒真判据）、
  同一个元素的计算时长必须跟着变。2026-10-10 实测：**reduce 档 p50 14.5 / p95 15.6 ms ⇒ 关掉动画之后反馈仍在同一帧里**，
  "操作不依赖动画"这句第一次有了运行时依据。明确记下这台量具**买不到的那一半**：它没证"那 150 ms 进入过渡被缩短"
  （时长只挂在过渡类名上，落定之后读回 `0s`），而且它在 perf 台、不进门禁；门禁层与真机 WebView 两半仍开着。
- 这组判据自己红过两轮，两种坏法都进了文档：在落定之后读过渡时长 ⇒ 把**生效的仿真判成空转**；
  用 `([0-9.]+)(ms|s)` 解析时长 ⇒ 浏览器回的是 `1e-05s`，被读成 `05s` = 5000 毫秒。
  INV-P31 规则 4 那条「自证侧形状」清单因此从两种扩到**四种**（新加的两条：吞掉自己判据的输入；
  把仿真落点建在一个时长只在过渡期间存在的元素上），并写下那句通用教训：**探针报"某样东西不存在"之前，先证"我读的那一刻它本该在"**；
  完整清单在 `perf/README.md`（那份会一直加，所以这里不写条数）。
- **门禁层那一半补上了（N27 由"仍欠"改成"已做"）**：`scripts/check-ui-runtime.mjs` 的 `runOverlay` 加了 **E 组** ——
  用 `Emulation.setEmulatedMedia` 把 `prefers-reduced-motion` 设成 reduce，然后判**这一档下一处浮层还能不能用**：
  打得开（`dlg=1` 且焦点入内且面板 `opacity=1` 且几何在视口内）、真点 ✕ 关得掉且 DOM 撤净且 `body`/`html` 样式回基线、
  **✕ 与 Esc 两条路径都**把焦点还给那颗按钮、关掉后同一坐标再真点仍打得着（`hitId=opener` ⇒ 没留下"看不见但接得住点击"的壳）、
  撤掉仿真能退回普通档那份。现算：`--only=overlay` **41/41 绿**，**整支全段 166/166 绿** ——
  后一条不是顺手跑的：这一组动的是**会话级**仿真，而 emoji / search / taskCard 共用同一个页面会话，
  只有整段复跑才证得明"这次开关没漏进后面的段"。
- **两轮单点变异各自跑过**（防恒真）：只把仿真那一发摘掉 ⇒ **恰好红 1 条**（那条自证）；
  只摘 `BaseModal` 的 `@after-leave` ⇒ **红 5 条**（A、B、D 加 E 的两条焦点判据），其余一条不动 ⇒
  reduce 档的焦点归还确实还挂在过渡**结束事件**上，不是绕道过去的。
- 又抓到一处**我自己编的规矩**（同一条教训第五天再犯）：E 组第一版把仿真自证写成"打开态面板时长 <1ms 且普通档 ≥1ms"
  ⇒ 报红。真相是面板那 150 ms 只挂在 Headless UI 过渡期间临时加的类上、落定就撤，**普通档落定态本来就是 `0s`**。
  出口不是放宽阈值，是换一个恒被系统偏好作用到的节点当落点（`body`：那条 `*{… !important}` 对它同样成立），
  并把面板那两份读数**降级成打印**——因为它们测的是"有没有那条 !important"，不是"那 150 ms 被缩短了"。
  ⇒ "那 150 ms 真被缩短"这一句现在仍写成**未证**（要证得趁过渡进行中采样）。
- 这一层的边界同时写清了三处，防止被读成"减少动效已全面验收"：`verify.mjs` 里探针是 **local 组**、
  **CI 不跑这一层**（`:519` 原话）⇒ 别写成 CI 判据；**WKWebView / WebView2 / Android 有没有把系统级偏好传进 WebView 仍零证据**（归 Smoke-11）；
  Tailwind 的 `motion-reduce:` 变体仍 0 处，但**不为其另起第二处家**（全局那条 `*` 已覆盖）。
  roadmap 的 **N27** 因此从"门禁层仍空"改成"perf 层 + 本地门禁层都有数"，**N12** 那句"①减少动效模式在自动化层是空的"
  随这条一起改口（它已被 E 组 + perf 台的 reduce 档 p50/p95 收掉，只剩真机那一半）。
- **顺手撤掉一条我自己写错的登记（N19）**：那一格原先写的是"桌面端 Tab 到悬停才现出来的操作时，那层**可聚焦但隐形**"，
  并给了"一条 CSS 家加 `:focus-visible` 就能修"的方向。逐处读了四处真实用法之后这句站不住：
  `ChatWindow.vue:1148-1156` 那颗取消置顶 ✕ 是 `span role=button` **且无 tabindex**、还嵌在 `<button>` 里 ⇒ 键盘到不了它
  （焦点落在外层"跳到原消息"的按钮上，所以不存在"焦点环打在空气上"）；`TitleBar.vue:195/212/233` 三颗同样是 `span` 无 tabindex；
  `MessageItem.vue:1124-1132` 那排是真 `<button>` 但写的是 `hidden group-hover/msg:flex` ⇒ `display:none` 也不可聚焦。
  ⇒ **今天没有任何元素同时满足"可聚焦 + 被这两个类藏起来"**，那条 `focus-visible` 规则加下去就是死代码，
  按约束 11 不加没有作用点的东西。N19 已就地改成"键盘根本进不去"，并把两半各自需要的改动与硬约束写清：
  ① `MessageItem` 要从 `hidden` 换成 `opacity-0` 系（布局中性，那颗是 `absolute`）才能既保持"悬停才现"又可聚焦 ——
  但它桌面靠悬停是用户明确要求，现行键盘入口是消息右键菜单，换不换**待拍板**；
  ② 置顶那颗 ✕ 要键盘可达就得加 `tabindex`（= button 里套可聚焦交互元素，语义不合法）或拆成同级兄弟 ⇒ 结构改动。
  两半都没实测过。
- **量化验收表（`docs/design-guidelines.md` §11.5）整段换成今天现跑的数**，并把两个单位坑写进口径列：
  ① `du -sk dist`（按文件系统块 = **2828 KB**）与逐文件字节求和（**2,479,504 B ≈ 2.4 MB**）差约 15% 是块大小不是体积涨了；
  ② chunk 大小直接引 vite 自己那行打印（十进制 kB + gzip：**297.66 kB / gzip 90.09 kB**），
  自己换算成 KiB 会变成 291 —— **那不是回归，那是单位**。同批：`npm test` **861 例 0 失败**（这条为写进文档专门复跑过，
  `ℹ tests 861 / pass 861 / fail 0`）、19 个 js 合计 **973.1 KiB**、依赖 **13 运行时 + 9 开发**、**动画库 0 项**（13 个名字逐条读过）。
  响应性那一格从"没有量具，记未测量"改成引 `perf/latency.mjs` 的基线与 reduce 档 p50/p95，
  没测到的那一半（真机 WebView）搬进右列，并带上那句限制：**这台量具分辨率就是一个采样帧（≈16.7 ms）**。
- **写进文档的复跑命令自己也坏过一次，而且是落笔当天跑出来的**：那一格原先给的依赖数是
  `node -e "...console.log(p.dependencies.length, p.devDependencies.length)"` —— `dependencies` 是对象不是数组，
  原样跑印的是 `undefined undefined` ⇒ 改成 `Object.keys(...).length`，并把这条坑写在同一格旁边。
  既有纪律是"写进文档的复跑命令要落笔前当场原样跑一遍"，**这次它抓到的正是我自己刚写下的那一格**。
- 一次**自己对自己文档的破坏**也被当场发现并修好：改 §11.5 那两行时，编辑锚点跨过了相邻的「稳定性」与「无障碍」两行而新文本没带上它们
  ⇒ **两行被删掉**（数据行 6 → 4）。发现靠的是改完重读那一节，不是靠任何信号：**表格剩下四行结构完全合法、渲染看不出破绽，
  而 `git diff` 里那两条 `-` 混在一次大块替换中间** —— 没有任何守卫会为台账少两行变红。
  处置：从 `git show HEAD:` 取原文逐字节插回，再按内容锚逐行核未转义竖线数（每行应=4）与 `**` 配平。

## [4.33.37] - 2026-10-10

### 移动端 / 列表（N22 最小一步：消息行的图片不再吃同步解码）

- `src/components/message/` 下 **10 条**行内 `<img>` 补上 `loading="lazy"` 与 `decoding="async"`
  （头像 ×3、行内表情 ×3、表情回应、合并卡片预览、转发列表、图片气泡本体）。
  只用浏览器原生属性：**零新增依赖、零新增 CSS、不改布局**（这两个属性不参与尺寸计算）。
  `ImageLightbox` 那一条**显式豁免**（`img-eager-ok` + 就地写了理由：那是用户主动点开、不在列表里的一张，
  懒加载只会让它更晚出现）。
- 新护栏 **㉜ `findMessageImageWithoutFetchHint`**：扫每条真实存在的 `<img>`，缺哪个 hint 报哪个。
  **真实树那条的范围＝`src/components/message/`**（会被虚拟列表反复挂载的那一层）；`message/` 之外那几十条
  `<img>` 不在这条管线下 —— 它们不在滚动热路径里，要不要收另说，不把"全仓都守住了"写成结论。
  两处尺子自己的坑都在实现里写明了：注释里提到的 `<img src>`（`MessageImageBubble` 的文档注释就有）**不算分母**；
  属性值里的 `>`（`:style` 里的 `scale > 1`）会把正则 `[^>]*` 截断 ⇒ 用引号状态机找闭合，并配了一条专门钉这个的测试。
  持久变异用例进 `guard_cases/frontend_ui.py`（全库 217 → 218，契约图那一格同批）。
- ⚠️ **收益没有量**：这条判据钉的是「这两个属性不许有人漏」，不是「省了 X 毫秒」。
  真实节省要在真机与带图片的滚动场景测（N26 那格连方法都还没定），所以本行不写任何毫秒数。
  下一步（没做）：图片行的固有尺寸提示 —— 那才是会让整表重算点亮的那一半。

## [4.33.36] - 2026-10-10

### 移动端（N16 底部安全区）+ 领域 I 的 N10（整表重算第一次有数）

- **N16 落地**：三处整屏形态（`MobilePageFrame` overlay / `FavoritePanel` 详情 / `BaseModal` 全屏态）此前
  只写 `pt-[env(safe-area-inset-top)]`，底部没人读 ⇒ 滚到最后一行落在 iOS Home Indicator 底下。
  修法用仓库既有两种写法（工具类 `safe-bottom`、`pb-[max(env(...),原本内距)]`），**没有新增 CSS、没有新增依赖**；
  `max()` 那条保证桌面 `env()`=0 时结果仍是原本那 12/16px ⇒ 桌面视觉零变化（这一半是本机推的，不是量的）。
  工单原方向里"另两处收进 `MobilePageFrame` 这一个家"**没做**，理由与影响面写在 roadmap 那一格。
- **新护栏 ㉛ `findTopInsetWithoutBottomInset`**（`designGuards.ts`）：真实树扫每个写了顶部安全区的 `.vue`，
  没写底部就红；夹具含**两种合规写法**（分母不空转），逃生阀 `safe-area-ok` 只给确实只画顶部的组件
  （例：`ToastHud` 那种飘条）。持久变异用例进 `guard_cases/frontend_ui.py`（全库 216 → 217 条，契约图那一格同批）。
  非空转实测：摘掉三处底部内距 ⇒ 真实树那条 1 红（其余 126 条不动），装回 ⇒ 127/127。
- **N10 用数字判成"不动"**：给 `perf/vlist.ts` 加了 `calibrate()`（量具一的第四个 API）（直接把整表估算一遍、5 遍取中位，
  跑法 `PERF_ONLY=calib node perf/run.mjs 20000`）。现读 20k **2.6 ms**（约一帧的 16%）/ 50k **3.5 ms** /
  100k **1831 ms** —— 真实条数下重算不是帧成本主导项 ⇒ 不为它动 `VirtualList`（约束 7）；
  同时记下 50k→100k 那条**非线性折线**和它的**未证成因**（候选：`bubbleCache` 容量上限），
  并把原先那个"推出来的" `offsetsRebuilds` 是推不是量的事实写进 `perf/README.md`，防止被读成测量。

## [4.33.35] - 2026-10-10
### 交互 / 触屏（原生体验领域 G 补测：一颗 16px 的按钮点不中，而守卫本来就看不见这一档）（N15）

- 审计口径是**真实存在的组件**，不是清单：把 `src/**/*.vue`（82 个文件）全扫了一遍
  「小尺寸 + 可交互 + 没 `tap-safe`」，分母现算是 **4 个标签** ——
  `ChatWindow.vue:1148`（置顶行那颗就地取消置顶的 ✕，`h-4 w-4` = 16px）+ `TitleBar.vue:184/201/218`
  三颗 macOS 红绿灯。后三颗只吃鼠标、且各自带 `.traffic-hit` 的隐形热区扩展，不算触屏缺陷
  ⇒ 真正要修的只有那 1 处（子代理把 GroupTasksBoard 也报成缺陷，读源码后撤销：那一颗本来就写了 `tap-safe`）。
- 根因不只在那颗按钮：**守卫 `SMALL_SIZE_RE` 的字面量只列了 `h-5..h-8 / w-5..w-8`**
  ⇒ 16px 那一档整档不在扫描面上。所以这一格是「一处漏 + 一把尺子的量程上限」，
  只补按钮不放宽尺子，下一颗 16px 照样静默过关。
- 两处一起动：那颗 ✕ 补 `tap-safe`（`:pointer: coarse` 下垂直热区 +16px ⇒ 16→32）；
  尺子放宽到含 `h-4 / w-4`，守卫文案补上量具买不到的一半
  ——「h-4 加了 tap-safe 也只有 32px，且 `tap-safe` **只撑垂直方向**，横向热区仍等于可见盒」。
- 判据（一正一反 + 真实树）：夹具里 `h-4` 无 `tap-safe` 报 1 条、加了报 0 条；
  真实树那条 `src 下所有小尺寸可交互元素都带 tap-safe` 继续恒绿。
  **反向对照跑过**：把 `tap-safe` 摘掉 ⇒ `npx tsx --test src/utils/designGuards.test.ts`
  122 pass / **1 fail**，红的恰好是真实树那一条 ⇒ 放宽后的尺子不空转。
- 门禁：`npm test` ⇒ **861 pass / 0 fail**（上一轮 859，+2 就是这两条新判据）；
  `npx vue-tsc --noEmit` ⇒ 0 报错；`npm run build` ⇒ 通过；`python3 scripts/verify-guards.py --list` ⇒ 退 0。
  依赖零变化。**产物体积没做改前/改后对照 ⇒ 这一格不引数字**（不是"没涨"，是没量）。
- 登记（同一次审计里没修的那些，全部在 `docs/stability-roadmap.md` §12.6.1 续到 N20）：
- 同一轮还做了一次**收敛**（纯文档，不动版本）：表现层交互的四条规则原先散在 design-guidelines §11 与 roadmap 的 N 行里，现在收进 `docs/protocol-invariants.md` 的 **INV-P31**（悬停揭示的非悬停可达路径、小尺寸热区与它那把尺子的量程边界、关闭之后的两个终态、量具先自证在出帧）——`presentation` 域的不变量第一次有了家。
  N16 全页浮层只吃顶部安全区不吃底部、N17 Android 键盘补偿是假设不是量出来的、
  N18 `h-dvh` 与裸 `inset: 0` 没有 `@supports` 兜底、N19 桌面端 Tab 到悬停揭示的操作时那层是隐形的、
  N20 四处根/单例监听器没配对（无故障证据 ⇒ 本轮不修，理由写在那一格）。

## [4.33.34] - 2026-10-10
### 界面 / 交互（原生体验 N14：弹窗关闭之后把焦点还给打开它的那个元素）

- `BaseModal` 之前只管把焦点**收进**弹窗（Headless UI 的焦点陷阱），关完之后
  `document.activeElement` 落在 `body` —— 键盘用户关掉一个弹窗，Tab 序列就从头开始。
- 修法：`open` 变真时记下 `document.activeElement`（`body` 不记 ⇒ 程序化打开是 no-op），
  在 `@after-leave` 的 `nextTick` 里、且只有焦点确实掉到 `body` 时才 `focus({ preventScroll: true })` 还回去。
  时机选 `afterLeave` 而非 `open` 变假的那一刻：早一步 `Dialog` 还挂着，
  它自己的 FocusSentinel 会把刚设的焦点抢回弹窗内部。`preventScroll` 是为了不引入滚动跳跃。
- 判据（不是静态断言）：`node scripts/check-ui-runtime.mjs --only=overlay` 三条红绿判据
  分别钉 Esc / ✕ / 生产形状宿主这三条路径关完之后 `activeElement == 那颗触发按钮`。
  **反向对照跑过**：摘掉 `@after-leave` 绑定再跑 ⇒ 29/32，红的恰好是这三条，其余一条不动。
- 修后实测：overlay 段 **32/32 条绿**（这一段从上一轮的 19 条长到 32 条）。
  影响 26 个 `BaseModal` 调用方；**WKWebView / WebView2 / Android 未实测**。
  整链复跑（同一条命令不带 `--only`）：`node scripts/check-ui-runtime.mjs` ⇒ **158 ✅ / 0 ❌**，
  现算正好 = 上一轮那 155 条 + 本节这 3 条焦点判据 ⇒ 上一节那句「155/155」是加这三条**之前**的形状。


### 测试 / 门禁（原生体验审计第三轮：**上一轮那条 P1 是我量错的**，overlay 段 19 → 30 条判据）

- **撤销一条登记为 P1 的缺陷**：「✕ 关完之后 portal 里留一层看不见但吃掉点击的浮层」（四处现场，
  含生产形状宿主）**不是应用的行为**。`--headless=new` 的探针页 `visibilityState=hidden`、
  静止时不出帧，而 Headless UI 的过渡收尾靠 `disposables.nextFrame`（两层 `requestAnimationFrame`）
  ⇒ leave 停在同步的第一步（类名停在 `leave-from`：`duration-150 ease-in opacity-100 scale-100`），
  壳一直挂着。**`src/components/BaseModal.vue` 一字未改**（26 个调用方共用的外壳没动）。
- 决定性的一读是**同一次关闭、同一时刻读两遍**（`runOverlay` 的 B 组那条读数）：
  【只等不泵】`dlg=1` 且面板类名停在 `leave-from`；【泵帧之后】`dlg 1→0`、`open=false`、`portal=0`。
  泵帧 = 用 `Page.captureScreenshot` 强制走一遍"更新渲染"，rAF 在那一步里跑。
- 探针里落下三件常驻东西：`boot()` 那条「量具在出帧」（泵 6 次截图期间 rAF ≥ 2 次；
  **这条红是量具红，不是产品红**，但必须报出来）、`readAfterClose()`（先泵帧再读）、
  帧计数器做成 `__ovFrameStart/Stop` 两段式而**不返回 Promise** —— 返回 Promise 那一版
  在冻住的页面上把整个探针挂死过（那条 await 就是当时的现场）。
- 原先四处只以 `⚠️` 打印的读数**全部升成红绿判据**：✕ / 连开关 3 轮 / 生产形状 / 真按一次后退
  四组都判「关掉之后 DOM 撤干净」+「同一个坐标再真点打得着那颗按钮」。
  中途我自己写过一条"关掉之后再点必须把弹窗打开"的断言，红了两处 ——
  那是**我编的规矩**（A/B/C 那三组的按钮由探针翻 prop 打开、不接 `click`），已改成判命中本身。
- 复跑与现算：`node scripts/check-ui-runtime.mjs --only=overlay` ⇒ **30/30 条绿**；
  八段全量 `node scripts/check-ui-runtime.mjs` ⇒ **155/155 条绿**；`npm test` ⇒ **859 pass / 0 fail**。
  ⚠️ 上一节里那两个数（19/19、144/144）是同一批命令在上一轮的形状，**以本节这两个为准**。
- 文档：`design-guidelines.md` §11.9 改写为「先证帧在出，再谈还剩没剩」（命中测试那条规则保留）；
  `stability-roadmap.md` §12.6.1 的 **N13 判成结案（量具坏）**，N14（关完焦点落 `BODY`）
  与出帧无关、仍开着 —— 那一刻 `dlg=0`，是没人负责还焦点。
- **仍未证的一半**：真机（WKWebView / WebView2 / Android）上"关闭那一刻窗口被遮挡 ⇒ rAF 停"
  会不会留下同样的中间态、以及窗口重新显示时会不会自愈，没测过；人工步骤归 Smoke-11。


### 测试 / 门禁（原生体验审计第二轮：领域 F「弹窗、菜单与覆盖层」换成运行时判据）

- `scripts/check-ui-runtime.mjs` 加第八段 `--only=overlay`（真鼠标 + 真键盘 + 真命中测试），
  并且**每一组自己起一次页面**（A 打开态与关闭 / B ✕ 与快速连开关 / C 连开关 / D 生产形状），
  一处红不许污染下一组的读数。这一段自己跑 **19/19 条绿**，含两把反面对照：
  「关掉之后同一个坐标再按 ⇒ 必须真打到那颗按钮」（证明"不穿透"那条的零次不是坐标选错）、
  「弹窗已关时再按 Esc ⇒ 不多冒一条 close」（证明判据读的是真事件，不是任何按键都记一笔）。
  八段全量复跑：`node scripts/check-ui-runtime.mjs` ⇒ **144/144 条绿**（段与段互不串味）。
  判到的东西包括：弹窗挂进文档根的 portal 且全页只有一份、面板矩形落在视口内、焦点落进弹窗内、
  遮罩真的挡得住那颗背景按钮（`elementFromPoint` + 真按下）、点遮罩恰好一条 close、
  Esc 关得掉且 `html overflow` / `body[style]` 回到基线、连按 5 次 Tab 焦点没跑出弹窗、
  打开往真 `history` 压一条且连开关 3 轮不漏条目（Android 返回键不用按好几下）。
- ★ 同一段**实测到两处缺陷并登记**（读数以 `⚠️` 行打印，不当判据 —— 钉成红就是一条红，
  修的那一次一起钉）：**N13** 弹窗由宿主翻 `open` 关完之后，portal 里留一份 `opacity:0`（看不见）
  但 `fixed inset-0` 包裹层仍 `pointer-events:auto` 的浮层，同一坐标真点**打不到底下任何东西**
  （四处现场，含"真点击开、slot 里有内容"的**生产形状**；而 Esc 与点遮罩那两条同一天实测是干净的）；
  **N14** Esc 关完之后焦点落在 `BODY`，没还给触发按钮（那一刻 DOM 已撤干净，与 N13 无关）。
  证据、复跑命令、影响面与"下一步只能动外壳嵌套结构"的边界写在
  `docs/stability-roadmap.md` §12.6.1 的 N13/N14。
  规约新增在 `docs/design-guidelines.md` §11.9：**关闭的验收要按"同一坐标再真点一次打不打得到"来写**，
  且两条关闭路径（Headless UI 自己那条 / 宿主直接翻 `open`）都要量，只测一条必然漏。
- 试过并**已回退**的一种修法：把 `open` 镜像成内部 `shown`、关闭时延一个 tick 再翻
  （想复现"Esc / 点遮罩那条为什么干净"）⇒ 三处读数一字不变 ⇒ 假设被证伪，`BaseModal.vue` 一字未改。

## [4.33.33] - 2026-10-09

### Fixed

- ★ **选中色与原生控件强调色此前"写了但没生效"**（#35-N7 那一格，`src/style.css`）。
  根因不是没写，是**放错了地方**：`::selection` 与 `accent-color` 两条被写在
  `input,textarea,select,[contenteditable]{…}` 的**括号里面**。原生 CSS 嵌套会把它们编译成
  **后代**选择器 —— `input ::selection, textarea ::selection, …`（输入框没有元素子节点）
  和 `[contenteditable=""] progress{…}` 这类形式 ⇒ **整条匹配不到任何东西**。
  实际后果：选中消息文字永远是浏览器默认蓝（深色面板里既不跟手又刺眼），
  复选框 / radio / 进度条也没吃到主题强调色。修法是把两条各自放回顶层，**值一个字节没改**
  （"半透明叠加 + `color: inherit` ⇒ 不改文字颜色、不绕过 `tokenContrast`"那个设计照旧）。
- **同批把那条判据换了形状**：旧的只正则扫源码"有没有写 `::selection`"，而本次缺陷恰恰是
  "写了、扫到了、判据绿了、界面上没有" ⇒ 那道判据对本次故障是**空转的**。
  新增 `designGuards::findNestedThemeRuleIssues` 改判**嵌套深度**（`::selection` 选择器必须在深度 0、
  `accent-color` 必须待在一个顶层规则里），`@media` / `@supports` 的括号不计深度
  ⇒ 媒体查询里合法写 `::selection` 不被误伤。四组用例一正一反：真实 `style.css` 必须 0 条、
  当时那个嵌套形状必须恰好报 2 条（反向用例就是当时的真实代码）、两条都缺也报红、媒体查询写法不误伤。

### 验证（这一格读源码看不出来，必须看产物）

`npm run build` 后现读 `dist/assets/boot-*.css`：`::selection{background:color-mix(…)}` 与
`input,select,textarea,progress{accent-color:var(--gosslan-primary)}` 都是**顶层**规则；
后代残留检索为 False。复跑：`npm run build && grep -c "input ::selection" dist/assets/*.css` ⇒ 应为 0。
门禁：`npm test` **859/859**（比上一版多的 4 条就是上面那四组）、`vue-tsc` 0 错误、
`node scripts/check-doc-numbers.mjs` 通过。

⚠️ **仍未实测的一格**：选中色在真机 WKWebView / WebView2 上的实际观感，以及半透明选中底色压在
自定义气泡底色上够不够醒目 —— 产物层证明了"规则会生效"，"好不好看"要人眼看（本机锁屏取不到帧）。


## [4.33.32] - 2026-10-09

### Changed

- **表情面板 300px 高度这一格结案**（用户 2026-10-09 看过两行标题之后的行数，判定"高度没问题"）。
  4.33.31 那条里我写的是"行数少了多少留给真人与肉眼判，不在这里猜" —— 现在判过了：**不加高，300 不动**，
  这条不再是悬着的待办。组件注释里那句仍然留着，因为它说的是"作者为什么没量"，不是"谁欠着一件事"；
  真正会漂的是"要不要抬高度"这个决定，所以决定记在这里（`docs/` 与 `*.md` 不计入改动预算，
  而改 `EmojiPicker.vue` 里那行注释要按判据 4 再花一个补丁号 —— 为一个结论花一次发版不值）。
  要推翻它只需要看这一条 + `--only=emoji` 那 27 条运行时判据（列数、标题落点、可视行数都在里面）。
### Fixed

- ★ **虚拟列表的「可视区高度」现在跟着容器真实高度走**（原生体验审计第一项，`src/components/VirtualList.vue`）。
  根因只有一条：`viewport` 这个虚拟化输入**只在 `onMounted` 和 `window` 的 resize 上更新**，
  而容器自己变高变矮没有任何人读 —— 移动端软键盘弹出、断点切成整页形态、常驻辅助窗口重新显示、
  面板开合挤压布局，这四类路径都不发 `window:resize`。输入停在旧值时两个方向都是缺陷：
  旧值偏大 ⇒ **整表都被算成"可见"（全量渲染）**，旧值偏小 ⇒ 滚到下方出现空白。
  修法就一处：给容器挂一个 `ResizeObserver`，尺寸真的变了才走既有的 `onResize()` 那一个出口。
  ⚠️ **`clientHeight` 为 0 时不写入**（常驻窗口关闭即隐藏 / `display:none`）—— 写进去会让可见区间塌成空，
  与 `commitHeight` 拒绝 0 高度是**同一个失败方向**，保留上一个可用值等重新显示时再更新。
- **压测台自己坏了，而且坏了很久**（`perf/vlist.ts` + `perf/probe.mjs`）：压测页从来没加载应用样式，
  于是 `overflow-y-auto` 只是个死类名、那个容器**根本不是滚动容器** ⇒ `scrollTop` 写入被浏览器整轮忽略。
  症状是"滚动帧间隔 p50 = 16.7ms 满帧"，而 16.7ms 正是一个**什么都不做的空闲帧**；
  同一份报告里那句"`estimateHeight` 调用次数 0 ⇒ 稳态滚动没有整表重算 ✓"同样作废 ——
  **调用数为 0 不是因为不重算，是因为根本没滚动**。现在补上 `import "@/style.css"`，
  并让 `probe.mjs` 在采数之前先打印 `scrollerReal`（写一次 `scrollTop` 读不回同样的值就是量具坏）。

### 实测（同一台机器、headless Brave、dev 构建；复跑见 `perf/README.md` 的三步）

| | 改前 | 改后 |
|---|---|---|
| `renderedRows` / `virtualizationOK`（n=2 万） | **20000 / false** | **12 / true** |
| 因果对照：合成一次 `window:resize` | 立刻塌成 15 行 | —— |
| 滚动 120 帧 × 800px | 无法测（没滚过） | p50 **16.7** / p95 **17.6** / max **18.2** ms，`longFramesOver50ms` **0** |
| `offsetsRebuilds`（整表前缀和重算） | 无法测（没滚过） | **117.02** ⇒ ≈ 每帧一次 |

- **这一格还开着，且这次没动它**：重算每帧一次还没浮出成本，靠的是 `bubbleCache` 把每次估算退化成哈希查找，
  **挡住它的是缓存不是算法**。10 万档这一轮 `run.mjs` 在 180s 超时**没跑完**，
  归因未定（可能是重算随规模线性放大，也可能是 harness 又开了一个 10 万行的页），
  按"没实测过就不算结论"登记在 `perf/README.md`，不许从这里读出"10 万会卡"。
- 未验证：真机 WKWebView / WebView2 与 Android WebView 上的滚动表现（`docs/acceptance/stability-smoke-matrix.md`
  那一格没变），以及移动端软键盘弹出时容器变高的**现场**（本轮证据来自压测页改容器高度 700→300→700，
  行数 15→11→15 正确跟随，是浏览器不是手机）。
- 门禁：`npm test` **855/855**、`vue-tsc` 0 错误。

## [4.33.31] - 2026-10-09

### Changed

- ★ **表情面板的两段各有一行小标题，且「全部表情」那一节恒在**（用户 2026-10-09 拿参照图定的：
  「最常使用 / 全部表情」那种分块，并明确「在没有常用数据的时候，常用表情模块消失只有全部表情」）。
  - 上一轮只给常用那一节加了标题、矩阵那一节没有 ⇒ 两块只靠"上面那行有标题、下面没有"分，
    读起来像"常用 + 一堆没归属的格子"。现在矩阵那一节也有自己的标题（新词条 `emoji.all`
    =「全部表情」/ "All emoji"，两份语言同时加，`i18n/index.test.ts` 的键集相等判据管着）。
  - **「全部表情」恒在、没有门槛**；「常用」仍然只在真攒出常用时出现。
    这一条是这一轮唯一真正新增的语义差别，判据两侧都钉：正向钉插在两段交界的
    `v-if="i === grid.frequentCount"`，反向钉"不许把恒在那一节也挂上 `frequentCount` 条件"。
  - 结构上仍是**一个网格、一条 `cells` 序列**：标题插在 `i === frequentCount` 那一格之前，
    没有为矩阵另起一支遍历（`emojiUsage.test.ts` 那条按形状数网格的判据原样成立）。
  - 面板高度**没有**跟着加高（300 不动）。加高会动"输入框上方要留多少空间"那个已知边界
    （验收矩阵 §19 缺口④：composer 那一支从来没有挂载态的运行时测量），
    所以"两行标题吃掉多少可视行数"留给真人与肉眼判，不在这里猜。
  - 运行时探针表情段 20 ⇒ **27 条**：新增"两行标题的顺序 / 都不是 button /
    「全部表情」的 y 夹在两段之间"三条，并加了**第二趟**——重新加载页面、清掉本机账再装一次组件，
    量"没有常用数据"那一档（只剩一个标题、格子数正好等于全表、第一个子元素是标题不是格子、
    列数仍是 8）。第二趟必须重新 navigate：`usage` 是在 setup 里一次性读 localStorage 的，
    装完再清账不会让已经挂起来的面板退回去；而在同一页里再装一次会留下第二个面板，
    `buttons()` 会把两块的格子混着数。
  - ⚠️ 本轮自己踩到的一条锚点错：判"标题元素不是 button"时拿裸串 `t("emoji.frequent")` 去
    `indexOf`，先撞上的是**脚本里**那句读屏标签（`常用 · [微笑]`），切出来的"元素"根本不是标题
    ⇒ 判据当场假红。改成锚模板插值那种写法 `{{ t("emoji.frequent") }}` 才对。
  - 复跑：`node --test src/utils/emojiUsage.test.ts` ⇒ 21/21；
    `node scripts/check-ui-runtime.mjs --only=emoji` ⇒ 27/27；
    四条单点变异（恒在那一节被挡 / 标题整个删掉 / 标题换成 button / 交界锚被改）逐条报红。

### Added

- ★ **表情面板两段划分的两条新判据登记成永久非空转用例**：护栏总数 214 ⇒ **216**
  （现算 `grep -h '^    Case(' scripts/guard_cases/*.py | wc -l`；契约图统计卡同批改，判据 E 对账）。
  `python3 scripts/verify-guards.py --only=emoji` ⇒ 5/5（上一轮那三条 + 本轮这两条）。

## [4.33.30] - 2026-10-09

### Added

- ★ **群任务看板每一行前面加了两枚小图标：优先级 + 类型**（用户 2026-10-09：
  「任务列表的前面可以加一些小图标，显示出优先级 类型各种不同的区别，形象表达直观理解」）。
  这一格以前是**空的**：优先级在看板上完全不显示（只有聊天气泡里那一行文字），
  类型只藏在编号首字母 T/R/B 里。
  - 优先级 ↑ / — / ↓（紧急 / 常规 / 不急），只有「紧急」上主题色；
    类型 ☑ / 💡 / 🐞（任务 / 需求 / 缺陷），需求走主题色、缺陷走 danger-ink。
    两张配色表加在 `todos.ts` 已有的那几张 `TODO_*_CLASS` 旁边，
    字形表加在看板里已有的 `STATUS_ICON` 旁边 —— 都没另开一家。
  - **三档一律画**，不给缺省那档留空：2026-09-30 在类型角标上已经为同一件事被纠正过一次（㉔）。
    区分度放在**形状**上，颜色只负责把「紧急」「缺陷」提出来。
  - 悬停词复用已有的「紧急/常规/不急」「任务/需求/缺陷」六个词条 ⇒ **零新 i18n 词条**；
    图标本身 `aria-hidden`（这件事文字层已经说了，读屏再念"向上箭头"是噪声）；
    图标**不可点**，改档位仍在详情弹窗 ⇒ 零新交互面、零新字段、零 Rust 改动。
  - ⚠️ 两枚各包一个 `<span>` 才挂 `:title`：`<svg>` 上的 `title` **属性**在部分内核里不出提示。
  - ⚠️ 类型会在这里出现两次（图标 + 编号字母）：字母是**口头引用的编号**，INV-P29 要求它在，
    不能为了不留重复而拿掉。两枚挨着放，读作一个整体。
  - 新增判据 ㉙（`designGuards.test.ts`）+ 一条永久非空转用例：护栏总数 213 ⇒ **214**。
    它守三件事，其中两件是这一格特有的坑：
    ① 两枚图标各档都在（`PRIORITY_ICON` / `CATEGORY_ICON` 三档齐全）；
    ② **`<component :is>` 会绕过 `componentImports` 那条判据**（它数的是模板里的 PascalCase 标签）
      ⇒ 表里写错一个图标名不会报错，只会那一格静默消失，所以这里把两张表的取值逐个钉成
      "确实在 lucide 的 import 行里"；
    ③ 两枚都不许被 `v-if` / `v-show` 挡起来。
  - ⚠️ 这条判据的**第一版太宽**：它禁的是"文件里出现 `category ===`"，于是把
    `canClaim` 里那句正当的 `x.category === "requirement"`（认领只开给需求）判成了红。
    尺子宽到咬合规写法，下一个人的处置就是把它改松 ⇒ 判据反而没了。改成只圈两枚图标
    **自己那一段**，并在同一条测试里配**反方向**的空转对照：坏形状必须被抓到、
    `canClaim` 那种正当条件必须不被抓到。
  - 三条单点变异逐条报红（图标名从 import 里删掉 / 加 `v-if` 只画紧急 / 配色表删掉 `low` 一档），
    并登记为 `python3 scripts/verify-guards.py --only="看板行首的优先级图标"`。
  - **观感仍未经运行时验证**：看板要 chat store + 群成员 + 提及上下文，探针现在挂不动它
    （挂起来红的是夹具而不是产品）。这一格和它上面那排图标的**好看与否**一样，归真人与肉眼。

- ★ **搜索那两条修复补上了真渲染的运行时判据**（同一批用户反馈，从"静态 + 单测"升到 DOM 层）。
  探针的 search 段以前夹具**三条全是 `kind: "text"`** —— 和 `chatSearch.test.ts` 犯的是同一个盲点：
  「载荷型 kind 渲染成人话」这件事从没被真渲染过一次。现在混进任务与图片两种卡片 kind，
  钉两条：整页文字里不许出现 JSON 片段、且必须真出现「[任务] …」与「[图片]」；
  再真点一次「发送人」筛选入口，读菜单**计算后的 background-color** 必须不是透明 ——
  ⚠️ 读的是背景色而不是 class 列表，"挂着 frost"与"有底"是两件事（同一类错本轮在表情那格也抓到一次）。
  焦点必须还回输入框：方向键与回车都挂在 `<input>` 上，点过菜单不还焦点，
  下面那批键盘判据会红在夹具上而不是产品上。
  两条都配了单点变异证明会咬：注回直接铺载荷 ⇒ 探针红；注回没底 ⇒ 恰好那一条红。
  整条链 `node scripts/check-ui-runtime.mjs` ⇒ **118/118**（search 段 9 ⇒ 13）。

## [4.33.29] - 2026-10-09

### Added

- ★ **AOCI 手册新增 §8「重新索引：走哪条路、会撞到什么、怎么处理」**（`docs/aoci-usage.md`）。
  起因是今天把本机二进制从 v0.1.0-rc17 升到 rc18、照官方说明跑 `init` 与 `scan`，两条**都被拒**，
  而拒的那句读起来像工具坏了。这一节把「重新索引」拆成三件不同的事（日常补条目 / 刷新收录与基线指纹 /
  整份推倒重写），再列出本仓（Volumes v1、基线已建成）**实测会被拒的六条命令与它们的报错原话**：
  `init`、`scan`、`scan --dry-run`、`index inventory|update|score|agent plan`、`status --deep`
  是同一条 `error_code=config`；`baseline scope plan` 是另一条退 2 的
  `baseline_scope_managed_scope_unsupported`。⇒ **`--dry-run` 在这个仓不是安全的只读 scan**，
  只读收录权威只有 `aoci scope preview`；`scan --force` 那句「未处理的漂移会被洗白」是真话，别顺手加。
  - 另附三张对照表：finding 五类里**只有 `code_stale` 与 `code_missing` 是活**（今天实跑合计 308 项里
    `code_skipped` 占 282，全是二进制/超 1 MiB 的合同免条目；`observed_pending` 那一格在等**人**复核，
    机器永远等不出结果）；写条目被拒的七个错误码与出口；以及「什么才算做完」（`verify` 双 true →
    `check` 退 0 → `guide` 的 `stage=aligned`）。
  - 升级那一节还钉了一条今天踩到的环境形状：**MCP 握手探针必须 `sleep 8`** —— server 起来要先把整仓
    收录跑一遍，`sleep 2` 会得到 `保留的机器事实：EOF` 与零输出，读成「配置没生效」就跑偏了。
  - 这一节里 4 条命令块都**从仓根原样跑过、退码全 0**（跑法：按「## 8. 重新索引」切段，正则取出所有
    三反引号 bash 围栏逐个丢给 `bash` 执行并打印退码与首行）。另按本仓改 markdown 台账的老规矩复查了
    加粗星号逐行配平与表格列数：全文 0 行星号不配平、9 个表格块无列数劈裂。


### Fixed

- ★ **搜索聊天记录：结果行不再铺 JSON 载荷，两个筛选菜单补上底**（用户 2026-10-09 一句话说完的那一屏）。
  - **根因有两层，887477e 只堵了上面那层**。那次修的是"本机**不认识**的 kind"（对端版本比本机新），
    而 `image / file / merge / todo / todo_update / poll / poll_vote / announcement` 这**六种认识的**
    kind 载荷本来就是 JSON，`ChatSearchDialog` 的 `cellText` 当时仍然 `? m.content :` 直接交给界面
    ⇒ 认识的这六种任何一种命中，界面上就是一整段花括号。
  - 做法不是再写一个摘要函数：把 `previewText` 里那张「kind → 人话」表**抽成**
    `previewBody(kind, content, textLimit = 30)`，`previewText` 变成它的默认档包装。
    摘要/通知/置顶条仍截 30 字（行为一字未动），检索行传 `0` 不截 —— 因为那一边要在正文里
    定位关键词，截了 `hitSnippet` 与高亮就没有落点了。
    判据是**双向**的：一条钉"六种卡片 kind 一律给人话、不许出现花括号或 JSON 引号"，
    一条钉"textLimit=0 时正文不截而卡片分支不受它影响"，还有一条钉"两家同源"（防日后有人再抄一份表）。
  - **透明那半**：`.gosslan-menu` 只声明尺寸/内边距/描边/圆角/阴影，**底在另一个类 `.frost` 上**
    （`style.css` 里两条规则，所以漏一个类不会有任何报错）。全站六处容器里五处成对写、
    搜索面板那两个筛选菜单两处漏 ⇒ 菜单文字与底下的结果行叠在一起。
  - 新增守卫 `findMenuWithoutBackdrop`（`designGuards.ts`）+ 全站扫描那条：⚠️ **按词匹配而不是按子串** ——
    `.gosslan-menu-item` 与 `.gosslan-menu-hint` 里也含 `gosslan-menu` 这几个字符，
    子串匹配会把每一个菜单项都判成缺底的容器（全站假红）。反空转那半固定成用例：
    给一段只有菜单项与提示行的源码必须报 0 处。
  - **仍然欠的一半，别读成"搜索的显示问题都修完了"**：SQL 检索的是**载荷原文**
    （`db/messages.rs` 的 `WHERE content LIKE ?1`），而人话那一行只展示卡片里被画出来的那个字段
    （任务=标题、投票=问题、公告=正文）。所以关键词若只命中**没画出来的那一格**（任务的描述、
    文件的 `sha256`、投票的某个选项），行会正常显示一句人话但**没有高亮**，看起来像误命中。
    要补的是"检索面 = 展示面"那一层（改 SQL 侧的检索列，或让预览带上描述），本轮没做。
  - 复跑：`node --test src/utils/messages.test.ts src/utils/designGuards.test.ts` ⇒ 219/219。

- ★ **图片预览独立窗口按显示器居中；所有辅助窗口一律钳进那块屏**（用户 2026-10-09：
  「把窗口上移到屏幕靠上，打开预览图片 窗口会有一部分展示在屏幕外面」）。
  - 根因不是"居中公式写错了"，是**那条不变式的适用时刻**：`aux_window_fits_inside_the_main_window_and_is_centered`
    钉的是"子窗口永不比主窗口大"，而它只在**创建那一刻**成立 —— 预览窗口常驻（`AUX_PREVIEW_RESIDENT`），
    复用路径 `show_existing_aux_window` 刻意**只重摆位置、不重算尺寸**（留住用户自己拉过的大小，
    2026-09-21 那条口径）。于是主窗口后来被拖小、或被拖到屏幕靠上，按主窗口外框算出的居中位置
    就会顶出屏幕；而这五扇全是 `decorations(false)`，**掉出去那一截没有把手能拖回来**。
  - 两件事分开做：① **所有**辅助窗口在摆位后统一钳进"主窗口所在那块屏"的 `work_area`
    （用 work_area 不用 size，否则 macOS 上会压住菜单栏；正常情形下这一钳是空操作）；
    ② 只有**预览**把参照物从主窗口换成那块屏的工作区居中 —— 它设计尺寸 1120×820 比多数主窗口还大。
    另外四扇仍以主窗口为参照物，那是 2026-09-16「新窗口没居中、而且比主窗口还大很多」定下来的口径，
    本轮**不跟着改**（判据里点名钉住了：那四扇 + main 传进 `aux_centers_on_monitor` 必须全 false）。
  - 退路写成三级：主窗口中心所在屏 → 本窗口当前屏 → 主屏 → 拿不到就保持旧摆法。
    ⚠️ 参照物取**主窗口**而不是预览自己当前所在那块屏：常驻窗口可能还留在上一块屏上，
    拿它自己就等于把 2026-09-16 那个"弹到另一块屏"的错误固定下来。
  - ⚠️ **这一条的接线判据是变异抓出来的，不是先想到的**：把 `recenter_aux_window` 里
    `clamp_pos_into_rect(base, outer, r)` 整段换成 `base`，纯计算那两条判据**全绿** ——
    因为它们测的是我新写的那两个函数，坏掉的是"谁调它们"。补了
    `recenter_aux_window_actually_uses_the_placement_rules`（读 `logs.rs` 源码切片，
    与 `lib_window_tests.rs` 里"每个 ensure_* 体必须含 `apply_aux_geometry(`"同一家风），
    切片自己带两条反空转：不许吃进下一个函数、必须含 `set_position`。
  - 现读：`cargo test --lib` ⇒ **776/776**（+2）；`npm test` ⇒ **853/853**（+5，表情那五条）；
    `npm run verify` 快速层 **17 步全绿**；`cd src-tauri && cargo fmt --check --all` 0 处差异；
    `cargo clippy --features bluetooth -- -D warnings`（= CI 那一条）0 红；
    `node scripts/check-ui-runtime.mjs` ⇒ **113/113**（表情那一段 13 ⇒ 20，见下面那条）。
  - **本轮没做真机验证**：预览窗口的实际落点要真把主窗口拖到屏幕靠上再开一次图片才看得见，
    而 WKWebView / WebView2 那一半不在浏览器探针的等价范围内（验收矩阵 Smoke-11 的边界行）。

- ★ **上面这些新护栏都登记成了永久的非空转用例**（不是一次性脚本）：护栏总数 206 ⇒ **213**
  （现算 `grep -h '^    Case(' scripts/guard_cases/*.py | wc -l`；契约图统计卡那一格同批改，
  判据 E 对账通过）。逐条走完「改坏 → FAIL → 恢复 → PASS」且红由声明的那条判据报出：
  `python3 scripts/verify-guards.py --only=search` ⇒ 4/4（含一条同标签的既有用例），
  `python3 scripts/verify-guards.py --only=emoji` ⇒ 3/3，
  `python3 scripts/verify-guards.py --only="预览摆位的钳制"` ⇒ 1/1（Rust，走 cargo 重编译）。
  - ⚠️ 其中那条 Rust 用例**就是本轮变异抓出来的缺口本身**：把 `recenter_aux_window` 里的
    `clamp_pos_into_rect(base, outer, r)` 换成 `base`，两条纯计算判据**全绿** ——
    它们测的是我新写的那两个函数，而坏掉的是"谁调它们"。所以那条用例钉的是
    `recenter_aux_window_actually_uses_the_placement_rules`（读源码切片），不是数学。
  - ⚠️ 同一类缺口在表情这一轮又出现一次，形状是**探针读错了对象**：那条写着"只有常用那一格
    被染色"的 DOM 判据读的是 `data-emoji-freq` 属性，而注入变异改的是 `:class` —— 于是
    **染错色它照样全绿**。改成读 `getComputedStyle().backgroundColor` 之后才真的咬住。
    属性标记与用户看得见的那件事不是一回事，标着不等于染上了。

- ★ **表情面板：常用单独成一行、上面带「常用」小标题，下面那张表不再被它牵动**
  （用户 2026-10-09：「表情前一行单独列出来上面写个小标题常用，和下面固定表情区分开，
  并且下面表情不随上面常用变化而变化」）。
  - 改的是**组成**不是布局：`emojiUsage.ts` 新增 `pickerCells(all, usage)`，返回
    `{ items, frequentCount }` —— `items` = 常用那几格 + **一字未动的全表**。
    旧做法（4.31.26）是把常用的几格从抖音原序里**摘走**再挪到前面 ⇒ 常用攒得越多、
    下面洞越多，正是他这次要改掉的那件事。代价是同一个表情会出现两格。
  - **仍然只有一块网格**。那一行小标题是网格里一个 `col-span-8` 的子元素而且**不是 button**，
    所以它占一整行却不进 `buttons()` 的下标 ⇒ 组件里写死的键盘整行步长 `COLS` 照旧成立。
    这条立场（"拆成第二块网格会让 ↑↓ 落点算错"）没有被推翻，被推翻的只是它当年顺带做的
    那个"摘走"细节；`emojiUsage.test.ts` 里那条按形状数网格的判据原样保留，
    只有它上面那段"常用是重排所以不重复"的**理由**改口了 —— 不改口的话下一个读的人会以为
    重复是 bug。
  - 出现两格带来两处必须按**位置**而不是按表情判：`:key` 带段号（`f:` / `m:`，只用 `file` 会撞键，
    表现是点一格另一格跟着变）；染色与无障碍标签也只能按 `index < frequentCount` 判，
    否则矩阵里那一格会被连带染色、连带读成「常用 · [微笑]」。
  - 攒不出常用时（新设备）那一行连标题都不渲染 —— 空标题比没有标题更吵。
  - 运行时探针那一段 13 ⇒ **20 条**，而且**先给本机账里种 8 条常用再装组件**：
    不种的话 `frequentCount` 恒为 0、那一行根本不渲染，则原有 13 条键盘判据量不到本轮
    风险最大的那个占整行的新元素。token 从组件自己那份全表现读，脚本里没有手抄表情名。
  - 复跑：`node --test src/utils/emojiUsage.test.ts src/data/emojis.test.ts` ⇒ 16/16；
    `node scripts/check-ui-runtime.mjs --only=emoji` ⇒ 20/20；
    `python3 scripts/verify-guards.py --only=emoji` ⇒ 3/3。
  - ⚠️ 面板可视行数这一轮**没量**：小标题占掉一行高度，所以那一屏比改前少看一行左右。
    组件注释里原来那句"300 高度里正好 7 行不损失行数"本轮没有逐格复核，已经就地改成
    只声明"标题会占一整行"，不再复述那个精确数。

### Changed

- `docs/aoci-usage.md` §1 那行二进制版本改为 **v0.1.0-rc18**（`aoci --version` 现读，本机 sha256 前缀 `0293da27`）；
  `README.md` 的「AI 开发必读」表与 `docs/AI_ENGINEERING_INDEX.md` 两处对该手册的一句话描述同步加进「重新索引」这一格。

## [4.33.28] - 2026-10-08

### Added

- ★ **已读成员弹层也补上运行时判据** —— 这一支就是当年「真机：已读列表靠右被裁一半」那一支，
  4.33.25 之后一直只有静态一半。做法：`MessageReceipt` 那层浮层挂 `data-readers-popover`，
  探针直接挂出这个组件、真点那枚已读入口（上一轮补的 `click()` 在这里第二次派上用场），
  然后钉「挂在 body 上 + 没有祖先裁得到 + 整块在视口内」一条，外加一把反面对照
  （把它的 fixed 坐标推到视口右缘外 ⇒ 必须在视口外；换回来必须在里面）。
  - ⚠️ **量法是独立挂载**（挂的是 `MessageReceipt` 本体，不是整条消息行）：escape 与在不在视口都判得动
    （同一份 `placeCard`、同一个 `Teleport`），但**别把它读成"真实消息行里那一条的位置也被判过了"** ——
    那需要把 store 里的群已读状态种进夹具，是另一件事。
  - 现读：`--only=roster` ⇒ **43/43**；整条链 `node scripts/check-ui-runtime.mjs` ⇒ **106/106**；
    `npm test` ⇒ **842/842**。
  - **这一类现在的覆盖账（照这个读，别读成全封住了）**：四支自算坐标的浮层里
    **三支有运行时判据**（表情名单、表情选择器、已读弹层），任务行内状态菜单仍只有静态那一半
    （它不在聊天页那套夹具里）；静态那两条（自算坐标的必须 Teleport + fixed、所有 Teleport 根元素自己必须 fixed）
    覆盖的是**全部**四处 + 全部六处挂到 body 的浮层。

- ★ **本人头像那两条静态判据补上正式的非空转用例**（4.33.22 立它们的时候只写了"读真实文件的断言"，
  按本仓库规矩（v4.22.31 之后：新守卫必须证明「改坏一定 FAIL」）那是半件事，这轮把它结掉）。
  - 用例一：把 `ResponsiveLayout` 那一处退回旧的 `UserCircle`（当年那个蓝色图标）⇒
    「三处都走 SelfAvatar」必须红。
  - 用例二：把 `SelfAvatar` 里图片那一支的取值口改回「只用调用点传进来的 prop」⇒
    「图片必须来自 `app.device.avatar`」必须红。这条钉的是"三处同步"真正的落点 ——
    不是三处挂同一个组件，而是那个来源只有一个。
  - 两条都走完「改坏 → FAIL → 恢复 → PASS」（`python3 scripts/verify-guards.py --only=avatar` 现跑 2/2）。
  - 护栏总数 203 ⇒ **205**；契约图 `ARCHITECTURE-MAP.html` 那一格同批改（`node scripts/check-doc-numbers.mjs` 对账通过）。
  - ⚠️ 顺手抓到自己写的一条**会自膨胀的复跑命令**：册头那句"本册现数 N 条"给的命令是不锚行首的
    `grep -c '    Case('`，而那一行文本里正好含这个字面量 ⇒ 跑出来比真实条数多 1，
    即"复跑命令"与它要背书的那个数字互相矛盾。已改成行首锚定 `grep -c '^    Case('` 并在原地写清原因。
  - 只动 `scripts/` 与文档（`isAppCodePath` 两处都是 false）⇒ 不提版本号。

- ★ **escape 判据的另一半也补上了真实文件的非空转证明**：上一条登记的是"根元素不是 fixed"那一半，
  "Teleport 在不在"那一半当时仍只有夹具。现在把已读弹层那层 `Teleport` 拆掉、让它回到消息行那个
  滚动容器里（= 真机「已读列表靠右被裁一半」当时的形状），判据必须红。
  一条用例里两处注入（开标签与闭标签），撤的时候一起还原。
  - `python3 scripts/verify-guards.py --only=floating-layer` ⇒ 现跑 **2/2**（改坏即 FAIL、恢复即 PASS）。
  - 护栏总数 205 ⇒ **206**；`ARCHITECTURE-MAP.html` 那一格同批改；
    `verify-guards.py --list` 的起跑前核对报"206 条锚点各恰好命中一次"。
  - 至此这两条新判据的**每一半**都有"改坏一定 FAIL"的真实文件证明，不再只有夹具。

## [4.33.27] - 2026-10-08

### Added

- ★ **表情选择器补上运行时判据**（把上一条登记的那半缺口结掉，用的是那条自己写的补法：**加 harness，不是加判据**）。
  做法：`MessageItem` 那层 Teleport 壳挂一个 `data-reaction-picker` 钩子（钩子的消费者就是探针本身），
  探针的 CDP 客户端补一条**真点击**（`mouseMoved → mousePressed → mouseReleased`；
  DOM 上 `el.click()` 不过命中测试，也就照不出"这颗按钮其实被谁盖住了"），
  然后在 `roster` 段里真点一次表情入口。
  - 钉两格，且**两个对象分开量**：对那层**壳**判 escape（挂 body + 没有祖先裁得到）；
    对**里面的面板**判整块在不在视口内。混不得：壳是零高度的（孩子全 absolute），量壳的矩形证明不了"看得见"；
    而里面那块面板是 `absolute` —— 它的包含块就是这层 fixed 壳，对它读 `escapes` 天然是假的，只许读矩形。
  - 反面对照照做：把壳的 fixed 坐标推到视口右缘外 ⇒ 面板必须落到视口外；换回来必须又进视口（不留残留）。
  - 现读：`--only=roster` ⇒ **38/38**；整条链 `node scripts/check-ui-runtime.mjs` ⇒ **101/101**；
    `npm test` ⇒ **842/842**（挂这个属性没弄坏任何静态判据）。
  - 动到组件（加 DOM 钩子也算动应用码，这条口径是 4.31.41 那次的教训）⇒ 同提交 `Version-Bump: patch`，
    版本号 4.33.26 ⇒ **4.33.27**。
  - **仍未被运行时覆盖的只剩已读成员弹层那一支**（它要的是"点回执图标"那条通路，本轮没做）。

## [4.33.26] - 2026-10-08

### Fixed

- **补上 4.33.25 那两条新判据里没被证明会红的那一半**（同一条立场：「有断言」≠「被证明会失败」）。
  4.33.25 给名单钉了两条 ——「escape」与「整块在视口内」，但反面对照只证到了前者
  （`reparentRoster` 让 escape 翻假）。`inViewport` 那一格当时只有断言没有变异 ⇒ 现在把它挂到
  已有的那支推坐标出视口的变异（`forceLegacyRoster(true)`）上：同一次变异下 `inViewport` 必须翻假。
  `node scripts/check-ui-runtime.mjs --only=roster` ⇒ 现跑 **33/33 绿**。
  两个方向都观察到了才算数：干净状态下同一条判据是 `inViewport === true`（左列/右列各一次），
  变异下是 `false` ⇒ 不是"恒真"也不是"恒假"。
  ⚠️ 只动探针（`scripts/` 按 `isAppCodePath` 不算应用码）⇒ 不提版本号、不重打 tag。
  同一节里那两个现读数（32/32 与整条链 95/95）**只对 `6d72b28` 那一刻成立**，
  按本节读数复跑即可，不必回头改历史小节。

### Notes

- **同一次评审查出的新的一格，没修**：输入框那一支有两个浮层**都不在这套判据的分母里** —— 它们不自己算坐标，全用 CSS `absolute bottom-full` 往上长、整块留在输入框卡片里面：`MessageComposer` 挂的 `<EmojiPicker>`（面板本体固定 300px 高 ⇒ 要按钮上方约 310px）与输入 @ 那张候选列表（`max-h-44` ⇒ 约 184px）。评审把这条**算准成两半**：表情面板一打开就把焦点从编辑区移进自己的网格里（`EmojiPicker` 那份 `restoreFocusTo` + 首个格子）⇒ 软键盘通常随之收起，它更可能是安全的；**真正该量的是 @ 候选列表** —— 它开着的时候键盘一定还在。但「焦点离开输入框 ⇒ IME 收起」是设备行为，本机（桌面 headless）判不了，而运行时探针只单独挂过 `EmojiPicker`、没挂过 `MessageComposer` ⇒ 两块都既无运行时判据、也不算已验。已登记进 `docs/acceptance/stability-smoke-matrix.md` 第 23 行「缺口」那一格（三格改成四格，第 ④ 条），归人工 → Smoke-11。**没修，也没假装修**：要修得先给探针加一段挂载 `MessageComposer` 的 harness，那是新写交互通路，不属于这轮补判据的范围。

### Changed

- ★ **escape 判据从「这个文件里出现过 `fixed`」改成「被 Teleport 出去的那个根元素自己是不是 `fixed`」**。
  上一条正是我自己最常反对的那种形状 —— 存在性断言当守卫：同一文件别处一枚 `fixed`（遮罩、装饰条）就能替浮层
  顶掉这一格，于是"Teleport 出去了但根节点还是 absolute"这种真缺陷会判绿。
  - 为此新增 `teleportedRootClasses()`：读出每个 `<Teleport to="body">` 里面**真正挂出去的那个根元素**的 class，
    允许中间套一层 `<Transition>`（图片预览就是那形状）；**读不出就报一条而不是静默跳过**
    （静默跳过等于"新写法自动放行"，正是这条判据最不该有的样子）。
  - 写这个解析器当场踩到自己记过的那条坑：属性值里带 `>`（`v-if="actors.length > 0"`）会把按 `[^>]*`
    切的版本从那一行切断 ⇒ **第一版把两条合规的判成违规**。改成引号感知的"取标签尾"，
    并拿三种形状钉住（带 `>` 的属性、`<Transition>` 包裹、空 Teleport / 只有注释 ⇒ 走"读不出"那一支）。
  - 覆盖面同时放宽一条：新增一条全库判据，判的是**所有** Teleport 到 body 的根元素（现数 6 处，全是 `fixed`），
    不再只管会自己算坐标的那 4 处；分母由测试自己打印、数到 0 先响。
  - 现读：`node --test --experimental-strip-types src/utils/designGuards.test.ts` ⇒ **113 条全绿**；
    `npm test` ⇒ **842/842**；已登记的护栏用例 `python3 scripts/verify-guards.py --only=浮层搬回裁切容器`
    重跑仍然「改坏即 FAIL、恢复即 PASS」（注入落在根元素那一行 ⇒ 新解析器照样咬）。

## [4.33.25] - 2026-10-08

### Added

- ★ **「浮层被祖先的 overflow 裁掉」这件事第一次有机器判据**（用户 2026-10-07：
  「你可以再看看有没有这种悬浮窗被内部的 DOM 给 overflow hidden 裁掉，可以评审一下」）。
  评审结论：自算视口坐标的浮层共 4 处（表情名单、已读成员弹层、表情选择器、任务行内状态菜单），
  四处都已经 Teleport 到 body + `fixed` ⇒ **没有新的现场缺陷**；但这句话此前只写在注释里，
  搬回去没有任何东西会红 —— 那一类的第三次现场（名单）本来就是"同一个坑在同一个文件里只修了一半"。
  补两层：
  - **运行时**（`node scripts/check-ui-runtime.mjs --only=roster` ⇒ 现跑 **32/32 绿**；
    整条链 `node scripts/check-ui-runtime.mjs` ⇒ 现跑 **95/95 绿**）：新增量具 `floatLayer`，
    左列/右列各钉两条 ——「escape：挂在 body 上且没有任何祖先裁得到它」+「整块在视口内」
    （escape 出去 ≠ 看得见，fixed 坐标算错会飞出屏幕）。反面对照 `reparentRoster`
    把名单搬回"absolute 挂在裁切容器里"= 修之前那个形状 ⇒ escape 必须翻假，撤回来必须恢复。
  - **静态**（`designGuards.findFloatingLayerWithoutEscape` + 5 条用例）：凡**自己算摆位**的
    `.vue`（消费 `useHoverCard` 或 `popupLeft`/`popupPlacement`）必须同时有 `Teleport to="body"`
    和 `fixed`，缺哪半报哪半。**分母是现数的那 4 个消费者**，不是手写的名单 ⇒
    第 5 个浮层一旦用这套摆位就自动进判据；非浮层的 `absolute` 装饰条不归这条管（另有一条用例钉住"不许放大分母"）。
    非空转实测（不改源码，在内存里变异真实文件内容）：拆掉 `Teleport` ⇒ 报一条；
    `fixed` 改 `absolute` ⇒ 报另一条；四份未改源码报 0。
    并按本仓库规矩（v4.22.31 之后：新守卫必须进**护栏非空转**用例集）把 `fixed ⇒ absolute`
    那一支登记成正式用例（`guard_cases/frontend_ui.py` 第 31 条，注入锚点是已读弹层那一行的真实字面量）
    ⇒ 护栏总数 202 ⇒ **203**，契约图 `ARCHITECTURE-MAP.html` 那一格同批改（`node scripts/check-doc-numbers.mjs` 现跑对账通过）。

  ⚠️ 两条不显然的、写在这里省得下一个人重新踩：
  1. **`position: fixed` 的包含块是视口 ⇒ `body` 自己是 `overflow: hidden` 也裁不到它**。
     这个夹具页的 `body` 现读就是 `hidden/hidden` ⇒ 第一版量具把 body 算进祖先链，
     判据会变成**恒红**。真能把 fixed 拽回去裁掉的只有"祖先变成了包含块"
     （`transform`/`filter`/`perspective`/`will-change`/`contain: paint`），
     那一类必须连 `body`/`html` 一起查 —— 所以量具按 CSS 语义合成**一条** `escapes`，
     而不是钉三条"看起来像裁切"的。
  2. **「到 body 之间没有 overflow 祖先」不能单独当判据**：名单是 body 的直接子节点时
     那条是 `parentIsBody` 的推论 ⇒ 恒真、永远不会咬。同理第一版对照写成"往上找一个带
     overflow 的祖先再搬进去"，而这个夹具页里名单到 body 之间本来就是空的 ⇒ **搬不动、白报红**
     （真机里切它的是消息列表那层 `overflow-y: auto`，夹具页没有那一层）；
     改成给那一列补 `overflow:hidden` 再把名单塞进去，才是生产形状的反面。

  ⚠️ 这两把尺子各**买不到**哪一半（缺口登记，别读成"这一类全封住了"）：
  - **运行时那条只判名单这一支的真像素**。已读弹层与表情选择器在探针页里没有"点开"通路
    （那两支要走 click / 回执图标，得先加 harness 才量得到）⇒ "escape 出去但坐标仍算错、
    飞出屏幕"这一格在它俩身上**未证**，现读只有静态那一半守着。补法是加 harness，不是加判据。
    ⟴ **这句的一半已被 4.33.27 结掉**：表情选择器补上了真点击通路 ⇒ 现在只有已读弹层仍是静态一半。
  - **静态那条只判 `Teleport` + `fixed` 两样在不在**，管不到"祖先里新加一个 `transform`/`filter`"
    —— 而那恰恰是唯一真能裁到 fixed 的东西（上面第 1 条）⇒ 这一格只有 `roster` 那一段会当场红
    （`breakers` 那一栏）。另外两处浮层哪天被搬进带 transform 的容器里，静态判据不会响。


### Fixed

- **探针那一段的 hover 通路换成"页面真的有焦点"，合成兜底删掉**（上一节的"没做掉的下一步"做完的那一半）。
  `roster` 段自己包一层**作用域限定**的 `Emulation.setFocusEmulationEnabled`
  （配 `Page.bringToFront`，`finally` 里必关）⇒ 整段跑现读左右两列都是
  「mouse 通路，第 0 次命中」（此前是"3 次真鼠标不中就派发合成 `mouseenter`"，
  那等于"hover 坏了也能判绿"）。
  ⚠️ 必须作用域限定、不能全局开：全局焦点模拟会把 `emoji` 段的键盘用例打成几千次
  `select`（那几条例外本来就是按"页面没有焦点"写的）⇒ 只在进本段前开、出段即关。
  同时更正 4.33.21 里那句"试 focus emulation 挂住没出结果、已回退"：**那是我自己看错了**
  —— 输出接进管道给 `grep`，而 `grep` 块缓冲 ⇒ 进程一直在跑却一个字也没印出来。
  改成重定向到文件后当场跑通。

### Changed

- 4.33.21 里那句"表情选择器是这套判据现存的第二个家"就地补了一个指向 4.33.23 的注脚
  （同一轮里选择器也迁进 `useHoverCard` 了）⇒ 读到那句不必再重做一次取舍分析。


## [4.33.24] - 2026-10-08

### Fixed

- ★ **表情回应的「谁点的」名单把自己跟自己说矛盾**：4 个人的名单**全列出来**，末行又挂一条
  「等 1 人」—— 组件头注释写的契约（"超过 `ROSTER_VISIBLE` 人折成「+N」"）和胶囊上的原生
  tooltip（走 `summarizeActors` 的 `shown`/`hidden`）都是"列 3 个 + 说还剩几个"，
  只有名单模板那一支 `v-for` 的是**全量** `c.actors`，于是两个口径同时成立。
  （用户 2026-10-07 那句「表情很多的时候 查看这个列表也是有问题的」里就包含这一半 ——
  之前我只当它说的是浮层被遮挡，漏了名单内容本身自相矛盾。）
  修法：列出与折叠收成**同一个数**（`rosterIds()` 用 `max(1, ROSTER_VISIBLE)` 切，
  与 `summarizeActors` 内部那条 cap 完全一致），顺带去掉因此永不生效的
  `max-h-60 overflow-y-auto`（3 行 + 1 条折叠 ≈ 86px，上限 240px）。
  ⚠️ **这条缺陷是我自己前一轮的判据把它固化的**：4.33.22 我新加的那条静态判据钉的是
  `v-for="id in activeChip.actors"`，注释还写着"不截位" —— 正好把 bug 当成契约钉住，
  所以双轴复审时它一路绿。已改成钉 `rosterIds(activeChip)` 并补一条
  `doesNotMatch(v-for="id in activeChip.actors")`。教训：**新写"钉现状"的判据时，
  要先问现状对不对** —— 否则判据会把 bug 变成以后改不动的东西。
  新增一条真浏览器判据（`--only=roster` 第 26 条）：4 人夹具必须恰好 3 行 + 末条是折叠行；
  先跑红（实测"现读 4 行，末条 = 等 1 人"）再修绿，不是照着结果写的判据。

## [4.33.23] - 2026-10-07

### Changed

- **表情选择器也并进同一套浮层摆位**，并**订正 4.33.22 里我写错的那条理由**。
  上一版我写"选择器刻意不迁，因为它有独立生命周期管理"——那是半对的：真正卡住的不是生命周期，
  而是 `placeCard` **少一个输出**。选择器要把"这次往上还是往下弹"这个**语义**原样传进
  `EmojiPicker` 的 `placement` prop（面板靠它换 `top-full mt-2` / `bottom-full mb-2` 的展开方向），
  而 `placeCard` 当时只给 `top`/`bottom` 两个数。缺的是 API 的一格，不是一处不能合并的耦合。
  现在 `CardPlacement` 补上 `placement`，三处浮层（表情名单 / 已读成员 / 表情选择器）
  共用同一个家；"忽略浮层自己内部滚动"那条判断也从三份变成一份。
  ⚠️ 一个容易看错的地方：`placeCard` 在"往上弹"那一支发的是 CSS `bottom`，而选择器旧代码
  两个方向都发 `top`。两者**结果相同**，因为那个 Teleport 壳是**零高度**的
  （它的子元素全是绝对定位）⇒ 壳的 top == bottom。这条不是推出来的，是量出来的：
  三种锚点（上半偏左 / 下半偏右 / 下半偏左）实测 `shellH = 0`、面板全在视口内、展开方向全对。
  真正变了的是横向：入口在视口右半时面板改成**右缘贴锚点**，
  不再像旧的 `align:"start"` 夹位那样把面板整个推到锚点左边去
  （现算：1280 视口、锚点右缘 1184 ⇒ 旧写法面板落在 912…1272（左缘离锚点 248px），
  新写法落在 824…1184（右缘正好钉在锚点上））。

## [4.33.22] - 2026-10-07

### Fixed

- ★ **本人头像三处三张脸**（用户 2026-10-07：「移动端『我的』里面那个上面的头像好像没有同步…
  没有设置头像的时候它是一个蓝色的一个图标」「点进去个人资料那个页面头像也没有同步，
  它是一个红色的卡片、红色的一个相机的按钮」「没上传的话默认应该是同一套那个默认的 emoji 头像，
  这些组件应该是同一个组件取的同一个数据源」）。三个根因各自独立：
  1. **「我的」页顶部根本没走默认头像那套** —— 它画的是 lucide 的 `UserCircle`（就是那句
     "一个蓝色的图标"），而导航栏画的是 emoji 小动物 ⇒ 同一账号两处两脸。
  2. **资料页的头像被自己的入口盖住了** —— 换头像的按钮是一层 `absolute inset-0` 的
     `bg-[var(--gosslan-danger)]` 蒙版，靠 `group-hover:opacity-100` 揭示；触屏没有 hover，
     而 `@media (hover: none)` 的悬停兜底把 `hover-reveal-op` 强制成**常显**
     ⇒ 手机上头像被一张红卡片整个盖掉（正是"红色的卡片、红色的一个相机的按钮"）。
     规范 §10.3 讲的是"悬停不能是唯一入口"，这里的兜底方式等于**用盖住内容来暴露入口**，方向反了。
  3. **种子来源不一致（比"没同步"更深的一层）** —— 资料页拿的是**输入框里那份未保存的 nickname**
     当头像种子 ⇒ 改一次名字换一次脸，而导航栏读的是 `app.device.nickname`
     ⇒ 保存之前两处就已经不同脸。
  修法：新增 `components/SelfAvatar.vue` 作为本人头像的**唯一**渲染处 —— 图片读
  `app.device.avatar`、默认脸读 `avatarSeedFor(app.device.device_id)`，尺寸与圆角由调用点
  用 class 透传（emoji 字号是 `58cqw` 容器查询，16px 与 64px 共用一份定义），三处全部换成它。
  换头像的入口从"整块红色蒙版"改成**右下角标**：两端常显、不遮头像，且不再占用危险色
  （"换一张图"不是破坏性动作）。角标做成**兄弟节点** —— `SelfAvatar` 根节点带
  `overflow-hidden`（圆角裁切用），负偏移塞进去会被裁掉，与导航栏那个在线点同一条约束。
  ⚠️ 资料页的**乐观预览**没被顺手弄丢：`SelfAvatar` 开一个 `preview-src`，只覆盖**图片**，
  默认脸的种子仍来自 store ⇒ 上传失败回滚之后落回的那张脸和别处依然一致。

### Added

- **两条判据钉住这件事不再回来**（`designGuards.test.ts`，现跑 103/103 绿）：三处消费点必须
  都 import 并使用 `<SelfAvatar>`；`SelfAvatar` 的图片与默认脸必须来自 store 而不是各自传进来的
  prop。这类缺陷**编译过、门禁绿、只有肉眼看得出**，不机器盯一定会再长回来。
  ⚠️ 第一版还写过一条反向判据「`<img>` 里出现 `app.device.avatar` 就算第二个家」，
  落盘前实测**恒真** —— `SelfAvatar` 把取值收进了 computed，模板里根本不出现那个表达式，
  全仓扫到 0 处 ⇒ 那条判据删了，不留装饰。

## [4.33.21] - 2026-10-07

### Fixed

- ★ **表情回应条与气泡对不齐（左右各差 12px）、右列 hover 的「谁点的」名单被窗口右缘裁掉、
  气泡与胶囊之间偏松**（用户 2026-10-07 两条观感：「电脑端 右边聊天 hover 表情 人员列表 展开遮挡」
  与「表情和气泡对齐：左右两条表情回复边缘都与上面气泡对齐，并且间距紧凑点」）。
  三处根因都量出来了，不是猜的：
  1. **补偿值算错**：回应条是消息行的**兄弟节点**，要让出「行的 `px-4`(16) + 头像 `w-9`(**36**) +
     行 `gap-2`(8)」= **60px** 才压到气泡边上；册里写的是 48（注释按"头像 40 + 间距 8"算，
     而头像其实是 36，还整个漏掉了行的 16px）⇒ 真浏览器现读 `chip.right - col.right = +12px`、左列 −12px。
  2. **同属性两档 class 互相覆盖**：外层挂 `pr-1`(4px)、册内挂 `pr-12`(48px)，两档都落在**同一个元素**上
     ⇒ 生效的只有 48 那一档（实测 `padding-right: 48px`，那 4px 静默消失）。
     这条形状比算术错更阴：两处各自看都对，合起来少一层。
  3. **名单锚点不分朝向**：两侧都写 `left-0` ⇒ 名单永远从胶囊左缘往右长；右列的胶囊本来就贴着右缘，
     于是整块越界（现读：宽 128px 的名单**右溢 37px**，正是截图里被切掉那一截）。
  修法：补偿收成**一个** `pl-[60px]` / `pr-[60px]`（不再叠第二档）、去掉条自己的 `mt-1`
  ⇒ 竖向间距 10px ⇒ **6px**（剩下那 6px 是消息行自己的 `pb-1.5`，它同时是选中底色的下沿，刻意不动）。
  ⚠️ 这一轮给名单写的"按 `mine` 翻转锚点"**当天就被下面第二、三轮换掉了**（按消息朝向写死 ≠ 按位置现算），
  条目留着是为了记下那个判据为什么不够。

- ★ **同一批里第二、三轮：名单浮层仍被遮挡 ⇒ 换成 Teleport + fixed，四个方向都按位置现算；
  宽度改成按名字伸缩；去掉「最新」标签**（用户 2026-10-07 连着追的两轮：「这个列表还是会被遮挡」
  「左边右边不能特别固定的就往左偏或者往右偏，而是看这个图标的位置靠近哪边就往反方向偏」
  「名字很长很长的话也要做省略」「框框长度是固定长度的，名字不够长后面有空白…希望是伸缩长度，
  又有一个最大长度」「最新的那个标签去掉」）。三个根因各自独立：
  1. **`position: absolute` 逃不出 `overflow: hidden`**：第一轮的锚点翻转只解决了"往哪边长"，
     没解决"被谁裁"—— 名单和胶囊都在消息列表那个 `overflow-hidden` 容器里
     （`ChatWindow.vue` 的消息区），只要浮层越出容器边就一定被切。
     表情选择器与已读成员弹层早就为同一个原因改成 Teleport + fixed，这一处当时只修了朝向 ⇒
     **同一个坑两处各修一次**。
  2. **朝向 ≠ 位置**：一群回应有十几个时胶囊会**折行**，同一侧（同一朝向）的一排里既有贴左缘的
     也有贴右缘的 ⇒ 按 `mine` 翻转必然在某一侧再撞一次边界。改成按**这颗胶囊中心离视口哪半近**现算，
     纵向同理按视口中线翻。
  3. **写死宽度 = 短名字留白**：原来 `min-w-[8rem] max-w-[16rem]` 加固定锚点，名字短时右边一截空白。
     改成只给 `max-width` ⇒ 盒子按内容撑开，超出上限才交给行内 `truncate` 出省略号（`title` 兜全名）。
     ⚠️ 这一步带出一个不显然的连带约束：**宽度一伸缩，就必须钉住"会靠住的那条边"**。
     往左长那一支若仍发 CSS `left`，内容一窄右缘就够不到胶囊右缘 ⇒ 浮层与锚点脱开；
     所以那一支改发 CSS `right`（夹位仍按最宽那一档算，内容只会更窄 ⇒ 只会更往里，不可能外溢）。
     这条光测"不越界"抓不到，`hoverCard.test.ts` 里单独钉了"右缘正好落在锚点右缘"。
  顺带：名单不再在末位标「最新」—— 顺序本身就是追加序（先点的在上、后点的在下），
  末位再挂标签是重复表达；两个语言包里那个键随之删掉。

### Changed

- **浮层摆位收成通用的一套**：新增 `utils/hoverCard.placeCard`（纯几何：四向翻 + 夹进视口 +
  `max-width`）与 `composables/useHoverCard`（开/关 + "一滚就收、但忽略浮层自己的内部滚动"），
  表情名单与**已读成员弹层**都改为消费它 ⇒ 那段 scroll/resize 监听与"忽略自己滚动"的判断从两份变一份。
  已读弹层顺带拿到左右翻转（此前写死"永远右对齐"）。
  ⚠️ **表情选择器（`MessageItem.positionReactionPicker`）本轮刻意不迁**：它是点击展开、
  要配合 `useExclusivePopup` 与 document click 一起收，且固定 360px 左对齐是它自己注释里写明的取舍；
  为省十几行样板去动一条有独立生命周期管理的通路，收益不抵风险。它是这套判据现存的第二个家。
  ⟴ **那句"现存的第二个家"已被 4.33.23 超越**（同一轮里选择器也迁到 `useHoverCard`，
  两处私有的摆位与滚动监听随之删掉）—— 读到这里不必再重做那次取舍分析。

### Added

- **UI 运行时探针新增 `roster` 段**（`node scripts/check-ui-runtime.mjs --only=roster`，
  现跑 **25/25 绿**；整条链 `node scripts/check-ui-runtime.mjs` 现跑 **88/88 绿**）：
  左右两列各量「胶囊边 vs 气泡边」（容差 1px）、竖向间距、hover 展开的名单**左右溢出像素**，
  外加反面对照 —— 把条朝外侧挪 8px ⇒ 对齐判据必须不再成立；把名单 fixed 坐标推到视口右缘外
  ⇒ 右溢必须重新出现；两把都验了可逆。多颗那一组还钉"贴左那颗往右长 / 贴右那颗往左长"
  "长名字顶到 256 上限"「短名字那颗必须明显窄于长名字那颗」（两颗互证 ⇒ 宽度写死就当场红，
  不需要额外的反面对照）与"超长昵称那行真被省略号截断且 title 里留了全名"。`--shot=` 存取证帧。
  ⚠️ 这一段自己踩到两条方法论坑，记在这里：
  ① **第一版量的是"回应条那个盒子"的边**，而盒子是通栏的、padding 长在盒子里面
     ⇒ 读出来两侧恒差 60px，差点照着这个假数去改补偿值。用户那句"边缘对齐"判的是**看得见的胶囊**，
     量具必须换成 `chip` 的边（读数随即从 60 变成真实的 12）。
  ② **真鼠标投递是间歇性失败的**：整段顺序跑时名单一次都没弹出，而单独跑 `--only=roster` 全绿。
     当时我据此二分、写成"是 `emoji` 那一段污染了后续"——**那句归因是错的，已被实测推翻**：
     之后 `--only=emoji,roster` 跑到 **39/39 全绿**，且红的位置在两次全量跑之间会换
     （一次红左列、一次红右列）⇒ 这是间歇性的，不是某一段造成的。
     再往下量到了真正的条件：探针页跑在 `document.hasFocus() === false`、
     `visibilityState === "hidden"` 下（headless 起的页面本来就没焦点），
     而 `mouseenter`/`mouseleave` 是浏览器按它内部的 hover 追踪算出来的 ⇒ 投递本身不可靠。
     同时**排除**了一条更省事的可疑解释：在上一段末尾埋一个"只有页面不重载才会活着"的标记，
     读回来是 `null` ⇒ `Page.navigate` 真的换文档，不存在"上一段状态漏进来"这回事。
     当时的处置是"先试 3 次真鼠标、不行再派发 `mouseenter` 兜底"，并把**走的哪条路打印出来**（不静默）。
     ★ **2026-10-08：这条"下一步"做完了，而上面那句"已回退"是假的，在此更正。**
     所谓"focus emulation 挂住没出结果"是我自己把输出接进管道给 `grep` 看 ——
     `grep` 块缓冲，进程一直在跑却一个字也没印到屏幕上，我据此判成"没结果"并回退了一次。
     改成重定向到文件后它当场跑通。现在 `roster` 这一段自己包一层**作用域限定**的
     `Emulation.setFocusEmulationEnabled`（配 `Page.bringToFront`，`finally` 里必关）
     ⇒ 合成 `mouseenter` 那条兜底**已删**：hover 真不工作就一定是红的，不再有"判据绿但通路是假的"那一格。
     ⚠️ 为什么必须作用域限定、不能全局开：全局焦点会把 `emoji` 那一段的键盘用例打成几千次
     `select`（那几条例外本来就是按"页面没有焦点"写的）⇒ 只在进 `roster` 段之前开、出段就关。



## [4.33.20] - 2026-10-07

### Changed

- ★ **代码复审那一轮的落地清单（9 条里做了 7 条，两条按实测判为不动）**。逐条都挂了现算的复跑，
  没有一条是"读过觉得没问题"：
  1. **内联耦合棘轮上限按领域口径重钉：13 ⇒ 6**（`scripts/check-domain-deps.mjs`）。
     上限是从"按物理文件"那一版沿下来的，而 2026-10-07 把可见性改成按领域判之后**存量自己掉到了 6**，
     留着 13 等于把三对的 slack 永久留在判据里。反证（不改文件就能红）：
     `GOSSLAN_DOMAIN_INLINE_PAIR_MAX=5 node scripts/check-domain-deps.mjs` ⇒ RC=1；
     注入一条新的内联耦合 ⇒ 打印"去重后 7 对"并判红。恒等：同一份新尺子在拆前/拆后两棵树都报 **30 处 / 6 对**。
  2. ⑥ **花括号 `use crate::{a, b};` 两条扫描都不看** —— `scanInlineCrate` 把 use 行整行让给
     `scanUseCrate`，而后者只认单条路径 ⇒ 这是一条**能绕开上面那个上限**的写法。
     现算今天 0 处 ⇒ 补上是纯收紧（改前改后本脚本输出**逐字节相同**）。
     ⚠️ 我自己的第一版修法就是错的：没先去行内注释，`use crate::{a::b}; // 说明` 照样看不见，
     注入实测 RC=0 —— 是那条注入把它照出来的，不是读代码读出来的。现在三种形状各有反证：
     带注释的花括号 / `pub use crate::{a, b};` / 嵌套 `use crate::{a::{b, c}}`（削成模块前缀）⇒ 全部 RC=1。
  3. ⑦ **BLE 匿名重述判据的扫描面只扩到 `network/ble/`，兄弟册仍然看不见**。
     先量再扩：把面临时扩到**全部生产 rs** 跑真实判据 ⇒ 命中 **0 处**（`grep -c '^  ✗ '` = 0），
     所以按 `network/` + `transport/` 两个目录扩面（点名 6 + 动态展开 ⇒ 现算 47 本）今天不改任何结论。
     不扩到全仓的理由写在脚本注释里：值清单含 `3 / 20`，`MAX_CHUNK_* = 3` 这类**同名不同义**的常量
     会被拉进误伤面，而这条守卫一旦被加白名单就形同虚设。反证：往 `network/file/receive.rs` 注入
     `const FAKE_ATT_HEADER_LEN: u16 = 3;` ⇒ 旧面 RC=0 / 新面 RC=1 且点名那一行。
  4. `verify-guards.py` **起跑前要求每条用例声明 `expect_fail_hint`**（现算 202/202 都有 ⇒ 这条前置
     今天不改结论，改的是"以后加一条没 hint 的用例"那种形状），`base.py` 的字段注释同步改成"必填"。
  5. `ble.rs` 两条读循环守卫的锚点唯一性断言：`body.starts_with("async fn x")` 是**同义反复**
     （`body` 就是从那个 `find` 命中点切的，永远以它开头 ⇒ 判据恒真）⇒ 换成
     `assert_eq!(src.matches("\nasync fn x").count(), 1)`，钉"锚点在整棵视图里恰好一次"。
  6. `lib_delivery_shape_tests.rs` 的 `assert!(uses >= 4)` ⇒ `assert_eq!(uses, 4)`：
     多了=有新的转发点没走可达集，少了=视图或被测试文本垫数，`>=` 两边都放行。
  7. **两条新的"形状对不对"判据**（复审点出的那个新口子该钉的钉）：
     `dispatch_arms_and_volume_arms_agree`（分发臂 ↔ 五册入口的臂表，两个方向 + 五族互不重叠 + 台账 6/6/11/8/4=35，
     分发区今天共 38 个变体 = 35 委托 + Gossip + OpaqueExternal + Unknown 三条原地）；
     `count_guard_views()` 发现式对账（按名字数"有几份守卫视图" ↔ 对账用例里写了几条 case ⇒ 新加一份视图而没登记，
     以前是沉默的）。**用例数 789 ⇒ 790**，两份平台基线同步（`--update` + `--sync-baselines` ⇒ macos 790 / windows 778）。
     非空转证据：把 `FileDone` 从 file 组的分发臂挪到 share 组（**编译合法、运行时静默丢帧**——分册自己那层有 `_ => {}`）
     ⇒ 恰好这一条红、其余 789 条全绿；还原后全绿。
     ⚠️ 这条守卫自己的第一版有两处自造解析缺陷，都被它自己红出来：按字节 `rfind("m @ (")` 切出**半行**
     （8 格缩进被切掉）⇒ 每组第一个变体永远漏数（实测 FileOffer 消失、6 报成 5）；
     而 `find("=> handler(")` 接不住 identity 族那种 `=> {\n handler(…)`。现在按行扫。
- **一条搬家时掉的日志文本空格**：`transport/relay_file.rs` 的 `RelayChunk 转投 tid=…` 少了前导空格。
  行多重集恒等判据看不见这一类（它只比代码行），是逐行读 diff 时抓到的。
- **⑨ 已知边界，写在这里而不是藏在注释里**：202 条用例里有 **6 条**的 `expect_fail_hint` 就是它自己的测试名。
  这类仍然"改坏即红"（`cmd` 只跑那一条测试；编译不过时 cargo 不印测试名 ⇒ 也不会误纳），
  弱的是**归因**（同一条测试里另一处断言坏了它也认）。**本轮不改**：换 6 条 hint 要逐条重写并复跑，
  而 4.33.18 那条已经证明"hint 取源码帧里的标识符"会在 CI 上长出专属红 —— 断言正文不是免费的。

### Notes
- 本地/E2E 层（`--group local`，21 步）在这一批改动之前已在 `1917d0a` 整层绿（结论行 `✓ 21 步 / ✗ 0 / ⏭ 1 跳过`），
  ⚠️ 但那次我把日志文件连同链尾的清理一起删了 ⇒ 现在**只剩结论行这一句可引**，逐步正文无从复核。
  教训记在这里：门禁日志留到提交之后再删，不在同一条链里 `rm`。


## [4.33.19] - 2026-10-07

### Changed
- 自查今天三处搬家时清掉一条**悬空的分节横幅**：`transport.rs` 分发段里那句
  `// ---- 中继文件传输 ----` 原来是贴在 `Message::RelayFileOffer` 那条臂上面的，
  臂体搬进 `transport/handle_share.rs` 之后 `cargo fmt` 把它挤到了上一条臂的右花括号后面
  （`} // ---- 中继文件传输 ----`）—— 它现在指着一条 Gossip 臂，说的是不在这儿的代码。
  同一句话在 `handle_share.rs` 的册头与分发臂上方的注释里都有，所以删掉而不是挪走。
- **这条是本轮机械自查抓到的，不是门禁**：恒等判据只比"行多重集"，比出"拆前拆后各 38 个变体、
  丢 0 / 多 0 / 无重复处理"与 `pub` 项数 `file 65→65`、`ble 8→8`，但注释位置不在它的射程里
  （唯一少掉的那一行就是这条注释）。⇒ 记下来：**搬家后按行多重集对账只能证明代码没丢，
  不能证明注释还指着它讲的那段**。


## [4.33.18] - 2026-10-07

### Changed
- ★ **CI 立刻替我复证了那条新判据的一个副作用，并已修**：推送上去的那 34 条在
  「前端测试 / 清单 / 构建」这一步红 —— `❌ 注入后是红了，但失败输出里**没有**声明的那句判据关键词
  「onFocusChanged」`。根因不是代码：那条 hint 取的是**标识符**，本机 node 会把失败那一行的源码打进输出、
  CI 那台不会 ⇒ 一个"只在本地成立"的 hint 在新判据下变成了 CI 专属红。
  修法两条：① hint 换成断言消息本体「设置窗口要监听重新获得焦点」（任何平台都会打印）；
  ② 红时打印的输出尾部从 600 字符加到 2500 —— 600 不够挑新 hint，这正是我这次定位慢的原因。
  复跑该条：`python3 scripts/verify-guards.py --only "常驻窗口"` ⇒ ✅。
  ⚠️ 同一形状的风险还剩几条（现算 `hint 总数 175 / 纯标识符形状的 40`，其中多数是**测试名**——
  cargo 的 failures 列表一定会打印测试名，那类是稳的；不稳的是只出现在源码帧里的标识符）。
  我不去逐条猜，交给下一次 CI 复证：**这条新判据的价值恰恰在于它会把这类脆弱点在真实环境里照出来。**

### Changed
- ★ **UI 运行时探针现在会核"这台浏览器起得来"，而不是只看文件在不在**（负责人点头"用我自己的浏览器跑"）：
  实测那台 playwright 缓存里的 Chrome for Testing 只剩 `Helpers/Libraries/Resources`，
  `Versions/Current/… Framework` 那个文件不见了 ⇒ dlopen 失败、进程一触即溃，
  而探针只报 `CDP /json/list 里一直没有 page target` —— **一条环境缺陷被伪装成代码回归**，
  在这台机器上连着两轮红在同一个位置，措辞一字不差。
  解析顺序三档：① `GOSSLAN_CHROME`；② 缓存那台（**加一次可加载性核对**）；③ 系统里已装的 Chromium 系
  （Brave / Chrome / Edge / Chromium，macOS + Linux 路径）。**三档全空仍然判红**，不许把没跑写成 PASS。
  走 ③ 时会把"实际用的是谁"打在 `· 来源：…` 那一行 ⇒ 换内核属于**可追溯的降级**，不是静默换尺子。
- 两条实测：真跑 ⇒ `· 来源：系统浏览器回退（playwright 缓存里那台存在但装坏了：框架二进制缺失）` +
  **63/63 条判据绿**；反证（把系统回退名单临时清空的那份副本）⇒ 退 1 报
  「环境：找得到可用浏览器（GOSSLAN_CHROME / playwright 缓存 / 系统 Chromium 系）」这条红。
  环境侧的正解仍是把那台浏览器装回来（`npx playwright install chromium`），那是在他机器上，不在本仓。



### Documentation（认知层第二批：把前两轮拆分的欠账补齐）
- ★ 认知条目 **531 ⇒ 587 条**（新增 56 条：`scripts/e2e/core.mjs` + 19 本轮次分册、`scripts/guard_cases/` 9 本、
  `lib_*_tests.rs` 11 本、`transport/*_tests.rs` 15 本、`CHANGELOG.md` 本体），基线文件 893 ⇒ **948**；
  复跑 `grep -c ': F:' aoci.code.txt` 与 `aoci status`。另把 3 条**正文已失真**的条目改口：
  harness 驱动那条（旗标与分发留在驱动、轮次体搬去 core/rounds）、拆分计划那条（不再是在途地图，
  而是计划+两轮结果+11 行尺子表）、探针那条（"文件在 ≠ 起得来"）。
  `aoci --json check` 现读：`code_missing / code_stale / code_unbaselined` **三格都归 0**，`structure_valid=true`。
- ⚠️ 剩下的 `governance_aligned=false` 不是缺条目，而是** observe 证据要人工复核**（`aoci scope preview` 现读
  「阶段 observed_evidence_review_required｜人工review 155」）。`aoci scope acknowledge` 的字面意思是"记录复核"，
  我跑它就等于替负责人宣称"这些我看过并认可了"——AGENTS 里"人工裁决/审批边界不得忽略"就是这一格 ⇒ **不自行越过**，
  如实报给他：要么他复核一次，要么在带 `aoci_maintain` 的会话里走正式 maintain 通道。
- 机器事实两条（写进记忆，别再当"只有 MCP 能写"）：① **相同文本重传会被拒**（"重复批次: 正式索引零写入"）
  ⇒ 过期条目不能靠原文重绑，必须真的改内容或走 maintain 签发的候选；② 整行有预算上限
  （`entry_field_budget_exceeded` 实测：本条 S 到 435 字节被拒、422 字节通过 ⇒ 按字节而非字符数收）。

### Documentation（认知层第三轮：全局体检剩下的两格）
- 全局漂移分类现读（`aoci --json check` + `aoci --json scope preview`）：`code_missing / code_stale /
  code_unbaselined / orphan` **四格全 0**，条目 587、基线 948 文件、整索引 88,470 tokens（目标档 200,000）。
  本轮补的最后 3 条：`verify-guards.py`（判据化的代价与 5 条不符的现场）、`guard_cases/frontend_ui.py`
  （CI 抓到的那条标识符 hint）、`CHANGELOG.md` 本体（**写清它天然一直过期**：每记一次账就改一次本文件，
  所以它的 code_stale 不算欠账，别为它反复重绑）。
- ⚠️ 剩两格需要他动作，都不在 agent 权限内：
  ① `src/utils/designGuards.test.ts` 的 observe 指纹变了而我今天确实改过它（豁免从一条字面路径改成点名三本），
     但 `observe_change_policy = review_required` ⇒ 要 `aoci scope acknowledge`（字面含义"记录复核"）；
     我不自跑——那等于替他宣称复核过。
  ② `docs/notes/changelog-archive.md` 报 unbaselined（它是超 1 MiB 的免条目对象 ⇒ 属报告噪声）；
     只有他愿意把当前源码整体承认为新起点时才动 `aoci scan --force`，而**那一步会把未复核的 observe 漂移一起洗白**
     （工具自己写的原话就是"防止一键洗白未处理的漂移"）⇒ 我没跑。

## [4.33.17] - 2026-10-07

### Documentation
- ★ **AOCI 认知层按命令行通道补写本轮的 26 条对象行**（他授权"硬走一遍"）：**新增 17 条**
  （`transport/handle_*` 5 册、`network/file/*` 5 册、`network/ble/*` 4 册、`i18n/locales/{dict,zh-cn,en-us}` 3 册）
  **+ 重写 9 条**（`transport.rs` / `network/mod.rs` / `file.rs` / `ble.rs` / `locales.ts` / `file_tests.rs` /
  `check-domain-deps.mjs` / `check-ble-constants.mjs` / `verify-guards.py`）。
  索引条目 514 ⇒ **531**（复跑 `grep -c ': F:' aoci.code.txt`），基线文件 876 ⇒ 893。
  机器事实（修正旧口径"写条目只有 MCP 一条通道"）：`aoci update-entry` 可用，但 `--entry` 必须是
  **完整规范对象行**（含 `basename[TAG]: ` 键前缀；只给 `F:…|R:…` 会被判 `canonical_object_line=false`），
  且要带 `--source-sha256`（自己按文件算）；`--preview` 只给人读文本、**不吐 JSON** ⇒ 批量脚本以裸退码为第一信号
  （我第一版按 JSON 解析，把 26 条成功全报成失败 = 又是"整批读数一模一样 ⇒ 探针读错对象"）。
- ⚠️ **同一台机器上那条 UI 运行时探针的红已定位成环境缺陷**：playwright 缓存里那台 Chrome for Testing 的
  Framework 二进制不见了 ⇒ 浏览器起不来、探针报"CDP 里没有 page target"。换个完好的 Chromium 内核跑同一条探针
  **63/63 全绿**（复跑：`GOSSLAN_CHROME="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" node scripts/check-ui-runtime.mjs`）
  ⇒ 两条结论：这条红不是本轮回归；界面文案那侧（locales 拆册）在真浏览器里渲染正常。现象与复跑写进
  `docs/large-file-split-plan.md` §6-bis，**没改探针、没放宽判据**（装回浏览器属于他机器上的动作）。
- **AOCI 剩下的欠账不是我本轮造的**（现读 `aoci --json check`）：缺条目 56 条、条目过期 25 条、未入基线 55 个
  —— 绝大多数是 10-06/10-07 那些拆分册（`scripts/e2e/core.mjs`、`e2e/rounds/*`、`guard_cases/*`、`lib_*_tests.rs` 等）
  一直没补认知。`structure_valid=true`、`governance_aligned=false`、门禁各层不读它 ⇒ 补多少条等他拍板（见工单）。


## [4.33.16] - 2026-10-07

### Changed
- ★ **护栏的 `expect_fail_hint` 从"提示"改成"判据"**（`scripts/verify-guards.py`）：现算 **202/202 条 Case 都声明了它**，
  所以它就是契约的一部分。旧写法只在红的时候附一句括号 ⇒ 一句永远匹配不上的 hint 只存在于没人读的 detail 里
  （第 15 趟已经抓到过 local 层一条这样的，那次是手工改措辞）。现在不匹配就 FAIL，并附实际失败输出尾部供挑新 hint。
  判据本身有反证：临时把一条 cargo 用例的 hint 换成 `ZZZ-这条判据措辞不存在` ⇒ 退 1 并原样打印那句关键词找不到；
  删掉注入 ⇒ 回到 ✅。**改坏即 FAIL、恢复即 PASS 两条半边都保留**（先恢复再判 hint，所以红不会把现场留在树里）。
- **整跑 202 条的实测结果：5 条不符合预期，其中 2 条是我今天自己造出来的假绿**（不是过期措辞，是"注入照样绿"）：
  · `ble_reader_loop_refreshes_read_activity`、`peripheral_handshake_failure_clears_the_handshaking_mark`
    这两条读的是 `ble_src_for_guards()` 聚合文本，而**判据自己的字面量也在文本里** ——
    `ble.rs` 的内联测试模块排在视图第一段、函数本体被我搬进最后一段的 `ble/io_loops.rs`，
    于是 `find("async fn ble_reader_loop")` 先撞上测试里那个字符串，取到的"窗口"是 13 行测试文本，
    里面当然有 `mark_conn_seen(` ⇒ 断言恒真。**这条守卫在我拆完 BLE 那一刻起就不守东西了**，
    而快速层/全量层那天都是绿的 —— 只有逐条注入才看得见。
    修法照 `transport/gossip_tests.rs` 的先例：检索式带行首换行（`"\nasync fn x"`；**不加左括号**，
    这两个签名带泛型 `<S: FrameSource + 'static>`，加了就找不到 —— 我第一次就改成了带括号，测试当场 panic
    在 `.expect(...)`，那是响亮的好形状），再加 `body.starts_with("async fn x")` 钉住窗口真的是函数本体。
    复证两条各退 0（`--only "BLE 读循环必须回灌读活性"` / `--only "外设握手失败必须解除"`）。
  · 另 3 条是措辞过期：`有一条群消息补发…` 实际打印的是`有一处…`；`成键` 换成那条测试的名字
    `file_send_progress_counts_wire_not_queue`（红时必打印，而纯编译错不会）；`只有后端说 bluetooth` 换成
    失败用例标题 `连接图标名与文案同源`。三条逐条复跑都回到 ✅。
- ⚠️ 一处**测量工具自己的缺陷**顺手记下：红时打印的输出尾部只有 600 字符，而 cargo 尾部是编译噪声 ⇒
  挑新 hint 时看不到真正的断言消息。这次靠"再单跑一次 + 读测试源码"绕过去了，没改工具（不为本轮范围加东西）。
- §7 那张尺子表加到 **11 行**：新增那一行就是上面的"视图里带内联测试模块 ⇒ find 自匹配"，
  后果标的是**静默失明**而不是响亮报错 —— 这是本轮搬家唯一一次"守卫被搬家弄瞎、而所有门禁都绿"。


## [4.33.15] - 2026-10-07

### Changed
- ★ **`src-tauri/src/network/ble.rs` 按角色切成四册（tier-2 第三轮，也是 2,000–3,000 那一档的最后一本）**：
  2,392 行 ⇒ 主文件 **745 行**（常量 + `start`/`stop` + 链路拆除 + 帧诊断 + 那份 274 行的内联测试模块）+
  `ble/central.rs` 777（扫描→该不该拨→拨号→握手验签→登记链路，含拨号退避）+
  `ble/peripheral.rs` 536（起广播→收 central→首帧判路由→握手→建链与顶替旧链）+
  `ble/io_loops.rs` 275（三级抢占写循环 + 读活性判据，两条角色跑同一对循环）+
  `ble/frame_io.rs` 112（`FrameSink`/`FrameSource` 两个 trait、四个 impl、两个薄封装）。
  边界依据是模块文档自己那句："这一层只补两件 BLE 专属的事：**扫描/连接** 与 **分片收发**"。
  分册不各写 `#[cfg(feature = "bluetooth")]` —— `network/mod.rs:10` 门控整个模块，`include!` 继承它。
- **自证同一套**：`cargo test --features bluetooth --lib` 789 passed / 0 failed；`-- --list` 789 条用例名
  与基线**差集 0 行**；clippy（门禁形态）干净；`verify-guards.py --list` 仍是"202 条锚点各命中一次"；
  `check-ble-constants` 扫描面点名 6 + 目录动态展开 4 = 10 个文件；`check-domain-deps` 在这一刀之后
  仍报 **30 处 / 6 对**（与拆分前同一个数 ⇒ 上一条口径改准是搬家不变的，不是把洞说小）。
- **两处尺子跟着搬家改口（都是响亮的那种，靠现跑抓到）**：
  · `network/mod.rs::ble_src_for_guards()` 立成第三个家 ⇒ 11 处读 `ble.rs` 文本的形状守卫
    （`lib_ble_tests.rs` 9 处 + `ble.rs` 自己测试模块里 2 处 `include_str!("ble.rs")`）改读它；
    `lib_source_view_tests.rs` 的登记对账 4 个用例 ⇒ **5 个**（canary = `ble/central.rs`）。
  · `scripts/check-ble-constants.mjs` 的 `BLE_DOMAIN_FILES` 是**硬编码文件清单**：新册落在
    `network/ble/` 里它不会红、只会永远看不见 ⇒ 判据 B 的扫描面改成"点名 6 + `network/ble/` 目录动态展开"，
    分母由脚本自己打印。反证真跑：往 `ble/central.rs` 塞一行 `const GATT_CHUNK_PROBE: usize = 512;`
    ⇒ `✗ network/ble/central.rs:2 const GATT_CHUNK_PROBE = 512`（退 1），删掉后回到 10 个文件 / 退 0。
- ⚠️ **一条我自己数错的分母，记在这里因为它是流程缺陷而不是笔误**：动手前我把"读 ble.rs 文本的守卫"
  数成 11 处（`include_str!("network/ble.rs")` + `include_str!("ble.rs")` 两种拼法），实际**还有第 12 处**
  写成 `include_str!("../ble.rs")`（在 `network/transport/queue_tests.rs`，跨目录相对拼法）。
  它是靠 `cargo test` 真跑红才现形的（`应为「定义 1 处 + 四个建链点各 1 处」left: 3 right: 5`），
  而红报的形状是"少了建链点"——那会把下一个人推向"补一个并不缺的建链点"。
  复跑口径：`grep -rnoE 'include_str!("[^"]*ble\.rs")' src-tauri/src scripts`（最宽形状，先修尺子再下结论）。
- 契约图 `docs/ARCHITECTURE-MAP.html`：transport 与 files 两个节点的 `paths` 各补一条**目录**认领
  （`network/ble`、`network/file`），并在 notes 写明"逐册名单的唯一来源是 `docs/domains.data.mjs`，
  这张图不抄第二份"。改完按老规矩 `node --check` 那段内嵌 script（1 段，语法通过）。


## [4.33.14] - 2026-10-07

### Changed
- ★ **`src-tauri/src/network/file.rs` 按角色切成五册（tier-2 第二轮）**：2,495 行 ⇒ 主文件 **398 行** +
  `file/send.rs` 689（offer→accept→分片流式→收尾，含 `WireLedger` 记账与 `wait_complete_ack`）+
  `file/receive.rs` 845（offer 决策→`.part` 接收器→逐片解密→校验改名→失败与接管）+
  `file/relay_push.rs` 261（借道中继：`RelayFileOffer`/`RelayChunk`，收件人不是链路对端）+
  `file/group_receive.rs` 142（一个群文件对多成员各建一个接收器）+ `file/share_walk.rs` 224
  （共享目录遍历与落盘命名 —— 纯函数、不碰网络也不碰会话状态）。
  边界依据是文件自己那段模块文档：它开头就写了"发送方 / 接收方 / 中继路径"三条生命周期。
  机制与 transport 那五刀同一条：`include!` 是文本粘贴 ⇒ 同一模块、同一 `use`、同一可见性，
  **测试全名一字不变**。
- **恒等与自证**：`cargo test --features bluetooth --lib` 789 passed / 0 failed；
  `-- --list` 的 789 条用例名与 `test-baseline.macos.txt` **差集 0 行**；clippy（门禁那条形态，不带
  `--all-targets`）`-D warnings` 干净；`verify-guards.py --list` 报"202 条用例的注入锚点都在各自文件里
  恰好命中一次" ⇒ 锚点由 runner 沿 `include!` 树自动解析，指向 `file.rs` 的那批 Case 的 `file=` **一字未改**（对账就是 `--list` 那一句"202 条…恰好命中一次"）；
  `check-domain-map.mjs` 认领数 347 ⇒ 352；`check-doc-citations.mjs` 31 处全落真行。
- **新登记的第五把尺子 + 一处旧尺子改严**：
  · `network/mod.rs::file_src_for_guards()` —— `file` 模块的"生产码全集"视图（`#[cfg(test)]`，与
    transport 那份同形）；形状守卫原先 9 处 `include_str!("network/file.rs")` 全部改成读这个家
    （读单个文件在搬家后只看见主册：搬走会红，但**搬进来的坏形状看不见** = 假绿）。
  · `lib_source_view_tests.rs` 的登记对账守卫从 3 个用例加到 **4 个**（新用例 canary = `file/send.rs`）
    ⇒ 以后少登记一册、或多登记一个不在 `include!` 闭包里的文件都会红，两侧都钉。
  · 同批把 `file_tests.rs` 里那条用 `std::fs::read_to_string("<crate>/src/network/file.rs")` 读源码的
    判据也接进视图 —— 它是本次唯一"跑起来才知道"的红（`✖ 单聊 peer-wide 收尾改名了`），
    红是对的方向：它读的是单个文件。
  · `docs/domains.data.mjs` 的文件传输领域按**目录**认领 `src-tauri/src/network/file`（不是逐册点名），
    并写明两边严格程度的差异按各自失效方式定：视图漏一册是假绿，所以逐册；领域漏一行是无主文件，
    判据 D 会当场红，所以按目录。
- **一条自己踩到的计数错，如实记**：动手前我把"读 `file.rs` 文本的守卫"数成 6 处（只在两个
  `lib_*_tests.rs` 里 grep），实际是 **9 处 / 5 个文件**（还有 `lib_ble_tests` / `lib_compat_gating_tests`
  / `lib_relay_data_tests` 各一处）。按文件去 grep 就是把"检索面"当成了"全集"。
  这次没造成损失是因为批量替换脚本对每个文件写了 `assert count == 预期`，第一个文件就断言失败、
  一个字都没写下去 ⇒ 分母是错的这件事被工具替我说出来了。
- 顺带 4 处指路句改口到真位置：`state.rs`（`file/send.rs::wait_complete_ack`）、
  `commands/files.rs`（`file/send.rs::send_file_from_path_at`）、`file_relay.rs`
  （`file/share_walk.rs::safe_transfer_id`）、`db/messages.rs`（`file/receive.rs::resume_receive`）。

### Changed（同批的第六把尺子：领域依赖方向守门的口径改准，**上限一格没动**）
- ★ `scripts/check-domain-deps.mjs` 里"判据看不见的内联跨域引用"从**按物理文件**判改成**按领域**判。
  起因：`file.rs` 切册后这里 13 对 ⇒ 16 对并报红，而棘轮写明"不许直接调大上限"。
  现量核对（不是解释）：把同一份新脚本在 `567694b`（拆分前）与现树各跑一遍 ⇒
  **两边都是 30 处 / 6 对**；旧口径在两棵树分别是 13 / 16 ⇒ 红来自"`use crate::db;` 留在模块根文件、
  内联的 `crate::db::now_ms` 搬进了分册"这种**归属假象**：include! 让"use 落在哪个物理文件"变成任意事实，
  而 `consumes` 与判据 G 本来就是**领域粒度**的。
- 反证（证明口径没被改成瞎）：往 `files` 域塞一句该域任何文件都不曾 `use` 过的内联
  `crate::notifications::…` ⇒ 6 对变 7 对，且 `GOSSLAN_DOMAIN_INLINE_PAIR_MAX=6 node scripts/check-domain-deps.mjs`
  当场退 1（`✗ 内联跨域引用对数 7 超过棘轮上限 6`）；撤掉注入后回到 30 处 / 6 对。
- ⚠️ 这条口径买不到的那一半写在脚本注释里：同一条**已声明**依赖在另一个物理文件里被内联使用，
  现在不再单独报出来（按领域问就只看领域）。取舍：宁可少报一格，也不拿"文件归属"这种会随搬家漂移的事实当分母。

## [4.33.13] - 2026-10-07

### Changed
- ★ **`src/i18n/locales.ts` 按语言拆册（大文件拆分第二轮，tier-2 里"确有内聚边界"的第一本）**：
  2,010 行 ⇒ 门面 `locales.ts` **16 行** + `locales/zh-cn.ts` 1,024 + `locales/en-us.ts` 1,000 +
  `locales/dict.ts` 7（`MessageDict` 的形状，两册与门面共用，放门面里会形成类型层面的自我 re-export）。
  行数以 `wc -l src/i18n/locales.ts src/i18n/locales/*.ts` 现算为准。
  边界依据是文件自己的第一句：那本字典装的是**两门语言**，各自 903 个键 —— 改中文要在英文的行号上面插话。
- **恒等判据是产物而不是文本**：拆前后各 import 一次 `locales.ts`、把 `{zh, en}` 两个对象
  `JSON.stringify`（键序也进串）后取 sha256 ⇒ 两边都是 **`bf4fee1c6837b3bc`**、键数 903/903。
  三条字典护栏（中英 key 一一对应、值非空、所有 `t("…")` 字面量调用点命中真实 key）读的是**对象**
  而不是文件文本 ⇒ 搬家对它们透明，一字未改；`node --test` 那四本相关测试 148 passed / 0 failed。
- **同批改一处尺子**：`designGuards.test.ts` 里"查看者视角的 `@你` 只许存在于 i18n 名单里"那条，
  豁免从 `rel === "i18n/locales.ts"` 改成**点名三本**（门面 + 中英两册）。没有改成
  `startsWith("i18n/locales")` —— 那样落在该目录下的任何新文件都会**静默豁免**，而这条判据要的
  恰恰是"只有字典本体能带这些字面量"。反证真跑：临时放一本未登记的 `locales/xx-lie.ts`（内含 `@你`）
  ⇒ `✖ 这些生产码把查看者视角的文案写死了：i18n/locales/xx-lie.ts（含 @你）`，删掉后 101 passed。
- **顺手补一条上一轮的漏账**：`check-domain-map.mjs` 判据 D 报 `handle_message` 拆出的五册没登记
  （前五个族提交各少一行 paths），已在 `1736744` 补齐并让该层认领数从 342 变 347。
  另注：4.33.12 那条里写的"主文件 ⇒ 1,391"是搬家脚本在 `cargo fmt` **之前**打印的数，`cargo fmt` 后
  现量 `wc -l src-tauri/src/network/transport.rs` = **1,394** ⇒ 以现算为准（§5.1-bis 已按 1,394 写）。

## [4.33.12] - 2026-10-07
### Changed
- ★ **`handle_message` 第五族：消息与送达回执 4 个变体搬进 `transport/handle_messaging.rs`**（235 行 → 分册 253），
  主文件 1,613 ⇒ 1,391。并一族的理由是这条送达链要一起读才看得见谁点亮谁：落库（ChatMessage）→
  对端确认（Ack 清 outbox）→ 已读（ReadReceipt 只推游标、不改会话摘要）→ 气泡样式（ChatStyle）。
- **五族搬完后 `handle_message` 的实际形状**（现量）：见提交正文与 `docs/large-file-split-plan.md` §5.1 的改口。
  自证同一套：789 passed / 0 failed、用例名差集 0、clippy 与 fmt 干净、202 条锚点各命中一次。

## [4.33.11] - 2026-10-07
### Changed
- ★ **`handle_message` 第四族：身份握手与好友关系 8 个变体搬进 `transport/handle_identity.rs`**（266 行 → 分册 288），
  主文件 1,866 ⇒ 1,613。这一族带着全仓最硬的两条顺序守卫（「身份锚点打标点必须留在 Hello 分支」、
  「打标必须排在 `upsert_peer` 之后 —— 反了不报错，只会静默绑不上」），它们原来与臂体隔着几百行互相看不见。
  两条按函数名开窗的守卫**跟着臂改家**（不跟着改会当场红，不是静默变弱 —— 这条红就是搬家自己报的）。
  ⚠️ 顺手记一处我在这次改里造的自伤：第一版把窗口变量直接遮蔽了全集视图 `tr`，害到同一测试后面
  那条「密钥冲突提示」的断言找不到锚点（`必须还有密钥冲突提示` 红）。正解是给窗口另起名字，
  **全集视图不许被窗口变量顶掉**。

## [4.33.10] - 2026-10-07
### Changed
- ★ **`handle_message` 第三族：群聊与群文件 11 个变体整块搬进 `transport/handle_group.rs`**（167 行 → 分册 185 行），
  主文件 2,029 ⇒ 1,866。并成一族的理由留在分册头部：这 11 个变体共用同一套群前提
  （密钥必须先到、受众按群算的 G-Set 语义、群文件走另一条 outbox），留在原处时这些前提散在 11 个臂中间。
  自证同一套：`cargo test --lib` 789 passed / 0 failed、用例名差集 0 行、clippy 与 fmt 干净、
  `verify-guards --list` 202 条锚点各命中一次。

## [4.33.9] - 2026-10-07
### Changed
- ★ **`handle_message` 拆出两族，主文件 2,743 ⇒ 2,029 行**（第一、二族并一个提交：两批改动都落在同一个函数的同一张 match 上，
  事后拆提交只会让每次的恒等判据更难核）。12 个变体的处理体整块搬进两个新分册：
  `transport/handle_file.rs`（1:1 文件收发 6 臂 / 500 行）与 `transport/handle_share.rs`（共享目录 + 单跳中继 6 臂 / 239 行）。
  **臂体逐字未改**：分册里那层 match 与原函数同一层（臂仍 8 格缩进）⇒ 不需要重排；分发臂用
  `m @ (Message::FileOffer { .. } | …) => handle_file_messages(state, peer_id, m).await`，
  `{ .. }` 不绑字段 ⇒ 绑定全部留在分册里那条同形状的模式上。
- 为什么这一刀算机械搬家而不是改控制流：AST 现量过 **match 之前没有裸 `let` 绑定、分支之间不共享局部量**，
  且 `match msg` 是函数最后一条语句 ⇒ 臂里的 `return` 从 helper 返回与原来从 `handle_message` 返回**等价**
  （若 match 之后还有代码，这个等价就不成立 —— 那是这条搬家能做的判据，写在分册头部）。
- **搬家自己报出的一处真耦合**：一条按函数名开窗的形状守卫
  （`duplicate_file_done_still_answers_with_an_ack`）跟着臂搬家后窗口里没有了那段文本 ⇒ 它当场红，
  已把开窗锚点改指 `handle_file_messages` 并同步那段"为什么是源码守卫"的说明。
  ★ 而护栏用例那 11 条注入锚点**一条都不用改**：`verify-guards.py` 自己顺着 `include!` 树解析锚点所在文件
  （`--list` 现算 202 条各恰好命中一次）⇒ 按文件路径硬改 `file=` 反而是错的。
- 恒等与自证（两族一起）：`cargo test --lib` 789 passed / 0 failed、用例名与 `test-baseline.macos.txt` **差集 0 行**、
  clippy `-D warnings` 干净、`cargo fmt --check` 干净、`verify-guards --list` 202 条锚点全命中。

## [4.33.8] - 2026-10-07
### Fixed
- ★ **数据面中继授权闸从"抄三遍"收成"一个家"，同时把替那个缺陷形状把关的判据改严**：
  `decide_relay_from_peer(` 原来在三个转发点各写一遍（定向借道 / `OpaqueExternal` 转投 / `RelayChunk` 转投），
  三段的策略判定、db 锁取好友、节流日志形状完全相同，只差"为什么被拒"那句文案。
  现在唯一的家是 `transport.rs::relay_denied(state, peer_id, why)`，三处各自 `if relay_denied(...) { return; }`。
  **行为一字未变**（同一张真值表、同一个节流键 `relay_deny`、同一句日志文本），789 条用例全过、用例名与基线差集 0 行。
- 判据 `relay_data_plane_respects_policy` 原来钉的是「`decide_relay_from_peer(` 出现 ≥3 次」⇒
  它要求的正是"重复三遍"这个形状：谁收成 helper 让三处共调，计数掉到 1、判据当场红，而代码其实变好了；
  最顺手的消红动作是再抄第四遍。**现在钉形状不钉次数**：策略判定恰好 1 处（在家里）+ `fn relay_denied(` 恰好 1 处 +
  `if relay_denied(` 恰好 3 处。两条反证都真跑过（不是设计意图）：
  摘掉 `RelayChunk` 那一处消费者 ⇒ `FAILED … 都要走 relay_denied，实际 2 处`；
  在 helper 旁再抄一处判定 ⇒ `FAILED … 必须只有 relay_denied 一个家，实际 2 处`。两次都当场还原。
- 顺手止住一处热路径小浪费：被拒日志的文案以前在**每一跳**都无条件 `format!`（中继在文件分片的热路径上），
  现在 `why` 是 `impl FnOnce() -> String`，只在真被拒且节流放行时才求值。

- ★ **CHANGELOG 分卷（方案 A，他 2026-10-07 点头后执行）**：台账主文件 **13,592 ⇒ 720 行**，
  4.31.41 及更早的 **303 个版本小节 / 12,888 行**整段搬到 `docs/notes/changelog-archive.md`。
  切点取「保留未发布小节 + 4.32 及以后」，依据是现算的分布：最近 10 节只占全文 6%，未发布小节 242 行 ⇒
  **天天要读的那一块本来就只 700 行，剩下 94% 是冷的历史**（复跑 `grep -c '^## \[' CHANGELOG.md` ⇒ 9、
  `grep -c '^## \[' docs/notes/changelog-archive.md` ⇒ 303，两份之和 312 = 分卷前那份的小节数）。
- **只搬不改，恒等判据是字节级**：把两段新增说明文字摘掉后，主文件 + 归档重拼回原文，**SHA 相同**
  （`570410fb47cd…`）。分卷脚本里六道断言（小节数守恒、锚点仍在主文件且唯一、归档不含锚点、
  归档首节确实是 4.31.41、主文件仍是新在前降序、重拼逐字节相同）**任何一条不过就不写盘**。
- ★ **这一刀没有改任何一把尺子，三条理由都是当场读过的**（与前面几刀"判据必须同批改口"形成对照 —— 区别不在大小，
  而在**判据读的是不是这份文件的哪一段**）：
  ① 结构判据与发版脚本只认**行首**的未发布小节锚点 ⇒ 锚点留在主文件且仍唯一；
  ② 条目归属判据只读**当前这一版**那一小节 ⇒ 后半段住哪儿与它无关，跑出来仍然「归属可证」
  （`npm run version:changelog` 当场退 0）；
  ③ 引用与数字两把文档量具用**显式清单**（台账本就不在其中），而命令名探针的跳过规则整段放过
  `docs/notes/` 与 `CHANGELOG.md` ⇒ **归档落 `docs/notes/` 是刻意的**：这样不需要为它新开一条豁免，
  也不会让 12,888 行历史里的旧命令名被当成"文档引用了不存在的脚本"。
- **非空转复证**：那条专门往台账注入、证明结构判据会红的护栏用例（`CHANGELOG 结构（[Unreleased] 锚点缺失/顺序错乱必须报出）`）
  分卷后仍报「✅ 改坏即 FAIL、恢复即 PASS」⇒ 锚点没被搬丢；`check-doc-numbers` / `check-doc-citations` /
  `check-invariant-hooks` / `check-scripts-parse` 全 0。
- 归档顶部写死两条规矩：**不追加、不改写**。新的更新说明一律写主文件的未发布小节；历史小节里那些
  "当时的行号 / 当时的条数"是证据，不是待更新的字段 —— 改了就把记录换成了传闻。
- 零应用码改动（一份台账 + 一份新归档 + 一处文档改口）⇒ 不提版本。


- ★ **验真时发现并修掉一条永远匹配不上的护栏 hint**（顺带把这类洞的量法记下来）：
  `guard_cases/toolchain.py` 那条「门禁 local 层必须逐条点名 harness 的正向注入轮」写的是 `expect_fail_hint="local 层"`，
  而这条用例跑的 `node scripts/check-doc-numbers.mjs` **从不打印这个短语**（它打印的是
  「门禁层点名了 harness 里不存在的注入 …」和「harness 有正向轮次 --fault=kill-mid，但 verify.mjs 的门禁层没有它」——
  那句 `local 层` 只存在于该文件第 299 行的**注释**里）。⇒ 改成判据真会打印的那句，跑完 detail 从
  「失败输出里没看到 …」变成「✅ 改坏即 FAIL、恢复即 PASS」；再反向证一次匹配机制本身不是空转：
  故意把 hint 换成一个不存在的短语 ⇒ 提醒立刻出现（退码仍 0）。
  ⚠️ 由此量到的**系统性形状**：202 条用例全带 `expect_fail_hint`，而 runner 对"匹配不上"的处理是
  **写进 detail 后照样判绿**（`verify-guards.py:270`）⇒ hint 是 attribution 提示、不是守卫。
  静态代理只能筛出 8 条"整个仓里没有任何代码会打印这个短语"的（这条 `local 层` 反而不在其中 ——
  别的脚本会打印它，**但这条用例跑的那条命令不会**），真实数量必须按 `case.cmd` 分组跑一遍才知道
  ⇒ 已开一条工单（要不要把 runner 改成「声明了 hint 却没匹配上就 FAIL」= 一次 202 条整跑，约 45–55 分钟）。
- 纯文档一记（无码改动 ⇒ 不提版本）：拆分计划补 **§2-bis「其余五个文件由什么构成」** —— 把"具体分析它们在干嘛"这半条目标
  从一句话描述升级为**现算的内部构成表**：护栏 runner 202 条 Case 的七个域分布（39/32/30/29/27/26/19）、
  `transport/*_tests.rs` **96 个**测试的分布、`lib_*_tests.rs` **75 个**、harness 19 册 **175 条 `check("`**
  （+ 驱动里默认轮那 18 条 ⇒ 每轮真数 = 18 + 本册数，与判据 C 是两条独立量法、互点对上了）、
  台账 **312 个版本小节**（平均一节 43 行）。表里每条都挂了复跑命令，并逐条在本机原样跑过（BSD grep 也吃那个形状）。
  ★ 数出第一版时我自己的尺子是坏的：`re.findall` 忘了开 `re.M` ⇒ `^    Case\(` 对七册全数 0，
  而 202 是我知道的非零值 —— "已知非零的量具读出 0"就当场否掉了它，补 `re.M` 后又漏数 `#[tokio::test]`（`listen_tests` 4 个被数成 0）。
  两个错都修在落笔之前，表里现在是修完的读数。
- ★ 拆分管线段的验证口径补一条**会咬人的运维警示**（落在 `docs/large-file-split-plan.md` harness 那一节）：
  **锁屏期间不许跑 `selfproof:sync`**。实测本轮整层跑的每一次报红，红名聚起来只有一种（「报告带两张全屏帧」⇒ 环境不是搬家），
  但反证档的红**条数**会被这一格顶上去 —— 而 `scripts/fixtures/selfproof-baseline.json` 存的正是每档红条数，
  这时候 `--sync` 等于把 +1 悄悄写成契约。正确顺序：解锁 → 单档复跑对数 → 需要时才 sync；跑不动就记「未跑」，不许记绿（总指令§十）。
- 写这条警示时**被自家判据 A 当场逮到一次**：我在文档里写「`verify:e2e` 前 14 步」，判据把任何「N 步」都当门禁步数声明，
  报「手写 14，现算只有 快速 17 / 全量 23」⇒ 本地层的步数不许写成「N 步」（换量词，或引脚本自己打印的那行）。
  这条形状约束已进长期记忆，判据本身一字未改 —— 它这次的红是**对的**。
- 纯文档一记（无码改动 ⇒ 不提版本）：把三处**会指挥下一步动作**的旧指路句按搬家后的真位置改口 ——
  ① `docs/acceptance/stability-smoke-matrix.md` 顶部那句"判据 C 从 `e2e-multi-instance.mjs` 现算每轮条数"
  改成两路归堆（驱动的块 + `rounds/*.mjs` 按册里 `export const MODE`），并写清"同一 MODE 两处家 = 红"；
  ② 同一份矩阵里点名的 `openWhileOff` / `openWhenOn` / `probeControl` 三条判据，落点从主文件改到
  `scripts/e2e/rounds/lanoff.mjs`（现读确认这三条只住在那儿了）；
  ③ 拆分计划 §4「已完成」补第 5 条（harness 那一刀的形状、三条必须同批改的判据、惰性 import 那个洞），
  标题计数改口为五个文件。
  ★ 有一条**没改**并说清为什么：矩阵 §213 那句"`e2e-multi-instance.mjs` 起跑前 `renameSync(i.db, …)`"仍然成立 ——
  库备份/还原那段确实还留在驱动里（现读 693 / 757 行），把它跟着别的指针一起改掉就是制造假修正。
  复跑：`node scripts/check-doc-numbers.mjs`（20 轮数字仍逐轮一致）/ `check-doc-citations` 0 / `check-invariant-hooks` 30 条全绑定。
- ★ **harness 第八刀第三段：剩下 9 族 13 个块（2,108 行）也搬完了 —— 至此 `scripts/e2e-multi-instance.mjs` 4,845 ⇒ 驱动 910**，
  `scripts/e2e/core.mjs` 679，`scripts/e2e/rounds/` **19 册 / 3,664 行**（最大 `task.mjs` 535）。驱动里顶格轮次块现为 **0**
  （复跑 `grep -cE '^if \([A-Z_]+\) \{$' scripts/e2e-multi-instance.mjs`），只剩 26 条分发行 + 默认轮 + 报告。
  ⇒ **本轮目标的"人写的代码文件都进 3,000 行"这条已经达成**：§1 那条现算命令现在只印 4 行，全都不是代码
  （`CHANGELOG.md` 台账 + `Cargo.lock` / `package-lock.json` 两份生成物 + `.aoci/baseline.json` 工具基线）。
- ★ **抓到一类"只有文件存在性能看见"的洞**，而且当场就抓到：块体里有惰性 `await import("./ax-tree.mjs")`
  （群聊轮读 AX 树那两处）。**静态 import 表看不见它**（它不是 import 语句）、**ESM 链接测试也看不见它**
  （19 册逐个 `await import()` 全过 —— 那一行还没被执行）⇒ 唯一报红的是 `check-scripts-parse.mjs`
  那条「被引用但文件不存在」。修法一行：按新目录重定基成 `../../ax-tree.mjs`。
  ⇒ 记下这条区别：**"能不能解析"与"路径落不落得到真文件"是两把判据，后者不能被前者替代**；本轮没为此新加工具（已有的那把买到了）。
- **生成器自己的两个缺陷都被当场抓住，各记一条形状**：
  ① 取"声明自己的注释"不能用 `getFullStart()` 的前导 trivia —— 同批被搬走的轮次块也算"上一条语句"，
     于是**群聊那一族的预置横幅落进了 `task.mjs` 的私有段**（同一段话在两个分册各出现一次、还挂错对象）。
     改成只认**紧邻上一行**的连续注释后解决；
  ② 修完 ① 之后那段横幅**仍然**在 task.mjs 里 —— 因为它是**驱动里本来就挂错对象的注释**（内容说的是 `if (GROUP)` 那一段，
     却坐在任务 id 声明上面；`if (GROUP) {` 自己头上是空的）。已把它归位到 `group.mjs` 的 preset 上。
     这条不是搬家用具的错，是搬家把一处旧缺陷照出来给你看了 —— 系统性扫法：逐册列"注释里提到的 `--round=` / `--fault=` 名字"与本族对照
     （复跑：把 `docs/large-file-split-plan.md` §1 那段 python 换成按 `export const MODE` 分组即可），其余命中都是**正当交叉引用**
     （如续发轮里那句"`--round=groupcrash` 判的是崩溃恢复，不是新建群能不能送达"）。
- **恒等与行为**：判据 C 现算的 20 个轮次标签**在 13 个块搬完 + 注释补完之后仍与搬前一字不差**；真跑这 9 轮
  `group` 36 / `task` 49 / `posttext` 39 / `dmreaction` 24 / `gossip3` 25 / `gossip-late` 23 / `lanoff` 26 / `groupcrash` 26 / `gfile` 28，
  **每轮恰好 1 条红且 9 条都是同一格**「报告带两张全屏帧」（会话锁定 ⇒ 环境判不了，**没放宽截图判据**），条数与现算逐轮吻合。
  契约图那格依赖的现读命令也当场复跑过：`grep -oE 'ROUND === "[a-z0-9-]+"' scripts/e2e-multi-instance.mjs | sort -u` ⇒ 仍 19 个轮次名
  （分发留在驱动 ⇒ 判据 D 与这条命令一字未改）。
- 一次性工具的一条自我伤害记下来（不留红、但值得记形状）：argv 里带 `=族名=阶段名` 覆盖写法时被我的过滤器当成"不是族名"，
  于是**只搬走了 6 个单块族**；而更早一次失败（`dmreact` 的 `ROUND` 没家）在被拒写盘之前已经把 group/task/posttext 三册落过一次盘 ⇒
  **驱动最后写盘**这个顺序保住了不一致不会发生，但孤儿分册确实存在过、也确实清掉了。⇒ 生成器该"全部成功才落盘"，
  而"引用没家就拒绝写盘"那道断言第一次发挥了作用（它抓到的是真洞：漏搬内置件与 `ROUND`）。
- 零应用码改动 ⇒ 不提版本。护栏/文档侧欠账只剩两件：新落的 19 册 + core/驱动的 **AOCI 认知维护**（要一个 aoci MCP 工具在册的会话），
  以及 `CHANGELOG.md` 那一本的 A/B 决定（等你拍板）。
- ★ **harness 第八刀第二段（下）：10 个注入族 13 个块整块搬进 `scripts/e2e/rounds/`** —— 主文件 4,209 ⇒ **3,146**，
  10 册共 1,266 行（最大 `sendkill.mjs` 153），core 679。搬走 1,038 行；驱动里还剩 **13 块 / 2,108 行**（群聊与任务那 9 族）
  ⇒ **再搬任意一族就进 3,000 阈值**。
- **这一刀一行都没重排，也没改成入参**：块体本来就是 2 格缩进（顶层 `if` 之内）⇒ 去掉旗标行与它顶格的 `}` 之后**正好是函数体缩进**，
  逐字即所得；而**旗标与分发留在驱动**（`if (POISON) await poison.preset();`）⇒ 判据 D 与契约图那条 `ROUND === "…"` 现读命令的输入没搬家，**一字未改**。
  这条切法推翻了我自己 10-06 写进拆分计划的那句结论（「块读的就是那 29 个顶部旗标 ⇒ 搬出去必须改成显式入参，那是重写而不是搬家」）：
  按族取 AST 引用集合后，**块体里没有一处读旗标**，旗标只出现在 `if (FLAG) {` 那一行。文档里那两处（连同「`peerTo` 被十族都写」→ 实为**十族都读**）已按读数改口。
- **搬家前先证的两条前提**（决定"盲加前缀会不会静默改语义"）：7 个跨块可变名在全文件除顶层那条 `let` 外**零绑定**（无解构 / 无形参 / 无内层 `let`）、
  **0 处写成对象简写属性**；再加一条 AST 硬断言：**每册正文引用的名字必须有归属**（自带 import / 族私有 / 全局），没家就拒绝写盘 ——
  这条当场抓到过一次真洞：第一版生成器没搬 `fs` / `path` / `createHash` 这些**内置件 import**，`node --check` 全过而跑起来才 ReferenceError。
- **尺子跟着搬，并且当场证它不是空转**（判据 C 四条 lie，一条比一条狠）：
  ① 把一册的 MODE 改成未登记名 ⇒ 红（沿用原有那条 unknown 口径）；② **把整册挪走** ⇒ 红「MODE_LABEL 登记了 POISON，但驱动与 rounds/ 里都没有它的家」
  —— 这条是新加的，挡的正是"删分册 ⇒ 该轮断言数静默变 0 而文档跟着改 0 就绿"；③ 同一 MODE 出现两份家 ⇒ 红；
  ④ 摘掉册里一条 `check("` ⇒ 文档那句「脏前缀轮 22 条断言」与现算 21 对不上 ⇒ 红。四条恢复后全部退 0。
  恒等判据：判据 C 现算的 **20 个轮次标签在搬前搬后一字不差**（`node scripts/check-doc-numbers.mjs | grep 现算 E2E 断言数` 与搬前那份 diff 为空）。
- **另外两处"检索面必须跟着搬家"的守卫，都是实测必需而不是预防**：
  · `check-invariant-hooks` 的 `e2e:` 片段原来只读驱动 ⇒ 加宽到驱动 + `e2e/core.mjs` + `e2e/rounds/*.mjs`（12 份）。
    反证做过：把检索面收回只读驱动 ⇒ `INV-P06` 的 `e2e:故障注入判据③` / `…⑧` 两条当场报红（退 1）——
    因为它们搬完后只存在于 `rounds/kill.mjs` / `rounds/rot.mjs`。**不加这条的话表现是"这两条不变量没有钩子"**，会指挥下一个人去补一条本来就活着的钩子。
  · `check-scripts-parse` 的 import 闭包原来只跟 `./x.mjs`，不跟 `../x.mjs` ⇒ 分册引用上一级那条边一直是漏的；
    放松后**当场多查一个文件**（41 ⇒ 52，新增的是 `docs/domains.data.mjs`，此前从未被查过）。
- **行为复证（真跑搬过的族，屏幕锁定态）**：`--fault=kill-mid` 25 条 / `--fault=recv-dir-rotted` 24 条 / `--fault=multi-file` 24 条，
  **每轮恰好 1 条红，且都是同一格**「报告带两张全屏帧」（loginwindow 盖屏 ⇒ 环境判不了；**没放宽截图判据**），条数与判据 C 现算逐轮一致。
  便宜量具：`verify-guards.py --list` 退 0、`check-domain-map` / `check-domain-deps` / `check-test-manifest --only rust` / `check-doc-numbers` / `check-doc-citations` 全 0。
- ★ 顺手记一条**量具坏了的形状**（已写进拆分计划正文）：那行数块的 python 只匹配 `^if \([A-Z_]+`，
  分发行出现后它把 13 条 `if (X) await …` 也当块开头，而分发行没有顶格 `}` ⇒ 一路吞到下一个真闭合，
  实测读出「26 块 / 3,497 行」这种**比全文还大**的废数。形状规则收成 `^if \([A-Z_]+\) \{$` 之后回到 13 块 / 2,108 行。
- 零应用码改动 ⇒ 不提版本。下一段：群聊与任务那 9 族（13 块 / 2,108 行）同法搬走，主文件落到 ~1,050。

- ★ **harness 第八刀第二段（上）：先把「谁都能碰的那份共享量」收成一个家** —— 主文件 4,321 ⇒ 4,209，`scripts/e2e/core.mjs` 602 ⇒ 676。
  搬去 core 的是 12 条 argv/env 派生声明（`FAULT` / `ROUND` / `LIE` / `LIE_SHA` / `GROUP_ID` / `GROUP_NAME` / `GROUP_KEY_B64` 连它的填充循环 /
  `GROUP_KEY_STR` / `SIZE_ARG` / `FILE_MB` / `FILE_BYTES`）；7 个「写在驱动、读在轮次块」的可变量（`idA` `idB` `msgId` `peerTo` `xferId` `srcFile` `srcSha`）
  并进已有的状态对象 `S`。**26 个轮次块一个都没动** —— 这一段是下一步的前提：轮次块要搬出去，就得先拿到同一份共享量。
- **为什么前一段说「43 个模块级标识符」不是拦路石，而共享量只有 7 个**：用 `node_modules` 里的 TypeScript 解析器现数
  （一次性脚本在 /tmp、不入库，所以这两个数是**本轮读到的、不是读者能复跑的**；能复跑的是下面那两条恒等判据）⇒
  **89 个名字只在某个块里出现**（各轮的旗标、`*_LIE`、字节数、`xferIdN` 这类族内 id —— 它们跟着块走，不需要任何家），
  **只有 9 个跨越块或跨块/驱动**（7 个可变量 + `FILE_BYTES` + `GROUP_KEY_B64`）。上一段那句「43 个标识符 ⇒ 拆不得」是把"块引用过模块级名字"
  误读成"必须共享"，实际绝大多数是**一族私有的**。
- **盲加 `S.` 前缀会不会静默改语义 —— 先证两件事再动手**：这 7 个名字在块内**没有任何局部绑定**（无解构、无形参、无内层 `let`，AST 全文件扫：
  除顶层那一条声明外零绑定），也**没有一处被写成对象简写属性**（`{ idA }` 这种加前缀会变成语法错或改语义的形状，实测 0 处）
  —— 这两条同样是 AST 现数、随本次一次性脚本作废，但它们正是「234 处插入」的前提，所以写在这；后果由下面两把判据兜住 ⇒ 234 处插入
  （`idA`97 / `idB`75 / `peerTo`23 / `xferId`17 / `msgId`16 / `srcFile`3 / `srcSha`3）全部按 AST 位置做，不靠正则。
- **恒等与行为两把都交了**：判据 C 现算的 20 轮断言数**逐轮与搬前一字不差**（`node scripts/check-doc-numbers.mjs | grep 现算 E2E 断言数` 前后 diff 空）；
  真跑默认轮 18 条 = 1 红（锁屏那一格，与拆前同形）；再跑 `--fault=poison-part-lie` 得 **22 条 3 红**，其中 **2 条是设计要红的脏前缀判据**
  （『坏内容不许冒充成功』『两侧都不许 done』）—— 这两条亮着就是 `LIE`/`LIE_SHA` 从 core 读到的活证据，第 3 条才是锁屏。
  便宜量具：`check-scripts-parse` 0（41 个脚本）、`check-invariant-hooks` 0（30 条钩子全绑定）、`check-doc-citations` 0（34 处 file:line）、
  `verify-guards.py --list` 0。
- **顺手拔掉一处会说谎的指路命令**：`docs/stability-roadmap.md` 那条「`grep -n GOSSLAN_AUTOSTART scripts/e2e-multi-instance.mjs` ⇒ 第 554 行」
  在上一段搬家后就已经空了（那份 env 现在由 `scripts/e2e/core.mjs` 的 `launch()` 塞）—— 它是写给读者的复跑指令，不是历史读数 ⇒ 改成指向 core 并去掉硬行号；
  同一条目里 `lib.rs:335/342` 那两处**留着不动**（那是 09-27 那次现场的记录，且本仓已把 `forced || enabled` 改掉，改了反而把历史覆盖掉）。
- 零应用码改动 ⇒ 不提版本。下一段是真搬家：10 个文件注入族（POISON/RESUME/KILL/FREEZE/SENDKILL/STALL/DISK/ROT/SHRINK/MULTI，共 1,088 行）
  整块搬进 `scripts/e2e/rounds/*.mjs` —— 块体缩进本来就是 2 格，正好是函数体的缩进 ⇒ **去掉 `if (FLAG) {` 与它顶格的 `}` 之后逐字即所得，一行都不必重排**；
  旗标与分发留在驱动（判据 D 与契约图那条 `ROUND === "…"` 的现读命令因此一字不用改），判据 C 改成按分册里一行 `export const MODE` 归堆。

- ★ **harness 第八刀第一段：`scripts/e2e-multi-instance.mjs` 4,845 ⇒ 主文件 4,321 + 新家 `scripts/e2e/core.mjs` 602 行**（55 个导出：常量、共享量、可复用的工具函数）。搬的段全是模块级声明（本来就在第 0 列）⇒ 唯一的文本改动是给声明行加 export 前缀；另有两处是**必须**改的：① `ROOT` 由本文件位置推导，搬进子目录要退两层（不改就静默指到 `scripts/`）；② 三个会被赋值的标量（`curStep` / `curStepIdx` / `stashSeq`）改由状态对象 `S` 承载 —— 6 个读写点，逐处数过。
- ★ 这一段把「JS 里为什么不像 Rust 那样能纯搬」量成三条硬约束（每条都是本轮真跑出来的，已写进 core 册头）：
  ① **ESM 不给 import 绑定赋值** —— 第一版搬完真跑就报 Assignment to constant variable；
  ② **搬进 core 的函数不许回头引用留在主文件的声明** —— 链接期不报，`writeReport` 引用了驱动侧 8 个标量，
     跑起来才炸 ⇒ 生成器现在把这条做成**写盘前**的断言（B 类洞会点名到行）；
  ③ **位置相关量必须单独核** —— `import.meta.dirname` 派生的 `ROOT` 换目录就换含义（实测 pre-flight 以「没有二进制」拒跑、退 2）。
- **复证不靠读代码**：`node --check` 两份都过；core 单独 import 无顶层副作用（`test-results` 目录数前后都 299、  无残留进程）；真跑三轮 —— `--round=dmreaction` 24 条、`task` 49 条、`group` 36 条，  **每轮恰好 1 条红，且是同一格**「报告带两张全屏帧」（屏幕锁定 ⇒ 只抓到 1 张），与拆前的读数同形；  判据 C 现算的 20 轮断言数**逐轮与拆前一致**；`verify-guards.py --list` 0（202 条锚点各恰好命中一次）、  `check-scripts-parse` 0（41 个脚本，新 core 已被 import 闭包吃进去）、`check-domain-map` 0、  `check-doc-numbers` 0；快速层 16 绿 + 第 14 步 Change Budget（既有红，非本次）。顺带量到：**每轮 13–39 秒**。
- 零应用码改动（都在 `scripts/` 与 `docs/`）⇒ 不提版本。下一段是把 26 个 `if (FLAG) {…}`（3,157 行）按族拆进 `scripts/e2e/rounds/`，同批改判据 C/D 的读法 —— 那一段做完主文件才落到 ~1,200 行。

- 纯文档一记（无码改动 ⇒ 不提版本）：拆分计划补 **§5「更优雅的写法实测到哪一步」**，把**函数级**这一半从印象变成现算 —— `handle_message` 函数体 **1562 行 / 38 个顶层分支**，`match` 之前的 `let`（`allowed` / `cfg` / `dbc`）全在一条**早退分支内部**、分支体里的同名 `let` 各分支自己有（现算 7 处）⇒ **「一个消息族一个 handler」在这里是机械活不是重写**（新函数只要 `(&AppState, &str peer_id)` + 自己的解构字段）。但这一刀**不让任何文件变小**，改的是控制流 ⇒ 按既有口径仍属「真重构」，且 2026-09-25 复审已把这一处判为「短期只降稳定」而暂缓 ⇒ **等他点头再动**，动就一族一提交、每步跑同一套恒等判据。文档里那条复跑命令在仓库根原样跑过，读数 `span 1562 arms 38` 与正文一致。
- ★ 顺手抓到一处**真缺陷**（不是风格问题）：中继授权闸在生产码里有 **3 个家**（`transport.rs:1003`、`transport.rs:1278`、`transport/relay_file.rs:459`），而判据 `relay_data_plane_respects_policy` 钉的是 `wired >= 3` ⇒ **这条判据现在要求的就是「重复三遍」这个形状**：谁把闸收成一处 helper 让三个消费者共调，`wired` 掉到 1、判据当场红，而代码其实变好了。文档里写清了唯一正确的改法（两件一起做）：抽一个家 + **同批把判据改严而不是改松**（「策略调用恰好 1 处 + helper 调用点恰好 3 处」，配两条反证：摘掉一个消费者必红、把闸内联回去必红）。不同批改判据的话，最顺手的消红动作是再复制一份第四遍 —— 那才是把缺陷真钉死。
- 证据归属：全量层（23 步）在 tip `8b77d33` 上整跑过一遍 —— 21 绿 / 2 红 / 1 跳过，两条红仍是同一根因（`Change Budget` 窗口里那三条 transport 补丁形状提交，以及被它顶住的「force push 后 before 不可达不得判空转」那一条护栏用例的「恢复后即 PASS」半边），与上一版全量层（`fe35db0`）比**差集为 0**（没有新增红）；`移动端编译门禁（Android）` 那一步本层跳过、按既有口径记「未跑」不记 ✅。另把契约图那两格也现算核了一遍：`字面量事件名` 27 与 `arch-map-stats.mjs` 读数一致、`护栏非空转用例` 202 由判据 E 对账 —— 这轮搬家**没有让图上任何一格悄悄变数**。
- ★ **护栏 runner 第七刀：`scripts/verify-guards.py` 4,176 ⇒ runner 385 行 + `scripts/guard_cases/` 7 个域分册
  （最大 771 行）** —— 202 条 `Case` 按**锚定的被守物**分册，runner 只剩注入/还原/报告那一套。
  这一刀与前面几刀不同类：它**必须同批改判据本身**（判据 E 的计数范围跟着搬家），所以两件事各补了非空转对照。
- **恒等判据换了形状，但仍是硬的那种**：`python3 scripts/verify-guards.py --list` 拆前拆后都是 624 行、
  **排序后逐字节差集 0 行**（202 条用例名与说明一字未变）；运行次序按 `MODULES` 分段变了 ——
  只影响 `[n/m]` 进度号，而**没有判据读那个序号**（现算：代码里没有 `CASES[` / `CASES.index`；
  文档里 `[197/197]` 那种写的是**总数**、与次序无关）。
  ⚠️ 搬完第一跑就抓到**我自己造的新噪声**：册头里写了一句带反斜杠括号的正则，Python 报 7 条
  `SyntaxWarning: invalid escape sequence` ⇒ 改成中文原样描述后 stderr 0 行。
- ★ **三处判据跟着搬家改口径，每一处都当场证明没空转**：
  ① `check-doc-numbers.mjs` 判据 E 现在 glob `scripts/guard_cases/*.py` 数 `^    Case\(`（仍故意「数到 0 就 throw」）
     —— 摘掉一条 `Case(` ⇒ 它报「现算 201 与图上那格 202 对不上」；还原 ⇒ 退 0；
  ② `guard_cases/__init__.py` 加了一条**起跑前就炸**的对账：目录里的分册集合 ≠ `MODULES` 名单 ⇒ `AssertionError`
     点名差集。这条守的是 E **买不到的那一半**：E 按目录 glob 数，「漏点名一册」在它眼里条数不变（＝假绿），
     只有装配表自己知道自己少装了谁。实测：临时丢进一册 `zzz_probe.py` ⇒ `--list` 退 1 并打印差集，删掉即复绿；
  ③ `check-scripts-parse.mjs` 的 import 闭包原来只走 `.mjs`（`node --check` 不解析 import ⇒ 共用件坏了没人知道），
     现在补上 Python 的 `from <pkg> import` ⇒ 分册里的语法错落在秒级层被抓。实测：`= [` 改成 `= [)` ⇒ 该步报红，还原即绿。
- **路由规则踩过一次 substring 假命中，已改**：第一版按裸 substring 判域，于是 `TodoCardBubble.vue`（含「ble」）
  被分进蓝牙册、`FriendProfile.vue`（含「file」）被分进文件册 —— 各 2 条。改成按**路径段/文件名主干**匹配后归位；
  这条教训写进了每一册的册头，因为下一个加用例的人会同样手滑。
- **`ROOT` 的深度换了，配一条当场断言**：分册在 `scripts/guard_cases/` 下 ⇒ `ROOT` 必须是 `parents[2]`；
  数错时 `src-tauri/Cargo.toml` 就不在 ⇒ `base.py` 直接抛，而不是让 202 条用例去找不着的文件。
  同批让 `verify-guards.py` 自己把脚本目录插进 `sys.path`：`docs/final-architecture-review.md` 里有一条用
  `spec_from_file_location` 数 `CASES` 的复跑命令，那种加载方式下 `from guard_cases import` 会
  `ModuleNotFoundError`（**改之前实测整条命令已作废**）⇒ 指路句必须在读者站的位置原样跑得通，不能只写「应该能跑」。
  ⇒ 修的是**模块自己**（不把 `sys.path` 的責任推给每个读者），文档那条命令一字未改、现在原样返回 202。
- 零应用码改动（都在 `scripts/` 与 `docs/`）⇒ **不提版本**。快速层第 10 步「护栏注入锚点静态核对」正是这一刀的
  常驻回归（它 import 整个包 ⇒ 装配表少点名会当场红）；
- ★ **第四处指名点被我漏了，是快速层当场抓出来的**：`check-invariant-hooks.mjs` 也在**按用例名**解析
  `guards:` 钩子（`docs/protocol-invariants.md` 里 11 条不变量各钉着一具名 Case）⇒ Case 一搬家，
  那 11 条钩子当场「解析失败」（现算读数：`形态 … guard-case:11`）。同批把取名范围改成
  `verify-guards.py` + `scripts/guard_cases/*.py`，并照例做非空转对照：把一个 Case 的名字改坏 ⇒
  该守卫退 1 并把两处都点名（还原 ⇒ 退 0）。
  ⚠️ 这条流程欠账记下来：**我是先提交、后跑快速层**才看到它的。前面逐个跑的 `check-doc-numbers` /
  `check-scripts-parse` / `check-domain-map` 都是我自己列的清单，而权威清单是**那一层的 17 步**；
  清单少列一个判据，就等于那个判据没被跑过 ⇒ 以后每一刀在提交前先跑快速层，不靠"我想起有哪几处"。
  快速层在这条链里已经是第二次当唯一目击者（另一次是 09-29 那趟 rust 锚点）。第 14 步 `Change Budget` 那条红与本刀无关
  （窗口里仍是 a1c4301/615c659/339b8ae 三条 transport 补丁形状提交）。
- ★ 顺手改掉上一刀里我自己抄错的一格：那句写成了「`[61/66] force push 后 …`」—— 用例**序号**会随 `MODULES`
  分段而漂，正是本轮要避免的抄法 ⇒ 改成只点用例名、不点序号（同一条纪律第二次用上）。

- ★ **`lib_tests.rs` 第六刀（4,009 ⇒ 壳 205 行 + 11 个 `lib_<concern>_tests.rs`，最大一册 614 行）
  ⇒ `src-tauri/src` 下所有 `.rs`（含分册）今天已经没有 > 3,000 行的文件**
  （量法见 `docs/large-file-split-plan.md` §1 那条现算命令；逐册 `wc -l src-tauri/src/lib_*.rs`）。
- **分册与 `lib_tests.rs` 同级平铺，不是随手放的**：这个文件近 50 处 `include_str!("commands.rs")`、
  `include_str!("../gen/android/…")` 是**相对本文件**解析的，挪进 `lib_tests/` 子目录会让它们整体偏移一位。
  编译器会拒（不静默），但那就不再是"逐字未变"的搬家 ⇒ 恒等判据从"块文本逐字相同"降级成
  "我读过觉得没变"。这条规矩本来就读得到：`lib_tests.rs` 头部 2026-09-28 那段注释写的正是同一条，
  并拿 `network/transport/tests.rs` 那次换目录必须改 `../ble.rs` 当反例 ⇒ 这次是照它做。
  留在壳里的只有三份守卫视图（`all_commands_src` / `all_db_src`）与解析器 ——
  登记对账那条守卫读的是 `include_str!("lib_tests.rs")` 并按函数名切体，把视图搬走就是弄丢它自己的锚点。
- **搬家用的跨度规则换了（这一步是必须的，不是偏好）**：前一版按字符数 `{`/`}` 算函数跨度，
  在 `lib_tests.rs` 上把 96 项只认出 **57 项** —— 那个文件里就有 `'{' => depth += 1` 这种字符字面量，
  按字符数括号会把它当成真的花括号，于是把 29 个项当成 1 个项（顺带把某项算成 1,126 行，实测 29 行）。
  改成"声明行 `^    fn` ⇒ 收口行 `^    }`"（rustfmt 保证嵌套收口更深），并把
  **认出项数 == `fn` 声明数** 当断言跑（96 == 96 才继续）。同一条断言在上一刀里是 113 == 113。
- **恒等判据同前一批且全绿**：`cargo test --features bluetooth --lib -- --list` 拆前/拆后各 789 条、
  排序后差集 **0 行**；`cargo test --lib` **789 passed / 0 failed**；`cargo fmt --check --all` 0、
  `cargo clippy --features bluetooth -- -D warnings` 0、`verify-guards.py --list` 0
  （202 条锚点各恰好命中一次）、`check-test-manifest --only rust` 0、`check-domain-map` 0
  （11 个新册同批登记进 `unmapped` —— 判据 D「coverageRoots 下不许有无主文件」靠的就是这份登记，
  而它们跨业务领域，不该塞进某个领域的 paths）、`check-domain-deps` / `check-doc-numbers` /
  `check-doc-citations` 0。
- **搬走的守卫自己还会咬（现跑对照，不是推断）**：摘掉 `network/mod.rs` 里 `transport/dial.rs` 那一行登记
  ⇒ 搬进 `lib_source_view_tests.rs` 的 `guard_source_views_register_every_include_subfile` 当场 `FAILED`
  并指名缺哪一个分册（输出 `1 failed; 788 filtered out` ⇒ 过滤确实命中，不是打空退 0 那种假绿）；
  还原后 `1 passed`。摘动的是判据的输入、不是判据本身，跑完 `git checkout` 复原，工作树只留下本次搬家。
- 顺带把**下一刀该动谁**用现算定下来（`docs/large-file-split-plan.md` §1/§4 已改口）：
  `verify-guards.py` 4,176 那条 Case 清单可以先切，但**必须同批改判据 E** —— 它只在主文件这一个文本里
  按 `^    Case\(` 数条数，分册后现算会得 0，而那条判据故意"数到 0 就 throw"（这是设计，不是 bug）；
  `e2e-multi-instance.mjs` 4,845 排最后 —— 现算顶格 `if (MODE)` 轮次块 3,146 行、非轮次部分 1,699 行，
  光搬引擎最多落到 ~3,100（还在阈值边上），而判据 C/D 的尺子就长在这一个文件上 ⇒ 改尺子的风险大于收益。
- 零应用码改动（`isAppCodePath` 把 `lib_*_tests.rs` 判成测试）⇒ **不提版本**。
  全量层 23 步这次跑出 2 条红，两条同一根因、且都早于本刀：`Change Budget 守门`（窗口里是
  a1c4301/615c659/339b8ae 三条带 `Version-Bump: patch` 的 transport 提交）与
  `护栏非空转（前端子集）` 里那条「force push 后 before 不可达不得判空转」——
  后者的"恢复源码后即 PASS"半边正好被前者顶住（受检范围内一直是红的），不是新的坏。

- ★ **`transport/tests.rs` 第五刀（3,227 ⇒ 壳 29 行 + 15 个 `<concern>_tests.rs`，最大一册 336 行）
  ⇒ Rust 侧今天已经没有 > 3,000 行的文件**（量法见 `docs/large-file-split-plan.md` §1 那条现算命令；
  逐册行数 `wc -l src-tauri/src/network/transport/*.rs` 现数）。
- **计划初稿那句"测试归位到各生产分册"被否掉了**，两条理由都是机器定的：
  ① `network::transport_src_for_guards()` 那份"生产码全集"视图**只许装生产码** —— 测试字面量掺进去
  会把按窗口取段的守卫飘到测试文本上（4.33.6 已经为此修过一次，再并进去就是把那个 bug 请回来）；
  ② `lib_tests.rs` 的 `guard_source_views_register_every_include_subfile` 按**文件名后缀 `_tests.rs`**
  豁免测试分册 ⇒ 新册名必须以此结尾。叫 `tests_*.rs` 会被判"漏登记"，而消红最顺手的做法
  （把测试并进视图）正好是**假绿的形状** —— 所以册名是被判据选定的，不是我起的。
  册内仍用 `include!` 拼回**同一个 `mod tests`** ⇒ 模块路径、`use`、可见性、**测试全名一字未变**。
- **恒等判据与前四批同一套，且这次用到最硬的那一种**：拆前/拆后 `cargo test --features bluetooth
  --lib -- --list` 各 789 条、**排序后差集 0 行**（其中 95 条 `network::transport::tests::*` 逐字相同），
  `cargo test --features bluetooth --lib` **789 passed / 0 failed**；`cargo fmt --check --all` 退 0、
  `cargo clippy --features bluetooth -- -D warnings` 退 0（`--all-targets` 那 37 条测试码既有异味
  拆前拆后同为 37，这次搬家没改动它）；`python3 scripts/verify-guards.py --list` 退 0
  ——「202 条用例的注入锚点都在各自文件里恰好命中一次」；`check-test-manifest --only rust` 退 0
  （基线 789 条全部在跑）；`check-domain-map` / `check-domain-deps` 退 0（15 个新册已登记进
  `docs/domains.data.mjs` 的 transport 领域，判据 D「coverageRoots 下不许有无主文件」靠的就是这份登记）。
- **搬家手法本身也自证了一次**：脚本按花括号深度切出 113 个顶层项、块与块之间**无缝覆盖全文件**
  （`covered == span` 断言），分配阶段断言"未分配 0 项 / 重复分配 0 项"（第一次跑就逮到 1 项漏分：
  `gossip_trust_for_known_friend_never_tofus`），末尾再把块按原序拼回原文逐字对账 ⇒
  "内容没动"是脚本算出来的，不是我读出来的。
- 文档两处随批：`docs/large-file-split-plan.md` §1 表改成**首量快照**并标注去向（数字一律以 §1 那条
  现算命令为准），§4 那句"预期主文件落到 <300"按实测改口 —— 没达成也没必要达成：差的正是
  `startup 1,281` / `dispatch 1,658`（含 `handle_message` 1,562 行）两段，**文件级已进阈值，
  再搬只是壳里套壳**，该动的是函数级拆分，那是改控制流的重构、不能和"只搬不改"混在一次提交里 ⇒ 另案。
- 零应用码改动（`isAppCodePath` 把 `*_tests.rs` 与 `tests.rs` 判成测试）⇒ **不提版本**；
  快速层那一步「CHANGELOG 结构」判据读的是本文件的形状，不是这里的条数。

## [4.33.7] - 2026-10-06

### refactor(network): transport.rs 第三、四批 —— 主文件进 3,000 阈值，并推翻"最大单函数 59 行"这个错结论
- **`transport.rs` 第三、四批：再搬 2,531 行进八个分册，主文件 3,941 ⇒ 2,742 行 —— 进 3,000 阈值**。
  这批新增 6 个分册 `transport/{group_file 839, dial 625, handshake 581, peer_registry 244,
  group_membership 145, e2ee_payload 113}`；连同前两批共 13 个分册
  （复跑 `ls src-tauri/src/network/transport/`、`wc -l src-tauri/src/network/transport*.rs`）。
  恒等判据与前两批同一套：`cargo test --features bluetooth --lib` **789 / 0**、
  **逐条用例名与拆前基线差集 0 行**、clippy/fmt/`verify-guards --list`/测试清单守卫/领域图/快速层全退 0；
  26 条护栏锚点现在解析分布在 7 个文件（14 主文件 + group_file 2 + handshake 2 + queue_policy 5 +
  relay_file 1 + outbox_sweep 1 + dial 1），**失败 0 条**。
- ★ **推翻我自己前一轮写进文档的一个结论**：那句"最大单函数仅 59 行"是算错的——
  我第一版跨度函数在遇到尚未开 `{` 的行就返回。按正确的括号深度重量：`handle_message` **1,562 行**、
  `handle_gossip` 840、`handle_group_file_done` 335、`spawn` 304、`connect_to_peer` 247。
  ⇒ 「更优雅的写法」不只是文件级聚合：**函数级拆分是真重构**，与本轮"只搬不改"是两类活，
  必须一 handler 一提交、每步重跑同一套恒等判据，所以另案处理，文档已按实测改口。
- ★ 两次搬家尝试被自己的机器拦下来（这两条记下来是给下一次省事）：一次把 `include!` 那行本身卷进
  待搬段 ⇒ 子目录里的相对路径变成 `transport/transport/…` 编不过；一次按"墙"碎切成 26 段 ⇒
  同一批项被复制进两处，`E0428 defined multiple times`。都是先编译再提交，工作树干净回退，
  最终做法回到**一刀一整段连续块 + 块内断言无 `include!`/无分节横幅 + 结尾必须正好是该item的右花括号**。

## [4.33.6] - 2026-10-06

### refactor(network): transport.rs 第二批 —— 再搬 1,388 行进五个分册，并修掉「视图掺测试文本」这个潜伏守卫 bug
- **`transport.rs` 第二批：再搬 1,388 行进五个 `include!` 分册，主文件 6,648 ⇒ 5,266 行**。
  新分册 `transport/{queue_policy 264, relay_file 535, outbox_sweep 201, read_receipt 118, link_state 296}`
  （复跑 `wc -l src-tauri/src/network/transport*.rs src-tauri/src/network/transport/*.rs`）。
  恒等判据同第一条：`cargo test --features bluetooth --lib` 仍 **789 passed / 0 failed**、
  **逐条用例名与基线差集 0 行**，`cargo fmt --check --all` 与 `cargo clippy --features bluetooth -- -D warnings` 退 0，
  快速层 17 步退 0，测试清单守卫与领域图退 0。
- ★ **搬完 26 条护栏锚点的实际归属是现算出来的**：19 条仍在主文件、5 条跟着进了 `queue_policy.rs`、
  1 条进 `outbox_sweep.rs`、1 条进 `relay_file.rs`，解析失败 0 条 ⇒ `include!` 分册下**锚点自动跟随**
  这件事第一次拿到正对照（不是只读代码读出来的结论）。
- ★ **顺带修掉一个潜伏的守卫设计 bug（早于本轮存在，是这次搬家把它逼出来的）**：
  `transport_src_for_guards()` 那份"生产码全集"视图里一直拼着 `transport/tests.rs`。
  搬家前生产码都在主文件、排在前面，所以没人发现；搬完之后视图里**先撞上 tests.rs 中的字符串字面量**
  （`"async fn reader_loop("` 这类），于是按窗口取段的守卫飘到测试文本上 ⇒ 4 条守卫假红
  （`writer_loop_splits_local_from_socket_failure_exactly_once`、
  `peer_wide_receiver_cleanup_is_gated_on_total_link_loss`、`peer_offline_rule_has_one_home`、
  `peer_offline_group_cleanup_takes_before_finalizing`）。修法是按本仓自己写在 `mod.rs` 注释里的规矩来：
  **视图只装生产码**，把 tests 分册移出视图，登记对账用例的过滤条件同步补上"恰好名为 `tests.rs`"这一种；
  同时把 4 处"直读 transport.rs 单文件文本"的守卫改指全集视图（原来只读主文件 ⇒ 下一次搬家必然再假红一次）。
  这条属于「守卫看着绿、其实读错了文本」那一类，比少一条用例危险。

## [4.33.5] - 2026-10-06

### refactor(network): `transport.rs` 第一刀搬出四个 `include!` 分册（同批：AOCI 认知层接入、安卓 gradle 相对路径修复、大文件拆分计划与两份文档守卫登记）
- **`transport.rs` 的第一刀：446 行搬进四个 `include!` 分册，行为不变的证据是「测试用例名逐字相同」**。
  主文件 7,087 ⇒ **6,647 行**（复跑 `wc -l src-tauri/src/network/transport.rs`），新增
  `transport/{pending_keys 194, member_notices 131, peer_state 92, outbox_flush 41}.rs`。
  手法沿用本仓先例（`include!` 回同一模块 ⇒ 模块路径、可见性、`use`、测试全名都不变），
  所以恒等判据能用最硬的那种：`cargo test --features bluetooth --lib` 拆前 **789 passed / 0 failed**，
  拆后仍 **789 / 0**，**逐条用例名排序后与基线差集 0 行**（不是"条数相等"这种弱判据）；
  `cargo clippy --features bluetooth -- -D warnings` 退 0、`cargo fmt --check --all` 退 0、
  `python3 scripts/verify-guards.py --list` 退 0。
- ★ **三条守卫立刻报红，且三条都是"我漏登记"而不是"代码坏了"** —— 这仓按源码形状钉住的东西必须同批登记，
  这次被机器当场逮到：① `guard_source_views_register_every_include_subfile` 断言**每个 `include!` 子文件
  都要进守卫视图**（视图＝`network/mod.rs` 的 `transport_src_for_guards()`；漏登记是**假绿**，
  relay.rs 在 4.25.0 接线时漏过两次）；② `offline_peer_stays_listed_but_is_not_online` 在源码文本里
  找不到 `pub(crate) async fn mark_peer_offline(` —— 因为我把它按横幅错分进了 `pending_keys.rs`，
  **它按内聚该在 `peer_state.rs`**（同一条证据：作者留的分节横幅不等于内聚，照横幅切会切出杂糅文件）；
  ③ `friend_identity_anchor_has_one_binding_rule` 的计数从 3 掉到 2 —— 视图少看一册，
  「成为好友的三条路径各绑一次公钥」这条判据就少看见一条路。补登记 + 重归位后三条全回绿。
  同批还要在 `docs/domains.data.mjs` 的分册清单里登记这 4 个文件（`check-domain-map` 退 0）。
- **锚点会跟着 `include!` 走，不必改 26 条 Case 的 `file=`**（推翻拆分计划初稿的推断，已改口）：
  `verify-guards.py` 的 `_list_includes()` + `_resolve_anchor_file()` 会递归展开子模块树、把注入写回
  真正含锚点的文件。正对照是活的：**全仓 202 条 Case 里已有 18 条的锚点本来就落在 include 子文件中**
  （chat.rs 4、settings.rs 2、friends.rs 2、favorites.rs 2、logs.rs 2…），且 202/202 解析零失败。
  真实约束因此是另一条：**同一锚点必须在整棵树里恰好出现一次**。
- 拆分进度（阈值 3,000）：`transport.rs` 还差 **3,647 行**才达标，锚点分布已现算排好序——
  下一刀按 `outbox_sweep 316` → `queue_policy 263` → `peers 251` → `mesh_sync 297` → `dial 624` →
  `relay_file 534` → `group_keys 1,094` → `startup 1,281` → `dispatch 1,658`（含 10 条锚点、最后做）。
  计划与安全网见 `docs/large-file-split-plan.md`。

- 新增 `docs/large-file-split-plan.md` —— **>3000 行大文件的清点与拆分计划**（分析交付，未动一行业务码）。
  现算结论：12 个超阈值文件里 3 个是图标按换行数误算、3 个是生成物 ⇒ **真正要处理 6 个**；
  `transport.rs` 7,087 行由 15 条作者横幅分成 13 个关注点，**最大单函数仅 59 行** ⇒ 病症在文件聚合
  不在函数粒度，所以「更优雅的写法」＝沿横幅切 Rust 子模块 + `pub use` 再导出（调用点零改动），
  而不是顺手重写。安全网先建：全仓 202 条护栏 Case 里 **26 条的 `file=` 指着这个文件**，搬家会静默
  弄死锚点 ⇒ 每刀同批改路径并跑 `verify-guards.py --list`；行为不变的证据是产物恒等判据
  （`cargo test --features bluetooth` 断言条数逐字相同 + clippy/fmt 退 0 + 测试基线现算对账），
  不是「读过觉得没变」。`CHANGELOG.md` 自己 13,268 行的归档与否**交他拍板**，`state.rs`/useChatStore
  沿用他 2026-09-25 的「不拆」决定，本计划不碰。

- ★ **跨轮清理以前只看"绿不绿、超没超上限"，不看这份产物有没有被文档指名** ⇒ 被台账点名的"实测锚点"
  会被当普通绿轮淘汰掉。这次盘查里量到：**文档共点名 19 个 `run-…Z`，其中 9 个已经不在盘上**（不可恢复），
  而新加的 `check-doc-citations.mjs` 按设计**跳过 `test-results`** ⇒ 这件事发生时没有任何机器会报，
  只能靠临时脚本现算才看得见（临时脚本只证明"我看到了什么"，不证明"工具管不管"）。
  现在：被点名的绿轮**不进删除名额**；**引用名单拿不到（`git ls-files` 失败）时一个都不删** ——
  "扫不到引用"和"没有引用"是两件事，只有后者允许删。
- **这条判据原来长在收尾的 `finally` 里** ⇒ 要证明新加的两格真会失败，只能先跑满一轮（30–45 分钟）。
  按 `--logtail-selfcheck` / `--shot-selfcheck` / `--report-contract-selfcheck` 三个先例，把
  `prunePlan` / `selfcheckPrune` / `citedRunIds` 提到模块级并给一条 `--prune-selfcheck` 秒级入口
  （不起实例、不碰任何目录，并顺手现印"点名几个 / 在盘上几个 / 已缺失几个"及逐个名字）。
  ⚠️ **起跑前不 throw**：清理逻辑坏了不该让一整轮跑不起来，立场与原来一致 —— 收尾自证不过就
  "一个都不删 + 本轮记一条不合格"。判据只留一个家，收尾那段改成调用同一份函数。
- 自证六格 ⇒ **八格**，新增的一对同一批输入只换一个输入；两条单点变异各自只红对应那一格：
  摘掉引用过滤 ⇒ 只有"被点名的绿轮不删"红（其余 7 格不受影响 ⇒ 说明"留下那个"确实只由引用决定，不是排序巧合）；
  把"拿不到名单"写成"没有引用" ⇒ 只有 fail-closed 那一格红。`docs/stability-roadmap.md` 里那句
  "先跑六格自证"同步改成八格（散文抄条数正是这次的漂法），收尾注释的"三条硬约束"补成四条。
- 回归：`check-scripts-parse` 0 / `check-doc-numbers` 0（**E2E 各轮断言数逐字与改动前相同**、反证档仍 20/20 对齐，
  这次没动任何断言也没加 npm 入口）/ `verify-guards.py --list` 0（代码搬家没弄死注入锚点）/
  `check-domain-map` 0 / `check-doc-citations` 0（28 处 `file:line` 全部落在真文件真行）/
  `--prune-selfcheck` 改前 0、两次变异各恰好红 1 条、还原后复绿；`test-results/` 目录数在前后两次核对都是 298 项，
  这条入口一个目录都没删。零应用码改动 ⇒ 不提版本。
- 顺带（与本条无关的清理，无码改动）：删掉可再生的构建缓存共约 10.8 GB —— Rust debug 产物 7.8 GB、
  安卓/依赖下载缓存 2.7 GB、安卓目标产物 371 MB，`git gc` 把 `.git` 从 166 MB 收到 23 MB
  （`git fsck` 裸退码 0；**`src-tauri/target/release` 特意留着**，它是让下次 `cargo build --release`
  走增量而不是冷编的那半）。仓库 16 GB ⇒ 5.2 GB。
- ★ **入库的那份安卓 gradle 里写的是这台机器的绝对路径**（`src-tauri/gen/android/app/build.gradle.kts`
  第 22 行那条 btleplug Java 源目录，由 `scripts/inject-android-signing.mjs` 注入）。不只是难看 ——
  它是一条**静默坏包**通道：Gradle 对**不存在的 `srcDir` 一个字都不报** ⇒ 别人机器/CI 上那个目录解析为空，
  btleplug 的两半 Java 不进 dex，构建全绿，只在真机 logcat 里现形
  （`failed to resolve Java class 'io/github/gedgygedgy/rust/future/Future'`，正是该文件注释里那条事故）。
  现在注入的是**相对 App 模块目录**的 `file("../../../../scripts/android/btleplug-java")`
  （与同文件里 `file("release.keystore")` 同一套解析口径），脚本另加一条折回核对：算出的相对路径
  resolve 回来不是那个目录就**拒绝写入** ⇒ 生产通道再也产不出带绝对路径的那一行。
  机器证明（`./gradlew --offline -I <打印 main java srcDirs 的 init 脚本> help`，正反对照同一份判据）：
  相对写法 ⇒ `:app` 那个目录 `exists=true`、`.java` 28 个（`com/nonpolynomial` 10 + `io/github/gedgygedgy` 18，
  正是 `build-android-releases.sh` ⓪b 反查 dex 要的那两半）；把它换成"别人机器上的绝对路径"这一形状 ⇒
  **退码仍是 0，而 `exists=false`、计数掉到 0** —— 这类坏法第一次被当场看到，而不是靠下次真机报错。
  同批（AOCI 索引收尾）：`scrape-douyin-emoji.py` 那条 Entry 的 R 原来指着 `code:src/assets`（目录、
  非托管对象，全库唯一一处 dangling），现按现读到的真实关系链改成 `code:src/data/emojis.ts`
  （它首行写明「由 scripts/douyin_comments_emoji/emojis.json 生成」，而那份产物目录不入库）；
  `logs.rs` 那条 Entry 里一个中英夹生词已由机器的 cognition_optimization 批次重写，重写时把
  ⚠️ 一处**注释与代码不符**登记了进去 —— `prewarm_aux_windows` 上方那段"只预热预览这一扇"是过期的，
  函数体现在预览与群任务两扇都建。改那段注释要动应用码 ⇒ 不在本轮，只登记。
  回归：`verify-guards.py --list` 0（那份 gradle 没被任何锚点钉着，改它不会改坏注入锚点）/
  `aoci check` 0（五净）/ `aoci verify` structure_valid+governance_aligned 双 true /
  `aoci index agent guide` stage=aligned、complete=true、next_action=none /
  全库 497 条 Entry 的 R 项逐条复审（存在性 + 是否跟踪 + 是否目录）异常 0 处。零应用码改动 ⇒ 不提版本。
- 新增 `docs/aoci-usage.md` —— **AOCI 认知层使用手册**（工具用法：哪些文件入库、换机器怎么接宿主、
  谁在什么时候必须调它、9 个 MCP 工具与 CLI 只读命令速查、一条 Entry 的格式与 `S` 的两层配额、
  收尾三件套）。写的时候现跑了一遍自查，抓到两处我自己想当然的假命令：**CLI 没有 `aoci header`**
  （字典的现读口是 MCP `aoci_header` 或 `aoci_maintain` 响应里的 `authoring_meta`），以及
  `aoci guide` 不存在 —— Guide 的真位置是 `aoci index agent guide` 且 **`--agent` 必填**。
  已按"每条命令都要在读者站的位置跑得通"逐条改口，并在文档里登记这两个坑。
  导航同步：README 的「AI 开发必读」表加一行（★ 按需）、`docs/AI_ENGINEERING_INDEX.md` 的
  「其余在 docs/ 里」加一条 —— 新建文档不进导航＝约束失效。零代码改动 ⇒ 不提版本。

## [4.33.4] - 2026-10-03

### fix(scripts): `$var` 紧跟中文时 bash 会吞掉变量值 —— 修 10 处 + 加门禁

- **实测确认的坏法**（不是理论推断）：
  ```console
  $ bash -c 'SRC=/tmp/app; echo "A: $SRC（后续）"'   →   A: ��后续）      ← /tmp/app 整个没了
  $ bash -c 'B=x; echo "C=$B）"'                      →   C=��
  ```
  bash 把 `$name` 之后**紧邻**的中文字节算进变量名解析，值整段丢失。
  代价不是崩，而是**错误消息里最该看清的那个值不见了** —— 而这些行几乎都在错误分支上
  （"[错误] 未找到 $BIN，请先…"、"缺少 Rust 目标 $TARGET"），正是排障时唯一要看的那一行。
- **修了 10 处**（`check-mobile.sh` / `e2e-dev.sh` / `pack-macos-app.sh` /
  `t2-learn-id.sh` / `t3-presence-relay.sh` / `t4-mirror-dial.sh`），一律写 `${var}`。
  逐行复核过 diff：只改**紧跟中文的那一个**，同一行里前面是空格的 `$TARGET` 等保持原样。
- **新增门禁 `scripts/check-shell-var-cjk.mjs`**（已接进 `verify.mjs`，`group: frontend`
  ⇒ CI 自动覆盖）。三类误报必须排除，否则它立刻变噪音：
  ① **注释里引用这个坑当反面案例**（`ci-run.sh:23` 写着 `` `$status（` `` 并解释为什么要写
  `${var}`）—— 那是**文档**不是代码，走**按行号登记**的 `EXEMPT`（不接受通配）；
  ② `.yml` 里的 **PowerShell 块**（pwsh 不做这种解析）—— 靠 `run: |` 块内的 pwsh cmdlet
  标记**预扫描整块**；⚠️ 第一版写成"从当前行往上找最近的 `run: |`"，结果
  `build-windows-webview2.yml:96` 没被排除（实测才发现），已改成先标记整块；
  ③ 已是 `${name}` 的形状。
  另有覆盖面自证：扫到 <5 个文件直接红（路径挪了/正则失配 ⇒ 静默空转）。
- **非空转**：注入一处裸写 ⇒ 退出码 1；还原 ⇒ 0。
- 起因是 2026-10-03 一天内**两处**踩到同一件事：`ci-run.sh` 的注释早记着它，
  我在 `publish-release-assets.sh` 写新守卫时又犯了一次（`--label=$label（` 直接
  `unbound variable`）。⇒ 这类"看起来是风格问题、实际会静默吃掉值"的坑值得机器钉。
- ⚠️ 顺带记一条工具事实：**macOS 的 `grep` 不支持 `-P`**，这类 Unicode 扫描用 Python 正则写。

## [4.33.3] - 2026-10-03

### fix(release): 内置 WebView2 那一档在 Release 上被默认档**覆盖**了（用户实报）

- **症状**：Release 的 Assets 里只有 2 个 Windows 安装包（`Gosslan_…_x64-setup.exe` /
  `…_arm64-setup.exe`），**没有**"内置 WebView2"那个包；而
  `Build Windows + 内置 WebView2` 那个 run **Status Success**、两档产物都在
  （arm64 176MB / x64 187MB，与默认档大小逐字相同）。
- **机制（静默覆盖）**：tauri 生成的 exe 文件名只由 `productName` + version 决定，
  **两档的 exe 逐字同名**。webview2 那档用 `merge-multiple: true` 把产物下载到
  同一个 `assets/` 目录 ⇒ **同名文件互相覆盖**，只剩一份，且不带任何 webview2 标识
  ⇒ 这一档在 Release 上彻底消失。artifact 名（带 `webview2-bundled`）是分开的，
  但 `merge-multiple` 恰恰把那个区分**抹掉**了 —— 注释里写"附件名自带 webview2-bundled
  ⇒ 与默认档一眼可分"，而事实是附件名来自 exe 自身，压根没带。
  为什么"产物大小与默认档相同"是**预期**而不是"没换包"：这一档的差别只在内嵌 runtime
  怎么装（`webviewInstallMode`），产物路径与命名都照旧 ⇒ 靠大小分不出，只能靠文件名。
- **修法**：
  ① `build-windows-webview2.yml` 在下载后、上传前给每个 exe 加 `-webview2-bundled`
     后缀（`.sha256` 同步改名）⇒ 与默认档**文件名**不再冲突，两档能同挂一个 Release；
  ② `publish-release-assets.sh` 新增 `--label`（`base` / `webview2`）与**档位守卫**：
     webview2 档出现裸名 exe ⇒ 硬失败并直接告诉人该改成什么名字；
     一个带标识的都没有 ⇒ 也红（这一档等于没发出来）；未知 label ⇒ 红
     （**不默认当 base** —— 默默放行正是这次 bug 的形状）。
- **判据**：`scripts/publishRelease.test.ts` 6 条新用例（15/15 绿），
  两向非空转都验过：把守卫短路 ⇒ 3 条变红、还原 ⇒ 15/15。
  含两条**反面对照**：默认档的裸名 exe 是基线、不许被自己的守卫拦下；
  macOS/Android 档（dmg/apk，不含 `setup.exe`）不受影响。
- 顺带修一个**我自己写出来又当场被测试抓住**的隐患：守卫里 `echo "… --label=$label（…）"`
  的 `$label` 紧跟全角括号 ⇒ bash 报 `label?: unbound variable`
  （本仓 `ci-run.sh` 早前也踩过同一个，注释里记着）。已写 `${label}`。
  ⇒ 这类"变量紧跟全角字符"目前**没有护栏**，今天两处各中一次，值得补。

## [4.33.2] - 2026-10-03

### fix(guard): force push 后 Change Budget 不再自己判自己空转
- **真实事故（CI run 37106836002）**：发 `v4.33.0` 时用了 amend + `--force-with-lease`
  改写提交声明（patch → minor），于是 GitHub 事件里的 `event.before` 指向的是
  **刚被改写掉的那个提交**（`1231aa2`）。它不在任何 ref 上，而 CI 是从 GitHub
  全新克隆（`fetch-depth: 0` 只拉 ref 上的对象）⇒ `git cat-file -e <before>^{commit}`
  必然失败 ⇒ 脚本拿不到 `before..sha`，退到 `HEAD~1..HEAD`。
- **矛盾在哪**：那条兜底范围**确实判到了 1 个 commit 并把三条判据全跑完**，
  却仅因为「来源不是 `before..sha`」被判 `exit 1`。门禁自己兜住了范围，又自己判这个
  兜底无效 —— 自相矛盾。而 `docs/VERSIONING.md` §3 明确允许改写已推送历史
  （那条流程第一步就是 amend + force push），所以这不是该拦的形态。
- **修法**：把"env 压根没喂"与"喂了但 `before` 不可达"分成两种情形。
  只有前者硬失败（那正是这条判据 2026-09-28 立起来要拦的洞）；后者打一条
  **如实说明覆盖局限**的警告后放行 —— 不写"全部提交都判到了"（实测那次 force push
  引入 3 个提交而 `HEAD~1..HEAD` 只判到最后一个，固定深度猜不出这次改写动了几个），
  而是打印判到了几个、判不到的是什么、需要全覆盖时该在本地跑什么。
- **判据**：`verify-guards.py` 新增一条非空转 Case「force push 后 before 不可达
  不得判空转（改回去必须红）」，与既有的「真·env 没喂必须红」互为对照 ——
  两条都守住，才既不误红又不放松。非空转实测：注入 `if (false && …)` ⇒ `exit 1`；
  还原 ⇒ `exit 0`。
- 顺带把 `docs/ARCHITECTURE-MAP.html` 里手写的护栏非空转用例数从 201 改成 202
  （由 `check-doc-numbers.mjs` 对账现算，不是手改数字了事）。

## [4.33.0] - 2026-10-03

> **为什么是 minor 而不是 patch**：提交原本声明 `patch`，但这一批里有一条
> `feat(guard): 新增「文档 file:line 引用对账」门禁` —— 按 `docs/VERSIONING.md` §1
> 「`feat` ⇒ 中」且**「改动规模与线索词不参与定档」**，用户可感知的新能力落在 minor。
> 声明与版本位已一并改正（`Version-Bump: minor`），不是"声明 patch 却发 minor"的错配。
> 另三条 `fix` 是用户可见的缺陷修复（重发重复气泡、破坏性确认框显示裸 key、英文界面
> 显示中文 toast），按 SemVer 属向后兼容的改进，不构成 MAJOR。

### fix(send): 重发不再产生第二条气泡 —— 旧 failed 气泡原地复用
- **缺陷**：`MessageItem.vue::retrySend` 走 `chat.send(...)`，而 `send()` 每次都新建一条
  `msg_id = tmp-${Date.now()}-…` 的乐观记录并 `enqueueMessage`。于是列表里同时留着
  「发送失败的原文」与「重发中的原文」两条，而**失败那条永远不会被删**：
  全库没有任何删除类函数（`messages.ts` 导出的 19 个里没有 remove/delete/purge），
  且 `appendLocalOnly` 把 `tmp-*` 视为"只存在于内存"，每次 `loadMessages` 都会把它
  **重新追加**到快照尾部 ⇒ 用户点一次「重发」看到两条一样的文字，切会话重开也一样。
- **修法**：`send()` 新增可选 `retryOfMsgId`。传它就**不再新建乐观记录**，而是按
  `msg_id` 找到那条 failed 气泡、原地转回 `sending`，成功后 `replaceMessage(convId,
  retryOfMsgId, …)` 替换**同一条**；再失败则退回 `failed`。找不到那条（切了会话/
  已被快照吞掉）时**退回新建** —— 宁可多一条也不静默丢消息。
- ★ **为什么不能字面"复用同一 msg_id"**（INV-001 的另一半在本项目做不到）：
  后端 msg_id = `SHA-256(sender_id + nonce + payload)`（`protocol.rs::compute_message_id`），
  nonce 每条新消息都不同 ⇒ 重发**必然**是新 msg_id；且 `send_message` 的签名只有
  `(friend_id, content, kind)`，**没有 msg_id 参数**可传。所以 INV-001 的"重试复用同一
  msg_id"在本项目落在**接收侧幂等**（`message_exists` 按 msg_id 去重），前端这一侧
  只能做成"旧气泡原地复用"—— 逻辑消息在界面上仍是同一条。
- 顺带把单聊/群聊的 invoke 分流抽成 `sendToBackend`（重发与首次发送共用），
  避免两条路径各写一份 `startsWith("group:")` 分流。
- **撞上一条既有守卫并正面处理**：`storeContract.test.ts` 的 #82 形状守卫
  （"返回 MessageRecord 的命令，调用点必须 enqueueMessage"）在 `sendToBackend` 上变红。
  它不是漏 enqueue —— 记录去哪儿**由调用方决定**（新建 vs 重发两条路径不同），
  转发层擅自 enqueue 反而会把重发路径那条旧气泡顶掉。为此给该守卫加了
  **带理由的白名单**，并配两条自证：① 白名单里的函数必须**真的存在且仍在调**返回记录的
  命令（否则函数改名后豁免会静默留着，"看起来有豁免、实际不豁免任何东西"）；
  ② 白名单**上限 3 条**（膨胀到一半说明它被当成万能洞用，该问"能不能不抽这一层"）。
  两条自证都做过非空转（指向不存在函数 / 塞满 4 条 ⇒ 都变红）。
- 判据 `src/utils/retrySend.test.ts`（5 条，含形状断言与后端前提对账），
  **两种非空转都验过**：把 `retrySend` 退回不传 msg_id ⇒ 红；整个重发分支删掉 ⇒ 3 条红。
  其中一条钉住后端"msg_id 不可由客户端指定"这个前提 —— 哪天 `send_message` 加了可选
  `msg_id`，前端就该改成真复用，本文件的推理与注释都要重写。
### fix(i18n): 取消发送的三条结果提示不再硬编码中文
- `MessageItem.vue::doCancelSend` 的三条用户可见文案（"已请求取消发送" /
  "标记为已取消（传输可能已结束）" / 错误前缀）全是中文字面量 ⇒ 英文界面下显示中文 toast。
  同一函数里 `@cancel` 的入口文案走了 `t()`，自相矛盾。
- 补 `msg.cancelSend.requested` / `.alreadyEnded` / `.fail` 中英各一条。
  **不复用**已有的 `msg.canceled`：那条是"已取消发送"（`onFileCancelled` 的事件提示），
  而这三条讲的是"用户点了取消之后发生了什么"，语义与语气都不同。
- 全仓复查：`app.toast(...)` / `toastError(...)` 已无硬编码中文。
### refactor(store): 在线判定收成唯一一份实现（`utils/friendOnline.ts`）
- `friends[].online` 的判定此前被抄成两份：`onPeers` 那条链带
  「或持有活跃链路也算在线」，`searchNearbyPeers` 那份**漏了**。后者是"添加好友"弹窗
  的探测路径（`commands/network.rs::search_nearby_peers`），漏了那层意味着一次
  `who_has` 探测回来后，正在保持 TCP 链路的好友被判离线 ⇒ `ChatHeader` 的
  `v-if="!isGroup && online && linkState"` 整块链路信息凭空消失。
  同一份语义的两个家必然漂移（AI_RULES §32），现收进 `utils/friendOnline.ts`，
  两个调用点共用。抽成纯函数而不是留在 store 私有函数里，是为了**能测** ——
  藏在 store 里的口径护栏无从下手，这正是它漂了没人发现的原因。
- 判据随实现一起搬家：`channelState.test.ts` 那条 2026-09-14 的用例（用户实测
  "局域网都连上了，在线状态却不实时"）原先正则匹配 store 里那一行，代码搬走后会失效；
  `scripts/verify-guards.py` 的**注入锚点**同步跟到新文件。
  并加一条**调用点个数**断言（必须恰好 2 处调用）—— 否则将来任一路径改回自己算 online，
  `linkedIds` 那层会被悄悄丢掉，而这正是本条判据当年钉住的缺陷。
- ★ **顺带查清一件被误报的事**：`linkedIds` 那一层在当前后端数据形状下是**冗余**的。
  `state.rs::emit_peers_now` 与 `commands/network.rs::fill_peer_links` 这两个填 `link`
  的入口**都只给「已经在 peers 表里」的节点填**（都是先收 `peers`、再
  `for p in peers.iter_mut()` 填），恒有 `linkedIds ⊆ onlineIds`，删掉行为不变。
  审计报告的 F2（"`searchNearbyPeers` 漏 linkedIds ⇒ 好友被闪成离线"）**据此撤回**：
  节点不在 peers 表里，后端根本不会给它 `link` 字段，前端拿到的 list 里不可能有它。
  `state.rs:1770-1774` 那段注释描述的痛点是真的，但**不是前端能修的** ——
  该修的是后端让 peers 表覆盖"有链路但广播没到"（或让 `fill_peer_links` 额外接受一组
  待填 id），不在本次范围。**这一层仍然保留**：它无害，且后端哪天真的支持了表外节点带
  link 就会自动生效；但推导过程写进了注释与新判据，避免下一个人误以为它在兜什么。
- **非空转实测**（本仓铁律，两种都验过）：
  ① 删掉 `|| linkedIds.has(...)` ⇒ `friendOnline.test.ts` 的形状断言与
  `channelState.test.ts` 的用例**都**变红；
  ② 把后端 `fill_peer_links` 改成不再只遍历 peers 表 ⇒ 钉着数据形状假设的那条判据变红。
  ② 是必要的：它防的是"后端改了数据形状而前端注释/推导没跟上"。
- 过程里踩了一次**判据自等于**并当场抓到：第一版新测试把设备同时放进了 list，
  于是"看起来在测 linkedIds、实际 onlineIds 就够了"，删掉 linkedIds 层 6 条用例全绿。
  改法是把那条改成**形状断言**并显式写明"删掉它行为不变，但它是 2026-09-14 那条判据
  钉着的契约" —— 而不是留一条看起来在测、实际测不到东西的用例。
- ★ **「版本号同步几处」在文档里有三个不同的数，而实现是五处**（纯文档/注释口径修复，零应用码改动）：
  `scripts/version.mjs` 头部注释写"三处"、`README.md` 与 `AI_PROJECT_HANDOFF.md` 各写"4 处"，而本文件开头的
  前言一直写的是五处 —— 第 4、5 步（`package-lock.json` / `Cargo.lock`）落地时只改了实现和本文件，
  那三份副本没被带上。现在统一成五处，并修掉 version.mjs 里重复编号的第二个 `// 5)`（→ `// 6)`）。
- **判据 4 的一条理由与实现相反**：`check-change-budget.mjs` 注释写着 `Cargo.lock`"由 cargo 构建时同步、
  可以合法地晚一版"，而 `version.mjs` 第 5 步现在把晚一版直接 `exit 1` 拒掉。对账集仍是那四个清单文件
  （没有放宽任何判定），理由换成"第五处已由 version.mjs 自己断言，不在判据里重复数一遍"。
  留着错理由的代价是具体的：下一个人会据此认为 `Cargo.lock` 不一致是可接受的。
- **README 手抄的 IPC 命令数漂了一格**（写 129、注册表 130）。契约图自己早就为这个形状改过口
  （那张表的行数由页头 `CMDS.length` 现数，图里还点名说"以前这里抄过 129、同页另一行写 130，两条都是手抄"），
  但 README 那份副本没跟着走，而 `check-doc-numbers` 只覆盖门禁步数与 E2E 断言数 ⇒ 属于静默漂移那一类。
  README 现在不带这个数，改指向 `CMDS.length` 与 `check-key-boundary.mjs` 自己打印的那行"注册表 N 条"。
- **两处"用现在时命名过去读数"的表头**：`AI_PROJECT_HANDOFF.md` §6 那张表的列名从"现状"改成
  "当时读数（v1.0.0 · 2026-09-08，今天不作数）"，并在表下给出三把现成量具
  （`check-test-manifest.mjs` / `cargo test --lib` 末行 / `e2e_peer` 自己打印的结果块），
  同时写明别把读数抄回表里 —— 那张表正是这么坏的；`docs/VERSIONING.md` §4 的标题从"现在的台账与数字"
  改成"台账与数字怎么取"，184 / 23 / 45 / 116 与 `2.1.2 → 3.0.0` 就地标为 3.0.0 那一次的读数。
- **约束导航漏了 5 份文档**。`docs/AI_ENGINEERING_INDEX.md` 作为"约束文档导航"没提它们，其中
  `docs/VERSIONING.md`（自题"从 2026-09-12 起强制执行"）和受硬数字守卫的活文档
  `docs/acceptance/stability-smoke-matrix.md` 在 README / 索引 / AI_RULES 三处入口全是零引用
  ⇒ 只从 README 找约束的人根本碰不到它们；`docs/P1-image-out-of-sqlite-overview.md` 此前全仓零引用。
  索引新增一节逐份写明角色与时效（含 `ARCHITECTURE-EXPLAINED.md` 自带的 v4.2.7 快照戳已漂），
  README 的 `docs/` 目录树同步补齐。
- 没动的两处附理由：`probe-doc-command-names.mjs` 报的 2 条"断链"是它咬到自己（`docs/final-architecture-review.md`
  里一个在讲"命令名断掉是响亮失败"、一个在记录往 VERSIONING 注入假脚本名的非空转实测），文档原文不改、
  也不给量具开白名单 —— 它本来就不是门禁步（#131 判过），而整份排除又会把它另外 15 个真引用的覆盖一起丢掉。
  契约图 `ARCHITECTURE-MAP.html` 一字未改：它的 130 与自数口径现读就是对的。
### docs(ledger,tcp): 台账的失效引用与过期判定，注释的腐烂行号
- `docs/migration-ledger.md` 5 处 `docs/domains.yml` → `docs/domains.data.mjs`、2 处 `active_home`
  与 3 处 `second_home` → 驼峰 `activeHome`/`secondHome`。那个 `.yml` **从不存在**
  （`.yml`→`.mjs` 是有意改名，工具链没有 YAML 解析器），而台账 §5「维护规则」是写给接手者的
  **操作指令**：照着改会去打开一个不存在的文件、用错字段名，且 `check-domain-map.mjs` 读的是
  `.data.mjs` ⇒ **门禁照亮绿灯**。
- 9 条行数证据改成自指表述（`network/transport.rs` 声称 8836 实测 7086、`file_relay.rs` 声称 86
  实测 504、`mesh/` 声称 10 文件 2432 行实测 11 文件 3276 行…）。行数在这份文件里是**论据**不是修辞：
  §4 用"最大最活"把它排在收口顺序**最后一位**，这个优先级就建立在那个行数上；而 §1 又声明
  "行数不是判据"，口径自相矛盾。统计段两处 `db::` 引用数（13 / 43）同样自相矛盾且都错（实测 12 / 56）。
- §3「过期声明上报」第 1、2 条判定**作废**：源码 2026-09-16 就改成「已接线」了
  （`transport/bluetooth.rs:44`、`transport/tcp.rs:12`），台账却一直挂着红牌，让下一个人重新调查
  当天就解决完的事。
- `src-tauri/src/transport/tcp.rs` 模块头两行「接线状态」表的 `file:line` 全部重钉到真符号：
  帧原语在 `network/transport/outbound.rs:45,105`；`TcpReceiver`/`TcpSender` 在
  `network/transport/relay.rs:392,393`。原写的 `network/transport.rs:57,62,69` 与
  `:1231,1232,1529,1613,2368,2369` 逐个核对**全部指向无关代码**（`"transport"` / `format!(` /
  `high_open` …）—— `network/transport.rs` 已目录化、数据面搬进了 `network/transport/*.rs`。
  **之所以危险**：注释说"已接线"是对的、**行号是烂的**，这比"注释撒谎"更隐蔽 —— 顺行号核对的人会
  看到无关代码，从而误判"注释在骗人"而把好的接线拆掉。这是本仓「待接线声明腐烂」族的第三次
  （`ble_framing.rs` Phase 3、`transport/bluetooth.rs` Phase 5、此处），本次由 2026-09-16 那次核过、
  到今天又烂掉亲自坐实。零行为变更（`src-tauri/` 侧 diff 过滤后为空）。
- 验证：快速层 15 步全绿；`cargo fmt --check` exit 0；clippy 警告数 42，与改动前基线
  （`git stash` 对比）逐条一致、零新增。
### fix(i18n): 破坏性确认弹窗标题显示裸 key —— 补「t() 调用点必须命中词典」护栏
- ★ **新护栏：`t()` 调用点引用的 key 必须在中英词典里命中**（`src/i18n/index.test.ts`）。
  一次只读审计（2026-10-03）查出**破坏性确认弹窗的标题显示裸 key**：自动删除策略那个
  `BaseModal` 写的是 `t('settings.storage.limit')`，而这个 key 中英两侧都不存在 ——
  `t()` 的回落是 `dict.value[key] ?? key`（`i18n/index.ts:93`），于是用户点开"要永久删除历史
  消息引用的图片/文件"的确认框，标题直接写着 `settings.storage.limit`。同文件正文用的
  `settings.storage.confirm.body` 是存在的 ⇒ 漏了一条，不是有意为之。
- **为什么已有两条字典护栏抓不到**：它们只查「中英 key 集合互相一致」和「值非空」，
  对"调用点引用了不存在的 key"完全无感 ⇒ 假绿。新护栏扫全仓 `.vue`/`.ts` 的 `t("字面量")` 调用点。
  两条设计取舍写进注释：① **只查字面量**（`t(\`prefix.${kind}\`)` 那类模板字符串由各自专项用例
  钉住，如 relay.rs `as_str` ↔ TS 联合类型 ↔ 两种语言那条三向断言）；② **`.test.ts` 整个跳过**
  （测试本来就要引用不存在的 key 来验回落，扫它们得到的红是假的 —— 假红会让人养成
  "先加白名单再跑"的习惯，那比漏报更危险）。
- 护栏上线当场抓到**另外两个真漏项**（都不是审计报告里列的，是护栏自己发现的）：
  ① `BaseModal.vue:150` 用 `t('common.close')`（关闭按钮的 `title` + `aria-label`），词典里只有
  `closeEsc` 没有 `close` ⇒ 关闭按钮的悬浮提示与**无障碍标签**两种语言下都是裸 key；
  ② `utils/storeContract.test.ts:84` 期望真实代码用 `t('msg.fail')`，词典里也没有 ⇒ 错误提示显示裸 key。
  三处都补齐（`common.close` 中英、`settings.storage.confirm.title` 中英），`common.close` 那条
  顺带把"此前只写了 closeEsc"的原因记在旁边，免得下次又被当成多余条目删掉。
- `settings.storage.limit` 改名为 `settings.storage.confirm.title`：调用点与词典一起改，跟同族
  `settings.storage.confirm.body/.cap/.keepDays` 对齐 —— 原来的名字既不在词典里，也不跟任何兄弟条目同族。
- **护栏的非空转实测**（本仓铁律：新护栏必须证明它不是空转）：删掉 `common.close` 的英文条目
  ⇒ 两条判据同时变红；只删中文、保留英文 ⇒ 中英一致性那条与新护栏**都**变红且新护栏点名
  `zh-CN 缺 common.close（src/components/BaseModal.vue）`。两种形态都验过，验证完已还原。
  顺带确认了旧护栏的真实盲区：它抓"漏译"（一侧有一侧没有），抓不到"两侧都没有" ——
  而后者才是这次事故的形状。
- `scanned > 50` 自检：一条调用点都扫不到时判据直接失败（正则失配或目录搬迁会让护栏悄悄空转）。
### feat(guard): 新增「文档 file:line 引用对账」门禁
- `scripts/check-doc-citations.mjs`（已接进 `verify.mjs` 第 7 步，`group: frontend`
  ⇒ CI 的 `verify.mjs --group frontend` 自动覆盖）。三条判据：文件存在（按 `SOURCE_ROOTS`
  解析，裸名按全仓唯一同名）／行号落在文件范围内／**扫到 <20 处引用判 INCONCLUSIVE 而非绿**。
- **上线当场抓到本台账两处真断裂**：一处引的 `transport/mod.rs` 行号**超出该文件行数**，
  一处引的 `lib.rs` 行号**超出全文五倍**。两处都已重钉到真符号。
- ⚠️ **刻意不判「那一行是不是文档说的那个符号」**：那要解析 Rust/TS 语法，解析错了门禁会
  静默失效 —— 比没有门禁更危险。这条边界同时写进脚本头与台账（§4 末尾），
  免得下一个人以为它能抓符号腐烂。后果举例：台账 §3 第 3 条引的 `route()` 已被 0-A2
  整体删除，行号仍在范围内、门禁判绿，但那一行今天根本不是 `route()`。
- **故意不管**：带日期的复审快照（`ARCHITECTURE-REVIEW-*` / `final-architecture-review`）
  与 `CHANGELOG` —— 它们记录的是**当时**的读数，拿今天的事实源去判必然误报。
  与 `check-doc-numbers.mjs` 同一立场（能被现算的东西不许留第二份手抄），只是那条管「数字」、
  这条管「指向」。
- 非空转三种形态都验过并已还原：超界行号／不存在的文件／正则失配（判据 C）。
- 过程中自己踩了两次同一个坑：**在文档里「提到」一个已知坏行号**（叙述历史）时，门禁把它
  当「断言」判红。⇒ **提到行号**与**断言行号**必须分开写；复述一个已知坏行号 = 新造一条断裂。
### docs(invariants): 新增 INV-P30「前端自洽」一节
- `docs/protocol-invariants.md` §30（5 条规则 + 3 行反向判据速查表）把 2026-10-03 那三个
  补丁收敛成明文契约：同一份派生状态只有一个家／`t()` key 必须中英两侧都存在／重发复用
  失败那条气泡／派生值不粘住上一轮／同一份判据不许被抄成两份。
- 钩子 30 条全部解析成功（`check-invariant-hooks.mjs` 现场验）。
- 这一节是对 Change Budget 判据 3 的正式回答：它把 `presentation` 域连打三个补丁
  识别为 4.18.7→4.18.10 那种「每个补丁都很小、但它们在互相修」的犯案形态，
  并要求「① 该领域的不变量补了吗」—— 现在补上了。
- 第 1 条特意钉「必须恰好 2 处调用」：只钉「判定含 `linkedIds`」不够 ——
  有人把某个调用点改回自己算 `online`，那条断言照样绿。数调用点个数才关得住第二个家。

## [4.32.0] - 2026-09-30

### 工具口径修正（只动 `scripts/` 与 `docs/` ⇒ 按 `isAppCodePath` 不占版本号）

- **`scripts/sign-readiness.mjs` 那句「接在哪」原先是错的，现读改掉**：它叫人在 `tauri build` 之后另写 `codesign --sign` 与 `notarytool submit --wait + stapler staple` 两步，而本仓装的 **tauri-cli 2.11.4 自己就做签名与公证**。现读三处：`./node_modules/.bin/tauri --version` ⇒ `tauri-cli 2.11.4`；`tauri build --help` 里有 `--no-sign` 与 `--skip-stapling`（后者说明默认它会等公证完并 staple）；`config.schema.json` 里有 `bundle > macOS > signingIdentity` 与 `bundle > windows > signCommand`（Windows 的钩子是这条带 `%1` 的自定义命令，不是内置 signtool）；`cli.darwin-arm64.node` 的字符串表里出现 `APPLE_SIGNING_IDENTITY`、`APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD`、`APPLE_API_KEY` / `APPLE_API_KEY_PATH` / `APPLE_API_ISSUER`、`APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`、`APPLE_DEVELOPMENT_TEAM`、`APPLE_PROVIDER_SHORT_NAME` ⇒ 该挂的是**那一步的 env 与配置键**，不是再加两步 shell。⚠️ 边界：以上全是版本固定的**读数**，本仓没有凭据、**一次都没实跑过签名或公证**；换 CLI 版本这段要重读。
- 验收矩阵加 `Smoke-13` 一行（标题栏遮挡 / 表情入口 / 任务编号列的真机走查），写明机器只判到浏览器内、等级不往上抬；维护规则第 4 条那句「当前只有第 14 行满足」改成内容锚 + 现读 `verify.yml` 的口径。

### 真窗口读数进了仓 + 内置 WebView2 那一档开始挂 Release

- ★ **`npm run verify:ax` 多了两档"读数前置"**：`--fixture todo` 先给一个**本次新建**的隔离实例库写一条
  生产形状的群任务定义行，再读真实 WKWebView 的无障碍树；`--fixture todo-nonumber` 是同一条但 `number=0`。
  现跑读数（真 App，不是浏览器）：带号档 `AXStaticText=R2345` 与 `AXGroup=任务编号 R12345` **各 1 个**，
  无号档带编号字样的名字 **0 个** ⇒ 那两条不是探针自己造的。
  **有意不判红**：这一段只打印，不调 `ok()/bad()` ⇒ 该入口那四条判据与退码一字不改（这一屏要的是
  "读屏用户实际念到什么"，文案改了期望就该跟着改，进任何一层都会变成"改文案要改门禁"）。
  新增 `scripts/axTodoFixture.mjs`（两档 + 写库）与 `scripts/axTodoFixture.test.ts` 五条用例，其中一条
  **现读 `src-tauri/src/protocol.rs` 的 `TodoPayload` 字段名**当分母 ⇒ 生产加字段而夹具没跟上就红
  （这条一落地就抓到我今天那份一次性探针**漏了 `done_at`**）；`seedTodoFixture` 两档各占独立 `msg_id`
  （同 id 会互相顶掉）。参数只认空格写法：`--fixture=todo` 现在**拒跑**（退 2）而不是被静默忽略后
  给出一份"看着像夹具"的读数。矩阵 `Smoke-13` 那一格同步改口（编号列已有真窗口读数，遮挡与 hover 仍无）。
- **`build-windows-webview2.yml` 加了一个 `release` 任务**（负责人选 A）：这一档以前只 `upload-artifact`、
  从不挂 Release ⇒ Release 的下载列表里永远看不见"内置 WebView2 运行时"那个包，产物只在 Actions 里活着会过期。
  现在与另三条同构（取那一份 `scripts/publish-release-assets.sh` → 取本 run 的两档包 → 挂上同一个 Release），
  附件名自带 `webview2-bundled` ⇒ 与默认档一眼可分。⚠️ 本机没有任何 YAML 解析器，这份文件**没被一层判据读过**
  （现读：`verify-guards.py` 里没有一条用例的注入目标是 workflow 文件），第一次真跑只能等下一个 tag。
- 顺手记一条今天的事实：`v4.31.41` 的 Release 页已由 CI 建好，**8 个附件**（两份 APK + 两份 `.sha256`、
  两份 dmg、两份 exe），四条腿全 success ⇒ 这就是那条 `--repo` 修复的第一次真跑；
  ⚠️ **只有 Android 带校验文件**，mac 的 dmg 与 win 的 exe 都没有 `.sha256`（要不要补齐是另一个决定）。
### 修一条远程红灯：macOS 的 DMG 打包步加了"只认偶发"的有界重试

- **红在哪一步（负责人贴的日志，run `36714419638`）**：`build-macos (x86_64-apple-darwin, x86_64)` 的
  「Build .app + .dmg (x86_64)」，日志顺序是 vite build ✅ → cargo `Finished release profile in 4m40s` ✅ →
  `Built application at .../x86_64-apple-darwin/release/gosslan` ✅ → `Bundling Gosslan.app` ✅ →
  `Bundling Gosslan_4.31.41_x64.dmg` → `Running bundle_dmg.sh` →
  `failed to bundle project: error running bundle_dmg.sh` → `Process completed with exit code 1.`，
  后面 `Upload .dmg artifact` 被跳过。**同一条 run 的 arm64 腿绿**，而**同一个 x86_64 腿 1 小时前
  （v4.31.41 那趟）也是绿的** —— 中间那次提交没动应用码也没动这份 workflow ⇒ 输入一字未变、结局不同，
  这是 `bundle_dmg.sh`（hdiutil attach + Finder 排版）在 macOS runner 上的偶发，不是回归。
  ⚠️ 我一开始想自己读逐 step 结论，匿名 API 额度 20:50 打到 0（`remaining=0`/403，21:31 才回），
  是负责人把日志页贴出来才定到位；Actions 的 HTML 列表页我没当证据用 —— 它把 `v4.31.40` 的 macOS 也
  显示成 Success，而那次红在发布步是 API 逐 step 证实过的。
- **修法：有界重试，但只认"偶发"那一种形状**（`build-macos.yml` 那一步现在自己判）：
  二进制没产出 ⇒ 判编译/链接问题，**不重试**直接红；`.dmg` 已经在 ⇒ 挂在打包之后那一步，**不重试**直接红；
  `.app 出了、.dmg 没出` ⇒ 才重试，最多三次，三次仍无 `.dmg` 就红。
  **绝不加 `continue-on-error`** —— 那正是把"Release 少一档安装包"静音成绿的做法（v4.31.37 丢 Windows x64 就是这么丢的）。
- 五条分支本机现跑（`/tmp/retrytest`，桩 `npm` 造出各档结局，`sleep` 缩到 0）：
  编译失败 ⇒ 退 1 且不重试；打包失败且无 `.dmg` ⇒ 重试到第 3 次退 1；失败但 `.dmg` 已在 ⇒ 退 1 并说"重试没有意义"；
  一次成功 ⇒ 退 0；**前两次挂第三次成 ⇒ 退 0（这条才是"偶发被接住"的正面证据）**。
- 边界：这份 workflow **不被任何一层判据读**（现读 `verify-guards.py` 无一条用例的注入目标是 workflow 文件，
  `verify.mjs` 不解析 YAML），本机也没有 YAML 解析器 ⇒ 这段重试在真 runner 上的第一次执行只能等下一个 tag；
  本地能证的只有"抽出来的那段 shell `bash -n` 退 0 + 上面五条分支"。
