# 聊天长列表性能专项审计（只读，2026-10-25）

> 审计对象：`src/components/VirtualList.vue`、`ChatWindow.vue`、`src/stores/useChatStore.ts`、
> `src/utils/messageHeight.ts`、`heightCompensation.ts`、`scrollRestore.ts`、消息气泡族。
> 本轮**只读**：没有为审计改动 `src/`、依赖、lock、版本号。
> 量具：`perf/`（真实 `VirtualList` + 真实高度估算）、`scripts/check-ui-runtime.mjs` 的
> `vlist` / `scrollrestore` / `mergeheight` / `msgovf` 段。引擎：headless Brave
> `Chrome/156.0.8078.48`（`GOSSLAN_CHROME` 显式指定），**不是 WKWebView**。

> **2026-10-26 后续（本文是 10-25 快照，正文不改写）**：高度差补偿已内联进
> `VirtualList.vue` 的 `shouldAdjustScrollPositionOnItemSizeChange`
> （谓词 `item.start + item.size <= offset`），独立模块 `heightCompensation.ts` 与其测试已删除；
> `scrollIntent.ts` 里只被测试引用的两个判据（`shouldPinOnItemsChange` /
> `shouldSettleOnItemsChange`）也已删除 —— 生产侧的贴底重置点改成按 `conversationKey` 判。
> 另外 10-25 晚消息列表已迁移到 `@tanstack/vue-virtual`、key 改为 `local_id ?? msg_id ?? id`，
> 所以下文"手写实现 / msg_id 作 key"等描述同样是**当时的实现**，不是现状。

## 0. 结论（TL;DR）

1. **"长列表本身滚不动"不是当前主因。** 产品上界是 1000 条/会话
   （`PAGE_SIZE 100 × MAX_PAGES 10`，`useChatStore.ts:1465-1466`）。在 1000 条合成文本 +
   真实 `VirtualList`/真实估算函数上：冷 16.6 ms/帧、p95 17.7、max 21.8、**长帧（>50 ms）0**；
   暖 16.7 ms/帧、长帧 0；5 个跳转目标全部命中、**重叠 0 / 空隙 0**。
2. 证据指向的是四类**与内容/状态相关**的机制，而不是虚拟化算法：
   ① 测量缓存**没有会话维度**（切会话复用上一条会话的实测高度）；
   ② 滚动修正有 **15 个写入者**，跨层重复补偿；
   ③ 真实内容（代码高亮、图片、文件卡、表情、任务卡）的**异步改高**；
   ④ 每次消息数组 mutation 都重跑 `fold*` 与整表估算。
3. **推荐先修当前实现**，不把迁移 `@tanstack/vue-virtual` 当第一步。理由：库换掉也解决不了
   ①–④；而现有 4 段探针（13/5/9/80 条）已经绿，迁移有明确回归面。迁移必须先在**同一套
   量具 + 同一份代表性数据**上做原型 A/B，并按 §8 的阈值判定。
4. 本轮**没有测**：真机真实数据的冷启动/热切换耗时、TanStack A/B、用户手势期间迟到测量、
   长时间切换后的堆/DOM/监听器。它们列在 §9，是实施阶段的第一批任务——这里不假装已证。

## 1. 证据等级

| 等级 | 含义 | 本报告中的例子 |
|---|---|---|
| **已证** | 本轮现读源码或现跑量具 | 1000 条冷/暖帧数据；探针 4 段绿；`heightOverride` 无会话键；`key` 回退索引 |
| **候选** | 静态证据支持，但未在真机复现 | 首次切换抖动由"估算 vs 实测差 + 无会话缓存"造成；热启动更稳是因为旧测量残留 |
| **未测** | 需要新量具/真机 | 冷启动到布局稳定的毫秒数；TanStack A/B；长时内存曲线 |

## 2. 当前实现（事实）

### 2.1 库与几何
- 消息列表是**手写** `src/components/VirtualList.vue`（非库）。
- `@tanstack/vue-virtual@3.13.47` 已安装，但**只服务** `src/components/LogViewer.vue:4`
  （日志窗口，`estimateSize: () => 26`）。
- 项目**没有** `vue-virtual-scroller`。
- 几何：前缀和 `offsets` + `estimateHeight`（`ChatWindow.vue:468-480` →
  `messageHeight.ts:223-260`；`bubbleCache` 键 = 字号 + `msg_id`，上限 50 000）。
