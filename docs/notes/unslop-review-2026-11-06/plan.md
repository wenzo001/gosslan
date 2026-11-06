# 改造方案（草案）与 Gosslan 专属约束

> 配套证据见 [report.md](report.md) 与 `shots/`。本文件是**方案**，不是成品文档；确认前不动 `src/`。

## 1. 总原则

- **不重写**。先把失败态修到「说一次、说清楚、不挡路」，再谈视觉。
- 一次只做一段，每段单独提交、单独跑门禁；任何一段验收不过就停在原地。
- 优先级固定为：**稳定性 > 流畅性 > 正确性 > 原生体验 > 安全性 > 可维护性 > 扩展性**。视觉改动排在这些之后。
- 涉及既有交互习惯的（双 CTA、页脚版本号、色雾、骨架脉冲、搜索高亮），先问再动。
- 玻璃线（`release/5.18.35`）合入前不碰 `ChatWindow.vue` / `MessageItem.vue`。

---

## 2. 分阶段方案

### 阶段 0 — 决策（本轮终点，不动代码）

- 范围：`report.md` §8 的 6 个裁决项。
- 产出：一份「保留 / 改 / 删」清单，作为后续每段的输入。
- 回归：无代码改动，只需 `git status` 证明工作区干净。

### 阶段 1 — 失败态与通知（P1，建议第一个做）

- 范围：`ToastHud.vue` / `ToastList.vue`、`useErrorText.ts`、`AddFriendModal.vue`、收藏/链接/日志三处错误档。
- 现有问题：A1（叠 3 条 + 重复 + 长句遮挡）、A2（双后缀）、A4（标题=说明）、A5（弹窗 316px 密集小字）。
- 设计方向：
  - toast 只留「一句短结论 + 可选一个动作」；长说明进页面内错误档，同一 `code` 去重。
  - `errorText` 的 unknown 分支不再追加「请稍后重试」；改成「前缀 + 下一步」。
  - 错误档说明位写**可行动作**，不重复标题。
  - 添加好友弹窗改左对齐、12px、行高 1.6；①②③ 拆成列表；两个文字按钮升为次按钮规格。
- 回归检查项：
  - `npm test`（重点 `storeContract` / `designGuards` 的错误出口断言）
  - `check-i18n.mjs`（zh/en 键数一致，死键 0）
  - 新增单测：前缀已含「请稍后重试」时不得二次拼接（中英各一条）
  - 截图复拍：`contacts-1440-light`、`contacts-390-light`、`dialog-addfriend-1440-light`
  - 探针：`--only=netcard,diag,crashnotice,historyerr`
- 风险：toast 去重可能吞掉「同一错误连续发生两次」的真实信息 ⇒ 用计数徽标（×2）保留信息量；错误档改造会碰 `StateBlock` 的调用方，注意不要回退 `1d69b72e` 的空态口径。

### 阶段 2 — 空态与品牌签名

- 范围：`ResponsiveLayout.vue` 的两个 64px `NavIcon` 空态、`links` 中央标题重复、双 CTA 规格。
- 现有问题：A3、C3、C6。
- 设计方向：
  - 空态只留「结论 + 一句说明 + 一个主动作」；删掉 64px 通用图标。
  - 签名细节换成只属于 gosslan 的事实：本机设备名 / 节点指纹 / 「无服务器 · 数据仅存本机」中的**一条**（一条，不是四条）。
  - 双 CTA **保留**（用户 2026-09-12 #13 的明确要求），只统一按钮尺寸与文案。
- 回归检查项：`designGuards` 里关于空态与 `friendsLoadFailed` 三态口径的断言；`--only=links,navicon,overlay`；复拍 `main-1440-*`、`links-1440-light`。
- 风险：删图标会牵动居中留白，需要同时调垂直间距；不要改到「会话框页面和聊天列表页面都要有兜底」那条既有要求。

### 阶段 3 — 设置与控件统一

- 范围：`AppearanceSection.vue` 色板、`SettingsPanel.vue`/`FriendRequestList.vue` 的 uppercase、`EmojiPicker.vue` 投影、文件面板关闭按钮。
- 现有问题：B3、B4、B5、C5。
- 设计方向：自定义色入口与 6 个 preset 同尺寸同形状；小节标签改 sentence case；浮层统一玻璃投影；关闭按钮统一为裸图标 + `tap-safe`。
- 回归检查项：`designGuards`（TOKEN_UNCONSUMED 反向钉、阴影 token）；`--only=fontsel,switch,select,emoji,overlay`；复拍 `settings-1440-light/dark`、`probe-settingsmobile`。
- 风险：原生 color input 在 Tauri 内核下外观可能不同，**需真机复核后再定形状**；uppercase 改动会影响英文换行，需中英各拍一次。

