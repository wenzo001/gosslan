# Gosslan 体验约束层（G-1 ～ G-16）

> v0.1 · 2026-11-06 · 由 unslop 只读审查（`docs/notes/unslop-review-2026-11-06/`）产出的可判红判绿约束。
> 上游方法论与署名见 [sources.md](./sources.md) §7；玻璃、控件、动效的具体规格分别见
> [liquid-glass.md](./liquid-glass.md)、[controls.md](./controls.md)、[ambient-motion.md](./ambient-motion.md)。

## 这份文件回答什么

unslop 风格的视觉判断（4px 网格、一个 accent、发丝线）不足以守住本仓：gosslan 有协议、E2EE、
Outbox、虚拟列表、Tauri 原生化这些 unslop 原版不涉及的面向。本文件把「改界面时不许碰什么、
什么时候算改坏了」落成 16 条可验收约束，供 Code Review 与本仓门禁使用。

## 优先级（冲突时的裁决顺序）

`稳定性 > 流畅性 > 正确性 > 原生体验 > 安全性 > 可维护性 > 扩展性`

任何视觉改动与上述任一条冲突时，视觉让步；只有前六项全部满足，才讨论「像不像 unslop」。

## 约束表

标注：**更严** = 比 unslop 原版更严格；**同档** = 与原版一致但落成可判红判绿。

| # | 约束 | 判绿锚点 | 判红锚点 | 落地门禁 |
| --- | --- | --- | --- | --- |
| G-1 | 不动业务/协议/E2EE/SQLite/Outbox/Ack/文件传输代码 | `git diff --stat` 只含 UI 文件；`src-tauri/` 与协议、加密、SQL 文件零改动 | diff 出现 `src-tauri/`、Outbox / Ack / 加密 / SQL 文件 | 人工 diff + Code Review |
| G-2 | 优先复用现有组件与成熟开源 | 新样式走 `PrimaryBtn` / `SecondaryBtn` / `StateBlock` / `SettingsToggle` / `glass-*` | 新增与 `PrimaryBtn` 同形的按钮组件，或新引第三方 UI 库 | Code Review |
| G-3 | 不引入 Ant Design Vue | `package.json` 无 `ant-design-vue` | 出现该依赖或其 CSS 变量 | `check-deps` / `npm ls` |
| G-4 | 不新增 UI 依赖、不重造已有组件 | dependencies 数量不变；同目录不出现 `XxxV2.vue` 式重复件 | 依赖清单新增 UI 包 | `check-deps` + Code Review |
| G-5 | 不以增加动画/渐变/阴影/卡片当升级 | 同屏 `gradient` 计数不增；`shadow-lg` / `shadow-xl` 计数不增 | 上述任一计数上升 | 源扫描（`rg` 计数） |
| G-6 | 桌面/移动/深色同一套语言 | 同一组件在 1280 亮 / 1280 暗 / 390 亮 三档的字号、圆角、间距、按钮规格一致 | 任一档单独出现不同圆角/字号/按钮 | 截图对照 |
| G-7 | 键盘/触控/焦点/可访问性/点击区域 | 交互元素有 `aria-label` 或可见文字；命中区 ≥32px（`tap-safe` 可豁免视觉尺寸）；焦点环走 `--gosslan-focus-ring` | 裸 `div` 点击、无标签按钮、命中区 <32px 且未 `tap-safe` | `designGuards` + 探针 |
| G-8 | 异步交互有加载·成功·失败·取消四态，且不阻塞 UI | 新异步动作至少可见三态，主线程可继续操作 | 只做 loading+success；失败只靠 toast 而无页面内档位 | 探针 + Code Review |
| G-9 | 不改变既有交互习惯 | 双 CTA、页脚署名、TabBar 四项、会话行高、上传下载入口保持不变 | 无用户裁决就删除/合并/改语义 | Code Review |
| G-10 | 正文文本对比度 ≥4.5:1 | 改动页复算全绿（口径同 AM-15/AM-16） | 出现 3.24 这类读数 | 对比度脚本 + 截图 |
| G-11 | 4px 网格与同类同尺寸 | 新样式只用 2 / 4 的倍数（控件内 nudge 允许 2）；同类行同高同 gap | 出现 `mt-[13px]`、`py-[11px]` 式一次性值 | `designGuards` |
| G-12 | 一个 accent、发丝线代替厚阴影 | 新浮层用 `--gosslan-glass-2-shadow`；不新增第二个强调色 | 新增 `shadow-xl`、彩色描边、把状态色当装饰 | `designGuards` |
| G-13 | 空态不画通用插画 | 空态只有文字 + 至多一个动作；品牌签名只用本产品事实 | 用 64px `NavIcon` 或通用图形当插画 | 截图对照 |
| G-14 | 动效只动 color/bg/border/opacity/transform，一条 ease | `docs/design-guidelines.md` §14.6 与 §11.3.7 不触线；`transition-all` 计数不增；骨架/占位无循环脉冲（SK-01） | 新增 `transition-[left]`、`hover:scale`、新元素上的循环脉冲 | `designGuards`（SK-01）+ `receiptMotion.test.ts` |
| G-15 | 文案只说一次，不喊口号、不写占位话 | `npm test` 语气守卫 0 触线；标题与说明不同义重复 | 新增「重磅」「一键搞定」「暂无」；标题=说明 | `src/i18n/index.test.ts` |
| G-16 | 失败提示分层：toast = **结论 + 一句人话原因**（≤20 字宽）；同屏 ≤2 条；同 key 合并不叠条；超长/技术串只留结论，原因落到页面内错误档；不新增跳转动作按钮 | toast 一行放得下（如「发送失败 · 对方不是好友」）；技术串（错误码 / URL / 十六进制 / 栈帧）只在 console；重复同 key 显示「×N」；390 下 toast 在底部，不压页头/搜索框/列表首行 | 只报失败、不给具体原因；toast 里塞长串原因或「请到设置…」；原因里带 `err:`/`http`/`0x`/栈帧；同屏出现第 3 条；新增「去设置」类按钮；390 顶部被盖住 | `src/utils/errors.test.ts`（`buildToastText` 四条护栏）+ `--only=toast,links` 探针 + 390 截图 |

