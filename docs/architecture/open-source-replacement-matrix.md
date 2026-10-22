# 开源替换矩阵（5.x 前端基础设施）

> 口径：先扫真实调用点，再按 A（直接替换）/ B（适配后替换）/ C（保留业务核心）/ D（暂不迁移，附证据与重评估条件）归档。
> 本文件随批次更新；未落地的条目一律标 **未迁移**，不把选型写成完成。
> 证据来源：`package.json` / `package-lock.json`、真实 `src/**` 调用点、`npm test`、`npm run build`、`node scripts/check-ui-runtime.mjs`。
> 最近更新：2026-10-22（引入 `vue-router@5.4.0`；Pinia 3 / Vite 7 / plugin-vue 6 升级；`@pinia/colada` 只装不接线；`motion-v` 实测产物增量后不采纳）。

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
| 设置/表单下拉 | 5 处原生 `<select>`：`AppearanceSection.vue`（字体）、`NetworkSection.vue`（网卡、中继策略）、`StorageSection.vue`（保留天数、配额） | Reka `SelectRoot/Trigger/Portal/Content/Viewport/Item/ItemText/ItemIndicator` | **B（已落地）** | `src/components/ui/SettingsSelect.vue` + 上述三个设置页 | 触发器 `button[role=combobox]`、面板吃 `.gosslan-menu`；不传 `name` ⇒ 不渲染隐藏原生 select；`style.css` 删除 `.gosslan-select*`。全仓判据 `findNativeSelect`（正控＝真实组件注入）零命中；`--only=select` 6/6（键盘 ↓/Enter/Esc + 鼠标真点）。迁移中修掉 `ToastList` 全局 Esc `preventDefault` 吞掉所有弹层 Esc 的真实缺陷。**Reka `SelectItem` 不渲染空串 value**：字体默认档改用非空哨兵（真实 Tauri 实测菜单少了「系统默认」），`--only=fontsel` 4/4 |
| 日期/时间格式化 | `LogViewer` 手写 `padStart`；`DevDiagPanel` 用 `toLocaleTimeString()`；`StorageSection` 手写日期戳 | `dayjs` 统一 helpers（`utils/time.ts`） | **A（已统一）** | `src/utils/time.ts`、`LogViewer.vue`、`DevDiagPanel.vue`、`StorageSection.vue` | 固定 `YYYY-MM-DD HH:mm:ss` / `HH:mm:ss` / `YYYYMMDD`；不再受 WebView 区域设置影响；`time.test.ts` 2 条（形状 + 接线） |
| 浮层焦点陷阱 | `ImageLightbox` 手写「打开 focus 容器 / 关闭手动还焦点」，实际 Tab 会逃到背景页 | Reka `FocusScope`（`loop` + `trapped` + 卸载 auto-focus） | **B（已落地）** | `src/components/message/ImageLightbox.vue` | 预览外壳/手势/保存链仍是业务实现；焦点环、逃逸拉回、卸载归还交给库。`--only=lightbox` 7/7；摘 `loop` ⇒ 2 红、摘 `trapped` ⇒ 1 红（两次单点变异） |
| 表单与 IPC 运行时校验 | 手写 `trim`/长度判断；`invoke<T>` 只做编译期断言（Rust 改字段 TS 不会红） | `zod/mini@4.6.7`（MIT） | **B（已落地）** | `src/utils/validation.ts`、`externalLinks.ts`、`GroupCreateModal.vue`、`ProfileSection.vue`、`src/api/index.ts` | 群名/昵称/链接共用 schema（字符数按码点）；`list_group_files` / `request_share_tree` / `search_chat_history` 的返回数组经 `parseIpcList` 真校验，坏行带命令名与字段路径抛错；搜索结果做**嵌套校验**（会话 → messages），`kind` 收任意字符串以保住未知 kind 的前向兼容。单测 6 条（含接线判据）。mini 构建 vendor +6.85 kB gzip（完整版 +25.56，实测后弃用） |
| 异步查询/缓存 | `GroupFilesPanel.vue` 的 `files/loading/failed/loadError` + 两个 watch + `gid !== props.groupId` 过期守卫；`ShareDirectory.vue` 的 `entries/loading/error` + `StaleGuard` + 两个 watch；`ChatSearchDialog.vue` 的 `groups/searching/searchError` + `seq` + 150ms 防抖 + 两个筛选 watcher | `@tanstack/vue-query@5.104.4`（每个窗口一份 QueryClient） | **B（五个面板已落地：群文件/共享目录/搜索聊天记录/诊断快照 + 外部链接读+写；见 §6.90、§6.98）** | `src/boot/boot.ts`、`src/utils/panelQuery.ts`、`groupFilesQuery.ts`、`shareTreeQuery.ts`、`chatSearchQuery.ts`、`GroupFilesPanel.vue`、`ShareDirectory.vue`、`search/ChatSearchDialog.vue` | 面板族共用 `panelQuery`：按主体 id 分键 ⇒ 旧响应结构上写不进新主体；`staleTime 0` ⇒ 每次打开重拉；并发合并/失败保留/重试交给库。群文件另有事件窄订阅；共享目录把 `snapshot.friendId` 随数据缓存，下载归属不读当前会话。搜索页把**关键词/发送人/日期三件都放进 key**，`retry 0` 与 `keepPreviousData` 由策略文件钉住；发送人候选只认"当前键 + 非占位 + 无发送人筛选"的结果。单测 12 条（面板 7 + 搜索 5）、`--only=files` 8/8、`--only=share` 6/6、`--only=search` 16/16。边界：Pinia/SQLite/可靠投递仍是事实源，Query 只接管"纯读可过期面板" |
| 只读面板的加载状态（诊断快照） | `DevDiagPanel.vue` 手写 `diag`/`loading`/`loadError` 三枚 ref + `onMounted` 自拉 + `try/finally` | `@tanstack/vue-query` 的 `useQuery` + `utils/panelQuery`（全局单键 `["diag",""]`） | **B（已落地）** | 删掉三枚 ref 与 `onMounted`；「有旧快照就不说读失败」这条业务口径原样搬成 `error && !diag`；连点刷新合并成一次（旧实现各发一条）。`src/utils/panelQuery.test.ts` 6 条，三发单点变异各红一格。真实界面 NOT RUN（见 §6.90） |
| 外部链接（读 + 写） | `LinksList.vue` 手写 `links`/`loading`/`loadError`/`saving` 四枚 ref + `onMounted` 自拉 + `try/finally`；三条写命令各自把后端返回的**整份数组**回填同一个 ref | `useQuery` + `utils/panelQuery`（键 `["links",""]`）+ **一枚 `useMutation`**（增/改/删共用，成功时 `setQueryData` 把整份数组写回同一键） | **B（已落地，§6.98）** | 删掉四枚 ref 与 `onMounted`；写回缓存而不是失效重拉（list 命令少发一次，探针按调用次数判）；Chromium 里增/改/删 **9/9**，两发单点变异（删写回 / 换失效重拉）各 **6/9**；真机上的增删改 NOT RUN |
| 弹窗顶部让位（安全区） | 两套互不相认的口径：桌面 `top-[var(--gosslan-window-safe-top)]` + 移动端各处自己写 `env(safe-area-inset-top)`，卡片形态两枚都没读全（压刘海），预览工具条把两枚**相加**（桌面双计，真几何 delta=60） | 一枚 CSS 出口 `--gosslan-safe-top = max(window, env)`（**不引新依赖**） | **B（已落地）** | `style.css` 定义一处；`BaseModal` 外壳 top 与卡片 max-h、`ImageLightbox` 外壳各读它；整屏面板自己那句删；遮罩**故意**仍读 window（移动端要让刘海区落进暗层）。顺手删掉 `ImageLightbox` 的 `topInset` prop（外壳读同一枚后它没有活了）。判据 ㊿ 4 条 + 探针 `--only=lightbox` 新增 2 格（先红读数 delta=60 → 9/9 绿）；四发变异含"注释里写字面类名不许红"那一发。⚠️ 10-20 补第二个洞：`--gosslan-window-safe-top` 的桌面覆盖原先挂 `html:not(.is-mobile)`（布局档），而 caption 画不画看 `TitleBar` 的 prop（辅助窗的宿主不传）⇒ 桌面窗拖到 ≤767px（日志窗默认 760）就画着 caption 却拿不到让位；现改挂 `html.has-caption`，由 TitleBar 自己写（判据 52 两条 + 探针 `--only=caption` 12/12，三发变异各红 1/4/3 格） |
| 导航图标造型与选中态 | 4 枚自绘 glyph 在 PC 栏与移动端**各写一遍同一条 `d`**、`:fill` 绑定抄了 4 处（漏 1 处就是用户 2026-09-21 报的那格「链接选中不变实心」）；`BackArrow` 的 iOS 档把 lucide `chevron-left` 的路径**逐字抄进模板** | `lucide-vue-next`（已装，**不新增包**）+ 受控的 `ui/NavIcon.vue` 与造型数据 `ui/navIconPaths.ts` | **B（已落地）** | `src/components/ui/NavIcon.vue`、`ui/navIconPaths.ts`、`NavRail.vue`、`layouts/ResponsiveLayout.vue`、`ui/BackArrow.vue` | 例外两项：4 枚导航 glyph 必须自绘（lucide 无填充档 ⇒ 选中态靠 fill）；`TitleBar.vue` 5 枚内联 svg 保留（OS 窗口控件造型，不是功能图标）；探针 `--only=navicon` 6/6 + 11 发变异各点住对应格（文本层 4 + 运行时 5 + 判据 51 两发） |
| 同窗口事件总线 | `utils/appActions.ts` 的 `window.dispatchEvent(new Event(...))` + 各组件字符串事件监听；`navigate-to-contacts` 是裸串 | `mitt@3.0.1`（MIT，自带类型） | **B（已落地）** | `src/utils/appActions.ts`、`api/index.ts`、`ResponsiveLayout.vue`、`ConversationList.vue`、`stores/useChatStore.ts` | 类型安全事件表 `appBus`；`APP_ACTION` 四处 + `navigate-to-contacts` 全走 `emitAction`；`onAction` 返回解绑函数，组件卸载必须调用（mitt 不自动清理）；Tauri 菜单事件仍由 `bindMenuEvents` 转成同一批动作，跨窗口/Rust 继续走 `@tauri-apps/api/event`。`appActions.test.ts` 2 条（投递/不串线/解绑） |
| 多语言 i18n | 自研 150 行「字典 + `{name}` 插值」引擎；`t()` 在 78 个文件里调用 | `vue-i18n@11.4.16`（MIT，peer Vue 3） | **B（已落地）** | `src/i18n/index.ts`、`src/i18n/locales/*.ts`、`src/i18n/compile.test.ts` | 消息编译/插值/回退交给库；本模块只留偏好三态、系统语言检测、localStorage 快路径、`document.lang`。迁移前 **1003×2 条逐字对账**：998 条一致，5 条字面 `@` 改写 `{'@'}`；缺参保留 `{name}` 的既有语义由 `t()` 适配。`i18n/index.test.ts` 17 条 + `compile.test.ts` 1 条；全量探针 338/338。体积：vendor gzip +18.84（消息编译器） |

