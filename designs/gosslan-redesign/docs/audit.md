# 现有 UI 审计

审计基于当前代码与真实运行截图，未修改任何源文件。行号对应审计时的 `main` 分支（`4c90c89f`）。

查看过的截图：

- `test-results/ui-glass/after-main-light.png` / `after-main-dark.png` / `after-main-light-ambient.png`
- `test-results/ui-glass/after-settings-light.png` / `after-settings-dark.png` / `after-dialog-dark.png`
- `docs/notes/unslop-review-2026-11-06/shots/main-1440-light.png` / `main-390-light.png`
- `test-results/ambient-shots/03-main-t2-light.png` / `06-main-t2-dark.png`
- `test-results/i18n-shots/zh-CN-1-conversation-list.png` / `zh-CN-2-quote.png`

---

## 结论先行

当前界面不是「不好看」，而是**层级、标尺和状态语言三件事没有单一事实源**：

1. 亮色模式下，画布被薄纱压到接近列表与卡片，六级白同屏，同屏唯一有重量的是对方气泡——自己的消息反而像禁用态。
2. 排版同时存在 CSS 五档与 Tailwind 六档两套刻度，`text-body` 同名不同值（14 vs 13）。
3. 玻璃有 5 个入口、图标线宽有 8 档、动效有 14 个时长——规范存在，但执行面已经漂移。
4. 单聊没有头像/名字锚点，再叠加气泡权重反转，扫读与自我归属都受损。
5. 状态（空/错误/离线/传输/发送失败）没有统一解剖，用户需要逐页重新学习。

Still 的改法不是再加一层规范，而是把**表面、标尺、状态**收敛为可验收的三组 token 与三个组件。

---

## P0 — 直接损伤可用性

### P0-1 亮色表面层级坍塌

- 画布被 16% 薄纱压到约 `#eaeef2`（`src/style.css:601-604`）。
- 对画布对比：列表 1.06、自己气泡 1.16、卡片 1.10、chrome 玻璃 1.08；对方气泡 1.78。
- 截图 `docs/notes/unslop-review-2026-11-06/shots/main-1440-light.png` 可见大片灰蓝雾团；`after-main-light-ambient.png` 更明显。
- 后果：自己的消息像禁用；卡片「下陷」；三栏边界读不出来；日间模式显得脏、灰、假。

**Still 的回应**：取消内容层薄纱；`surface-canvas #f4f4f1` → `surface-list #f8f8f5` → `surface-content #ffffff` 三级明度差 + 1px 发丝线。自己气泡用 `accent` 填充，成为同屏最重的面；对方气泡 `#f0f1ed` + 1px 边界。环境雾不进入内容区。

### P0-2 键盘焦点环不达 3:1

- `--gosslan-focus-ring` 是主色 55% 透明（`src/style.css:223`）；合成后亮色约 1.91:1、暗色 2.27:1。
- `docs/design-language/controls.md:109` 已把它列为待签核项。
- 后果：非文本控件几乎看不见键盘焦点，WCAG 2.2 focus appearance / 1.4.11 不达标。

**Still 的回应**：`focus-ring` 用不透明 `#2f6beb` / `#6e9bff`，2px 外环 + 2px offset；文本输入仍用 1px 边线变色，不画外圈（遵循现有 §2.4）。令牌在设计系统 `tokens.json` 中单列，并注明用途。

### P0-3 排版双标尺

- CSS：title 15 / body 14 / callout 13 / footnote 12 / caption 11（`src/style.css:85-89`）。
- Tailwind：title 15 / emphasis 14 / body 13 / meta 12 / caption 11 / micro 10（`tailwind.config.js:30-37`）。
- 用量：`text-sm` 98 处、`text-xs` 155 处，与 `text-body` 83、`text-meta` 61、`text-caption` 170 混用；`text-base` 还有 4 处。
- 后果：同角色的「正文」在 13 与 14px 间摇摆；列表标题 13、设置行 14、聊天标题 15、少数 16 共存。

**Still 的回应**：一份字体阶梯（display / title / headline / body / body-sm / caption / micro / code），设计系统 `tokens.json` 的 `type.groups` 是唯一真相。11px 为下限；字重只用 400/500/600。

### P0-4 单聊缺少发送者锚点，气泡权重反转

- 单聊刻意不显示头像与昵称（`src/components/MessageItem.vue:1719-1726`），只靠左右与颜色区分。
- 群聊组首 30px 头像 + 11px 灰昵称（`MessageItem.vue:1872`）。
- 叠加 P0-1 后，对方气泡成为最重面，自己的消息最轻。

**Still 的回应**：单聊保持无头像列（iMessage 式，把空间还给文字），但**自己消息改为唯一强调色填充**，并在组尾给出回执；群聊保留 24px 头像 + 11px 名字，自己消息不显示头像与名字。归属靠「颜色 + 对齐 + 群聊名字」三通道，不再只靠左右。