- 行高：一个 `ResizeObserver` 管所有可见行（`VirtualList.vue:170-191`），写入
  `heightOverride`（`:52`，FIFO 2000）；`commitHeight` 拒绝 `<= 0`（`:96-100`）。

### 2.2 身份
- `keyOf` = `msg_id ?? id ?? ""`（`VirtualList.vue:62-64`）。
- v-for `:key` = `msg_id ?? index`（`:642`）；`data-vlist-key` = `msg_id ?? id`（`:644`）。
- **无 `msg_id` 时回退索引**；乐观消息的 `tmp-*` id 之后会被替换 ⇒ key 变化、旧 override 变孤儿。

### 2.3 缓存
- `heightOverride` 是 `VirtualList` 实例字段（`:52`），`ChatWindow` 切会话**不重建**
  （`ResponsiveLayout.vue:995-998` 无 `:key`）⇒ 测量跨会话混用。
- 宽度/字体/主题变化**没有失效**：字号只影响估算（`messageHeight.ts:129-147`），
  已实测过的行要等下一次 RO 才更新。
- `scheduleRemeasure`（`:193-210`）在 `visible`/`items` 变化时**重建 RO**（`:549`、`:566`）。

### 2.4 滚动写入者（至少 15 个）

| 机制 | 位置 | 与谁抢 |
|---|---|---|
| 高度差补偿 | `VirtualList.vue:128-141` + `heightCompensation.ts:30-43` | `pendingJump`、settle hold |
| `pinned` / `schedulePin` / `pinToBottom` | `:281-321`、`:592-601` | 用户上滑、jump、settle |
| `scrollToBottom` API | `:405-418` | restore、unread jump |
| `scrollToIndex` + 10 Hz 轮询 1.5 s | `:431-498` | loadMore 插入、settle |
| prepend 锚定 | `:506-523` | 估算漂移、remeasure 补偿 |
| 切会话 pin / `armSettleHold` | `:551-585` | ChatWindow 的 nextTick 贴底 |
| ChatWindow unread/locate/append 三条 | `ChatWindow.vue:924-935,982-999,1082-1112` | VirtualList 自动贴底 |
| `scrollRestore` 策略 | `ChatWindow.vue:93-118`、`scrollRestore.ts:33-71` | 切回贴底、unread jump |
| 原生锚定 | `style.css:1606` `overflow-anchor: none` | 已关闭（否则与补偿竞争） |

### 2.5 历史与切换
- `loadMoreMessages`（`useChatStore.ts:1658-1685`）在 `scrollTop < 60` 触发（可能每帧）；
  插入前按估算差补偿（`VirtualList.vue:506-523`），新行测到后只付完全在视口上方的差值。
- 切会话：没有 `StaleGuard`（消息流）；`pendingJump`（`:431`）与 `settleTimer`（`:235`）
  **只按 msg id**，不按会话；旧会话的迟到回调仍可能改当前列表。

### 2.6 每消息成本（静态读出）

| 类型 | 首次挂载同步工作 | 异步改高 | 备注 |
|---|---|---|---|
| 纯文本 | 4 次全量正文扫描（`parseQuote`×2、`splitEmoji`+`linkify`、`textNeedsClamp`） | 无 | 每次滚入都重做 |
| 代码卡 | **同步 `highlightAuto`（15 语言）**，每个实例一个 `<style>`（`CodeBlock.vue:58,96`） | 无 | 滚入 CPU 峰值 |
| 图片 | `<img>` 故意 eager；骨架预占 288 | 自然高度（横图缩 ~171 px）、失败 128 | RO commit + 补偿 |
| 文件卡 | 每行一次 `mediaPresent` IPC；进度/状态/投递页脚 | 进度条 ±20 px、换图时整卡换组件（92→288→自然） | 二次改高 |
| 表情 | 第一条回应插入条带（~+30 px）；每条一个 `strip` RO | 换行/缩放 | `chipTitle/summarizeActors` 在 render 里重算 |
| 群任务卡 | `parseTodo` 在卡片/估算/`foldTodos` 三处各解析一次 | 实时 `liveTodo` 改标题/描述/图带 | 估算与渲染可能不一致，直到 RO |

跨切面：
- 每次消息数组 mutation 都重跑 `foldReactions/foldReminders/foldTodos`
  （`ChatWindow.vue:639,649,688`）并整表重估（`VirtualList.vue:73-80`）。
- 每次消息重估时 `messageHeight.ts:209-220` 仍会 `JSON.parse` 任务内容（即使 bubble 缓存命中）。

## 3. 已测数据（本轮现跑）