| 锚定浮层（表情名单 / 已读名单 / 表情选择器 / 输入框表情） | `useHoverCard` + `utils/hoverCard.placeCard/cardStyle` + `utils/popupPosition`（**188 行**）；`MessageItem` / `MessageReceipt` / `MessageReactionBar` / `MessageComposer` 各自手写 Teleport、fixed 坐标、外点/Esc/滚动收起 | Reka `HoverCardRoot/Trigger/Portal/Content`（回应名单）+ `PopoverRoot/Trigger/Portal/Content`（其余三处） | **B（已落地 2026-10-19）** | `MessageReactionBar.vue`、`MessageReceipt.vue`、`MessageItem.vue`、`MessageComposer.vue`、`EmojiPicker.vue` | 定位/翻转/夹边/悬停宽限/外点/Esc 交给 floating-ui + DismissableLayer；`EmojiPicker` 去掉自绘 `absolute` 与 `placement`，面板由 Portal 挂 body（不再被输入卡片圆角/overflow 裁切）。`--only=reaction,roster` **62/62**、`--only=inputpanel` **22/22**（含"选完表情焦点回编辑器"）、`--only=search,overlay,toast,select,ctxmenu` **81/81**、`--only=touchroster` **6/6**；全量复跑见报告 §6.13。删除 3 个自研摆位文件（188 行）、2 条旧护栏（126 行）与 250 行过时测试；生产代码净 **−386 行** |
| 输入框里「回车 = 提交」的键盘行为 | 家已存在（`composables/useImeEnterGuard`），但 12 处可编辑绑定只有 3 处接上 | 自研判定 + 组合（`utils/ime` 三条互补判据；库里没有对应物） | 组合替换（家不变，加一个 `enter(fn)` 出口） | 9 处接线 + 删掉 ProfileSection 那份手写 `e.key === "Enter"` | 判据 53（按起始标签解析，全仓 0 例外）+ 探针 `--only=imecommit` 5/5；四发变异分别红 3 / 2 / 4 格与判据 1 条；真机 IME NOT RUN |

