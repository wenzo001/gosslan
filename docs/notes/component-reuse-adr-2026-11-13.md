# 组件复用与共享原语 ADR（2026-11-13）

承接两份审计：`docs/notes/reuse-and-component-audit-2026-11-13.md`、
`docs/notes/reka-ui-adoption-audit-2026-11-13.md`。本文把它们的评估项落成**决策记录**：
哪些本轮已改、哪些只评估不改、各自的理由与回滚面。

- 日期：2026-11-13
- 边界：**charCount 收敛本轮已实施并通过前端快速门禁**；日历 / 超时 / 防抖 / 日期格式
  四项是**评估结论，本轮不改业务代码**，也未为它们运行行为测试或真机验证。
- 成熟度信息来自 Reka 官方组件文档（见文末链接），引用时以官方当前标注为准。

---

## 决策 1：码点计数收敛到 `text.ts`（本轮已实施）

**状态：已接受并落地。**

审计 P2 指出 `validation.ts::charCount` 自称长度唯一实现，而 `externalLinks.ts` 又手写
`[...s].length`。旧守卫只扫 `validation.ts`，看不见第二份——正是"检查还在跑、但已查不到
东西"的形状。

落地：

- 新建无业务依赖的叶子 `src/utils/text.ts`，`charCount` 是唯一实现（`[...s].length`，
  与 Rust `chars().count()` 同尺）。
- `src/utils/validation.ts` 与 `src/utils/externalLinks.ts` 都 import 它；外链校验因此
  不必反向依赖整套 IPC validation 模块。`src/components/ui/CharCounter.vue` 改从 `text.ts` 取尺。
- 守卫（`src/utils/validation.test.ts`）从"只扫 validation.ts 期望 1 处"改成**扫全仓生产码**
  （剥注释后数 `[...x].length`），断言恰好只剩 `utils/text.ts` 一处。反例自证：任何文件
  再手写一遍码点数法即红；把家挪走或删掉也红。

验证：`node --test src/utils/validation.test.ts src/utils/externalLinks.test.ts` 通过；
`npm run verify`（快速层 26 步）`EXIT=0`，含中英两 locale 复跑与构建。

回滚面：纯前端、无行为变化（`charCount(s)` 与原 `[...s].length` 逐字等价）。

---

## 决策 2：Todo 日历暂不迁 Reka Calendar，先补自绘网格的可访问性（评估）

**状态：建议推迟迁移；本轮不改代码。**

现状（`src/components/TodoAttrDateField.vue`）：

- 弹层壳已复用 Reka Popover（经 `TodoAttrField`）；面板内是**自绘 7×6 月历**，42 个日期格
  都是普通 `<button>`，只有 `@click` 与 `aria-current="date"`。
- **缺口**：没有 `role="grid"`/`gridcell` 语义、没有 roving tabindex、没有方向键导航。
  键盘用户要 Tab 穿过最多 42 个按钮；读屏不会把它念成日历网格。
- 值契约：`YYYY-MM-DD`、空串=清空、本地日历日（刻意不用 `toISOString()` 以免东八区凌晨差一天）、
  月标题按 `currentLocale()` 用 `Intl.DateTimeFormat` 格式化、今天/清除动作。
- 自绘的理由（组件注释，用户 2026-11-05）：原生 `input[type=date]` 拾取器由系统 WebView 绘制，
  宽度/圆角/阴影/行高不受控，与同列标签面板"不是一家"。

Reka Calendar / DatePicker 评估：

- 官方当前标注 **Alpha**；日期能力依赖 `@internationalized/date`（本仓锁文件里已有
  3.12.4，是 reka-ui 的传递依赖，但**不是** package.json 的直接依赖；若采用需提为直接依赖）。
- 提供完整键盘导航、受管焦点、本地化，日期模型是 `CalendarDate`（带时区语义）。
- 风险：Alpha 稳定性、`CalendarDate` 与本仓"本地日历日 + `YYYY-MM-DD` 字符串"契约的转换、
  Android/iOS WebView 行为、深色主题与 `.gosslan-menu` token 集成、清空/最小日期等边界。

**建议**：

1. 短期（低风险、不引依赖）：给现有自绘网格补 `role="grid"` + `gridcell` + roving tabindex +
   方向键（Left/Right/Up/Down/Home/End/PageUp/PageDown）导航。这直接补上可访问性缺口，
   不动值契约、不引 Alpha 依赖。需配键盘行为判据与反例自证。
2. 中期：待 Reka Calendar 脱离 Alpha 后重新评估迁移；迁移前必须验证跨时区日期稳定性、
   移动端 WebView、键盘/读屏、深色主题、清空/最小日期契约，并保留 `YYYY-MM-DD` 数据契约与回滚方案。
3. 不为"看起来都来自库"而迁：`AppDateField.vue` 是原生 `input[type=date]` 薄封装，
   移动端体验最好，**不是**自动迁移项（与 Todo 自绘网格是两件事，分开判断）。

不采纳"现在就迁 Reka Calendar"：Alpha + 新直接依赖 + 日期模型转换，收益（库自带键盘导航）
可由短期方案以更低风险达成。