## 已落地的机器判据（不是口头的）

1. **双后缀**（G-15）：`src/i18n/index.test.ts` 扫描全部 `errorText(...)` / `toastError(...)` 的
   `t("…")` 前缀，zh / en 两册都不得自带「请稍后重试 / Please try again later」。
   反例自证：给一个自带后缀的 `demo.prefix` 必须被同一条函数检出。
2. **标题≠说明**（G-15）：`scripts/check-ui-runtime.mjs` 的 `--only=errtext` 把日志错误档的正文
   期望从 `errors.joined` 收紧为 `errors.rule.system`，并断言正文**不包含**标题那半句。
   反例自证：把调用点改回 `errorText(e, t("logs.loadFail"))` 时实测 2 条 FAIL。
3. **既有动效硬约束**（G-14）：`src/utils/receiptMotion.test.ts` 的「删掉修复就红」反例自证。
4. **失败提示分层**（G-16）：`scripts/check-ui-runtime.mjs --only=toast` 断言同 key 连推两次只留
   一条且带「×2」、第 3 条被 `data-limited` + `inert` 且不可见。反例自证：把 `:limit` 调回 3
   或删掉 `data-toast-count` 徽标，对应断言立刻红。

## 2026-11-06 的六条裁决（约束层的事实来源）

1. **色雾**：桌面 4 层 radial / 72·96·120s 保留；移动端降一档（层数或速度）以省电。
   不整体降饱和、不关闭。（阶段 5 落地：≤767px 只留 A/B 两团且漂移冻结到初始帧，
   雾保留、不再跑动画；见 `style.css` 手机竖屏块与 `ambient-motion.md` §5.2。）
2. **消息骨架**：`ChatWindow` 等 9 处 `animate-pulse` 改为静态占位（G-14 的唯一放宽项就此关闭）。
   判据：`designGuards` SK-01（真实树 + 两条反例自证）；`--only=scrollswitch` 的骨架锚点
   同提交迁到 `[data-msg-skeleton]`。
3. **搜索高亮**：`mark` 改用 accent token，不再用浏览器默认高亮色。
4. **页脚版本号**：移到设置「关于」，页脚只留产品名。
5. **双 CTA**：只统一尺寸/间距/层级，不删除任何入口（受 G-9 保护）。
6. **技能副本**：删除仓库内 `.claude/skills/unslop/`；已安装技能目录的 `LICENSE` 保留（CC BY 4.0 要求）。

## 2026-11-06 的 A1 裁决（失败态/通知）

1. 长句错误 toast 改**结论句**；详细原因与「去哪重连」落到页面内错误档 / 设置页对应分区。
2. 同屏最多 **2 条**；同 key 重复**合并计数**（`×N`），不叠新条。
3. **不新增**「去设置」这类跳转动作按钮；遮挡问题用分层与位置解决，不靠多一条入口。
4. 390 宽下任何 toast 不盖页头标题区、搜索框与列表首行：移动端 toast 固定在 TabBar 之上。
   证据：`docs/notes/unslop-review-2026-11-06/shots/stage2/a1-toast-390-light.png`。

### 2026-11-06 的 A1 修正（替换上面第 1 条的口径）

1. **失败必须给出具体原因**，不能只报失败。toast = 「结论 · 一句人话原因」
   （如「发送失败 · 对方不是好友」）；通用「请稍后重试」不算原因，不拿它凑字数。
2. 以移动端一行为界（≤ 40 显示列 ≈ 20 个汉字宽）：原文超长就只上结论，原因落到页面内错误档。
3. 技术串（错误码 / URL / 十六进制 / 栈帧 / err 对象）**只进 console**，一律不上屏。
4. `links.refreshFail` 五档先加页面内落点：来源条下方 inline 错误行（完整原因 + 原地重试），
   toast 只报结论。证据：`docs/notes/unslop-review-2026-11-06/shots/stage2/a1-links-refresh-fail-1400.png`。
5. 机器判据：`src/utils/errors.test.ts` 的 `buildToastText` 四条护栏 —— 短原因必须上屏、
   超长退回结论、技术串不上屏、全 `CODE_RULES` 中英两册扫宽与扫串。
   反例自证：上限调大 ⇒ 长原因那条红；删掉技术串判断 ⇒ 技术串那条红。
