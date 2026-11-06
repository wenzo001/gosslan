# gosslan × unslop 只读审查（2026-11-06）

## 0. 结论先说

1. **不是重灾区，属于 unslop 的「light slop / polish mode」。** 4px 网格、字号阶梯、字重（400/500/600）、图标集（统一 stroke 1.5，16/18px）、无 UI emoji、无渐变文字、无 `hover:scale`——这些都在真实渲染里通过了；源扫描也只有 1 处 `transition-all`（还是工具类定义本身）。
2. **真正该先修的只有三件**，都在「失败态」而不是「好看不好看」上：
   - 通知条会**同时叠 3 条**（来源各不相同）；390 宽下直接盖住搜索框与列表首行（[contacts-390-light.png](shots/contacts-390-light.png)）。
     **更正（2026-11-06 阶段 1）**：初稿写的「同一条错误重复出现两次」是**文本提取误判** —— DOM 里 toast 结构与 `aria` 文本各被抽了一次，视觉上只有一条；`pushToast` 的 `kind:text` 去重本来就在。
   - 错误提示会**自己跟自己拼接**：`扫描失败，请稍后重试，请稍后重试`（[dialog-addfriend-1440-light.png](shots/dialog-addfriend-1440-light.png)），根因是 `errors.retry` 模板再拼一次后缀。
   - 空态仍在用**64px 的通用导航图标**当插画（聊天/通讯录两处），这是 unslop 明确点名的那类「模板空态」。
3. **上一轮 `1d69b72e` 的评估：全部保留，没有需要回退的项。** 有 2 项需要「改写」而不是回退（见 §5），另有 3 项按原计划等玻璃线合入。
4. **没有改任何业务代码**。本报告与 `plan.md`、`shots/` 是唯一新增物；`git diff --stat` 为空，`git status` 只有两个未跟踪目录（§7）。
5. 本轮**没有安装任何东西**：没有 npm 包、没有 Playwright、没有浏览器内核；技能直接调用 Trae 已安装的那一份（§1）。

---

## 1. 技能：实际加载路径与调用证据