### 3.1 快滚：当前实现，1000 条（产品上界）

命令（先起 `npx vite --port 5199 --strictPort` 与带 `--remote-debugging-port=9223` 的 Brave）：

```bash
node perf/probe.mjs 9223     # 自检：scrollerReal / virtualizationOK
node perf/run.mjs 1000
```

| 相位 | 帧均值 | p95 | max | >50 ms 长帧 | estimateCalls | offsetsRebuilds |
|---|---|---|---|---|---|---|
| cold | 16.6 ms | 17.7 | 21.8 | **0** | 1,867 | 1.87 |
| warmUp | 16.7 ms | — | 24.3 | **0** | 4,173 | 4.17 |
| warmDown | 16.7 ms | — | 21.9 | **0** | 4,130 | 4.13 |

- 滚动距离：60 步 × 800 px = 48,000 px，用时 998 ms。
- `calibrate()`：1000 条整表估算一遍 **0.8 ms**（min 0.5 / max 2.9，5 遍取中位），
  每条 0.8 µs。
- 定位精度 `acc`：5 个目标（0/1/500/998/999）全部渲染，`overlapPairs=0 / gapPairs=0`。
- 读法：1000 条这一档，**帧预算不是瓶颈**；`offsetsRebuilds` 是
  `estimateCalls / items.length` 的推导值，不是"整表重算次数"的直接计数。

### 3.2 行为探针（真浏览器、真实组件）

| 段 | 结果 | 覆盖 |
|---|---|---|
| `vlist` | **13/13** | 滚动方向反转、前插锚定、定位 |
| `scrollrestore` | **5/5** | 卸载再挂载回到原位置 |
| `mergeheight` | **9/9** | 两档摘要等高、真矩形 |
| `msgovf` | **80/80** | 恶劣载荷溢出矩阵、动效、禁用态契约↔真渲染 |

复跑：`GOSSLAN_CHROME='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' node scripts/check-ui-runtime.mjs --only=vlist`（其余段同理）。

### 3.3 已作废/不可直接引用的历史数据

`perf/README.md` 记录了 2026-09-10 那批在 `scrollerReal=false` 时测出的帧数据，**已明确作废**。
同文件 20k/50k/60k/100k 档超出产品上界（1000 条），只能读"成本随条数怎么涨"，不能读"聊天页会怎样"。
其中"50k→60k 拐点 = `BUBBLE_CACHE_MAX`"仍是**数字吻合、因果未证**；本轮不改码，继续保持未证。

## 4. 症状 → 机制映射（候选，按证据强弱排序）

| 用户症状 | 最可能的机制 | 证据 | 如何在实施阶段证实/证伪 |
|---|---|---|---|
| 复杂群聊**首次**切换反复抖动，**热**启动后减轻 | ① `heightOverride` 无会话维度：第一次进入新会话只能用估算，RO 逐行修正 + 补偿；第二次进入复用上次的实测值 ⇒ **热稳定可能依赖旧缓存** | `VirtualList.vue:52`、`:96-117`；`ChatWindow` 不重建；估算 vs 实测差只在首帧 RO 修正 | 冷/热各跑一次同一会话：清空 `heightOverride` 后若热也不抖，则缓存不是主因；若冷抖热稳，测"冷时估算误差分布" |
| 消息高度变化引起滚动闪动 | ② 真实内容异步改高：图片 288→自然、文件卡二次改高、表情条插入、任务卡更新；RO commit 后同步写 `scrollTop` | `MessageImageBubble` eager + 骨架 288；`MessageFileBubble` 进度/投递页脚；`MessageReactionBar` strip RO；`commitHeight` + 补偿 | 在 `msgovf`/`mergeheight` 基础上加"改高次数 × 视口位移"记账；注入迟到测量看是否抢回 |
| 快速滑动不流畅 | ③ 内容相关：代码卡同步高亮、文件卡每行 IPC、每次 mutation 全量 `fold*` + 整表重估 | `CodeBlock.vue:58,96`；`MessageFileBubble` `mediaPresent`；`ChatWindow.vue:639,649,688`；`VirtualList.vue:73-80` | 用**混合内容**（代码/图片/文件/任务）而非纯文本跑同一 `perf/run.mjs`；对比 p95/长帧 |
| 会话快速切换后旧会话污染 | ④ 消息流没有 `StaleGuard`；`pendingJump`/`settleTimer` 只按 msg id | `useChatStore.ts:927,1166,1774`（StaleGuard 只在 peers/群任务）；`VirtualList.vue:235,431` | 注入"切换后旧请求延迟返回"，断言当前 `scrollTop` 写入次数 = 0 |
| 冷启动更差、热启动更好 | ⑤ `bubbleCache`/`heightOverride` 跨切换保留；冷启动没有实测高度 | `messageHeight.ts` bubbleCache；`VirtualList.vue:52` | 冷 = 清缓存后重开；热 = 同会话再进；两者都必须满足稳定性阈值 |