| 页面路由 / 层级返回 | `ResponsiveLayout` 的 `navState` 组件内 ref + `mobileView` store + 页面级 `useBackLayer`；无 URL | `vue-router@5.4.0`（MIT；peer 硬要求只有 `vue ^3.5.34`，vite/pinia/colada/compiler-sfc 均为 optional） | **A（已落地，2026-10-22）** | `src/router/main.ts`、`src/router/settings.ts`、`src/entries/main.ts`、`src/entries/settings.ts`、`src/layouts/ResponsiveLayout.vue`、`src/components/SettingsWindow.vue` | 主窗口 14 条命名路由 + 设置窗口 `#/settings/:key`；`navState` / `mobileView` 改为路由派生态；页面级返回层退役、浮层 `useBackLayer` 保留；Chromium 实测前进/返回、覆盖层、弹窗与路由共存；Tauri WebView 真机 NOT RUN。详见 `docs/architecture/routing-and-navigation.md` |

## 2. 本轮评估、尚未迁移

| 能力 | 原实现 / 调用点 | 候选 | 判定 | 证据 / 原因 | 重评估条件 |
|---|---|---|---|---|---|
| Tooltip（图标按钮悬停提示） | 原生 `title` 属性 **274 处**（现算）；无自绘 tooltip | Reka `TooltipProvider/Root/Trigger/Content` | C（当前保留） | `title` 是平台原生反馈（桌面悬停、读屏命名、触控长按由系统给）；引入 Reka 需要全局 Provider、延迟/碰撞与每颗按钮改触发结构，且移动端无悬停语义。逐处替换 274 个 `title` 会改变现有原生反馈，收益未证 | 出现富内容提示（快捷键组合/多行说明/触控长按引导）的真实需求时，只在需要的按钮上接 Reka Tooltip |
| Tabs / Accordion / Collapsible | 全 `src` 无自研调用面（`role="tab"/"tablist"` 0 处） | Reka 对应原语 | D（当前不引入） | 界面没有这些通用控件；为"将来可能用"引入只增加依赖面与代码面 | 出现设置分页或多段折叠的真实需求时，直接用 Reka 原语实现 |
| Checkbox / Radio | `type="checkbox"/"radio"` 0 处；设置开关已由 Reka Switch 承担 | Reka `Checkbox/RadioGroup` | D（当前不引入） | 没有多选/单选表单调用面 | 出现多选/单选表单时 |
| 命令面板 / 快捷搜索 | `ChatSearchDialog` 是产品搜索（SQLite 命中 + 发送人/日期筛选），不是通用命令注册表 | Reka 2.11.0 无 `CommandRoot` 导出（现查 `require('reka-ui')`） | C（保留业务核心） | 搜索语义、命中分组、跳转与消息定位都是业务；通用 command 库无法接 SQLite 与消息协议 | 若将来出现"全局命令/动作注册表"的真实需求，再评估 cmdk 类实现 |
| 消息列表虚拟化 | `VirtualList.vue`（525 行；前缀和 + 二分 + 实测高度覆盖 + prepend 锚定 + pending jump + pinned 贴底） | `@tanstack/vue-virtual` | C（当前保留） | P7 实测：20k 条 `calib()` 1.3 ms/遍，滚动 p95 17.5/16.8 ms、`longFramesOver50ms=0`；产品缓存上界 `PAGE_SIZE(100) × MAX_PAGES(10) = 1000 条/会话`。2026-10-19 新增 `--only=vlist` **12/12**：虚拟化、live region、`scrollToIndex` 贴顶、`nearBottom` 两态、prepend 锚定、触顶 `loadMore` 均真实通过 ⇒ 在 1000 条上界下没有迁移收益证据；替换会重写 0.5px 白缝、prepend 不跳动、未读跳转二次落定这些已被真机/守恒判据钉住的行为 | 若产品上界被抬高到 1 万条/会话，或需要横向虚拟化/多列，再试迁移 |
| 日志长列表 | 已迁：`LogViewer.vue` 的 `useVirtualizer` | `@tanstack/vue-virtual` | **B（已落地）** | 见第 1 节；真实业务页（日志窗口）已切换，不是空封装 | 真机长日志滚动读数尚未采集（NOT RUN） |
| 消息/会话/任务的异步状态 | Pinia stores + `StaleGuard` + 单飞 + 事件驱动更新（`useChatStore.ensureGroupTodoRows` 等） | TanStack Query | C（当前保留） | 数据源是 SQLite + 事件流；离线队列、可靠投递、加密传输、事务语义不能用普通查询缓存替代。存储层迁移会把"谁拥有事实"变成两份。**面板已另起试点**（纯读：群文件 / 共享目录 / 搜索聊天记录 / 诊断快照；读+写：外部链接，见第 1 节与 §6.98），两者边界：Query 不管消息状态机 | 远端目录、诊断快照与外部链接已各自接入（见 §6.90、§6.98 与下面的行）；再出现纯读、可过期、可后台刷新的独立面板时按群文件模式逐面板迁移；会话/消息主链不迁 |
| 表单 | 原生 `<form>`/事件 + i18n 校验；`TodoPickField` 等 | TanStack Form / vee-validate | D（当前） | 现有表单纯 UI 状态 + 少量校验；没有复杂字段数组/异步校验的调用点。引入 Form 只增加依赖与心智，不减少业务代码 | 出现多步、动态字段数组、跨字段异步校验的真实表单时 |
| 图标 | `lucide-vue-next` + `components/ui/icons.ts` 统一入口；4 个文件仍有内联 SVG（平台/产品专属） | Lucide | A（已统一） | 旧的前端正则曾跨 import 吞行造成 12 处假绿，P3 已修；内联 SVG 逐处判定为平台/产品图形保留 | 新增常规图标一律走 `components/ui/icons.ts` |
| Toast/通知 | `useAppStore` 手写数组 + 每条 `setTimeout`（无上限、无去重） | Reka `ToastProvider/Viewport/Root` + `createToastManager`（Tauri notification 仍是系统通知通道） | **B（已落地）** | `ToastHud.vue`、`ToastList.vue`、`utils/toastManager.ts`、`useAppStore.ts` | 同一 kind+文案按 id 去重；`limit=3`（超出 `data-limited`+`inert` 且隐藏）；错误 6s / 其余 3s；保留配色/图标/安全区；Esc 只在焦点位于 toast 时放行。`--only=toast` 7/7；摘 `limit` ⇒ 3 红、摘 Esc 守卫 ⇒ 2 红 |
| 图片/媒体查看 | 自研 `ImageLightbox.vue` + `useImagePreview` 缓存 | 自研（焦点语义已拆出，见上一行） | C | 与消息 msg_id/cid、预览缓存、保存、缩放/滑动绑定；通用 lightbox 库无法接这些业务语义。焦点陷阱/归还已交 Reka `FocusScope`，剩下的自研部分只覆盖业务手势与取字节 | 若要视频/多格式，先评估 media viewer 的 API 是否能接 msg_id/cid |
| Markdown/代码高亮 | 无 Markdown 渲染；代码块用 `highlight.js` 子集 | `markdown-it` + `dompurify` | C（当前保留） | 消息只渲染纯文本 + 链接/提及；没有"把对端 Markdown/HTML 渲染成 DOM"的业务。代码块已用 hljs 的转义输出；引入 Markdown 会新增 HTML 允许策略与过滤链，收益未证 | 出现 Markdown 消息/富文本编辑的真实需求时，`markdown-it` + DOMPurify 一起接 |
| HTML 过滤 / DOMPurify | 全仓 4 处 `v-html`：搜索高亮、日志行、代码块 | `dompurify` | C（当前不引入） | 4 处的输入都由构造保证已转义：`highlightText` 先匹配后逐段 `escHtml`、日志行复用同一函数、代码块用 hljs 输出或 `escapeHtml`；`highlight.test.ts` 已有 `<script>` / `onerror` 用例；新增 `findVHtmlSinks` / `V_HTML_ALLOWED` 允许清单判据 + 真实组件正控。没有"渲染对端原文 HTML"的路径 | 出现富文本/Markdown/允许 HTML 的消息渲染时，先定允许策略再接 DOMPurify |
| 剪贴板 | 浏览器 `navigator.clipboard` + Tauri 命令回退 | Tauri clipboard 插件 | D | 现有路径已带权限/回退；新增插件不减少代码 | 若移动端复制失败有真实读数 |
| 文件选择/保存 | 已迁保存链：`save_media_as` 源路径直拷；`save_data_file` 仅作回退 | Rust 源路径拷贝（复用 `copy_file`）+ 已装的 `@tauri-apps/plugin-dialog 2.2.0` 的 `save()` | **B（保存链 + 日志诊断包已落地）** | 事实校正：**预览链已经走原始字节**（`read_file_preview` 返回 `tauri::ipc::Response`，前端收 `ArrayBuffer`），不是 base64；保存链现在优先让后端按 `msg_id/cid` 直接拷，源不存在才回退 base64。Rust `tauri-plugin-fs 2.5.2` 已注册但前端包未装（本轮不需要）。10-20 同一个 `save()` 出口接上第二个调用点：`LogViewer.vue` 的「导出诊断包」把落点交给它（`saveDestinationOf` 归一化、取消含 Android 的 reject 不弹红条），后端 `export_diagnostics_bundle` 收 `destination` —— 传空串会被判错，Rust 不替前端决定写到哪；`api/index.ts` 补 `getLogLocations` / `exportDiagnosticsBundle`，`events.test.ts` 的 `DEAD_COMMANDS` 里这两条挂账**删除**（判据在真实 `invoke` 上转红 ⇒ 接上而不是放宽） | 桌面/iOS 路径已过类型检查；Android `content://` 与 raw IPC 仍需真机（NOT RUN）；release 里真按一次两颗按钮 + 导出物 `grep -c "$HOME"`、`grep -c "192\.168\."` 均为 0 —— **NOT RUN（只有负责人能做）** |

