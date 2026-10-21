# v4.36.0 验收：群任务（做不了状态 / 全员操作记录 / 自定义类型 / 优先级图标）+ 图片预览回归修复

- 发布时间：2026-10-12
- 代码提交：`5052f60`（main，tag `v4.36.0` 指向同一 SHA）
- Release：https://github.com/wenzo001/gosslan/releases/tag/v4.36.0

## 1. 需求与根因

用户 2026-10-12 提出四项任务需求，并报告「自己发的和别人发的图片都预览不了」。

图片问题根因（真机数据 + 真组件复现，非推测）：

- 6853680（10-10）给消息行所有 `<img>` 统一补了 `loading="lazy"`；
- 但 `MessageImageBubble` 的图在自己 `@load` 触发前一直带 `hidden`（display:none）；
- 懒加载只对参与排版的元素发请求，display:none 的懒加载图**永不发请求** →
  `@load` 永不触发 → state 永远停在 loading，5 次退避后显示「图片加载失败」，
  点击也只走重取而不开预览。自己发/对方发共用同一气泡组件，所以表现为全挂。
- 真机证据：本机 `gosslan.db` 里自己发出的图片消息（file-8a324dc8），
  消息行 `[data-img-state]` 为 loading 2 小时、`naturalWidth=0`；
  blob URL 在 headless Chrome 里直接 new Image 能 2000×1362 解码，但挂进
  display:none + lazy 的真组件不加载；去掉 lazy 后首轮即 loaded。

## 2. 实现摘要

### 2.1 任务状态「做不了」（线值 `impossible`）

- `protocol.rs`：`TODO_STATUSES` 4→5（todo/doing/overdue/**impossible**/done），
  新增 `todo_status_is_terminal`（done|impossible）。
- 终态语义与 done 完全同族：不进未完成徽标（`openTodosForMe`）、
  首次标记由 `resolve_done_archive` 记权威 `done_at`、满 7 天自动归档、
  成员窄档的归档/还原口子放开到全部终态（`archive_only_change`/
  `reopen_only_change` 增加 `custom_category` 逐字比对）。
- 命令层归档门从「仅 done」放宽为「done/impossible」，错误文案同步更新。
- 前端：看板新增独立分组（XCircle 中性灰）、行内状态菜单与详情状态选择器含 5 档、
  完成快捷按钮在终态隐藏、详情显示「标记为做不了于 …」、
  创建人收到 toast/系统通知「你创建的任务被标记为做不了」
  （`todoTerminalForCreator` 统一 done/impossible，旧窄口径函数保留）。

### 2.2 全员操作记录

- 纯函数 `buildTodoHistory(todoId, records)`（`utils/todos.ts`）：从该任务的全部
  `todo`/`todo_update` 事件按 `(seq,msg_id)` 排序后与上一帧逐字段 diff，
  识别 创建/标题/描述/状态/优先级/类型/指派人加入/移除/归档/还原/删除，
  操作人取事件 `sender_id`。零协议字段、零数据库迁移。
- `TodoDetailDialog` 底部新增「操作记录」区（最新在前、最大高度滚动），
  名字经看板注入的 `nameOf` 解析。

### 2.3 自定义任务类型

- `protocol.rs`：`TODO_CATEGORIES` 3→4（task/requirement/bug/**custom**），
  载荷新增 `custom_category: String`（serde default），
  `TODO_CUSTOM_CATEGORY_MAX_LEN = 20`。
- 服务端单一规范化入口 `normalize_custom_category`：custom 必须非空且 ≤20 字，
  非 custom 档一律清空残留名；创建/更新两条命令共用。
  `latest_todo_def` 增加 carry：老对端重建载荷丢字段时，名字沿用最近一份。
- 前端：编号字母 `C`、行首 Tag 图标、中性胶囊；详情选择器选「自定义…」后展开
  输入框 + 确定（空名不提交），草稿表单同样支持；`todoCategoryName` 统一显示口径；
  `carryAbsentTodoFields` 在类别 absent 时连同自定义名一起沿用；
  折叠白名单显式带 `customCategory`（防"接了一半"）。

### 2.4 优先级图标形象化

- 看板行首：紧急 Zap（闪电）、常规 Minus、不急 ChevronsDown（双下箭头）；
  颜色规则不变（只有紧急抢主色）。

### 2.5 图片预览修复

- `MessageImageBubble` 改回 eager（保留 `decoding="async"`；虚拟列表只挂载
  视口附近的行，滚动性能不受影响）。
- 静态锁：`designGuards.test.ts` 的豁免白名单从 1 支改为 2 支
  （ImageLightbox、MessageImageBubble）并按文件名钉死。
- 探针：`check-ui-runtime.mjs` 新增 `imgload` 段 6 条（有效 data URL 首轮 loaded、
  隐藏退出、自然解码、点击上抛 open、loading 属性静态锁），探针总数 231 → 237。

## 3. 验证证据

### 本地门禁（macOS arm64，2026-10-12）

| 门禁 | 结果 |
| --- | --- |
| 前端单测 `npm test` | 921/921（todos 新增 6 组用例，messageKinds/designGuards/axTodoFixture 同步） |
| `vue-tsc --noEmit` + `vite build` | 0 错误，构建通过 |
| Rust `cargo test --lib`（默认特性） | 790/790 |
| Rust `cargo test --lib --features bluetooth` | 806/806（新增终态窄档/自定义名校验与 carry 4 组用例） |
| `cargo fmt --check` / clippy 双特性 `-D warnings` | 通过（send_group_todo 参数超限行加 allow） |
| UI 运行时探针 `check-ui-runtime.mjs` | 237/237（含任务看板实时 14 + 三命中区 6 + 图片加载 6） |
| 非空转护栏 `verify-guards.py` | 222/222 |
| Android 交叉编译 `check-mobile.sh` | aarch64-linux-android 通过，0 warning |
| Change Budget `v4.35.2..HEAD` | L3 已声明 minor，4/4 版本文件，无重复犯案 |

### CI（tag v4.36.0，8 组工作流全绿）

- push 闸门（5052f60）：Verify / Build macOS / Build Android / Build Windows —— success；
- tag 发布：Build Windows（base）、Build Windows WebView2、Build macOS（arm64+x64）、
  Build Android —— success。

### Release 核验（GitHub API）

- Release `v4.36.0` 非 draft/prerelease，target_commitish = `5052f60`（= HEAD = tag SHA）；
- 10 个附件全部 uploaded，与 v4.35.2 同形状：
  - Android：`gosslan-4.36.0-arm64-v8a-release.apk`(+sha256)、`...-armeabi-v7a-...apk`(+sha256)
  - Windows：`Gosslan_4.36.0_x64-setup.exe` / `..._x64-setup-webview2-bundled.exe`、
    `..._arm64-setup.exe` / `..._arm64-setup-webview2-bundled.exe`
  - macOS：`Gosslan_4.36.0_aarch64.dmg`、`Gosslan_4.36.0_x64.dmg`
- 抽样 HEAD 下载链接：sha256 文件 200/103B，aarch64 DMG 200。

## 4. 已知边界 / 未覆盖

- 混合版本：旧版客户端不识别 `impossible`/`custom` 时按既有自由字符串策略处理
  （任务群 kind 不丢帧，旧端显示退化；自定义名在 absent-carry 下不会被新版抹平）。
- 图片修复的真窗口点按验证需要辅助功能授权（本机 TRAE CN 未获授权），
  以真组件+真实字节的浏览器探针与本机真机数据取证替代。
