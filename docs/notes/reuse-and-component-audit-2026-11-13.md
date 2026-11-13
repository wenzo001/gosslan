# 组件库与公共能力复审

审计日期：2026-11-13  
范围：Vue 前端组件库采用、通用工具复用与少量跨层公共能力；结合当前源码、依赖声明及既有替换矩阵。  
边界：只读审计并新增文档；未改程序代码，未运行测试、lint、类型检查或构建。

## 总结

当前工程已广泛使用 Reka UI、VueUse、TanStack Query/Virtual、Day.js、Zod、Marked、DOMPurify 等成熟库。主要机会不是再增加依赖，而是让少数通用行为保持单一实现，并把确需自研的理由写清楚。

结论按优先级排列：

1. **P1：Todo 日期网格值得评估 Reka Calendar。** `TodoAttrDateField.vue` 自己生成 42 天网格并用普通按钮呈现，当前未见方向键/网格焦点导航。弹层本身已复用 Reka Popover，因此问题只在日历语义和键盘行为。Reka Calendar / DatePicker 当前标注 Alpha；应先评估成熟度、日期模型及时区，再决定是否迁移。
2. **P2：超时包装存在多份实现。** 四处 `withTimeout` 和 `waitPreviousExit` 的 Promise race 重复管理计时器，但超时结果、错误码、服务关闭清理和迟到结果策略各异。建议只评估共用底层计时器原语，保留每个调用点的业务策略。
3. **P2：Unicode 码点计数有一处精确重复。** `validation.ts::charCount` 已声明为长度判定的唯一实现；`externalLinks.ts` 又写 `[...s].length`。建议后续把码点计数放到无业务依赖的公共小工具，再由两处调用。
4. **其余大多数自研点有明确理由。** 消息虚拟列表锚定、弹层全局互斥、对象 URL 生命周期、WebView 存储异常、输入/手势和协议解析均含产品或平台契约，不应只按代码行数判断“重复造轮子”。

## 组件库采用核查

| 领域 | 当前实现与判断 | 建议 |
|---|---|---|
| 对话框、动作面板、菜单、选择器、开关、分段控件、Toast、Popover | 已通过 Reka 原语或项目公共薄封装复用。自有 CSS 负责 Gosslan 视觉，不等于自研交互内核。 | 继续让 Reka 负责焦点、键盘、关闭、定位等通用行为；业务组件只提供内容和业务状态。 |
| Todo / 代码语言 / 导航 / 聊天筛选菜单 | 多处已采用 Reka DropdownMenu。`ContextMenu.vue` 使用 DropdownMenu 处理虚拟鼠标锚点及菜单行为。 | 保留当前 wrapper、全局浮层互斥与移动端选字约束；不要为了“原语名称更匹配”机械替换。 |
| Todo 日期 | `TodoAttrDateField.vue` 自绘日期格式解析、月份网格和 42 个按钮；外层弹层已用 Reka Popover。没有查到日历网格方向键焦点导航实现。 | 将它列为组件采用的最高优先级评估项。若采用 Calendar 原语，保留 `YYYY-MM-DD` 数据契约、空值清除、今天操作和业务同步语义；迁移前核对 Reka Alpha 风险、键盘/读屏支持、时区与 WebView 行为。 |
| 搜索结果 | `ChatSearchDialog.vue` 已有上下键更新命中项、Enter 打开、滚动到可见范围等产品逻辑。 | 维持搜索框和消息定位的业务语义；若补读屏/Listbox 语义，应基于具体缺陷而非改成通用菜单。 |
| 虚拟消息列表、表情网格、图片灯箱、任务卡片 | 交互与消息锚点、二维导航、缩放/拖动或业务工作流耦合。 | 保留业务层自研；只将内部可独立识别的弹层、焦点和基础控件交给库。 |

对日期能力的判断应区分两处：`AppDateField.vue` 是原生 `input[type=date]` 包装，可借助平台日期选择器；`TodoAttrDateField.vue` 则是应用内完整日历网格。前者不是自动迁移项，后者有可访问性和组件复用评估价值。

## 公共逻辑与开源依赖复核

### 建议收敛的候选

| 候选 | 证据与差异 | 处理建议 |
|---|---|---|
| Unicode 码点计数 | `src/utils/validation.ts` 的 `charCount()` 是唯一口径说明；`src/utils/externalLinks.ts` 的名称校验再次用 `[...s].length`。两处都需与 Rust `chars().count()` 一致。 | 后续抽到无业务依赖的 `string`/文本工具模块；schema 和外链校验共享它。避免 `externalLinks` 反向依赖整套 IPC validation 模块。 |
| Promise 超时包装 | `TaskCenter.vue` 超时 resolve 字符串；两个 updater service 超时 reject 并登记 timer 供 dispose 清理；`previewGalleryState.ts` 超时 reject 消息且由调用方代次号丢弃迟到结果；`useAppStore.ts::waitPreviousExit` 另有 Promise.race timer。 | P2 评估共享底层 timer primitive，显式支持 timer 注册/清理；错误类型、超时结果、取消/迟到结果策略仍由业务调用点决定。`waitPreviousExit` 的 race timer 需核对在先胜时是否清理。无需因此新增第三方依赖。 |
| Store 内 debounce timer | `useChatStore.ts::debounceMarkRead` 自管 300ms timer 和 init scope 清理；项目已使用 VueUse debounce API。 | 作为可选治理项评估 VueUse 的 cancel 与生命周期行为；保留活跃会话、视图可见和 dispose 契约。未证明语义完全一致前不要机械替换。 |
| 日期格式 | 项目已有 `utils/time.ts` 和 Day.js；局部组件仍有原生 `Date` 格式化。调用场景可能分别是日期、时间戳或平台本地显示。 | 先统一产品 locale/时区/精度策略，再决定是否扩展公共 formatter；不要仅凭出现 `new Date()` 就合并。 |