## 3. 依赖与删除

- 删除：`@headlessui/vue`（唯一消费者已全部迁到 Reka）。
- 新增：`vue-router@5.4.0`（MIT；硬 peer 只有 `vue ^3.5.34`；`vite` / `pinia` / `@pinia/colada` / `@vue/compiler-sfc` 都是 optional peer）。使用面 = 主窗口 14 条命名路由 + 设置窗口 10 个分区；vendor gzip 从 104.92 → 114.15（同机 `npm run build`，2026-10-22）。
- 升级：`pinia@^2.2.6` → `^3.0.4`（peer 仅 `vue ^3.5.11` + `typescript >=4.5`；4 个 store 无破坏，`npm test` 全绿）。
- 升级：`vite@^6.0.3` → `^7.3.7`、`@vitejs/plugin-vue@^5.2.1` → `^6.0.10`（Vite 7 必须配 plugin-vue 6；`gosslan:inline-boot` 插件行为不变，build 退码 0）。
- 新增：`@pinia/colada@^1.4.8`（MIT；**只装不接线**，产物无增量）。与 `@tanstack/vue-query` 职责重叠，迁移单独立项；在此之前 vue-query 保持唯一数据层。
- 未采纳：`motion-v@2.8.0`（MIT）。共享布局药丸实测 vendor gzip 114.15 → 160.63（+46.48 KB），CSS `--gosslan-ease-spring` 已覆盖同类反馈 ⇒ 移除，不进 `package.json`。详见 `docs/architecture/frontend-performance-antipatterns.md` §5。
- 新增：`reka-ui@^2.11.0`（MIT；peer Vue >= 3.4；本机安装版本 2.11.0）。
- 新增：`@tanstack/vue-virtual@^3.13.47`（MIT；peer Vue ^2.7 || ^3；本机安装 3.13.47）。
- 新增：`@tanstack/vue-query@^5.104.4`（MIT；peer Vue ^2.6 || ^3.x；本机安装 5.104.4，含 query-core 5.104.4）。使用面 = **5 个面板**（4 个纯读：`GroupFilesPanel` 群文件 / `ShareDirectory` 共享目录 / `ChatSearchDialog` 搜索聊天记录 / `DevDiagPanel` 诊断快照；外加 `LinksList` **读+写**，写侧 1 处 `useMutation`。现算：`grep -rl useQuery src/components` = 5、`grep -rl useMutation src/components` = 1）与每窗口各一份 QueryClient（`boot.ts` 装 `VueQueryPlugin`）。
- 新增：`@vueuse/core@^14.4.0`（MIT；Vue 3；本机安装 14.4.0）。使用面四格：`useClipboard({ legacy: true })`
  （复制链去掉手写 `execCommand` 回退）、`useEventListener`（根组件四个窗口级监听，§6.43）、
  `useDebounceFn`（设置页高频写入的去抖落库 + 搜索框输入防抖，§6.44）、
  `refDebounced`（过滤输入框的"延迟镜像"，§6.44）。**自研的 `debounce` 与 `useDeferredRef` 已删除**。
