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
| 运行日志长列表 | 两条外壳各自整表 `v-for` | `@tanstack/vue-virtual@3.13.47` 的 `useVirtualizer` + `measureElement` | B | `src/components/LogViewer.vue`、`src/utils/logViewerVirtual.test.ts` | 两条外壳共用同一套虚拟行；`data-index` + `measureRow` 实测高度；过滤变化 `scrollToOffset(0)`；护栏禁止退回整表渲染。2026-10-19 修掉开发环境白屏两因：`mergedRows` 声明晚于 `useVirtualizer`（dev TDZ）、独立窗滚动容器漏 `ref="logScroll"`；新增 `--only=logs` 3 条 |
| 图片另存（保存链） | JS 把整张图转 base64 → `save_data_file` | Rust `save_media_as(msg_id/cid, destination)`，复用 `copy_file` 的 Android `content://` 与 `spawn_blocking` | B | `src-tauri/src/commands/helpers.rs`、`src/api/index.ts`、`src/utils/saveImageAs.ts`、`saveImageCore.ts`、`ImageLightbox.vue`、`MessageItem.vue` | 源路径优先、失败回退字节路径；`cargo check --lib` 0、`cargo fmt --check` 0、helpers Rust 8/8；前端 saveImageCore 新增 2 条源路径用例 |
| 右键/上下文菜单 | `ContextMenu.vue`（自研 Teleport/document click/window keydown/焦点循环，135 行）+ 四个业务菜单（消息/会话/联系人/收藏） | Reka `DropdownMenuRoot/Portal/Content`（虚拟 `reference` 锚点）+ `DropdownMenuItem/Separator` | **B（已落地）** | `src/components/ContextMenu.vue`、`MessageContextMenu.vue`、`ConversationContextMenu.vue`、`FriendContextMenu.vue`、`FavoritePanel.vue` | 定位/翻转/点外部/Esc/roving focus 交给库；K 主题与 z 序不变；`contextMenuReka.test.ts` 4 条源码判据；`--only=ctxmenu` 12/12；迁移中发现 `fixed` 子元素让 popper wrapper 量到 0×0（翻转失效），已钉判据 |
| 搜索筛选菜单 | `ChatSearchDialog.vue` 发送人/日期两处手写 `role=menu` + 绝对定位 + 按钮开关 | Reka `DropdownMenuRoot/Trigger/Portal/Content/Item` | **B（已落地）** | `src/components/search/ChatSearchDialog.vue` | 互斥收进 `onSenderOpen/onDateOpen`；`:modal="false"` 防止焦点陷阱抢走搜索框；Portal 后用 `z-[80]`；`--only=search` **16/16**（含「嵌套 Dialog 的 aria-hidden/pointer-events 下仍可命中」与「乱序响应不跨关键词回填」） |
| 锚定菜单（其余四处） | `ConversationList`「+」、`NavRail`「更多」、`TodoPickField` 三格下拉、`GroupTasksBoard` 行内状态 | Reka `DropdownMenuRoot/Trigger/Content/Item`；看板用虚拟锚点 | **B（已落地）** | `ConversationList.vue`、`NavRail.vue`、`TodoPickField.vue`、`GroupTasksBoard.vue` | 开关/点外部/Esc/↑↓/Home/End 交给库；`useExclusivePopup` 互斥保留；看板不再手算 top/bottom。聚合判据「全 src 无手写 role=menuitem」；`--only=todopick` 4/4、`--only=tasksrt` 14/14 |
| 设置开关 | `SettingsToggle.vue` 自绘 `button role=switch`（9 个调用点） | Reka `SwitchRoot/SwitchThumb`（Vue 版 `modelValue/update:modelValue`） | **B（已落地）** | `src/components/settings/SettingsToggle.vue` | 保留必填 `label`、尺寸/配色/pending；`rekaPrimitives.test.ts` 钉住入参与无手写 role；`--only=switch` 4/4。迁移中实测：Radix 的 `checked/update:checked` 在 Reka Vue 上静默无效 |
| 单选分段控件 | `SegmentedControl.vue` 手写 `role=radiogroup/radio` + 按钮（多处分段切换） | Reka `RadioGroupRoot/RadioGroupItem` | **B（已落地）** | `src/components/ui/SegmentedControl.vue` | roving focus/方向键/禁用交给 RovingFocus；保留尺寸/配色/徽标。探针实测：组本身是 Tab 停点、项 `tabindex=-1`（不是 Radix 记忆里的选中项为停点）；`--only=segmented` 8/8 |
| 字号滑杆 | `ChatStyleSection.vue` 手写 pointerdown/move + 键盘处理 + 五档圆点 | Reka `SliderRoot/Track/Range/Thumb` | **B（已落地）** | `src/components/settings/ChatStyleSection.vue` | 保留五档视觉与 `setChatStyle` 落库；`aria-valuetext` 现读 `px · 文案`；`--only=slider` 8/8 |
| 设置/表单下拉 | 5 处原生 `<select>`：`AppearanceSection.vue`（字体）、`NetworkSection.vue`（网卡、中继策略）、`StorageSection.vue`（保留天数、配额） | Reka `SelectRoot/Trigger/Portal/Content/Viewport/Item/ItemText/ItemIndicator` | **B（已落地）** | `src/components/ui/SettingsSelect.vue` + 上述三个设置页 | 触发器 `button[role=combobox]`、面板吃 `.gosslan-menu`；不传 `name` ⇒ 不渲染隐藏原生 select；`style.css` 删除 `.gosslan-select*`。全仓判据 `findNativeSelect`（正控＝真实组件注入）零命中；`--only=select` 6/6（键盘 ↓/Enter/Esc + 鼠标真点）。迁移中修掉 `ToastList` 全局 Esc `preventDefault` 吞掉所有弹层 Esc 的真实缺陷 |
| 日期/时间格式化 | `LogViewer` 手写 `padStart`；`DevDiagPanel` 用 `toLocaleTimeString()`；`StorageSection` 手写日期戳 | `dayjs` 统一 helpers（`utils/time.ts`） | **A（已统一）** | `src/utils/time.ts`、`LogViewer.vue`、`DevDiagPanel.vue`、`StorageSection.vue` | 固定 `YYYY-MM-DD HH:mm:ss` / `HH:mm:ss` / `YYYYMMDD`；不再受 WebView 区域设置影响；`time.test.ts` 2 条（形状 + 接线） |
| 浮层焦点陷阱 | `ImageLightbox` 手写「打开 focus 容器 / 关闭手动还焦点」，实际 Tab 会逃到背景页 | Reka `FocusScope`（`loop` + `trapped` + 卸载 auto-focus） | **B（已落地）** | `src/components/message/ImageLightbox.vue` | 预览外壳/手势/保存链仍是业务实现；焦点环、逃逸拉回、卸载归还交给库。`--only=lightbox` 7/7；摘 `loop` ⇒ 2 红、摘 `trapped` ⇒ 1 红（两次单点变异） |
| 表单与 IPC 运行时校验 | 手写 `trim`/长度判断；`invoke<T>` 只做编译期断言（Rust 改字段 TS 不会红） | `zod/mini@4.6.7`（MIT） | **B（已落地）** | `src/utils/validation.ts`、`externalLinks.ts`、`GroupCreateModal.vue`、`ProfileSection.vue`、`src/api/index.ts` | 群名/昵称/链接共用 schema（字符数按码点）；`list_group_files` / `request_share_tree` / `search_chat_history` 的返回数组经 `parseIpcList` 真校验，坏行带命令名与字段路径抛错；搜索结果做**嵌套校验**（会话 → messages），`kind` 收任意字符串以保住未知 kind 的前向兼容。单测 6 条（含接线判据）。mini 构建 vendor +6.85 kB gzip（完整版 +25.56，实测后弃用） |
| 异步查询/缓存 | `GroupFilesPanel.vue` 的 `files/loading/failed/loadError` + 两个 watch + `gid !== props.groupId` 过期守卫；`ShareDirectory.vue` 的 `entries/loading/error` + `StaleGuard` + 两个 watch；`ChatSearchDialog.vue` 的 `groups/searching/searchError` + `seq` + 150ms 防抖 + 两个筛选 watcher | `@tanstack/vue-query@5.104.4`（每个窗口一份 QueryClient） | **B（三个面板已落地）** | `src/boot/boot.ts`、`src/utils/panelQuery.ts`、`groupFilesQuery.ts`、`shareTreeQuery.ts`、`chatSearchQuery.ts`、`GroupFilesPanel.vue`、`ShareDirectory.vue`、`search/ChatSearchDialog.vue` | 面板族共用 `panelQuery`：按主体 id 分键 ⇒ 旧响应结构上写不进新主体；`staleTime 0` ⇒ 每次打开重拉；并发合并/失败保留/重试交给库。群文件另有事件窄订阅；共享目录把 `snapshot.friendId` 随数据缓存，下载归属不读当前会话。搜索页把**关键词/发送人/日期三件都放进 key**，`retry 0` 与 `keepPreviousData` 由策略文件钉住；发送人候选只认"当前键 + 非占位 + 无发送人筛选"的结果。单测 12 条（面板 7 + 搜索 5）、`--only=files` 8/8、`--only=share` 6/6、`--only=search` 16/16。边界：Pinia/SQLite/可靠投递仍是事实源，Query 只接管"纯读可过期面板" |
| 同窗口事件总线 | `utils/appActions.ts` 的 `window.dispatchEvent(new Event(...))` + 各组件字符串事件监听；`navigate-to-contacts` 是裸串 | `mitt@3.0.1`（MIT，自带类型） | **B（已落地）** | `src/utils/appActions.ts`、`api/index.ts`、`ResponsiveLayout.vue`、`ConversationList.vue`、`stores/useChatStore.ts` | 类型安全事件表 `appBus`；`APP_ACTION` 四处 + `navigate-to-contacts` 全走 `emitAction`；`onAction` 返回解绑函数，组件卸载必须调用（mitt 不自动清理）；Tauri 菜单事件仍由 `bindMenuEvents` 转成同一批动作，跨窗口/Rust 继续走 `@tauri-apps/api/event`。`appActions.test.ts` 2 条（投递/不串线/解绑） |
| 多语言 i18n | 自研 150 行「字典 + `{name}` 插值」引擎；`t()` 在 78 个文件里调用 | `vue-i18n@11.4.16`（MIT，peer Vue 3） | **B（已落地）** | `src/i18n/index.ts`、`src/i18n/locales/*.ts`、`src/i18n/compile.test.ts` | 消息编译/插值/回退交给库；本模块只留偏好三态、系统语言检测、localStorage 快路径、`document.lang`。迁移前 **1003×2 条逐字对账**：998 条一致，5 条字面 `@` 改写 `{'@'}`；缺参保留 `{name}` 的既有语义由 `t()` 适配。`i18n/index.test.ts` 17 条 + `compile.test.ts` 1 条；全量探针 338/338。体积：vendor gzip +18.84（消息编译器） |

