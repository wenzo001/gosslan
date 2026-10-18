# 开源替换矩阵（5.x 前端基础设施）

> 口径：先扫真实调用点，再按 A（直接替换）/ B（适配后替换）/ C（保留业务核心）/ D（暂不迁移，附证据与重评估条件）归档。
> 本文件随批次更新；未落地的条目一律标 **未迁移**，不把选型写成完成。
> 证据来源：`package.json` / `package-lock.json`、真实 `src/**` 调用点、`npm test`、`npm run build`、`node scripts/check-ui-runtime.mjs`。
> 最近更新：2026-10-18（Reka Dialog 批次落地的同一天）。

## 1. 已落地的迁移

| 能力 | 原实现 / 调用点 | 替代 | 判定 | 实际迁移点 | 证据 / 备注 |
|---|---|---|---|---|---|
| 模态弹窗壳 | `@headlessui/vue` 的 `Dialog/TransitionRoot/TransitionChild/DialogPanel`；`BaseModal.vue`、`ActionSheet.vue` 两处唯一消费者 | `reka-ui@2.11.0` 的 `DialogRoot/Portal/Overlay/Content/Title` | A | `src/components/BaseModal.vue`、`src/components/ActionSheet.vue` | 依赖已删除：`package.json` 不再含 `@headlessui/vue`；`npm test` 1017/1017；overlay 探针 41/41；winsafe+search 33/33；build 309.71 kB / gzip 93.37 |
| 弹层动效 | Tailwind transition 类 + `@after-leave` 焦点归还 | `data-state` + `@keyframes`（`style.css`），焦点归还在 Reka `closeAutoFocus` | B | `src/style.css`、`BaseModal.vue` | Reka 的 `Presence` 只观察 `DialogContent`；动画必须挂在该元素上，否则退出被截断 |
| 面板点任意项收起 | `DialogPanel` 上的 `@click` | `DialogContent` 根上的 `@click`（组件标签，不冒充可聚焦按钮） | B | `src/components/ActionSheet.vue` | 设计判据 ⑥ 只扫原生 `div/span/...`；动作型 `@click` 留在组件根上，键盘用户走 Esc/取消 |
| 遮罩命中 | 全屏滚动层本身可点（HeadlessUI 的 outside-click 语义） | `.gosslan-dialog-card` 内容根 `pointer-events:none !important` + `.elevated` 恢复命中 | B | `src/style.css` | Reka 给内容根写内联 `pointer-events:auto`；类名压不过，必须 `!important`；否则点遮罩永远关不掉（探针实测 39/41） |
| 运行日志长列表 | `LogViewer.vue` 两条外壳各自整表 `v-for="r in mergedRows"` | `@tanstack/vue-virtual@3.13.47` 的 `useVirtualizer` + `measureElement` | B | `src/components/LogViewer.vue`、`src/utils/logViewerVirtual.test.ts` | 两条外壳共用同一套虚拟行；`data-index` + `measureRow` 实测高度；过滤变化 `scrollToOffset(0)`；护栏禁止退回整表渲染 |
| 图片另存（保存链） | JS 把整张图转 base64 → `save_data_file` | Rust `save_media_as(msg_id/cid, destination)`，复用 `copy_file` 的 Android `content://` 与 `spawn_blocking` | B | `src-tauri/src/commands/helpers.rs`、`src/api/index.ts`、`src/utils/saveImageAs.ts`、`saveImageCore.ts`、`ImageLightbox.vue`、`MessageItem.vue` | 源路径优先、失败回退字节路径；`cargo check --lib` 0、`cargo fmt --check` 0、helpers Rust 8/8；前端 saveImageCore 新增 2 条源路径用例 |
| 右键/上下文菜单 | `ContextMenu.vue`（自研 Teleport/document click/window keydown/焦点循环，135 行）+ 四个业务菜单（消息/会话/联系人/收藏） | Reka `DropdownMenuRoot/Portal/Content`（虚拟 `reference` 锚点）+ `DropdownMenuItem/Separator` | **B（已落地）** | `src/components/ContextMenu.vue`、`MessageContextMenu.vue`、`ConversationContextMenu.vue`、`FriendContextMenu.vue`、`FavoritePanel.vue` | 定位/翻转/点外部/Esc/roving focus 交给库；K 主题与 z 序不变；`contextMenuReka.test.ts` 4 条源码判据；`--only=ctxmenu` 12/12；迁移中发现 `fixed` 子元素让 popper wrapper 量到 0×0（翻转失效），已钉判据 |
| 搜索筛选菜单 | `ChatSearchDialog.vue` 发送人/日期两处手写 `role=menu` + 绝对定位 + 按钮开关 | Reka `DropdownMenuRoot/Trigger/Portal/Content/Item` | **B（已落地）** | `src/components/search/ChatSearchDialog.vue` | 互斥收进 `onSenderOpen/onDateOpen`；`:modal="false"` 防止焦点陷阱抢走搜索框；Portal 后用 `z-[80]`；`--only=search` **14/14**，新增「嵌套 Dialog 的 aria-hidden/pointer-events 下仍可命中」判据 |
| 锚定菜单（其余四处） | `ConversationList`「+」、`NavRail`「更多」、`TodoPickField` 三格下拉、`GroupTasksBoard` 行内状态 | Reka `DropdownMenuRoot/Trigger/Content/Item`；看板用虚拟锚点 | **B（已落地）** | `ConversationList.vue`、`NavRail.vue`、`TodoPickField.vue`、`GroupTasksBoard.vue` | 开关/点外部/Esc/↑↓/Home/End 交给库；`useExclusivePopup` 互斥保留；看板不再手算 top/bottom。聚合判据「全 src 无手写 role=menuitem」；`--only=todopick` 4/4、`--only=tasksrt` 14/14 |
| 设置开关 | `SettingsToggle.vue` 自绘 `button role=switch`（9 个调用点） | Reka `SwitchRoot/SwitchThumb`（Vue 版 `modelValue/update:modelValue`） | **B（已落地）** | `src/components/settings/SettingsToggle.vue` | 保留必填 `label`、尺寸/配色/pending；`rekaPrimitives.test.ts` 钉住入参与无手写 role；`--only=switch` 4/4。迁移中实测：Radix 的 `checked/update:checked` 在 Reka Vue 上静默无效 |