- 新增：`zod@^4.6.7`（MIT）。只使用 `zod/mini`：表单字段 + 两个 IPC 读边界的形状校验。
- 现存生产依赖：`@tanstack/vue-virtual`、`@tanstack/vue-query`、`@tauri-apps/api`、`@tauri-apps/plugin-dialog`、`@tauri-apps/plugin-notification`、`@tauri-apps/plugin-opener`、`@vueuse/core`、`dayjs`、`highlight.js`、`lucide-vue-next`、`pinia`、`reka-ui`、`vue`。
- 已确认**不在** `package.json`：`vue-easy-lightbox`、`clsx`、`tailwind-merge`（上一轮清理后无残留）。

## 4. 验证口径（每次批次都现算）

| 层 | 命令 | 本轮读数 |
|---|---|---|
| 单测 | `npm test` | **1053 / 1053，0 失败**（2026-10-19；本轮新增 3 条源码判据（角标单一出口 / 错误出口统一 / 全局禁拖）与 `extBadgeLabel` 4 条行为断言；条数以命令自打印为准） |
| 构建 | `npm run build` | 退码 0；`main` **308.05 kB / gzip 93.00**；vendor **344.39 kB / gzip 103.34**（Reka HoverCard/Popover 进 vendor；main raw 较 5.0.20 +0.49 / gzip −0.35）。⚠️ §6.31 那批只加了三条词典串与 `dayjs/locale/zh-cn.js`，**未重算产物体积** |
| Rust | `cargo check --lib` / `cargo fmt --check` | 均退出 0；helpers 过滤用例 8/8 |
| UI 运行时 | `node scripts/check-ui-runtime.mjs` | **全量 396/396 条判据绿、退出码 0**（同日两轮各在 overlay 段之后遇到一次 CDP eval 45s 未回包（255/256、254/256）：单独跑挂起点那两段 `--only=imgskel` 两次 **7/7** ⇒ 判为并行 cargo 抢 CPU 下的冷编译 eval 超预算（另有残留 probe Chrome/profile 让端口检查当场判红），两条都是量具/环境账，不是产品红；清干净后全量 396/396）。§6.31 新增 **locale 7/7**（真 Chrome 里切语言，读消息时间分割线的文本：中→英→星期名→切回中文）。本批新增 **favorites 8/8**、**links 5/5**、**fontsel 4/4**（Reka Select 空串默认档修复）、**tasksrt 15/15**、**inputpanel 23/23**（鼠标点「发送」按钮）、**reaction 20/20**（回执/回应不抢命中区）、**logs 5/5**（独立窗 + 390 宽移动端）、**settingsmobile 4/4**、**tasksmobile 2/2**、**files 10/10**（含 390 宽移动端 2 条）、**composermobile 2/2** 与 **search 18/18**（含 390 宽移动端 2 条）；此前新增 vlist 12/12、touchroster 6/6 仍在同一全量内。其余段：select 6/6、toast 6/6、share 6/6、lightbox 7/7、segmented 8/8、slider 8/8、switch 4/4、ctxmenu 12/12 等均在本次全量内 |
| 快速/本地门禁 | `npm run verify:local` / `npm run verify` | 本地层 **22/22、退出码 0、532.0s**（耗时是并行会话同时用同一个 `src-tauri/target` 跑 Rust 护栏抢 cargo 锁所致，无抢锁时同层 75.7s；唯一跳过「护栏非空转」，按用户策略留给发版/CI）。§6.28 那一批（只动 import 与判据）跑的是快速层：**17/17、46.1s、退出码 0**；§6.31 时间文案那一批：**17/17、19.4s、退出码 0**（暖 target） |
| 护栏非空转（前端族） | `python3 scripts/verify-guards.py --only frontend` | 首跑 **85/86**，唯一失败是 ActionSheet 注入锚点指到「取消」按钮；改成面板开标签缩进后单条 **1/1、退出 0**，其余 85 条同树通过。另修复 Reka 接线判据的空串存在性断言（`--only 已读名单` 1/1）。§6.26 与 §6.28 两批之后又各整族复跑一次：**86/86、退出 0**（第一次耗时 39 分钟，被并行会话冷编 target 拖慢）。**按用户 2026-10-19 口径：本地批次不再起整族**，判绿用 `npm test` + 快速层 + 名片段单点变异证明；整族与全部用例（§6.30 恢复两条被误删的 SelfAvatar 变异证明后 **231→233**；§6.31 又加一条时间文案注入用例 → **234**；`verify-guards.py --list` 现算头部读数）归发版前/远端 CI |
| 真实桌面（Tauri） | 隔离 HOME 的 `tauri dev` | **主窗/设置窗/日志窗已渲染**；日志「合并重复」点击生效（71→74 条、×2 消失）；设置页 Tab/Enter 键盘导航可用；Reka Select 在 WKWebView 内展开并用 ↓+Enter 选中（触发器文案更新），Reka Slider 点击后标签 14px→16px；**自聊输入框表情 Popover、自聊消息发送、群消息回应 Popover 与回应名单 HoverCard（隔离库里种群+消息+reaction，不接对端）均已验**；**已读名单 Popover 已在真实 WKWebView 里用系统无障碍 `AXPress` 点开并收起**（浅色/深色两档都正常，Esc 收起后焦点回到触发器并显出 `:focus-visible`；深色「我的气泡」像素实测 `#513f99`/luma 79，设计目标 74 ⇒ 暗色派生生效，不是缺陷）；通讯录/收藏/链接三页空态同轮截图复核；取证时发现仓内 `scripts/ax-tree.mjs` 不认 `AXPopUpButton` ⇒ **Reka 全部浮层入口在真窗口取证路上不可见**，已把该角色加进两处可点集合（报告 §6.25）；**桌面窄窗 390×768 下的移动端布局已验**（单列列表 + 底部 TabBar、`AXPress` 进聊天整页推入并显出「返回」、返回后 TabBar 复位；起实例前先把隔离库 `lan_enabled` 置 0，不参与局域网、不扰动并行 E2E）。见报告 §6.22、§6.25、§6.27；Windows/Android/iOS 与 E2E **NOT RUN**（需用户授权与真机） |