## 2. 本轮评估、尚未迁移

| 能力 | 原实现 / 调用点 | 候选 | 判定 | 证据 / 原因 | 重评估条件 |
|---|---|---|---|---|---|
| Tooltip（图标按钮悬停提示） | 原生 `title` 属性 **274 处**（现算）；无自绘 tooltip | Reka `TooltipProvider/Root/Trigger/Content` | C（当前保留） | `title` 是平台原生反馈（桌面悬停、读屏命名、触控长按由系统给）；引入 Reka 需要全局 Provider、延迟/碰撞与每颗按钮改触发结构，且移动端无悬停语义。逐处替换 274 个 `title` 会改变现有原生反馈，收益未证 | 出现富内容提示（快捷键组合/多行说明/触控长按引导）的真实需求时，只在需要的按钮上接 Reka Tooltip |
| Popover（锚定浮层） | `useHoverCard` + `utils/hoverCard.placeCard/cardStyle`（手写摆位/四向翻转/滚动收起）：`MessageItem` 表情选择器、`MessageReactionBar` 表情名单、`MessageReceipt` 已读名单 | Reka `PopoverRoot/Trigger/Portal/Content` | C（当前保留，已有真实调用面） | 三处都是「贴着消息元素弹 + 四个方向翻 + 列表一滚就收」。迁移的两个硬点：① 表情选择器的面板本体在 `EmojiPicker` 里是 `absolute`、外层壳零高度，直接塞进 `PopoverContent` 会让 floating-ui 量到 0×0（与 ContextMenu 的 `fixed` 坑同形）；② 表情名单由 hover / focus / 长按三种触发共同驱动，Popover 只有受控开关可接。收益未证、风险高于本批 | 表情面板改版（内容不再零高度）或需要富内容/焦点管理时，三处整批迁 Reka 并删除 `hoverCard` |
| Tabs / Accordion / Collapsible | 全 `src` 无自研调用面（`role="tab"/"tablist"` 0 处） | Reka 对应原语 | D（当前不引入） | 界面没有这些通用控件；为"将来可能用"引入只增加依赖面与代码面 | 出现设置分页或多段折叠的真实需求时，直接用 Reka 原语实现 |
| Checkbox / Radio | `type="checkbox"/"radio"` 0 处；设置开关已由 Reka Switch 承担 | Reka `Checkbox/RadioGroup` | D（当前不引入） | 没有多选/单选表单调用面 | 出现多选/单选表单时 |
| 命令面板 / 快捷搜索 | `ChatSearchDialog` 是产品搜索（SQLite 命中 + 发送人/日期筛选），不是通用命令注册表 | Reka 2.11.0 无 `CommandRoot` 导出（现查 `require('reka-ui')`） | C（保留业务核心） | 搜索语义、命中分组、跳转与消息定位都是业务；通用 command 库无法接 SQLite 与消息协议 | 若将来出现"全局命令/动作注册表"的真实需求，再评估 cmdk 类实现 |
| 消息列表虚拟化 | `VirtualList.vue`（525 行；前缀和 + 二分 + 实测高度覆盖 + prepend 锚定 + pending jump + pinned 贴底） | `@tanstack/vue-virtual` | C（当前保留） | P7 实测：20k 条 `calib()` 1.3 ms/遍，滚动 p95 17.5/16.8 ms，`longFramesOver50ms=0`；产品缓存上界 `PAGE_SIZE(100) × MAX_PAGES(10) = 1000 条/会话`。替换会重写 0.5px 白缝、prepend 不跳动、未读跳转二次落定这些已被真机/守恒判据钉住的行为 | 若产品上界被抬高到 1 万条/会话，或需要横向虚拟化/多列，再试迁移 |
| 日志长列表 | 已迁：`LogViewer.vue` 的 `useVirtualizer` | `@tanstack/vue-virtual` | **B（已落地）** | 见第 1 节；真实业务页（日志窗口）已切换，不是空封装 | 真机长日志滚动读数尚未采集（NOT RUN） |
| 消息/会话/任务的异步状态 | Pinia stores + `StaleGuard` + 单飞 + 事件驱动更新（`useChatStore.ensureGroupTodoRows` 等） | TanStack Query | C（当前保留） | 数据源是 SQLite + 事件流；离线队列、可靠投递、加密传输、事务语义不能用普通查询缓存替代。存储层迁移会把"谁拥有事实"变成两份。**纯读面板已另起试点**（群文件 / 共享目录 / 搜索聊天记录，见第 1 节），两者边界：Query 不管消息状态机 | 若再出现纯读、可过期、可后台刷新的独立面板（远端目录、诊断快照），按群文件模式逐面板迁移；会话/消息主链不迁 |
| 表单 | 原生 `<form>`/事件 + i18n 校验；`TodoPickField` 等 | TanStack Form / vee-validate | D（当前） | 现有表单纯 UI 状态 + 少量校验；没有复杂字段数组/异步校验的调用点。引入 Form 只增加依赖与心智，不减少业务代码 | 出现多步、动态字段数组、跨字段异步校验的真实表单时 |
| 路由 | 应用内 hash/窗口分层，无 Vue Router | TanStack Router | D（当前） | 路由与多窗口/Tauri 启动参数耦合；替换不会降低现有复杂度，反而要重做窗口路由 | 若引入真正的 URL 路由需求（Web 端独立部署） |
| 图标 | `lucide-vue-next` + `components/ui/icons.ts` 统一入口；4 个文件仍有内联 SVG（平台/产品专属） | Lucide | A（已统一） | 旧的前端正则曾跨 import 吞行造成 12 处假绿，P3 已修；内联 SVG 逐处判定为平台/产品图形保留 | 新增常规图标一律走 `components/ui/icons.ts` |
| Toast/通知 | `useAppStore` 手写数组 + 每条 `setTimeout`（无上限、无去重） | Reka `ToastProvider/Viewport/Root` + `createToastManager`（Tauri notification 仍是系统通知通道） | **B（已落地）** | `ToastHud.vue`、`ToastList.vue`、`utils/toastManager.ts`、`useAppStore.ts` | 同一 kind+文案按 id 去重；`limit=3`（超出 `data-limited`+`inert` 且隐藏）；错误 6s / 其余 3s；保留配色/图标/安全区；Esc 只在焦点位于 toast 时放行。`--only=toast` 7/7；摘 `limit` ⇒ 3 红、摘 Esc 守卫 ⇒ 2 红 |
| 图片/媒体查看 | 自研 `ImageLightbox.vue` + `useImagePreview` 缓存 | 自研（焦点语义已拆出，见上一行） | C | 与消息 msg_id/cid、预览缓存、保存、缩放/滑动绑定；通用 lightbox 库无法接这些业务语义。焦点陷阱/归还已交 Reka `FocusScope`，剩下的自研部分只覆盖业务手势与取字节 | 若要视频/多格式，先评估 media viewer 的 API 是否能接 msg_id/cid |
| Markdown/代码高亮 | 无 Markdown 渲染；代码块用 `highlight.js` 子集 | `markdown-it` + `dompurify` | C（当前保留） | 消息只渲染纯文本 + 链接/提及；没有"把对端 Markdown/HTML 渲染成 DOM"的业务。代码块已用 hljs 的转义输出；引入 Markdown 会新增 HTML 允许策略与过滤链，收益未证 | 出现 Markdown 消息/富文本编辑的真实需求时，`markdown-it` + DOMPurify 一起接 |
| HTML 过滤 / DOMPurify | 全仓 4 处 `v-html`：搜索高亮、日志行、代码块 | `dompurify` | C（当前不引入） | 4 处的输入都由构造保证已转义：`highlightText` 先匹配后逐段 `escHtml`、日志行复用同一函数、代码块用 hljs 输出或 `escapeHtml`；`highlight.test.ts` 已有 `<script>` / `onerror` 用例；新增 `findVHtmlSinks` / `V_HTML_ALLOWED` 允许清单判据 + 真实组件正控。没有"渲染对端原文 HTML"的路径 | 出现富文本/Markdown/允许 HTML 的消息渲染时，先定允许策略再接 DOMPurify |
| 剪贴板 | 浏览器 `navigator.clipboard` + Tauri 命令回退 | Tauri clipboard 插件 | D | 现有路径已带权限/回退；新增插件不减少代码 | 若移动端复制失败有真实读数 |
| 文件选择/保存 | 已迁保存链：`save_media_as` 源路径直拷；`save_data_file` 仅作回退 | Rust 源路径拷贝（复用 `copy_file`） | **B（P6 保存链已落地）** | 事实校正：**预览链已经走原始字节**（`read_file_preview` 返回 `tauri::ipc::Response`，前端收 `ArrayBuffer`），不是 base64；保存链现在优先让后端按 `msg_id/cid` 直接拷，源不存在才回退 base64。Rust `tauri-plugin-fs 2.5.2` 已注册但前端包未装（本轮不需要） | 桌面/iOS 路径已过类型检查；Android `content://` 与 raw IPC 仍需真机（NOT RUN） |

