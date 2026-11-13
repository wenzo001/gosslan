# Reka UI 使用情况审计与最佳实践方案

审计日期：2026-11-13  
审计范围：Vue 前端中与 Reka UI 可覆盖的交互组件、现有替换矩阵和相关设计约束。  
变更边界：本次只写文档，未修改程序代码，也未运行测试或构建。

## 结论摘要

项目已把 Reka UI 纳入主要交互基础设施，覆盖对话框、菜单、弹出层、选择器、分段单选、Toast 和焦点/定位等行为。多个看似“自绘”的菜单实际已用 Reka 做键盘、焦点、关闭和定位，应用只负责 Gosslan 样式及产品语义。

未发现需要立即全量重写的自研组件。当前应优先处理的是**覆盖审计与可访问性闭环**，而不是为了“所有控件看起来都来自库”而替换业务表现层：

1. 把 Reka 的基础行为继续封装在公共组件和薄适配器中，业务代码不得再自写通用菜单、模态层和浮层定位。
2. 对仍由原生日期控件承担的场景继续保留现状；Reka Date Picker / Calendar 当前为 Alpha，且日期能力引入 `@internationalized/date`，需单独评估稳定性、平台体验和时区语义后再立项。
3. 聊天搜索结果已有上下方向键移动高亮、回车打开；保留这段与搜索框/输入法语义耦合的业务键盘处理，不要为了使用组件库迁成 DropdownMenu。
4. 用现有 `frontend-inventory.md` 作为替换决策主矩阵；本审计用于更新后续实施顺序，不另起一套组件计数口径。

## 证据与核对范围

- `package.json` 声明 `reka-ui`；锁文件中存在 `@internationalized/date` 的传递依赖，但未见它作为项目直接依赖声明。
- `src/components/ContextMenu.vue` 用 Reka `DropdownMenuRoot/Content/Portal` 承担虚拟锚点菜单、键盘导航、外点/Esc 关闭和焦点管理；业务菜单通过 Reka `DropdownMenuItem` 组合。
- `src/components/ui/SettingsSelect.vue` 是 Reka Select 薄封装，多个设置页共用。
- `src/components/BaseModal.vue` 是 Reka Dialog 公共壳；`ActionSheet.vue` 复用它。
- `src/components/TodoPickField.vue` 与 `src/components/CodeLangMenu.vue` 已用 Reka DropdownMenu。虽然外观由项目样式绘制，它们不属于无库自研菜单。
- `src/components/ui/SegmentedControl.vue` 使用 Reka RadioGroup；`src/components/ToastHud.vue` / `ToastList.vue` / `src/utils/toastManager.ts` 使用 Reka Toast 能力。
- `src/components/ui/AppDateField.vue` 当前封装原生 `input[type=date]`，注释记录了平台拾取器与不新增日期依赖的取舍。该取舍形成于 Reka 日期组件尚未纳入决策时，需按当前官方组件成熟度复核，但不能直接视为实现缺陷。
- `docs/architecture/frontend-inventory.md` 第 2 节已有 Reka 替换决策矩阵；其“每文件依赖”区块由脚本生成，行数和覆盖数量以现算结果为准。

## 组件采用矩阵