## 2. 本轮评估、尚未迁移

| 能力 | 原实现 / 调用点 | 候选 | 判定 | 证据 / 原因 | 重评估条件 |
|---|---|---|---|---|---|
| Tooltip（图标按钮悬停提示） | 原生 `title` 属性 **272 处**（现算）；无自绘 tooltip | Reka `TooltipProvider/Root/Trigger/Content` | C（当前保留） | `title` 是平台原生反馈（桌面悬停、读屏命名、触控长按由系统给）；引入 Reka 需要全局 Provider、延迟/碰撞与每颗按钮改触发结构，且移动端无悬停语义。逐处替换 272 个 `title` 会改变现有原生反馈，收益未证 | 出现富内容提示（快捷键组合/多行说明/触控长按引导）的真实需求时，只在需要的按钮上接 Reka Tooltip |
| Popover / Tabs / Accordion / Collapsible | 全 `src` 无自研调用面（`role="tab"/"tablist"` 0 处） | Reka 对应原语 | D（当前不引入） | 界面没有这些通用控件；为"将来可能用"引入只增加依赖面与代码面 | 出现富信息浮层、设置分页或多段折叠的真实需求时，直接用 Reka 原语实现 |
| Checkbox / Radio | `type="checkbox"/"radio"` 0 处；设置开关已由 Reka Switch 承担 | Reka `Checkbox/RadioGroup` | D（当前不引入） | 没有多选/单选表单调用面 | 出现多选/单选表单时 |
| 命令面板 / 快捷搜索 | `ChatSearchDialog` 是产品搜索（SQLite 命中 + 发送人/日期筛选），不是通用命令注册表 | Reka 2.11.0 无 `CommandRoot` 导出（现查 `require('reka-ui')`） | C（保留业务核心） | 搜索语义、命中分组、跳转与消息定位都是业务；通用 command 库无法接 SQLite 与消息协议 | 若将来出现"全局命令/动作注册表"的真实需求，再评估 cmdk 类实现 |
| 原生下拉选择 | 4 个文件：`NetworkSection.vue`、`StorageSection.vue`、`AppearanceSection.vue`、`TodoPickField.vue` | Reka `Select` | C（当前保留） | 原生 `<select>` 在 iOS/Android 打开系统选择器，是平台原生行为；换成自绘弹层会丢失移动端原生选择器与系统无障碍。桌面端也没有证据表明 Reka 更优 | 若出现"桌面端需要复杂选项渲染（图标/多列）"的真实需求，再只在桌面端替换 |
| 消息列表虚拟化 | `VirtualList.vue`（525 行；前缀和 + 二分 + 实测高度覆盖 + prepend 锚定 + pending jump + pinned 贴底） | `@tanstack/vue-virtual` | C（当前保留） | P7 实测：20k 条 `calib()` 1.3 ms/遍，滚动 p95 17.5/16.8 ms，`longFramesOver50ms=0`；产品缓存上界 `PAGE_SIZE(100) × MAX_PAGES(10) = 1000 条/会话`。替换会重写 0.5px 白缝、prepend 不跳动、未读跳转二次落定这些已被真机/守恒判据钉住的行为 | 若产品上界被抬高到 1 万条/会话，或需要横向虚拟化/多列，再试迁移 |
| 日志长列表 | 已迁：`LogViewer.vue` 的 `useVirtualizer` | `@tanstack/vue-virtual` | **B（已落地）** | 见第 1 节；真实业务页（日志窗口）已切换，不是空封装 | 真机长日志滚动读数尚未采集（NOT RUN） |
| 异步请求/缓存 | Pinia stores + `StaleGuard` + 单飞 + 事件驱动更新（`useChatStore.ensureGroupTodoRows` 等） | TanStack Query | C（当前保留） | 数据源是 SQLite + 事件流；离线队列、可靠投递、加密传输、事务语义不能用普通查询缓存替代。存储层迁移会把"谁拥有事实"变成两份 | 若出现纯读、可过期、可后台刷新的独立面板（如远端目录列表），可在该模块试点 Query |
| 表单 | 原生 `<form>`/事件 + i18n 校验；`TodoPickField` 等 | TanStack Form / vee-validate | D（当前） | 现有表单纯 UI 状态 + 少量校验；没有复杂字段数组/异步校验的调用点。引入 Form 只增加依赖与心智，不减少业务代码 | 出现多步、动态字段数组、跨字段异步校验的真实表单时 |
| 路由 | 应用内 hash/窗口分层，无 Vue Router | TanStack Router | D（当前） | 路由与多窗口/Tauri 启动参数耦合；替换不会降低现有复杂度，反而要重做窗口路由 | 若引入真正的 URL 路由需求（Web 端独立部署） |
| 图标 | `lucide-vue-next` + `components/ui/icons.ts` 统一入口；4 个文件仍有内联 SVG（平台/产品专属） | Lucide | A（已统一） | 旧的前端正则曾跨 import 吞行造成 12 处假绿，P3 已修；内联 SVG 逐处判定为平台/产品图形保留 | 新增常规图标一律走 `components/ui/icons.ts` |
| 日期/时间 | `dayjs`（`useMessageDisplay.ts`、`chatStyle.ts`） | dayjs | C | 只在展示层格式化；没有时区/区间运算的复杂需求 | 出现跨时区排期/日程时再评估 Temporal/date-fns |
| Toast/通知 | 自研 toast store + Tauri notification 插件 | 自研 | C | toast 与业务错误、窗口层级、停留时长绑定；通用 toast 库不解决可靠性/去重问题 | 若只缺动画/队列，可在现有 store 上补，不换库 |
| 图片/媒体查看 | 自研 `ImageLightbox.vue` + `useImagePreview` 缓存 | 自研 | C | 与消息 msg_id/cid、预览缓存、保存、缩放/滑动绑定；通用 lightbox 库无法接这些业务语义 | 若要视频/多格式，先评估 media viewer 的 API 是否能接 msg_id/cid |
| Markdown/代码高亮 | `highlight.js` + 自研渲染/截断 | highlight.js | C | `highlight.js` 是 `v-html` 的上游；安全边界已在 P3/审计中处理，换库需重做消毒与截断 | 出现 Markdown 表格/任务列表等新语法需求 |
| 剪贴板 | 浏览器 `navigator.clipboard` + Tauri 命令回退 | Tauri clipboard 插件 | D | 现有路径已带权限/回退；新增插件不减少代码 | 若移动端复制失败有真实读数 |
| 运行时校验 | TypeScript 类型 + Rust serde 边界 | Zod/valibot | D | IPC 边界由 Rust 强类型序列化；前端加 schema 只重复一层，且会与类型漂移 | 出现外部不可信 JSON（插件/远端 API）时 |
| 文件选择/保存 | 已迁保存链：`save_media_as` 源路径直拷；`save_data_file` 仅作回退 | Rust 源路径拷贝（复用 `copy_file`） | **B（P6 保存链已落地）** | 事实校正：**预览链已经走原始字节**（`read_file_preview` 返回 `tauri::ipc::Response`，前端收 `ArrayBuffer`），不是 base64；保存链现在优先让后端按 `msg_id/cid` 直接拷，源不存在才回退 base64。Rust `tauri-plugin-fs 2.5.2` 已注册但前端包未装（本轮不需要） | 桌面/iOS 路径已过类型检查；Android `content://` 与 raw IPC 仍需真机（NOT RUN） |