**尚不能下结论的**：把四个症状归因到某一个具体写入者（例如"`ChatWindow` 的 nextTick 贴底抢了用户位置"）
需要手势期间的程序化写入记账；本轮没有这条量具。

## 5. 候选方案对比

| 维度 | 当前 `VirtualList.vue` | `@tanstack/vue-virtual@3.13.47` | `vue-virtual-scroller` |
|---|---|---|---|
| 现状 | 生产在用 | 已安装，仅日志窗 | **未安装** |
| 不规则动态高度 | 每行 RO + `heightOverride` + 前缀和 | `measureElement` + `measurementsCache`（成熟） | `DynamicScroller`（成熟但维护更旧） |
| 高度变化后的位置稳定 | 自己算 delta + 同步写 `scrollTop` | 库内调整 + 可选 `scrollMargin` | 库内调整 |
| 顶部插入历史 | 已有 prepend 锚定与"只付视口上方差值" | 需要我们自己重写这段（库不负责历史语义） | 同样需要 |
| 底部追加/贴底 | 已有 `pinned`/settle hold | `scrollToIndex(total-1)` + 自己的意图层 | 同样需要 |
| 按会话测量缓存 | **缺失**（本报告核心缺口） | `measurementsCache` 是实例级，仍需按会话分区/失效 | 实例级 |
| 冷热一致 | 热稳定可能依赖旧缓存 | 同样会复用实例缓存，需要显式失效 | 同样 |
| 迁移成本 | 0 | 替换 ~650 行 + 重接 15 个写入者 + 4 段探针回归 | 新增依赖 + 同类迁移 |
| 回归风险 | 0 | 高（现有 4 段绿的行为要逐条重证） | 高 + 依赖维护面 |
| 结论 | **先修** | **原型 A/B 后再定**；不证明更优不换 | 不优先 |

判定规则（写死，避免"README 驱动迁移"）：
- 同一台机、同一份代表性数据、同一套 `perf/` 量具；A/B 前必须 `scrollerReal && virtualizationOK`。
- TanStack 只有在 **p95 帧、长帧、首次切换抖动次数、测量次数** 四项中至少三项明确优于
  "修完的当前实现"，才允许迁移；否则保留。
- 迁移不得丢掉现有 4 段探针（13/5/9/80）与 `scrollrestore` 的语义。

## 6. 推荐方案（fix-first，按顺序）

1. **先建真实数据量具**（实施第一步，仍属只读）：Python `sqlite3` 在线备份到 `/tmp`，
   在副本里把 `lan_enabled=0`/`bt_enabled=0`，按真实消息形状扩到 1000 条；
   记录冷/热/快速切换/快滚四组指标（§8 的定义）。这是后续所有判断的基线。
2. **稳定身份**：去掉 `msg_id ?? index` 的索引回退；乐观消息用稳定本地 id（服务端 id 到达后
   只更新字段，不换 key）。**动数据模型，先出迁移方案**。
3. **按会话 + 布局条件的测量缓存**：`heightOverride` 键加 `convId` 与 `layoutKey(width,font)`；
   宽度/字体变化清对应会话；每会话有上限；隐藏/未布局时不得 commit（已有拒 0，保留）。
4. **统一滚动意图**：把 15 个写入者收成一个状态机（bottom / restore / jump / prepend / user）；
   所有程序化写入带 generation；用户手势开始即作废旧 generation。**这是风险最高的一刀，
   必须先用手势探针证明"用户滚动期间程序化写入 = 0"再合并。**
5. **会话隔离**：消息流接 `StaleGuard`（或 convId 世代）；`pendingJump`/`settleTimer` 带 convId；
   切走时清理；`scrollRestore` 按会话保存锚点。
6. **动态高度批处理**：同一帧内的图片/文件/表情/任务更新合并成一次测量与一次补偿；
   文件卡的进度/投递页脚不要各触发一次；`fold*` 按消息 memo（状态/回执变化不重算全部）。