| 能力 / 当前落点 | 当前判断 | 建议 | 优先级 |
|---|---|---|---|
| Dialog：`BaseModal.vue`、`ConfirmDialog.vue` 及各业务弹窗 | 已采用 Reka Dialog；业务层决定内容和动作 | 保持现有公共壳；新增模态必须复用 BaseModal 或经评审的同一 Reka Dialog 适配器，避免各自实现焦点陷阱、遮罩和关闭语义 | 规则持续执行 |
| ActionSheet：`ActionSheet.vue` | Reka Dialog 壳 + 产品自有移动端动作面板 | 保留组合式设计。动作面板布局和移动返回栈是产品体验，不重复实现模态底层 | 保留 |
| Select：`SettingsSelect.vue` | Reka Select 薄封装，设置场景复用 | 保持单一视觉入口；普通单选表单优先使用该封装，不新增原生 select 或第二套自绘选择器 | P1 防分叉 |
| Dropdown / Context Menu：`ContextMenu.vue`、`ConversationContextMenu.vue`、`FriendContextMenu.vue`、`MessageContextMenu.vue`、`FavoritePanel.vue`、`GroupMemberPanel.vue` | 已由 Reka DropdownMenu 提供行为；业务 wrapper 提供菜单语义和统一 token | 保持 `ContextMenu.vue` 为统一壳，所有选项用 Reka Menu Item；禁止复刻定位、菜单焦点循环、Esc/外点关闭。不要只因 Reka 另有 ContextMenu 原语就机械替换：目前虚拟锚点、全局浮层互斥、移动长按/文字选择让位属于本项目约束 | 规则持续执行 |
| Popover / HoverCard：消息回应、回执、输入辅助菜单等 | 已采用 Reka 原语；业务保留触发条件和内容 | 保持浮层互斥注册表与业务状态归本项目，定位和关闭由 Reka 承担；遵守 Teleport/fixed 和边界 token 约束 | 保留 |
| TodoPickField、CodeLangMenu、ChatSearchDialog 的筛选菜单、NavRail 更多菜单 | 源码已实际使用 Reka DropdownMenu，不应在盘点中误报为“尚未换” | 维持 DropdownMenu 语义。代码语言菜单容器边界与窄窗行为属于适配层，保留必要测量逻辑；不以追求零自定义代码为目标 | 无新增迁移 |
| SegmentedControl / 设置开关 | SegmentedControl 使用 Reka RadioGroup；开关封装使用 Reka Switch | 继续从公共组件暴露产品 API，确保可访问名称、键盘行为和尺寸档统一 | 无新增迁移 |
| Toast | Reka Toast Manager/Provider 承担计时、堆叠与 live region；业务层负责文案、图标与主题 | 保持 Toast 统一出口。不要拦截 Esc 的默认传播，否则会影响同一层级其它浮层关闭 | 无新增迁移 |
| EmojiPicker.vue | 业务网格和常用表情策略自有；有明确矩阵方向键行为 | 保留网格实现；它不是菜单或列表选择器，直接换 DropdownMenu 会改变二维方向导航与内容结构 | 保留自研 |
| AppDateField / TodoAttrDateField | 原生日期输入 + 项目外观适配；无 Reka 日期原语调用 | 暂时保留原生拾取器。另开评估项：Reka Calendar/DatePicker 是 Alpha，官方要求日期能力依赖 `@internationalized/date`。若评估后采用，先验证跨时区日期稳定性、Android/iOS WebView、键盘导航、深色主题、清空/最小日期等契约，再替换；不要仅为统一样式引入日历逻辑 | P2 评估 |
| ChatSearchDialog 搜索结果 | 当前输入框已处理 ArrowUp/ArrowDown、Enter；`stepHit` 更新高亮并滚动到可见区，`openHit` 统一处理键盘与鼠标打开 | 保持现有业务键盘行为。若后续检查读屏语义或焦点转移发现真实缺口，再评估 Listbox/Combobox；不要用 DropdownMenu 模拟搜索结果，也不要把已实现的方向键登记成未完成项 | 已有实现，暂不迁移 |
| MessageComposer 自定义输入、消息气泡、虚拟消息列表、图片灯箱手势、任务卡片 | 业务语义/高性能或手势驱动，不属于基础控件替换 | 只在内部确有弹层/焦点/选择语义时组合 Reka primitive；不要把消息列表、复杂输入状态、FLIP/缩放手势整体改造成库组件 | 保留自研业务层 |

## 与产品目标的匹配情况

### 符合目标的设计

- **外观统一有明确单一事实源。** Reka 负责无样式行为，Gosslan `.gosslan-menu` 和语义 CSS token 负责视觉；`SettingsSelect`、`ContextMenu` 等共享 wrapper 能统一色彩、圆角、间距和焦点样式。
- **避免重复实现交互内核。** 菜单和对话框的键盘导航、焦点管理、边界避让、外点/Esc 关闭交给 Reka，业务组件保留动作集合和权限规则，分层与“减少自己实现”目标一致。
- **保留产品独有约束。** 消息列表业务锚定、虚拟化、长按与系统选字冲突、全局浮层互斥都不是基础组件库可以直接替代的通用控件能力。

### 需要治理的风险