## 3. 依赖与删除

- 删除：`@headlessui/vue`（唯一消费者已全部迁到 Reka）。
- 新增：`reka-ui@^2.11.0`（MIT；peer Vue >= 3.4；本机安装版本 2.11.0）。
- 新增：`@tanstack/vue-virtual@^3.13.47`（MIT；peer Vue ^2.7 || ^3；本机安装 3.13.47）。
- 现存生产依赖：`@tauri-apps/api`、`@tauri-apps/plugin-dialog`、`@tauri-apps/plugin-notification`、`@tauri-apps/plugin-opener`、`dayjs`、`highlight.js`、`lucide-vue-next`、`pinia`、`reka-ui`、`vue`。
- 已确认**不在** `package.json`：`vue-easy-lightbox`、`clsx`、`tailwind-merge`（上一轮清理后无残留）。

## 4. 验证口径（每次批次都现算）

| 层 | 命令 | 本轮读数 |
|---|---|---|
| 单测 | `npm test` | 1030 / 1030，0 失败 |
| 构建 | `npm run build` | 退码 0；`main` 307.27 kB / gzip 92.55（TanStack 在 vendor 分块，vendor 75.20 kB / gzip 24.51） |
| Rust | `cargo check --lib` / `cargo fmt --check` | 均退出 0；helpers 过滤用例 8/8 |
| UI 运行时 | `node scripts/check-ui-runtime.mjs` | 全量 **287/287，退出码 0**。段读数：ctxmenu 12/12、search 14/14、todopick 4/4、switch 4/4、tasksrt 14/14、overlay 41/41、search+roster 58/58、emoji+search 41/41、winsafe+search 33/33。两处夹具时序已修（页面 hidden 时转场动画时钟冻在 0；长昵称未种进名字表），详见报告 6.11 |
| 快速/本地门禁 | `npm run verify:local` | **22/22、退出码 0、59.0s**（最终 tip 复跑；唯一跳过「护栏非空转」） |
| 真实多实例 / 真机 | E2E / Windows/macOS 移动端 | **NOT RUN**（需用户授权与真机） |

## 5. 明确未做

- Reka 的 Tooltip/Popover/Select/Checkbox/Radio/Switch/Tabs/Accordion/Collapsible/Command 尚未迁移；当前代码没有对应的通用调用面，或属于平台原生控件（Select）。
- 自研 `ContextMenu.vue`、四个业务右键菜单、`ChatSearchDialog` 两个筛选菜单与其余四处锚定菜单已全部迁到 Reka DropdownMenu；全 `src/components/**/*.vue` 不再出现手写 `role="menuitem"`。
- TanStack Query/Table/Router/Form 未引入；Reason 见第 2 节。TanStack Virtual 只在日志页试点，消息列表仍保留自研实现。
- P6 的**预览链**已走原始字节，但 Android/iOS 的真机行为未验证；保存链已去 base64，回退路径仍保留。
- 全量 UI 探针已拿到最终读数 **287/287**（含 reaction 长名字与 search 筛选菜单两处夹具时序修复）；
  E2E、Windows/Android/iOS 真机、长日志实机滚动读数仍未跑。