7. **内容成本**：代码高亮改异步/Worker + 缓存（允许首帧无高亮再补色）；文件卡
   `mediaPresent` 批量/延迟；任务卡 `parseTodo` 只解析一次（估算复用同一结果）。
8. **缓存与预渲染上界**：给 `heightOverride`/`bubbleCache` 每会话上限与淘汰；记录命中率。

预计改动范围：
`src/components/VirtualList.vue`、`ChatWindow.vue`、`src/stores/useChatStore.ts`、
`src/utils/messageHeight.ts`、`heightCompensation.ts`、`scrollRestore.ts`、
`src/components/message/*`（图片/文件/表情/任务卡）、`CodeBlock.vue`、`style.css`、
`perf/` 与 `scripts/check-ui-runtime.mjs`。

## 7. 风险

1. **动滚动所有权会碰现有绿探针**：13/5/9/80 条不是"参考"，是回归门禁；每一刀都要先跑它们。
2. **去掉索引 key 需要稳定本地 id**：乐观消息的 `tmp-*` 生命周期、重发、取消都要覆盖；
   否则 key 变化只是从"下标"换成"随机 id"，抖动更糟。
3. **按会话缓存会增加内存**：必须给每会话上限 + 全局上限，并记录命中率，不能"用内存换流畅"。
4. **异步高亮改变首帧观感**（先无色后补色）；需要用户接受（已授权这方向，但要在报告里显式记）。
5. **迁移库会丢掉现有语义**：prepend 锚定、jump 轮询、settle hold、隐藏测量，都是这个仓自己踩出来的；
   换库必须逐条重证。

## 8. 验收标准与回归矩阵

指标定义（实施时落到量具里）：
- **布局稳定耗时**：mount → 最后一次行高 commit 后连续 500 ms 无变化。
- **明显跳动**：非用户手势造成的 `scrollTop` 变化 > 4 px 的次数。
- **程序化写入**：用户手势窗口内 `setScrollTop` 调用次数（必须 0）。
- **长帧**：>50 ms 的帧数；**p95 帧**。
- **测量次数**：RO 回调数；**挂载组件数**；**JS 堆 / DOM 节点 / 监听器数**。

| # | 场景 | 量具 | 当前覆盖 | 目标（初版，待真实基线校准） |
|---|---|---|---|---|
| 1 | 1000 条混合内容快滚 | `perf/run.mjs` + 混合数据页 | 纯文本已跑 | p95 ≤ 20 ms，长帧 0 |
| 2 | 复杂群聊首次/重复/快切 | 新增 `chatswitch` 段 | **未覆盖** | 首次无 >4 px 跳动；返回锚点 ±4 px |
| 3 | 图片/文件/代码/表情改高 | `msgovf` + `mergeheight` 扩展 | 部分 | 同一帧只补偿一次；无可见跳动 |
| 4 | 顶部插入/底部追加/跳转 | `vlist` 已覆盖前两者 | 跳转部分 | 锚点 ±4 px；跳转命中 |
| 5 | 缩放/主题/字体/展开 | `PERF_ONLY=resize` + 主题探针 | 部分 | 不跳；缓存正确失效 |
| 6 | 用户滚动期间迟到测量 | 新增写入记账 | **未覆盖** | 手势期间程序化写入 = 0 |
| 7 | 多次切换后旧会话返回 | 新增 convId 世代判据 | **未覆盖** | 旧回调改当前 `scrollTop` = 0 次 |
| 8 | 长时滚动/切换后的堆/DOM/监听 | `PERF_ONLY=mem` + `heapDelta.mjs` | 有量具、未跑 | 10 次切换后无单调增长（上限按基线定） |

冷/热对照的硬要求：**冷缓存（清 `heightOverride` + `bubbleCache`）必须同样满足稳定性阈值**；
热可以更快，但不允许"只有热才稳"——那说明稳定来自旧缓存而不是正确实现。

## 9. 本轮未测 / 下一步

**未测（不假装已证）**：
- 真实数据下的冷启动/热切换/快切毫秒数与跳动次数（需要 §6.1 的隔离副本量具）。
- `@tanstack/vue-virtual` 原型 A/B（需要新 `perf/` 页面 + 同一套指标）。
- 用户手势 vs 迟到测量的写入记账。
- 长时切换后的堆/DOM/监听器曲线（`PERF_ONLY=mem` 未跑）。

**下一步（报告确认后，一次性实施）**：
1. §6.1 真实数据量具 + 基线（只读产物）。
2. 按 §6.2–6.8 切片实施；每片跑现有 4 段探针 + §8 矩阵。
3. 只有在"修完仍不达标"时，才做 TanStack 原型 A/B；A/B 不达标不迁移。