## 5. 明确未做

- Reka 的 Tooltip/Checkbox/Radio/Tabs/Accordion/Collapsible/Command 尚未迁移；这些当前没有调用面。
  锚定浮层已全部迁 Reka（回应名单 HoverCard，其余三处 Popover）；自研 `useHoverCard` /
  `utils/hoverCard` / `utils/popupPosition` 已删除，见第 1 节。`Select` 已落地。
- 输入去抖与"延迟镜像"已从自研并到 `@vueuse/core`（`useDebounceFn` / `refDebounced`）：
  `utils/defer.ts` 的 `Debounced` + `debounce` 与整册 `composables/useDeferredRef.ts` 已删除，
  `defer.ts` 只剩 `INPUT_DEFER_MS` 与纯函数 `shouldRunThrottled`（要能被 `node --test` 直测、
  且 `useThrottleFn` 是绑作用域的节流器，给不了"拿两个时间戳判该不该跑"这个形状）⇒ 那半格**保留自研**。见报告 §6.44。
- 仍然保留的自研通用实现只剩：消息列表 `VirtualList`（有 P7 实测与业务锚定语义，见第 2 节）、
  浮层全局互斥 `popupRegistry`/`useExclusivePopup`（Reka 只管栈内）、长按 `longPress` 与轻触反馈（移动端实测参数）；
  EmojiPicker 的键盘二维网格仍按业务语义保留（库没有直接对应的二维网格原语）。