| 核验项 | 读数 / 证据 |
| --- | --- |
| 实际加载路径 | `/Users/wendongfu/.trae-cn/skills/unslop/` |
| 调用方式 | `Skill` 工具（`name=unslop`），返回首行为 `**Skill Path:** /Users/wendongfu/.trae-cn/skills/unslop`，并输出完整 `SKILL.md` 正文 |
| 工具侧注册表 | `~/.trae-cn/skill-config.json` → `managedSkills.unslop = "user_upload"`（说明这份是用户上传、被 Trae 管理的技能，不是仓库副本） |
| 版本/来源一致性 | `SKILL.md` sha256 = `9e49b2ff7643fa09729e8665890a18f6bfa58a82e6fcbba330da38136ccdc393`；与上游 `raw.githubusercontent.com/heydamir/unslop/main/skills/unslop/SKILL.md` 下载件**字节完全一致**（同哈希）。取回时上游 main HEAD 短哈希 `a6f121e`（读取时刻读数，非固定版本号） |
| 目录完整性 | `SKILL.md`、`references/{visuals,refs,effects,signs,tokens}.md`、`references/refs/*.webp`（5 张）、`scripts/{snapshot,story}.mjs`、`agents/openai.yaml`，共 15 个文件 |
| 许可与署名 | 上游声明 CC BY 4.0 / Damir Sokolovsky（[@heydamir](https://x.com/heydamir)）；本仓 `docs/design-language/sources.md` §7（第 83–110 行）已有出处标注，按修正指令**保留不动** |
| 脚本依赖 | `snapshot.mjs` 需要 Playwright + Chromium；`story.mjs` 另需 ffmpeg。本机：Playwright 缓存条目 0、仓库无 Playwright 依赖、ffmpeg 缺失 ⇒ **未安装、未下载**，本轮改用既有 `scripts/check-ui-runtime.mjs`（原生 CDP + 系统 Brave） |

**本轮需要你确认的一处越界（发生在收到「不要再安装」修正之前）**：
- 我在 `/Users/wendongfu/.trae-cn/skills/unslop/LICENSE` 放了一份 CC BY 4.0 legalcode 文本。它不是包、不是副本、不加依赖，但确实动了已安装目录。**你要是不希望动它，我删除即可。**
- 仓库里还有 `.claude/skills/unslop/`（上一轮按旧指令拷的副本，未提交、未跟踪）。按新指令建议删除，**等你点头**。

---

## 2. 量具、环境、读数

- Brave `156.1.98.63`（系统安装，`GOSSLAN_CHROME` 指到它）；node `v26.13.0`；dev server `http://127.0.0.1:5288`；CDP `http://127.0.0.1:9644`（避开 1420/5199/9444）。
- 截图脚本：`/tmp/shots.mjs`、`/tmp/scenes.mjs`（原生 CDP，`Emulation.setDeviceMetricsOverride` + `setEmulatedMedia`）；读数脚本 `/tmp/audit.mjs`、`/tmp/contrast.mjs`。均不在仓库内。
- 探针回归（工作区未改代码）：
  - `--only=settingsmobile,logs,search,rowpair` → **655/655 通过**
  - `--only=files` → 通过，产出 `files-run-files*.png`
- 真实渲染读数：
  - 字号集合 `{11,12,13,14,16,18}`；字重 `{400,500,600}`；`<11px` 文本 **0**；UI emoji **0**
  - 间距采样 `{2,4,6,8,10,12,14,16,20}`，全部落在 2/4px 标尺上；492px 居中外边距可被 4 整除 ⇒ **4px 网格通过**
  - 对比度：主按钮 **6.32 / 6.74**；日志页「自动刷新」**3.24**（12px → AA 不达标）；错误红字 4.83；次要文本约 6.5；暗色档未见失败
  - 源扫描：`animate-pulse` 11、`transition-all` 1（工具类定义）、`shadow-lg` 6、`shadow-xl` 1、`uppercase` 3、`backdrop-blur` 1、`rounded-full` 101、`gradient` 9（4 层色雾 + 原生 color input + 色轮 + hover 叠层 + 按压涟漪）

---

## 3. 截图清单（`docs/notes/unslop-review-2026-11-06/shots/`）

| 文件 | 尺寸 | 这张证明什么 |
| --- | --- | --- |
| `main-1440-light.png` | 1440×900 | 桌面三栏结构、左栏空态、中央空态、页脚版本、色雾背景 |
| `main-1440-dark.png` | 1440×900 | 深色表面层级、暗色下空态与次要文本的对比度 |
| `main-1280-light.png` | 1280×800 | 1280 档三栏比例与空态换行 |
| `main-390-light.png` | 390×844 | 移动端：搜索 + 列表 + 底部 TabBar，无中央空态 |
| `main-320-light.png` | 320×640 | 极窄挤压：搜索框、按钮、长错误句是否溢出/截断 |
| `contacts-1440-light.png` | 1440×900 | 通讯录三态：新的朋友 / 好友读取失败 / 中央空态；通知叠层 |
| `contacts-1440-dark.png` | 1440×900 | 同一失败态的暗色版本 |
| `contacts-390-light.png` | 390×844 | **通知遮挡移动端搜索与列表首行**（P1 证据） |
| `contacts-320-light.png` | 320×640 | 极窄下的错误文案换行与重试入口 |
| `favorites-1440-light.png` | 1440×900 | 收藏页错误态：标题 + 说明 + 重试，说明与标题同义 |
| `links-1440-light.png` | 1440×900 | 链接页：左栏错误态 + 中央 64px `NavIcon` 空态 + 「外部链接」标题重复 |
| `menu-more-1440-light.png` | 1440×900 | 「更多」下拉：两项（设置/日志）、图标与行高、浮层投影 |
| `menu-new-1440-light.png` | 1440×900 | 「添加好友 / 创建群聊」下拉（会话空态的入口） |
| `dialog-addfriend-1440-light.png` | 1440×900 | 添加好友弹窗：316px 宽、居中密集小字、①②③、纯文字按钮；**双后缀错误 toast** |
| `settings-1440-light.png` | 1440×900 | 设置窗口：176px 导航、卡片分组、分段控件、色板（圆形 vs 原生方色块） |
| `settings-1440-dark.png` | 1440×900 | 设置暗色 |
| `settings-network-1440-light.png` | 1440×900 | 网络分区：开关、下拉、跨网段输入、公网中转表单 |
| `settings-network-1440-dark.png` | 1440×900 | 网络分区暗色 |
| `settings-storage-1440-light.png` | 1440×900 | 存储分区：数值行、导出、立即清理 |
| `settings-about-1440-light.png` | 1440×900 | 关于：E2EE 说明长文、设备指纹 |
| `probe-settingsmobile.png` | 780×1688（390@2x） | **真实移动设置**（外观分区），非 `settings.html` 伪场景 |
| `probe-network.png` | 780×1688 | 移动网络设置 |
| `logs-1440-light.png` | 1440×900 | 日志页：标题重复、chip 与开关同款选中、错误态同义重复 |
| `probe-logs.png` / `probe-logsmobile.png` | 桌面 / 780×1688 | 日志页桌面与移动的真实渲染对照 |
| `probe-search.png` | 780×433 | 搜索面板：**黄色高亮 mark**、输入框焦点框、结果行规格 |
| `probe-searchmobile.png` | 780×1688 | 移动搜索 |
| `probe-rowpair.png` | 780×433 | 连续消息组的间距与圆角（组件夹具，真实渲染） |
| `probe-tail.png` / `probe-tail-reactions.png` | 780×433 | 单聊气泡尾巴 + 回应条是否同一块（组件夹具） |
| `probe-mine-{text,file,code,merge,todo}.png` | 780×433 | 「自己」侧五种消息体的气泡（组件夹具） |
| `files-run-files.png` / `files-run-filesmobile.png` | 桌面 / 780×1688 | 群文件面板：空/失败、文件行、**悬空「·」** |
| `startup-error-1440-light.png` / `-390-light.png` | 1440×900 / 390×844 | 启动失败页的层级与按钮组（浏览器 mock 下多一行 JS 错误，见 §6） |

> 标注：`settings-390-light.png` 与 `todos-1440-light.png` 是**非真实场景**（`settings.html` 只有桌面窗口；`todos.html` 无 `groupId` 时走防御分支），已保留但不用于任何结论。

---

## 4. 发现（按优先级）

判据编号：**U-n** = unslop 原版第 n 节（Spacing/Color/Type/…）；**G-n** = 本仓补充层（草案见 `plan.md` §5）。

### P1 — 先修（失败态/可达性）

| # | 位置 | 病症（读数/截图） | 判据 | 改法 | 分类 |
| --- | --- | --- | --- | --- | --- |
| A1 | [ToastHud.vue:29](file:///Users/wendongfu/Documents/code/gosslan-unslop/src/components/ToastHud.vue#L29)；[ToastList.vue:36](file:///Users/wendongfu/Documents/code/gosslan-unslop/src/components/ToastList.vue#L36) | 同屏 3 条红色 toast（**来源各不相同**）；长句在 390 下折成 2–3 行并盖住搜索框（`contacts-390-light.png`）。**更正**：初稿的「同一条出现两次」是文本提取误判 —— `pushToast` 以 `kind:text` 去重，视觉上只有一条 | U-5 文案只说一次；U-3 层级靠颜色不靠重量；G-9 不阻塞 UI | ①保留现有 `kind:text` 去重，不重复加去重层；②长失败句进页面内错误档，toast 只保留短句 + 「查看」；③错误色改为左侧 2px 强调条 + 中性底（②③会改交互，先报后改） | AI 模板感 / 交互缺陷 |
| A2 | [AddFriendModal.vue:295](file:///Users/wendongfu/Documents/code/gosslan-unslop/src/components/AddFriendModal.vue#L295)、[:324](file:///Users/wendongfu/Documents/code/gosslan-unslop/src/components/AddFriendModal.vue#L324)；[zh-cn.ts:720](file:///Users/wendongfu/Documents/code/gosslan-unslop/src/i18n/locales/zh-cn.ts#L720) | toast 原文 `扫描失败，请稍后重试，请稍后重试`（`dialog-addfriend-1440-light.png`）。`errors.retry = "{prefix}，请稍后重试"`，而调用方传的前缀已含「请稍后重试」 | U-5 文案只留一处；G-3 文本质量 | 前缀改「扫描失败」或把 `errorText` 的 unknown 分支改成不追加后缀（用 `detailText` 口径）；加一条 zh/en 单测：`prefix` 已以「请稍后重试」结尾时不得再拼 | 文案缺陷 |
| A3 | [ResponsiveLayout.vue:1009](file:///Users/wendongfu/Documents/code/gosslan-unslop/src/layouts/ResponsiveLayout.vue#L1009)、[:1057-1058](file:///Users/wendongfu/Documents/code/gosslan-unslop/src/layouts/ResponsiveLayout.vue#L1057-L1058) | 空态插画 = `<NavIcon name="links|contacts|chats" size-class="h-16 w-16 opacity-25" />`（64px 通用导航图标当插画），`links-1440-light.png` / `main-1440-light.png` | U-3「空态不画通用插画」；G-2 不重造组件 | 空态只留「结论 + 一句说明 + 一个主动作」；品牌签名改为**本机节点名/设备指纹**这类只属于 gosslan 的一行事实（`app.deviceName` 已有？需核对） | AI 模板感 |
| A4 | 收藏/链接/日志错误档（`favorites-1440-light.png`、`links-1440-light.png`、`logs-1440-light.png`） | 标题「X 读取失败」+ 说明「X 读取失败，请稍后重试」= 同义重复；日志页还多一条「日志读取失败，请稍后再试」 | U-5 | 说明位改成**可行动的下一步**（「检查数据目录可读」/「重试」），标题只说一次 | 文案缺陷 |
| A5 | [AddFriendModal.vue](file:///Users/wendongfu/Documents/code/gosslan-unslop/src/components/AddFriendModal.vue)（弹窗体）；文案见 `zh-cn.ts:1409-1420` | 弹窗 316px 宽内放 5 行居中 11px 说明 + ①②③ + 两条键值行 + 两个纯文字按钮；层级全靠小字，扫描成本高（`dialog-addfriend-1440-light.png`） | U-3 层级靠字号/颜色；U-5 文案克制；G-8 点击区域 | 说明改左对齐、`text-footnote` 12px、行高 1.6；①②③ 改「常见原因」列表（每条独立行）；「重新扫描 / 复制邀请」改与主按钮同规格的次按钮 | 布局问题 |
| A6 | [LogViewer.vue:319-330](file:///Users/wendongfu/Documents/code/gosslan-unslop/src/components/LogViewer.vue#L319-L330)；[style.css:16](file:///Users/wendongfu/Documents/code/gosslan-unslop/src/style.css#L16) | 「自动刷新」12px 文本用 `text-[var(--gosslan-primary)]`（#3b82f6）压在浅色卡片上 = **3.24:1**；同页过滤 chip 用的是 `--gosslan-accent-ink`（72% 混黑） | U-2 一个 accent 且克制；G-10 对比度 ≥4.5 | 换 `--gosslan-accent-ink` 或「图标 + 文字」两档（开启=ink，关闭=text-2） | 视觉不统一 |

### P2 — 统一性（不影响功能，但在「像不像一个产品」上扣分）

| # | 位置 | 病症 | 判据 | 改法 | 分类 |
| --- | --- | --- | --- | --- | --- |
| B1 | [LogViewer.vue:295](file:///Users/wendongfu/Documents/code/gosslan-unslop/src/components/LogViewer.vue#L295)、[:330 附近](file:///Users/wendongfu/Documents/code/gosslan-unslop/src/components/LogViewer.vue#L330) | 桌面自绘标题栏「运行日志」+ 内容区「运行日志 N 条」→ 标题重复（`logs-1440-light.png`） | U-3 / U-5 | 内容区标题降级为计数（「N 条 · 自动刷新中」），不再重复名字 | 视觉不统一 |
| B2 | [LogViewer.vue:392-424](file:///Users/wendongfu/Documents/code/gosslan-unslop/src/components/LogViewer.vue#L392-L424) | 时间窗口 chip 与「合并重复」开关**同一套选中样式**（`border-primary + bg-primary-light + text-accent-ink`），只隔一条 1px 线 | U-4 同类同尺寸、异类必须可区分 | 开关改 checkbox/switch（有 `SettingsToggle` 可复用），chip 保留 | 视觉不统一 |
| B3 | [AppearanceSection.vue:110-130](file:///Users/wendongfu/Documents/code/gosslan-unslop/src/components/settings/AppearanceSection.vue#L110-L130) | 6 个 `h-6 w-6 rounded-full` 色板 + 原生 `<input type="color">`（浏览器下渲染成**蓝色圆角方块**），形状/尺寸不一致（`settings-1440-light.png`、`probe-settingsmobile.png`） | U-4 同类同尺寸 | 自定义色入口改成同尺寸圆形按钮（点开再拉起 color input），或统一为 24×24 圆角方块 + 「自定义」标签 | 视觉不统一 |
| B4 | [SettingsPanel.vue:221](file:///Users/wendongfu/Documents/code/gosslan-unslop/src/components/SettingsPanel.vue#L221)；[FriendRequestList.vue:29](file:///Users/wendongfu/Documents/code/gosslan-unslop/src/components/conversation/FriendRequestList.vue#L29)、[:58](file:///Users/wendongfu/Documents/code/gosslan-unslop/src/components/conversation/FriendRequestList.vue#L58) | 3 处 `uppercase tracking-wider/wide` 的小节标签；中文无大小写，英文下变成全大写 | U-3（sentence case） | 去掉 `uppercase`，保留 `tracking` 或改 `text-caption` + `font-medium` | AI 模板感 |
| B5 | [EmojiPicker.vue:128](file:///Users/wendongfu/Documents/code/gosslan-unslop/src/components/EmojiPicker.vue#L128) | `shadow-xl` 仍在（全仓唯一） | U-5 发丝线代替厚阴影；G-6 | 换 `--gosslan-glass-2-shadow`（与 `1d69b72e` 对 Toast/浮层同口径） | 视觉不统一 |
| B6 | [GroupFilesPanel.vue:340-352](file:///Users/wendongfu/Documents/code/gosslan-unslop/src/components/GroupFilesPanel.vue#L340-L352) | 元信息静态拼 `sender · time · delivery`，时间为空时留悬空「·」（`files-run-files.png` 已复现） | U-5；G-4 | 改数组 filter + join | 状态缺失 |
| B7 | [style.css:583-634](file:///Users/wendongfu/Documents/code/gosslan-unslop/src/style.css#L583-L634) | 4 层 radial 色雾 + `72s/96s/120s infinite alternate`；亮暗两套都能看到明显的蓝雾（`main-1440-*.png`） | U-2 表面中性；U-9 禁色雾；G-6 | **待你裁决**：保留（产品设计语言、可在设置里关）／降饱和 30% ／只在空态与欢迎区出现 | 无效装饰（争议项） |
| B8 | [ChatWindow.vue:1972-1991](file:///Users/wendongfu/Documents/code/gosslan-unslop/src/components/ChatWindow.vue#L1972-L1991)；[MessageImageBubble.vue:192](file:///Users/wendongfu/Documents/code/gosslan-unslop/src/components/message/MessageImageBubble.vue#L192) | 消息骨架 9 处 `animate-pulse`；图片占位也脉冲 | U-9（循环脉冲） | **待你裁决**：静态骨架（灰块 + 一条 240ms 淡入）／保留 | 动效（争议项） |

### P3 — 记录，不急着动

| # | 位置 | 病症 | 判据 | 改法 |
| --- | --- | --- | --- | --- |
| C1 | [highlight.ts:12](file:///Users/wendongfu/Documents/code/gosslan-unslop/src/utils/highlight.ts#L12) | 搜索/日志命中标记写死 `bg-yellow-200 dark:bg-yellow-800/50`（`probe-search.png` 的黄色块），不属于任何 token | U-2 一个 accent（黄色是第二个强调色） | 换 `--gosslan-primary-light` + `--gosslan-accent-ink`；或保留黄（搜索高亮的行业惯例）→ **待裁决** |
| C2 | [ChatSearchDialog.vue:432](file:///Users/wendongfu/Documents/code/gosslan-unslop/src/components/search/ChatSearchDialog.vue#L432) | 搜索框出现一圈 2px 蓝框（`probe-search.png`），与全站键盘焦点环（55% 主题色、offset 1）不一致；来源未证伪（UA 默认环 vs 包裹层规则） | U-4；G-10 | Tauri 真机复核后再定；若确为 UA 默认环，补 `.gosslan-input:focus-visible` 一类统一焦点样式 |
| C3 | [ConversationList.vue:549-579](file:///Users/wendongfu/Documents/code/gosslan-unslop/src/components/ConversationList.vue#L549-L579) 与 [ResponsiveLayout.vue:1074-1076](file:///Users/wendongfu/Documents/code/gosslan-unslop/src/layouts/ResponsiveLayout.vue#L1074-L1076) | 两个「添加好友」CTA（左栏 xs / 中央 large）；源码注释记录是用户 2026-09-12 #13 的明确要求 | U-4 | **不删**；只统一规格（左栏用同一 `PrimaryBtn` 的 `size="xs"` 变体并统一文案） |
| C4 | `ConversationList.vue:672-690` | 页脚「小院儿 · v5.18.34」长期占用左栏底部 | U-5 | **待裁决**：保留（排障友好）／移到「关于」 |
| C5 | `files-run-files.png` | 文件面板关闭按钮是有边框的圆角方块，而添加好友弹窗是裸「×」 | U-4 | 统一为一种（建议裸图标 + `tap-safe`） |
| C6 | `links-1440-light.png` | 左栏 header「外部链接」+ 中央空态标题「外部链接」重复 | U-3 | 中央只用「选择一个链接…」一句，不重复栏目名 |

---

## 5. 上一轮 `1d69b72e` 逐项评估

| 改动 | 评估 | 依据 |
| --- | --- | --- |
| `StateBlock` 空态不再渲染 `ImageOff`；loading/error 保留图标 | **保留** | `designGuards.test.ts` 有反向钉；真实渲染里空态确实只剩文字 |
| 三处 `text-[var(--gosslan-text-body)]` → `text-[length:…]` | **保留** | 原来编译成 `color:14px` 被整条丢弃；修复后可读到 14px |
| Toast/MessageComposer/MessageReceipt 的 `shadow-lg` → 玻璃投影 + 10% 描边 | **保留** | 截图里浮层已无「厚黑阴影」；但**报告写完后仍需配合 A1 改结构** |
| `SettingsToggle` 去掉 `transition-all`，改 `translate-x + transition-transform` | **保留** | 源扫描 `transition-all` 只剩工具类定义；§14.6 判据不再触线 |
| 色板去掉 `hover:scale-110`，按压交给全局 `:active` | **保留** | 悬停不再缩放；但**形状不一致（B3）仍在** |
| 中英两册把「暂无」清零、第二条软化句 | **保留** | `check-i18n` zh=1652/en=1652、死键 0；语气守卫在 `npm test` |
| `index.test.ts` 四条语气判据 + 反例自证 | **保留** | 反例自证可跑，正控两册 0 触线 |
| `designGuards.test.ts` 新增 `TOKEN_UNCONSUMED` 的 `--gosslan-text-caption` 条目 | **保留（不是放宽）** | 该名单有「必须仍然无人消费」的反向钉（`designGuards.test.ts:4258-4264`），登记项不能变成过期借口 |
| `verify.mjs` 第 23 步 `why` 点名语气判据 | **保留** | 步数仍 25/31，`check-doc-numbers` 不受影响 |
| `GroupFilesPanel` 的 `text-body` → `text-2` | **保留** | 修的是颜色误用；悬空「·」是**另一个**问题（B6） |
| `sources.md` §7 署名 + README Design references | **保留（按修正指令不动）** | 出处标注，不是 vendoring |
| ChatWindow/MessageItem 的 `shadow-lg` 未动 | **保留（明确挂起）** | 等玻璃线合入；仓库仍有 6 处 `shadow-lg` + 1 处 `shadow-xl` |

**需要「改写」的两项（不是回退）**：
1. Toast 只换了投影，**没解决叠 3 条 + 长句**（A1；「重复」一项已更正为误判）。下一步是把失败说明从 toast 挪到页面内错误档。
2. 色板只去掉缩放，**形状不一致**（圆形 preset vs 原生方色块，B3）没解决。

---

## 6. 拍不到的场景 + 原因（不伪造）

| 场景 | 状态 | 原因 |
| --- | --- | --- |
| 1:1 有真实数据的聊天（长历史、滚动到顶/底、虚拟列表） | **只拍了组件夹具** `probe-tail*.png`、`probe-rowpair.png` | 浏览器预览无 Tauri IPC，构造不出真实会话/消息；夹具是真实组件 + 真实渲染，但不是完整页面 |
| 群聊（成员、@、群公告、群文件有内容） | **拍不到** | 同上：需要真实群数据与后端 |
| 会话内搜索 + 全局搜索的「有结果、可滚动」 | 只有 `probe-search*.png`（1 个夹具会话、3 条命中、时间戳是 1970） | 真实索引在 SQLite 里，浏览器预览读不到 |
| 文件传输进行中/失败/取消/重试 | 只有 `files-run-files*.png`（群文件列表 + 失败横幅） | 传输队列与进度来自后端事件；浏览器里没有对端 |
| 群组列表、群详情、群任务（有数据） | `todos-1440-light.png` 只到防御分支 | `todos.html` 正常入口必须带真实 `groupId`，浏览器无法满足 |
| 长按菜单/右键菜单（移动端） | 桌面拍到了「更多 / 新建」下拉；**长按菜单未拍** | 需要真机触控事件；CDP 的 `Input.dispatchTouchEvent` 可模拟，但菜单项依赖真实消息 |
| 离线态 | 拍到了（左上「离线（局域网未连接）」按钮 + 失败 toast） | — |
| Tauri 原生控件（`<input type="color">` 真实外观）、Windows/Linux 字体、真机 `safe-area` | **拍不到** | 本机只有 macOS + Brave 预览 |
| `settings-390-light.png`、`todos-1440-light.png` | **非真实场景** | 前者是桌面独立窗口硬压到 390；后者无 `groupId` 走防御分支。两张都保留，但不用于结论 |
| `startup-error` 页底部多一行 `TypeError: … reading 'invoke'` | **浏览器 mock 泄漏**，不是产品缺陷 | 没有 Tauri 后端时 `invoke` 不存在；真机不会出现 |

---

## 7. 「未改代码」证明（审查阶段快照，不含后续阶段改动）

```text
$ git log -1 --format='%H %s'
1d69b72e9eca1964617941950e5278de0cb5ec72 feat(ui): 去掉界面的 AI 味（空态 / 阴影 / 动效 / 文案语气）+ 署名 unslop 方法论 [impact]

$ git status --short
?? .claude/
?? docs/notes/unslop-review-2026-11-06/

$ git diff --stat
（空）

$ git rev-list --left-right --count origin/main...HEAD
0	1
```

- 唯一新增：`docs/notes/unslop-review-2026-11-06/`（本报告 + `plan.md` + `shots/`）与未跟踪的 `.claude/`（上一轮按旧指令拷的技能副本，已按裁决 6 删除）。
- `1d69b72e` 仍在分支本地，**未 push、未合 main、未追加改动**。
- 版本读数：`小院儿 v5.18.34`（页脚与设置「关于」一致）；本 worktree 在 `main` 之上 ahead 1。

---

## 9. 阶段执行记录

### 阶段 1 — 失败态与通知（2026-11-06，进行中）

- **基线**：`git switch -c unslop/polish release/5.18.35`，HEAD `4ee9a1f1`（确认：`66d38da9` 已含五条 UI 线）。
- **已修**：
  - A2 双后缀：`friend.add.scanFail` / `friend.add.channelFailed` 不再自带「请稍后重试」；新增单测护栏（扫描所有 `errorText`/`toastError` 前缀，zh/en 两册都不得含后缀）。
  - A4 标题=说明：收藏 / 链接 / 日志 / 群文件 / 群任务 / 搜索 / 共享目录 7 处改 `detailText`（正文只给说明，不再重复标题）。
  - A5 添加好友弹窗：说明左对齐、去掉 `opacity-70`（改 `--gosslan-text-2`）、「重新扫描 / 复制邀请」升为 `PrimaryBtn` / `SecondaryBtn` 的 `large` 规格。
  - `errtext` 探针判据同步搬迁：正文期望由 `errors.joined` 改为 `errors.rule.system`，并加「正文不得包含标题」的反例自证（改回 `errorText(e, t("logs.loadFail"))` 即红，已实测 2 条 FAIL）。
- **未改（需裁决）**：A1 的「叠 3 条 / 长句遮挡」要改成「toast 短句 + 页面内错误档 + 可选动作」，属于交互变化，按指令先报后改。
- **未做**：`errorText` 本身的口径未动（只修前缀与护栏），避免全局文案口径变化面过大。

### 阶段 5 — 动效取舍（2026-11-06）

- **B7 色雾（桌面保留 / 移动端降档）**：桌面 4 层 radial 与 72·96·120s 原样不动。
  `@media (max-width: 767px)` 把 A/B 的漂移冻结到初始帧（速度降一档到 0），C/D 早已隐藏
  ⇒ 竖屏可见 2 团、运行中动画 0 个；不整体降饱和、不隐藏整层。
  同口径写进 `ambient-motion.md` §5.2（与 <480 的 JS `narrow` 判定对齐）。
- **B8 消息骨架静态化**：`ChatWindow.vue` 9 处与 `MessageImageBubble.vue` 1 处
  `animate-pulse` 全部移除，改静态灰块 + `gosslan-skeleton-in`（240ms opacity 一次淡入，
  reduce 档不播，符合 §11.3.7）。锚点 `data-msg-skeleton` 供 `--only=scrollswitch` 复用，
  探针里旧的 `.animate-pulse` 选择器同提交迁走（判据搬迁，不是删断言）。
- **判据**：新增 `designGuards` SK-01（两个文件 0 脉冲 + 两个锚点分母现算）；
  两条反例自证：塞回 `animate-pulse` 必红、把 `data-img-skeleton` 改名必红。
- **边界核对**：基点上 `ChatWindow.vue` / `MessageItem.vue` 的 `shadow-lg|xl` /
  `transition-all` / `hover:scale` 均已是 0 处（玻璃线已收）；`ImageLightbox` 的
  3 处 `shadow-lg` + 1 处 `shadow-2xl` 保留 —— 它们压在**任意照片**与黑底浮控之上，
  需要的是"与照片内容分离"的抬升，玻璃 token 的投影是给应用表面上的面板用的，不适用。

### 阶段 6 — 搜索命中与焦点框（2026-11-06）

- **C1 命中色**：[highlight.ts:13](file:///Users/wendongfu/Documents/code/gosslan-unslop/src/utils/highlight.ts#L13)
  `<mark>` 从 `bg-yellow-200 dark:bg-yellow-800/50` 换成
  `bg-[var(--gosslan-primary-light)] text-[var(--gosslan-text)]`。选 `--gosslan-text` 而不是
  `--gosslan-accent-ink`：后者在 12% 主题色底上实测亮 4.35 / 暗 3.69，不达 4.5。
- **C2 焦点框**：`ChatSearchDialog` 输入框**未改**。复核确认可见提示是文本控件自己的
  `box-shadow: inset 0 0 0 1px var(--gosslan-primary)`（`controls.md` §4.3 既有方案），
  `outline` 是 Tailwind `outline-none` 留下的 2px **透明**环（`outlineStyle` 非 none 但 alpha≈0）。
  按用户裁决：焦点环不算"有边框按钮"，保留键盘可达性现状。
- **分档读数（`--only=stage6mobile`，5 档 × 亮/暗，`marks=3`）**：

  | 宽度 | 改动前（yellow） | 改动后（token） | 是否回归 |
  | --- | --- | --- | --- |
  | 360×640 亮 | 18.05 | 12.28 | 否（≥4.5） |
  | 360×640 暗 | **2.40** | **8.35** | 否（由不合格转合格） |
  | 390×844 亮/暗 | 18.05 / 2.40 | 12.28 / 8.35 | 否 |
  | 430×932 亮/暗 | 18.05 / 2.40 | 12.28 / 8.35 | 否 |
  | 768×800 亮/暗 | 18.05 / 2.40 | 12.28 / 8.35 | 否 |
  | 1280×800 亮/暗 | 18.05 / 2.40 | 12.28 / 8.35 | 否 |

  横向溢出 5 档 × 2 主题均为 `overflowX=0`；弹窗矩形全部在视口内。
  移动端三档都真实走到搜索弹窗分支（不是"走不到"）。
- **判据**：`--only=search` 23/23 绿；`--only=stage6mobile` 10/10 绿；
  `highlight.test.ts` 新增"命中底色/文字走 token、不得出现 `bg-yellow|yellow-\d|#hex`"。
- **反例自证**：把 `MARK_OPEN` 改回 yellow → `highlight.test.ts` 该条红，
  同一次改动下 `stage6mobile` 5/10 FAIL（暗档 2.40 < 4.5），恢复后 10/10 绿。
- **截图**：`shots/stage6/search-{360x640,390x844,430x932,768x800,1280x800}-{light,dark}.png`。

---

## 追加问题 — 自愈横幅遮住内容（2026-11-06 用户截图）

- **定位**：文案 `recovery.title` / `recovery.body` 在
  [RecoveryNotice.vue](file:///Users/wendongfu/Documents/code/gosslan-unslop/src/components/RecoveryNotice.vue)；
  由 [App.vue](file:///Users/wendongfu/Documents/code/gosslan-unslop/src/App.vue) 的 `recovery`
  状态渲染。旧规则 `.recovery-notice { position: fixed; top: 16px; left: 50%;
  width: min(560px, 100vw - 24px) }` —— 浮层，必然压内容。
- **修法（规则，不是挪坐标）**：系统提示改为**占独立占位行**。`ResponsiveLayout`
  新增 `#banner` 插槽（caption 之后、三列之前；移动端无 caption，等价于 safe-top 之后），
  App 把 `RecoveryNotice` 放进去；`.recovery-notice` 改为 `position: relative`、`flex: none`、
  全宽居中。不引入新交互（仍是「知道了」关闭 / 「立即重启」），不删任何动作。
- **分档读数（`--only=recoverynotice`，提示卡片矩形 × 内容矩形，单位 px²）**：

  | 宽度 | 改动前：列表头 / 聊天头 / 标题栏 / 可操作元素 | 改动后 | 是否回归 |
  | --- | --- | --- | --- |
  | 1280×800 | 0 / 26880 / 6720 / 0 | 0 / 0 / 0 / 0 | 否 |
  | 1024×700 | 3936 / 22944 / 6720 / 784 | 0 / 0 / 0 / 0 | 否 |
  | 768×800 | 10080 / 16800 / 6720 / 2774 | 0 / 0 / 0 / 0 | 否 |
  | 640×480 | 33600 / 0 / 无 caption / 9112（搜索输入框） | 0 / 0 / — / 0 | 否 |
  | 390×844 | 27300 / 0 / 无 caption / 3718（搜索输入框） | 0 / 0 / — / 0 | 否 |

  改后内容整体下移：1280/1024/768 的列表头与聊天头顶边由 `y=28` → `y=104`；
  640/390 由 `y=0` → `y=76 / 86`。五档 `overflowX=0`，卡片整卡在视口内。
- **"半行字"的证伪**：按 `scrollHeight-clientHeight` 口径，横幅自身前后都是 **0 / 0**，
  并没有被自身容器裁切。截图上方那半行经矩形定位是 **caption 被 `top:16px` 横切**：
  caption 高 28px，横幅从 16px 起 ⇒ 上 16px 露出、下 12px 被盖，交叠 6720 px²。
  改成占位行后 caption 交叠 = 0，半行字随之消失（640/390 无 caption，症状不存在）。
- **判据与反例**：`--only=recoverynotice` 15 条（5 档 × 3 条）。把 `.recovery-notice`
  改回 `position: fixed; top:16px` ⇒ 9 条红（640/390 的 `overlapList` 与 `maxOp` 先红），
  恢复后 15/15 绿。
- **回归**：`npm test` 1783 pass / 0 fail；`npm run build` ✓；`check-i18n` zh=en=1651 死键 0；
  文档引用 76 处 / 硬数字 290 条 ✓。
- **截图**：`shots/recoverynotice/recovery-{1280x800,1024x700,768x800,640x480,390x844}-{light,dark}.png`。

---

## 8. 需要你裁决的 6 件事（我不猜）

1. **色雾**（4 层 radial + 72/96/120s 循环）：保留 / 降饱和 30% / 只在空态出现 / 全关？
2. **消息骨架 `animate-pulse`**（9 处）：改静态骨架 / 保留？
3. **搜索高亮的黄色 mark**：换 token（accent-soft）/ 保留黄色惯例？
4. **页脚版本号**「小院儿 · v5.18.34」：保留 / 移到关于？
5. **双 CTA**（左栏 xs「添加好友」+ 中央 large）：只统一规格（不删）——确认可以动规格吗？
6. **两个文件**：已安装技能目录里的 `LICENSE` 删不删？`.claude/skills/unslop/` 副本删不删？