## 3. 依赖与删除

- 删除：`@headlessui/vue`（唯一消费者已全部迁到 Reka）。
- 新增：`reka-ui@^2.11.0`（MIT；peer Vue >= 3.4；本机安装版本 2.11.0）。
- 新增：`@tanstack/vue-virtual@^3.13.47`（MIT；peer Vue ^2.7 || ^3；本机安装 3.13.47）。
- 新增：`@tanstack/vue-query@^5.104.4`（MIT；peer Vue ^2.6 || ^3.x；本机安装 5.104.4，含 query-core 5.104.4）。使用面只有群文件面板与每窗口的 QueryClient。
- 新增：`@vueuse/core@^14.4.0`（MIT；Vue 3）。使用面：`useClipboard({ legacy: true })`（复制链去掉手写 `execCommand` 回退）。
- 新增：`zod@^4.6.7`（MIT）。只使用 `zod/mini`：表单字段 + 两个 IPC 读边界的形状校验。
- 现存生产依赖：`@tanstack/vue-virtual`、`@tanstack/vue-query`、`@tauri-apps/api`、`@tauri-apps/plugin-dialog`、`@tauri-apps/plugin-notification`、`@tauri-apps/plugin-opener`、`@vueuse/core`、`dayjs`、`highlight.js`、`lucide-vue-next`、`pinia`、`reka-ui`、`vue`。
- 已确认**不在** `package.json`：`vue-easy-lightbox`、`clsx`、`tailwind-merge`（上一轮清理后无残留）。