---

## 决策 3：超时包装只评估共享底层计时器原语，业务策略留在调用点（评估）

**状态：本轮不改代码；记录行为对照，待确有第二消费者再抽。**

四处 `withTimeout` 与一处 `waitPreviousExit` 都用 Promise + 计时器，但**契约各异**：

| 调用点 | 超时结果 | 错误类型 | 计时器清理 | 迟到结果策略 |
|---|---|---|---|---|
| `src/components/TaskCenter.vue` `withTimeout` | resolve 哨兵 `"timeout"` | 无（resolve） | settle 时 clearTimeout | resolve 先胜（二次 resolve 无效） |
| `src/updater/service.ts` `withTimeout` | reject | `Error("timeout")` | 注册进 `timers` Set，dispose 可清 | `timers.delete` 守卫丢弃迟到 |
| `src/updater/androidService.ts` `withTimeout` | reject | `Error("timeout")` | 同上（注册 + dispose） | 同上 |
| `src/utils/previewGalleryState.ts` `withTimeout` | reject | `Error(message)`（调用方传） | settle 时 clearTimeout | 调用方用代次号丢弃迟到 |
| `src/stores/useAppStore.ts` `waitPreviousExit` | resolve `null` | 无 | **先胜时未清计时器** | Promise.race 先胜 |

结论：

- 真正共通的只有"计时器 + race"这一层机制；超时结果（resolve 哨兵 vs reject）、错误码、
  dispose 清理、迟到结果策略都是**业务决策**，不能为减少重复行而抹平。
- 若未来抽共享原语，应显式参数化 `{ onTimeout: "resolve"|"reject", message?, registerTimer? }`，
  并保留各调用点的业务守卫；当前消费者契约差异大，**抽取收益不足以抵消耦合风险**，暂不动。
- **真实小缺口**（值得单独一轮修）：`waitPreviousExit` 的 race 计时器在 `p` 先胜时不被清除，
  会在 `ms` 后空触发一次（resolve 进已 settle 的 race，无副作用，但计时器未清）。属清理卫生问题，
  非功能缺陷；本轮记录，不顺手改（半径控制）。

---

## 决策 4：防抖暂不机械换 VueUse（评估）

**状态：本轮不改代码。**

`src/stores/useChatStore.ts::debounceMarkRead` 自管 300ms 计时器，重入即清、`scope.onDispose`
取消，且开火前有三条业务守卫（当前会话、应用前台、`chatViewerLooking()` 聊天视图真可见）。
项目已用 VueUse 的 debounce API。

结论：VueUse `useDebounceFn` 提供 cancel，但**dispose 集成 + 三条业务守卫**必须先证明语义
完全一致才能替换；"回到前台补发已读"那条也读同一份 `chatViewerLooking()` 口径。未证明等价前
不机械替换（避免替用户判已读的回退）。列为可选治理项。

---

## 决策 5：日期格式先统一策略再谈合并（评估）

**状态：本轮不改代码。**

项目已有 `src/utils/time.ts` 与 Day.js；局部组件仍用原生 `Date` / `Intl.DateTimeFormat`
（如 Todo 月标题按 `currentLocale()`）。调用场景分别是日期-only、时间戳、平台本地显示。

结论：先统一产品 locale/时区/精度策略，再决定是否扩展公共 formatter；**不要仅凭出现
`new Date()` 就判重复并合并**。本轮不动。

---

## 与产品目标的匹配

- 交互内核继续由 Reka + 公共壳承担（`BaseModal` / `SettingsSelect` / `ContextMenu`），
  业务层只留内容、权限、产品状态；不为"零自研"机械替换业务表现层。
- 自有视觉 ≠ 自研行为：Reka 是 headless，颜色/圆角/间距仍由项目 token 与 wrapper 负责。
- 保留自研必须附理由：消息虚拟列表锚定、弹层全局互斥、对象 URL 生命周期、二维表情网格、
  搜索框方向键（`src/components/search/ChatSearchDialog.vue` 已实现上下键/回车，**不是缺口**）
  都含产品/平台契约，不按行数判"重复造轮子"。

## 本轮验证边界

- **已实施并验证**：决策 1（charCount 收敛）——`node --test` 两个测试文件通过、`npm run verify`
  快速层 26 步 `EXIT=0`（含中英复跑与构建）。
- **仅评估、未改代码、未跑行为测试**：决策 2–5。其中的键盘/读屏/WebView/时区结论是源码审阅
  与官方文档核对，不代表真机或运行时验证。
- 前端盘点里的文件数/行数/依赖统计随源码变化，引用以脚本现算为准。

## 官方资料

- [Reka UI Calendar](https://reka-ui.com/docs/components/calendar)：当前标注 Alpha，依赖 `@internationalized/date`，`CalendarDate` 模型，自带键盘导航与受管焦点。
- [Reka UI Date Picker](https://reka-ui.com/docs/components/date-picker)：同样 Alpha 与日期依赖。
- [Reka UI Dropdown Menu](https://reka-ui.com/docs/components/dropdown-menu)：菜单键盘/焦点/定位/关闭行为（现有公共壳已采用）。