### 阶段 4 — 日志页

- 范围：`LogViewer.vue`。
- 现有问题：A6（3.24:1）、B1（标题重复）、B2（chip 与开关同款）。
- 设计方向：标题只在窗口栏出现一次；「自动刷新」改 ink 或双档；合并重复改 switch。
- 回归检查项：`--only=logs,diag`；`logs-1440-light` + `probe-logsmobile` 复拍；对比度脚本复算 ≥4.5。
- 风险：日志页每 2 秒全表重算，改样式不要碰 `highlightText` 的缓存逻辑；不要把 chip 尺寸改到低于 32px 点击高度。

### 阶段 5 — 动效取舍（等阶段 0 裁决）

- 范围：`style.css` 色雾、`ChatWindow.vue` 骨架、`MessageImageBubble.vue` 占位。
- 方向（三选一，按裁决）：保留但降饱和 / 改静态骨架 / 全关（尊重 `prefers-reduced-motion` 与设置里的「减少透明效果」）。
- 回归检查项：`--only=ambient,perf`、`src/utils/receiptMotion.test.ts`、`npm run perf`（若存在）。
- 风险：色雾是产品设计语言的一部分，动它等于改品牌；骨架改静态会失去「正在加载」的时间感 ⇒ 需配一条 240ms 淡入。

### 阶段 6 — 搜索细节（等真机复核）

- 范围：`highlight.ts` 命中色、`ChatSearchDialog.vue` 焦点框。
- 现有问题：C1、C2。
- 回归检查项：`--only=search`；`probe-search` 复拍；Tauri 真机确认焦点框来源。
- 风险：黄色是搜索高亮的行业惯例，换 token 可能降低命中辨识度 ⇒ 保留黄色也合理，先裁决。

---

## 3. 统一门禁（每段都必须过）

1. `npm test`（含 i18n 语气守卫与 designGuards）
2. `npm run build`
3. `npm run verify:full`（31 步；末行必须是全绿原文）
4. `node scripts/check-ui-runtime.mjs --only=<本段相关段>`（端口避开 1420/5199）
5. `node scripts/check-change-budget.mjs --staged` → 按 L1/L2/L3 在**标题行**带 `[plan]` / `[impact]`
6. 复拍本段截图到 `docs/notes/unslop-review-<date>/shots/`，与旧图并排对照

---

## 4. 明确不做

- 不引入 Ant Design Vue、不新增任何 UI 依赖、不 `npm i playwright`、不下浏览器内核。
- 不重写组件树、不换图标集、不改配色体系、不重做布局结构。
- 不以「更多动画 / 渐变 / 阴影 / 卡片」当升级；不以「换一套模板」当重构。
- 不动业务/协议/E2EE/SQLite/Outbox/Ack/文件传输链路。
- 不碰主工作区、不碰 `release/5.18.35`、不碰 `.aoci/*`。

---

## 5. Gosslan 专属约束（草案，待你确认）

标注说明：**更严** = 比 unslop 原版更严格；**放宽** = 因本仓现状比原版宽松，附理由；**同档** = 与原版一致但落成可判红判绿。