## 4. 验证口径（每次批次都现算）

| 层 | 命令 | 本轮读数 |
|---|---|---|
| 单测 | `npm test` | 1060 / 1060，0 失败（相对 5.0.18 的 1055：搜索查询策略 5、搜索 IPC 校验 1、mitt 2、i18n 全量编译 1、日志窗口回归 1） |
| 构建 | `npm run build` | 退码 0；`main` 308.65 kB / gzip 93.34（vendor 323.99 kB / gzip 99.62 —— TanStack Query + zod/mini + Reka Toast/Select + mitt + vue-i18n 消息编译器；Virtual 仍在 vendor） |
| Rust | `cargo check --lib` / `cargo fmt --check` | 均退出 0；helpers 过滤用例 8/8 |
| UI 运行时 | `node scripts/check-ui-runtime.mjs` | **全量 341/341 条判据绿、退出码 0**（本 tip 实跑）。本批新增 **logs 3/3**（standalone 有虚拟行 / 200 条只渲染视口附近 / 滚到底换页；单点变异摘掉独立窗 `logScroll` ref ⇒ 0/3 红，恢复 3/3）。其余段：search 16/16、select 6/6、toast 6/6、files 8/8、share 6/6、lightbox 7/7、segmented 8/8、slider 8/8、switch 4/4、ctxmenu 12/12 等均在本次全量内 |
| 快速/本地门禁 | `npm run verify:local` | **22/22、退出码 0**（本 tip 实测见报告 §6.11；唯一跳过「护栏非空转」，按用户策略留给发版/CI） |
| 真实多实例 / 真机 | E2E / Windows/macOS 移动端 | **NOT RUN**（需用户授权与真机） |