---

## P1 — 一致性与效率

### P1-1 玻璃/表面有 5 个入口

- `.glass` 6px 给灯箱（`src/style.css:339,1542`；`ImageLightbox.vue:356`）。
- `.frost` / glass-2 给菜单。
- Toast 自写 `backdrop-blur-sm` + `border-white/10`（`ToastList.vue:39`）。
- 灯箱按钮 `bg-black/55 shadow-lg ring-white/30`（`ImageLightbox.vue:728/740/809`）。
- sticky 字母条自写 `blur(8px)`（`src/style.css:1605-1609`）。

**Still 的回应**：内容区零玻璃；只有标题栏与移动底栏允许 92% 不透明表面 + 背景模糊。浮层用实色 + 阴影，不再提供第二套模糊。

### P1-2 圆角与阴影不同源

- 发送键 6px 紧邻 8px 图标按钮（`MessageComposer.vue:1378 vs 1313`）。
- 表情胶囊 `h-7` 全圆角贴 18px 气泡（`MessageReactionBar.vue:207`）。
- 设置卡 `rounded-lg + shadow-sm + border`（`settings/SettingsGroup.vue:12`）与模态 `glass-3 + 24px 阴影`（`style.css:388`）是两种「浮起」语言。
- 气泡 18px 与规范 §1.2 的 alias 表已对不上。

**Still 的回应**：圆角 4/6/8/10/12/18/full 七档；阴影只用于浮层（menu / dialog / toast）；发送键与图标按钮同为 8px；表情胶囊 999px 是唯一允许的「胶囊例外」。

### P1-3 图标只有库，没有刻度

- 统一使用 `lucide-vue-next`（91 个名字、57 个文件），但线宽出现 1 / 1.75 / 1.9 / 2 / 2.2 / 2.35 / 2.5 / 3 共 8 档。
- 尺寸 10/16/18/20/22/32 混排：rail 22@1.9–2.35、聊天头 18@2、输入栏 20@1.75、回执 16@2.5、菜单 16@2。
- 另有 5 个手绘 SVG（`TitleBar.vue` 2 个、`BubbleTail.vue` 2 个、`GroupTasksBoard.vue` 1 个）。

**Still 的回应**：所有线性图标 1.75px，尺寸 16/20/22/24 四档；rail 22、聊天头 18→统一 20、输入栏 20、回执 14、菜单 16。窗口控制与气泡尾属于平台/形状，不在图标系统内。

### P1-4 聊天头信息过载，在线状态缺席

- 48px 内塞标题 + 设备图标 + 版本标记 + 链路徽标（11–15px）；群聊再塞 4 个 32px 按钮 + 2 枚角标（`chat/ChatHeader.vue:89-206`）。
- `online` 只决定链路图标是否出现（`:141`），没有在线/离线文字或点。

**Still 的回应**：头部 52px，左侧头像 + 名字 + 一行状态（在线/离线 + 设备 + 链路）；右侧最多 4 个 30px 图标。第二行状态用绿点 + 文字，离线用灰点 +「离线」；版本不兼容降级为一个小警示图标 + 悬浮说明，不再挤占标题行。

### P1-5 三态语言不统一

- 加载 = 静态骨架 + 一次淡入（`ChatWindow.vue:1975-1996`）；错误 = `StateBlock`（`:2004`）；空态 = 一行 `mt-20 text-sm`（`:2012-2017`）；列表空态又是自定义 CTA 块（`ConversationList.vue:549-572`）。
- 离线没有专门态，只有列表小圆点。

**Still 的回应**：空/错误/加载/离线共用一套解剖（40px 图标 + 17/24 标题 + 13/18 说明 + 一个主行动）；离线是 32px 常驻细横幅 + 头部状态，不遮内容，不阻止输入。见 `MobileStates` 与设计系统 `State`。

### P1-6 设置仍是长页

- 桌面 4 个容器，「通用」一页纵向叠 Profile / General / Appearance / ChatStyle / Notification 五个分区（`SettingsWindow.vue:245-249`）。
- 截图 `after-settings-light.png`：7 个色板 + 分段控件 + 滑杆 + 双气泡预览挤在同一屏。
- 移动端又是另一套分组列表（`SettingsPanel`）。

**Still 的回应**：桌面设置窗口 780×600 双栏，左栏 9 个分区（个人资料 / 通用 / 外观 / 聊天样式 / 通知 / 网络 / 存储与文件 / 关于 / 重置），右栏单分区；外观与聊天样式拆开。移动端沿用 4 组 9 项，二级页结构一致。

---

## P2 — 细节与工程

### P2-1 移动端顶部缺身份

- 390 列表首屏只有通栏搜索 + 「+」（`main-390-light.png`），没有头像入口或页面标题。
- 返回/群操作全压在 48px 聊天头里，4 个 32px 图标在 390 宽下逼近溢出。
- `.tap-safe` 只纵向扩到 44px（`src/style.css:1329-1336`），横向命中仍是 32px。