### 已有开源库复用与合理边界

- **VueUse** 已承担事件监听、尺寸观察、剪贴板、媒体查询和多处 debounce；继续优先检查已有 API，再考虑手写通用响应式工具。
- **TanStack Query** 用于可过期只读面板；消息权威状态和发送状态机属于 Pinia/数据库契约，不宜为了“统一数据请求”强行迁移。
- **TanStack Virtual** 用于日志等列表；聊天消息列表有 prepend、滚动锚定、未读位置和动态高度要求，不能按普通虚拟列表替换。
- **Day.js** 已用于共享时间和搜索日期能力；优先补充统一 formatter，不必再引入日期库。
- **Zod** 已用于输入和 IPC 边界 schema。前端预校验与 Rust 权威校验重复，是跨边界职责，不是同层重复。
- **Marked + DOMPurify** 已分别承担 Markdown 解析和 HTML 清理，不建议手写解析器或 sanitizer。
- **mitt** 用于菜单/快捷键等解耦事件；**force-graph** 用于专属网络拓扑可视化。
- `safeStorage` 封装 WebView 存储读写异常；`blobLru` 以累计字节限制缓存并负责撤销 object URL；`popupRegistry` 处理应用全局弹层互斥；这些包含浏览器/产品生命周期约束，不能直接换成语义较窄的通用库。
- 当前 Device Auth 中使用成熟的 Ed25519、SHA-256 等密码学原语是正确的依赖边界；JWT/JWS 组装属于协议层代码。应单独审视 RFC 兼容、算法固定、claim 白名单与负向向量，不应把“使用开源库”简化为盲目引入宽泛 JWT 依赖。

## 与产品目标的匹配及风险

总体设计符合“统一交互、复用成熟能力、业务逻辑自有”的目标：底层交互采用 Reka，视觉和 token 留在产品设计系统；数据、协议与平台策略保留在业务层。当前偏差集中在少量共用原语的重复与应用内日历的键盘可访问性风险，而非整体组件架构失衡。

需要持续防止三类误判：

1. **自有视觉不等于自研行为。** Reka 是 headless；按钮、颜色和间距由项目实现是设计系统职责。
2. **相同函数名不代表契约相同。** 超时、缓存和防抖常带有不同取消、生命周期及失败策略；抽象应先提取真正共通的机制。
3. **开源库不是目标本身。** 只有库的语义与产品需求、平台行为、性能和许可证兼容时才替换；对业务协议和特殊交互保留自研理由。

## 最佳实践与实施计划

### 工程原则

1. 新交互先查仓库现有封装和已安装库，再查成熟开源能力；只有不存在匹配原语或产品约束无法满足时才自研通用机制。
2. 统一复用行为与样式两个层面：组件库处理焦点/键盘/ARIA/定位，项目 wrapper 与 tokens 处理视觉和稳定 API。
3. 提取公共方法前先写清输入、结果、错误、取消、生命周期和跨端口径；不要为了减少重复行而抹平行为差异。
4. 新增依赖需说明现有依赖为何不足、包体/维护/许可证成本以及卸载/替代路径；能用已安装依赖则不增加依赖。
5. 保留自研必须附业务/协议/平台原因和关键不变量；定期复核原因仍成立，但不以“零自研”为指标。

### 分阶段计划

| 阶段 | 工作 | 验收标准 |
|---|---|---|
| 1. 日期可访问性评估（P1） | 评估 Todo Calendar 与 Reka Calendar 的成熟度、键盘/读屏能力、日期模型、时区及 Android/iOS WebView 行为。 | 输出是否迁移的 ADR；列出 Alpha 风险、直接依赖和回滚方案；暂不改代码。 |
| 2. 共享原语候选（P2） | 对 timeout、码点计数、debounce 建立行为对照，明确唯一实现位置与边界。 | 只合并严格相同的机制；错误类型、计时器所有权和业务守卫在对照表中保持可见。 |
| 3. 日期与格式策略（P2） | 明确日期-only、本地时间、显示 locale 和时区约定；复核组件 formatter。 | 得到统一策略后再决定是否增加 `utils/time.ts` API，不因写法不同自动判重复。 |
| 4. 持续组件治理 | 新增 UI 前复用 Reka 原语/公共 wrapper；新通用逻辑先查 `@vueuse/core`、TanStack、Day.js 等现有依赖。 | PR 描述记录“复用库/复用项目工具/自研理由”；抽象有实际多个消费者和一致契约。 |

## 证据与限制

- 主要源码位置：`src/components/TodoAttrDateField.vue`、`src/components/search/ChatSearchDialog.vue`、`src/components/ui/AppDateField.vue`、`src/utils/validation.ts`、`src/utils/externalLinks.ts`、`src/components/TaskCenter.vue`、`src/updater/service.ts`、`src/updater/androidService.ts`、`src/utils/previewGalleryState.ts`、`src/stores/useAppStore.ts`、`src/stores/useChatStore.ts`。
- 依赖边界与历史替换记录参见 `docs/architecture/frontend-inventory.md`、`docs/architecture/open-source-replacement-matrix.md`。这些文档含生成区和历史描述，数量类结论须按其脚本现算，行为结论以当前源码为准。
- Reka Calendar / DatePicker 成熟度信息来自其官方组件文档：[Calendar](https://reka-ui.com/docs/components/calendar)、[Date Picker](https://reka-ui.com/docs/components/date-picker)。
- 本轮只做审计和方案整理；没有运行自动化验证，因此文中是源码审阅结论，不代表行为测试或运行时验证。