- 首屏脚本 `src/boot/theme-boot.js` 是外观/语言解析的**第二份实现**，判**保留自研**：它由 vite 插件内联成裸脚本、
  必须早于 bundle 执行，结构上 import 不到模块 ⇒ 复制是平台约束。它缺的不是库，是**跨边界判据**：
  §6.46 已把"脚本里的 4 个裸字面量键 ↔ TS 侧 11 个具名 `*_KEY` 常量"做成两边现算比对，
  并把生产码里剩下的裸字面量键收成具名常量（现算 0 处）。
- **本地存储读写这一轴整条判「保留自研」，且已数完**（§6.69）：生产码 21 处 / 5 本（`useAppStore` 14、
  `theme-boot.js` 5、`useChatStore` 2、`ResponsiveLayout` 2、`i18n/index` 2），只有 **1 处**走 JSON ⇒
  抽一个 `utils/storage.ts` 是"给三个不同形状造一个通用口"；而 VueUse `useStorage`（已装）返回的是**新 ref**，
  这些值今天各自已有权威宿主（store 字段），接进去＝多造一个状态源，且它写失败与 `copy()` 同一族静默。
  真正重复的那一维（键名跨 Rust/前端边界）已由 §6.46 的判据守着 ⇒ **不换、不并、也别再重开这把尺子**。
- 自研 `ContextMenu.vue`、四个业务右键菜单、`ChatSearchDialog` 两个筛选菜单与其余四处锚定菜单已全部迁到 Reka DropdownMenu；全 `src/components/**/*.vue` 不再出现手写 `role="menuitem"`。
- 移动端「整屏覆盖壳」这一族**不是库替换问题，是自家原语没被复用**：唯一的家 = 自研 `MobilePageFrame`（overlay / inline 两种形态 + 统一返回键），
  ㊼ 现数三段形状齐全的生产码 **2 份**（家 1 + `FavoritePanel.vue:691` 手抄的 1 份）。档位判 **保留自研**
  —— §6.75 把 §6.70 当时写的「暂缓」改判了：暂缓暗示"补上基线读数就迁"，而这里的堵点是**形状**。那一格是**同一个元素同时 serve 两支布局**
  （移动端 overlay / 桌面内嵌右栏）：`overlay` 写 `fixed inset-0`，桌面那支用它会被摘出流并盖住左列；`inline` 根类写 `flex h-full`
  而**没有 `flex-1`**，而这格的父亲（`FavoritePanel.vue:582`）是 flex-**row**，`flex-1` 在那里管的是**宽度** ⇒ 两个 mode 各只盖住一支。
  只迁移动端那一半也得把这个元素拆成两支 ⇒ 详情正文 L688–L881（实测 194 行 / 8 个处理函数）要么抄第二份、要么抽成新组件（§七.6 禁的那种"为通用性加层级"）；
  底部留白还差一个量（框架 `.safe-bottom` = `env(safe-area-inset-bottom)`，收藏页 = `max(env(), 0.75rem)` ⇒ `env()` 取 0 的端上 12px 会静默变 0）。
  已用判据 ㊼ 钉成棘轮：抄本只许变小、新抄即点名，且这三条判定现在写进 ㊼ 的注释里（不许当默认豁免读）。见报告 §6.70 与 §6.75。
- TanStack Query 已在五个面板（群文件、共享目录、搜索聊天记录、诊断快照、外部链接）落地；会话/消息/群任务主链仍是 Pinia + SQLite + 事件流，Reason 见第 2 节。
  TanStack Table/Router/Form 未引入（当前无对应调用面）；TanStack Virtual 只在日志页试点，消息列表仍保留自研实现。
- 同窗口事件已从 `window.dispatchEvent` 迁到 `mitt`（类型安全事件表 + 解绑协议）；跨窗口/Rust 继续走
  `@tauri-apps/api/event`，两者边界见第 1 节与报告 §6.6。