## 5. 明确未做

- Reka 的 Tooltip/Checkbox/Radio/Tabs/Accordion/Collapsible/Command 尚未迁移；这些当前没有调用面。
  例外是锚定 Popover：`useHoverCard` 有三处真实调用点（表情选择器/表情名单/已读名单），因零高度
  `absolute` 面板与 hover/长按触发判 C（保留），见第 2 节。`Select` 已落地（见第 1 节）。
- 自研 `ContextMenu.vue`、四个业务右键菜单、`ChatSearchDialog` 两个筛选菜单与其余四处锚定菜单已全部迁到 Reka DropdownMenu；全 `src/components/**/*.vue` 不再出现手写 `role="menuitem"`。
- TanStack Query 已在三个真实面板（群文件、共享目录、搜索聊天记录）落地；会话/消息/群任务主链仍是 Pinia + SQLite + 事件流，Reason 见第 2 节。
  TanStack Table/Router/Form 未引入（当前无对应调用面）；TanStack Virtual 只在日志页试点，消息列表仍保留自研实现。
- 同窗口事件已从 `window.dispatchEvent` 迁到 `mitt`（类型安全事件表 + 解绑协议）；跨窗口/Rust 继续走
  `@tauri-apps/api/event`，两者边界见第 1 节与报告 §6.6。
- i18n 已从 150 行自研引擎迁到 `vue-i18n`（1003×2 条消息全量编译）；缺参保留 `{name}` 的产品语义由
  `t()` 适配，体积代价 vendor gzip +18.84。
- DOMPurify 当前不引入：4 处 `v-html` 全部构造即转义，并由 `findVHtmlSinks`/`V_HTML_ALLOWED`
  允许清单与真实组件正控守着；出现富文本/Markdown/允许 HTML 的渲染需求时再接。
- P6 的**预览链**已走原始字节，但 Android/iOS 的真机行为未验证；保存链已去 base64，回退路径仍保留。
- 全量 UI 探针已拿到最终读数 **338/338**（本 tip 实跑；含搜索乱序响应新判据）；
  E2E、Windows/Android/iOS 真机、长日志实机滚动读数仍未跑（NOT RUN）。