| # | 约束 | 判绿锚点 | 判红锚点 | 与原版 |
| --- | --- | --- | --- | --- |
| G-1 | 不动业务/协议/E2EE/SQLite/Outbox/Ack/文件传输代码 | 每段改动的 `git diff --stat` 只含 UI 文件；`src-tauri/**`、`src/stores/**` 的协议/存储文件零改动 | diff 里出现 `src-tauri/`、`src/stores/chat/{outbox,sync,delivery}.ts`、加密/SQL 文件 ⇒ 直接判红 | 同档（原版只管视觉） |
| G-2 | 优先复用现有组件与成熟开源 | 新样式必须走 `PrimaryBtn`/`StateBlock`/`SettingsToggle`/`glass-*`；引入新组件需在提交说明写明「为什么不能复用」 | 新增一个与 `PrimaryBtn` 同形的按钮组件、或新引第三方 UI 库 ⇒ 判红 | **更严**（本仓组件与 token 密度高，重造必冲突） |
| G-3 | 不引入 Ant Design Vue | `package.json` dependencies 不含 `ant-design-vue`；`rg "ant-design-vue"` 为 0 | 出现该依赖或其 CSS 变量 ⇒ 判红 | 同档 |
| G-4 | 不新增 UI 依赖、不重造已有组件 | `package.json` 的 dependencies 数量不变；`node_modules` 不新增 UI 包；改动文件不新增同名组件 | 依赖清单新增 UI 包、或同目录出现 `XxxV2.vue` 式重复件 ⇒ 判红 | **更严** |
| G-5 | 不以增加动画/渐变/阴影/卡片当升级 | 同一屏内 `gradient` 数量不增；`shadow-lg/xl` 数量不增（现 6+1）；卡片层级不新增 | 改动使上述计数上升 ⇒ 判红（可用 grep 计数脚本作锚） | 同档 |
| G-6 | 桌面/移动/深色同一套语言 | 同一组件在 1440 亮 / 1440 暗 / 390 亮 三张图里，字号阶梯、圆角、间距、按钮规格一致 | 任一档单独出现不同圆角/字号/按钮 ⇒ 判红（截图对照） | 同档 |
| G-7 | 键盘/触控/焦点/可访问性/点击区域 | 所有交互元素有 `aria-label` 或可见文字；命中区 ≥32px（`tap-safe` 可豁免视觉尺寸）；焦点环走 `--gosslan-focus-ring` | 新增裸 `div` 点击、`<button>` 无标签、命中区 <32px 且无 `tap-safe` ⇒ 判红 | **更严**（原版只提「点击区域」，本仓有 focus-ring token 与 tap-safe 约定） |
| G-8 | 异步交互必须有加载·成功·失败·取消四态，且不阻塞 UI | 每个新异步动作能看到四态中的至少三态，且主线程可继续操作 | 只做 loading+success、或失败只靠 toast 而无页面内档位 ⇒ 判红 | **更严**（原版不要求状态机） |
| G-9 | 不改变既有交互习惯 | 双 CTA、页脚版本、TabBar 四项、会话行 64px 等既有约定保持不变；要改必须在提交说明引用「明确问题 + 用户裁决」 | 无裁决就删除/合并/改语义 ⇒ 判红 | **更严**（本仓有大量用户历史裁决） |
| G-10 | 文本对比度 ≥4.5:1（12px 及以上正文） | `contrast.mjs` 对改动页复算全绿 | 出现 3.24 这类读数 ⇒ 判红 | **更严**（原版只讲「一个 accent」，不管对比度） |
| G-11 | 4px 网格与同类同尺寸 | 新样式只允许 2/4 的倍数（小控件内 nudge 允许 2）；同类行同高同 gap | 出现 `mt-[13px]`、`py-[11px]` 式一次性值 ⇒ 判红 | 同档 |
| G-12 | 一个 accent、发丝线代替厚阴影 | 新增浮层用 `--gosslan-glass-2-shadow`；不新增第二个强调色 | 新增 `shadow-xl`、新增彩色描边、把状态色当装饰 ⇒ 判红 | 同档 |
| G-13 | 空态不画通用插画 | 空态只有文字 + 至多一个动作；品牌签名只用本产品事实 | 用 `NavIcon` 64px / 通用图形当插画 ⇒ 判红 | 同档 |
| G-14 | 动效只动 color/bg/border/opacity/transform，一条 ease | `designGuards` 的 §14.6 判据不触线；`transition-all` 计数不增；不使用循环脉冲（除既有骨架，按裁决） | 新增 `transition-[left]`、`hover:scale`、`animate-pulse` 到新元素 ⇒ 判红 | **更严**（本仓 §11.3.7 五条硬约束比原版细） |
| G-15 | 文案只说一次，不喊口号、不写占位话 | `npm test` 的语气守卫（感叹号/「暂无」/中英空话）0 触线；标题与说明不同义重复 | 新增「重磅」「一键搞定」「暂无」；或标题=说明 ⇒ 判红 | **更严**（原版只禁感叹号与营销词，本仓另禁同义重复） |

**放宽项（只有一条，附理由）**：
- G-14 的「不使用循环脉冲」对**既有消息骨架**暂不判红：骨架脉冲承担「正在加载」的时间语义，且 `ChatWindow.vue` 在玻璃线里正在被改。等裁决后再决定是改成静态骨架还是保留。

**优先级冲突时的裁决顺序**（写进约束文档头部）：
`稳定性 > 流畅性 > 正确性 > 原生体验 > 安全性 > 可维护性 > 扩展性`。
即：任何视觉改动与上述任一条冲突时，视觉让步；只有「正确性」以上全部满足，才讨论「像不像 unslop」。