**复跑命令（本报告所有已测数字）**：

```bash
# 快滚（先起 vite:5199 与 Brave CDP:9223，页面 perf/vlist.html?n=1000）
node perf/probe.mjs 9223
node perf/run.mjs 1000

# 行为探针（每段会自己起/停 vite 与浏览器）
GOSSLAN_CHROME='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' \
  node scripts/check-ui-runtime.mjs --only=vlist
# 其余：--only=scrollrestore / mergeheight / msgovf
```

---

## 11. 迁移落地（5.13.0，2026-10-25）

按用户拍板，**所有虚拟列表都使用 `@tanstack/vue-virtual`**；线 A 的 5.12.0 已先行发布，本节是 5.13.0 的落地记录。

### 11.1 改了什么

| 主题 | 落地 |
|---|---|
| 消息列表 | 手写前缀和/二分/自建 RO → `useVirtualizer`：`anchorTo:"end"`（历史 prepend 锚定）、真实 `measureElement`、rAF 合批测量；`followOnAppend:false`，追加贴底由应用 `pinned` 独占 |
| 动态高度 | 高度 <= 0 不写缓存；`<=1px` 变化不重排（半像素白线仍保留两位小数）；`measureElement` 靠 `data-index` 认行 |
| 切会话 | pre-flush 先立收敛窗口；整会话切换（首尾 key 都变）延后到安静期统一贴底；底部追加仍立即跟随；换数据导致的 scrollTop 重置不计为用户上滚 |
| 布局失效 | 字体/主题走 `layoutKey`（ChatWindow 传字号+主题）；宽度失效 = `window.resize` + 面板宽度变化 >24px（忽略滚动条 ~15px 的清缓存反馈环） |
| 缓存边界 | `itemSizeCache > 6000` 整体重测；测量缓存以持久本地 id 为键 |
| 消息身份 | DB v13→v14：`messages.local_id`（唯一索引），老行回填 `msg_id`；乐观气泡由前端生成并随 `send_message`/`send_group_message` 落库，真实记录返回同一个值 ⇒ 列表 key 不换 |
| LogViewer | 已是 TanStack；过滤变化 `measure()` 清旧行高，隐藏/0 高度不写缓存 |
| 探针量具 | `perf/vlist.ts` 的定位读数从 `style.top` 改为真实 rect（新实现用 `transform`） |

### 11.2 迁移前 / 后（同一台机、headless Brave、1000 条）

| 指标 | 迁移前（手写） | 迁移后（TanStack） |
|---|---|---|
| 冷滚帧均值 / p95 / max | 16.6 / 17.7 / 21.8 ms | 17.8 / **21.8** / 24.7 ms |
| 暖滚帧均值 / p95 | 16.7 / — | 16.7 / 19.1 ms |
| >50 ms 长帧 | 0 | **0** |
| 定位（5 个目标）重叠 / 空隙 | 0 / 0 | **0 / 0** |
| 整表估算一遍 | 0.8 ms | 0.4 ms |
| 冷滚 `estimateCalls` | 1,867（推导值） | 325,163（逐行首测；生产 `bubbleCache` 命中后是哈希查找） |

冷滚 p95 从 17.7 升到 21.8 ms：这是**把每一行都真实测量**的代价（旧实现里相当一部分行停在估算值），长帧仍为 0；暖滚 p95 19.1 ms、定位零重叠零空隙。若要进一步压冷滚，下一步是"按会话持久化测量缓存"，本轮未做。

### 11.3 验证（本轮现跑）

- `vlist` **13/13**、`scrollrestore` **5/5**、`mergeheight` **9/9**、`msgovf` **80/80**。
- 前端 `npm test` **1411 passed**；Rust **1215 passed**。
- 真实库副本 v13→v14：`messages=160`，`local_id` 空值 **0**，唯一索引已建（主库未动，副本已删）。
- `perf/probe.mjs`：`scrollerReal=true`、`virtualizationOK=true`。

### 11.4 仍未测

- 真机真实数据的冷启动/热切换耗时（需要 §6.1 的隔离副本量具）。
- 长时切换后的堆/DOM/监听器曲线（`PERF_ONLY=mem` 未跑）。
- 真实 CoreBluetooth/图片/文件卡高度风暴下的端到端时延（现有 `msgovf/mergeheight` 覆盖形状，不覆盖真机资源时序）。