1. **文档认知容易滞后。** 前端矩阵跨度大且保留了大量历史批次叙述；新增审计应只追加现状结论并明确“实际依赖以源码为准”，避免再次把 `TodoPickField`、`CodeLangMenu` 等误判为自绘行为控件。
2. **“组件采用”容易与“样式采用”混淆。** Reka 是 headless primitive，不会自动统一颜色/圆角。样式统一仍取决于公共 wrapper、token 与设计护栏，不应期待直接 import 就获得项目视觉语言。
3. **日期方案可能因“库优先”过度迁移。** 目前官方 Date Picker/Calendar 标注 Alpha，且有日期计算依赖；项目当前采用系统原生日期弹层是有产品理由的。需要比较后再决定，而非把使用原生控件直接列为未完成。
4. **键盘闭环要核对真实调用。** ChatSearchDialog 的上下键、回车已实现，不能沿用旧盘点把它当作缺口；未来若重做列表语义，应先证明读屏或焦点模型确有缺陷。
5. **wrapper 的行为契约必须明确。** 菜单开关受控状态、异步选择、焦点归还、弹层互斥与 Escape 层级一旦散落在调用方，升级 Reka 时可能引入不同窗口间的行为分叉。继续让公共壳承接通用契约。

## 最佳实践方案

### 采用规则

1. **先选原语，再写样式。** 新交互优先确认是否属于 Reka 的 Dialog、DropdownMenu/ContextMenu、Popover、Select、RadioGroup、Switch、Combobox/Listbox、Tabs 等语义；只有组件库没有合适原语或产品语义冲突时，才保留自研。
2. **业务组件组合原语，不复制内核。** 业务层仅保留权限、数据、内容、文案、产品状态转换；定位、焦点、键盘模式和关闭语义由 Reka 原语或公共 wrapper 承担。
3. **统一通过项目级薄封装。** 对重复出现的控件优先维护项目 wrapper（例如 `BaseModal`、`SettingsSelect`、`ContextMenu`），让 token、ARIA、尺寸、Portal、边界和已知例外收口。
4. **禁止原语错配。** 搜索建议不是菜单；二维表情网格不是菜单；日期输入不因使用了系统 picker 就自动视为需要自研完整日历。
5. **评审时按交互和视觉分开验收。** 行为项：Tab/方向键/Home/End/Enter/Esc、焦点进入/归还、外点、嵌套层级、触屏按压；视觉项：token、亮暗主题、窄窗、滚动边界、减少动效与触屏热区。
6. **库升级遵守既有回归判据。** 修改公共 wrapper 前核对调用点和对应设计护栏/组件测试；更改判据锚点时，同次更新判据并保留反例自证。当前任务未运行测试，下面是后续实施时的建议门禁，不代表本次已验证。

### 实施计划

| 阶段 | 工作 | 产出 / 验收 |
|---|---|---|
| 0. 基线登记 | 以 `frontend-inventory.md` 的人工替换矩阵为基线；先复核其中 Reka 项目的真实源码与依赖，不手工改生成区的计数 | 形成“已采用 / 组合采用 / 有意保留 / 需要评估”清单，标明源码路径和理由 |
| 1. 交互闭环 | 复核 ChatSearchDialog 的键盘行为与读屏语义；检查公共 ContextMenu 与业务菜单是否仍共用壳 | 保留已存在的上下键/回车行为；如发现读屏/焦点缺陷，先形成具体复现再决定是否换原语；菜单行为只由 Reka + 公共壳提供 |
| 2. 原生控件复评 | 独立评估日期输入与 Reka Alpha Calendar/DatePicker；暂不引入替代依赖 | 文档记录平台体验、日期/时区模型、依赖和升级风险后再决定是否立项 |
| 3. 增量治理 | 新组件按“原语、wrapper、tokens、键盘/焦点验收”模板评审；矩阵只追加现状和日期 | 代码评审能解释每个自研组件保留的产品理由；无第二套通用菜单/模态/定位内核 |

## 本轮验证边界

- 本次进行了源码与现有文档的只读核对，并查阅了 Reka 官方组件文档。
- **未运行测试、lint、类型检查或构建**；用户要求只要方案和文档，本次也未改业务代码。
- 前端全量盘点中的文件数、行数和依赖统计会随源码变化，引用时以其脚本现算结果为准。

## 官方资料

- [Reka UI Dropdown Menu](https://reka-ui.com/docs/components/dropdown-menu)：完整键盘导航、焦点管理、类型搜索、定位和关闭行为。
- [Reka UI Context Menu](https://reka-ui.com/docs/components/context-menu)：右键或长按菜单，支持焦点管理与键盘导航；是否替换现有虚拟锚点封装需考虑本项目的全局互斥和选字约束。
- [Reka UI Date Picker](https://reka-ui.com/docs/components/date-picker)：当前页面标注 Alpha，依赖 `@internationalized/date`。
- [Reka UI Calendar](https://reka-ui.com/docs/components/calendar)：同样依赖 `@internationalized/date`。