- DOM 监听这一族：**该交给库的那一半已经交出去了**（§6.72 + §6.73 两批共 12 处），剩下的手写各有点名理由，边界写在判据里而不是靠口头。
  边界两条 = **组件作用域 + 挂载即终身（无条件摘挂）**。⚠️ §6.72 当时还写了第三条"无 capture 才迁"，**那条已被读库的实现推翻**
  （`useEventListener` 把同一个 options 同时喂给注册与注销 ⇒ 两侧旗标由构造保证一致，而手写漏摘一侧正是这条轴上抓到的真缺陷）
  ⇒ capture 站点是**最该**交出去的那一类。已迁的 12 处：`ChatWindow` 多选态 Esc、`SettingsWindow` Esc、`ImageLightbox` 键盘、
  `ConversationList` 点外部收菜单、`useShortcuts`（以上 §6.72，真删 10 条注册/注销 + 4 个 import 名），
  `TitleBar` 窗口快捷键、`GroupTasksBoard` 的 scroll(capture)+resize、`LogViewer` visibilitychange、`VirtualList` resize、
  `MessageComposer` 的 click+selectionchange（以上 §6.73，真删 14 条语句 + 2 个 import 名）。
  现读（判据 ㊽ 自己打印）：**走库 16 处 / 手写 15 处**。留下的手写只剩两族：条件性摘挂的 4 处
  （`GroupTasksBoard` 粘贴 —— 它与 `subscribeImageDrop()` 那只 `InitScope` 在同一只 `watch` 里成对；`MessageItem` 的
  touchend/touchcancel/selectionchange）、以及没有组件作用域的 11 处（store 与 boot 级 + `i18n`）；
  3 处整窗一次性接线（带理由登记在名单里，名单自带"今天必须还在绑定"的正控）；条件性摘挂那一族**才是留下的原因**，
  而"解绑与其它清理同在一个卸载块"这条理由**已撤回**（它和 §6.72 自己对 `ChatWindow` 的做法互相矛盾）。
  ⚠️ 分母口径也换了一次：原先钉"手写 ≥ 20"，每迁一次都要手改下限 ⇒ 量具跟着被量的东西走；改成钉**两个家加起来 ≥ 28**
  （手写 + 走库 = 31 是守恒量：迁移只是把一条 `addEventListener` 换成一条 `useEventListener`），两家的存在下限退成兜底。
  非空转两发各红各的家（"手写 15 + 走库 0" / "手写 0 + 走库 16"），复原后重跑退 0。
  ★ §6.74 补上这条轴上**第一条运行时间断言**（点开 @ 名单 → 真点卡片之外 → 名单收起而草稿里那个 `@` 还在），
  归因用单点变异钉死：摘掉那条 `useEventListener` 的 click 绑定 ⇒ 探针当场红、复原即绿。剩下 6 处仍只有静态证据。
  ⚠️ 这一轴原本挂着**两条**判据（旧那条只扫 `.vue` 且分母硬编码），迁移一次就得同时改两处 ⇒ 已并成 ㊽ 一条，
  取代关系写在原地注释里（㊽ 覆盖 `.vue`+`.ts`、多 capture 逐侧一致、分母与反控各一条）—— 不是放宽。见报告 §6.71–§6.72。
  ⚠️ **迁走的 5 处里只有 1 处拿到运行时凭据**：探针 `runLightbox` 挂的是真 `ImageLightbox.vue` 并真按 `Escape`
  （该组件唯一的 Escape 出口就是已迁的 `onKey`）；`ChatWindow` 多选态 Esc、`SettingsWindow` Esc、好友菜单点外部、
  `useShortcuts` 四处**探针从没按过那一下** ⇒ 判据只证"接线形状对"，交互达标仍要真机（报告 §6.72 有逐站点表）。
- i18n 已从 150 行自研引擎迁到 `vue-i18n`（1003×2 条消息全量编译）；缺参保留 `{name}` 的产品语义由
  `t()` 适配，体积代价 vendor gzip +18.84。
- DOMPurify 当前不引入：4 处 `v-html` 全部构造即转义，并由 `findVHtmlSinks`/`V_HTML_ALLOWED`
  允许清单与真实组件正控守着；出现富文本/Markdown/允许 HTML 的渲染需求时再接。
- P6 的**预览链**已走原始字节，但 Android/iOS 的真机行为未验证；保存链已去 base64，回退路径仍保留。
- 全量 UI 探针**最近一次实跑读数 448/448 条判据绿、退码 0**（2026-10-19，§6.72 收尾那次；条数会随新判据涨，
  复跑 = `npm run test:ui-runtime`，别手抄）；
  E2E、Windows/Android/iOS 真机、长日志实机滚动读数仍未跑（NOT RUN）。

- `useMediaQuery`（已装的 @vueuse/core 14.4.0）**不接**（见 §6.83）：读 dist 实现而不是文档 —— 它只把 `change`
  接成布尔 `ComputedRef`，没有 resize 兜底也没有首帧后重判（安卓首帧读到 980px 那一档正是靠这两条兜），
  且内部 `useEventListener` 只在有活动 effectScope 时自动摘，而 store 的 `init()` 可重跑、靠 `appInitScope`
  手工配对 ⇒ 接进去等于每重跑多一份永不摘的监听。断点那个数改由 `utils/platform.ts` 独家持有，
  并与库自己的默认主题对账（`createRequire` 读 `tailwindcss/defaultTheme.js` 的 `screens.md`，判据里不手抄）。
  复跑 = `node --test --experimental-strip-types src/utils/platform.test.ts`。