**Still 的回应**：移动列表顶部 56px 放「聊天」标题 + 左侧头像（进「我的」）+ 右侧「+」；聊天头 52px，左侧返回（44px 热区）+ 头像/名字，右侧最多 2 个可见图标 + 更多。所有图标按钮热区 ≥44px。

### P2-2 Toast 压住标题栏

- 桌面 `top: safe-area + 1rem`（`ToastHud.vue` 样式块），38px 标题栏下半段被盖住；toast 本体 `pointer-events:auto` 吃掉拖拽区。
- 截图 `after-dialog-dark.png` 可复现。

**Still 的回应**：桌面 toast 固定右下（距底 24px），移动端底部居中（距底 tab bar + 16px）；永不覆盖标题栏。错误 toast 带「重试」，停留至用户处理。

### P2-3 动效与令牌漂移

- 规范承诺 150/240ms 两档，实际 14 个时长（110–560ms）、40 条 animation。
- 常驻 3 团色雾 + 560ms 涟漪 + 520ms 抖动 + 页面滑入 + 卡片/抽屉/Toast/徽标/回执各自入场。

**Still 的回应**：动效预算四档 120/180/240/320ms，统一一条标准缓动；只动 opacity 与 transform；出现只播一次，状态切换不重播；reduce 档只保留 120ms 淡入淡出。色雾不进入内容区。

### P2-4 硬编码与残留

- `.vue` 内 28 个十六进制色值；`TaskCenter.vue:436` 仍有 `animate-pulse`（SK-01 名义上只允许循环进度条）。

**Still 的回应**：所有颜色走 token；骨架用静态灰块，不使用脉冲发光。

---

## 值得保留的资产

这些是现有代码里少见的严谨部分，改版不应丢掉：

1. **语义色三分**：填充档 / 文字档 / 实底档，以及自动对比度契约（`src/style.css:169-212`）。Still 沿用「fill / ink / soft」三分。
2. **圆角 token 化**：字面圆角几乎清零，只剩 96 处 `rounded-full` 胶囊白名单。
3. **密度纪律**：48px 头、64px 行、6px 气泡内距、78% 气泡宽；输入区 44px 编辑器 + 32px 工具行与微信 macOS 同量级。Still 保持同一量级，只把行高调到 68px 以容纳两级文字。
4. **状态可访问性基础**：全库 `aria-label`、装饰头像 `alt=""`、`role=img` 回执、`.tap-safe`、`.hover-reveal/.kb-reveal`、live region toast。
5. **动效克制**：无逐帧 JS、无背景 canvas、reduce 冻结而非减速。
6. **首屏骨架与真实三栏几何一致**、无窗口圆角。
7. **平台优先的移动判定**：Android/iOS 永远移动布局，桌面宽度兜底（`src/utils/platform.ts:84-101`）。Still 的响应式规则沿用这条判据。

---

## 改版不得违反的硬约束

来自 `docs/design-guidelines.md` 与现有实现，设计稿已逐条遵守：

1. 窗口形状由系统负责：根容器/标题栏不得画圆角；浮层不得盖 caption；新增浮层 z ≤ 80（标题栏 85、Toast 90 是仅有两格）。
2. 动效五条：出现才播一次；状态切换不重播 scale；占位尺寸不变；reduce 只淡入淡出；不叠加。
3. reduce-motion 双通道：CSS 媒体查询 + JS `useReducedMotion`。
4. 圆角只走 token，嵌套面按同心公式。
5. hover 白名单 + 必须有 press，不得位移/缩放；操作不得只藏在 hover 后。
6. 文本输入不画外圈，用 1px 边线变色；非文本控件保留 ≥3:1 焦点环。
7. 排版最小 11px、字重 ≤600、无负 tracking；改字号需同步行高与消息高度估算常量。
8. 对比度：正文 4.5、图形/边框/焦点 3.0。
9. 暗色分层单调：app-bg < chat < caption/rail < list/panel < active；浮起面更亮。
10. 玻璃预算：内容层不得玻璃；正文承载面 alpha ≥ 0.95。
11. 结构不动：移动 TabBar 四项、会话行高、双 CTA、上传下载入口；不新增 UI 依赖。
12. 改 token/布局需同步 `index.html` 骨架与 `tauri.conf.json` 窗口底色。

---

## 审计方法说明

- 代码证据来自逐文件阅读；截图证据来自上述真实运行产物。
- 颜色对比按 WCAG 相对亮度公式计算；玻璃底取合成后的近似值。
- 所有「现状」判断都以 `main` 分支当前代码为准，不以历史截图为准（例如对方气泡 token 已从近白改为 `#aab5c2`，以 `chatStyle.ts:122` 为准）。
