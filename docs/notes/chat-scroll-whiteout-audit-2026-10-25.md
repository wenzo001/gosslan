# 聊天长列表「白屏 / 抽动 / 复杂消息迟到」专项 · 只读诊断报告

- 日期：2026-10-25
- 范围：`src/components/VirtualList.vue`、`src/components/ChatWindow.vue`、`src/components/MessageItem.vue` 及其消息子组件、`src/utils/messageHeight.ts`、`src/stores/useChatStore.ts`（只读）
- 依赖现读：`@tanstack/vue-virtual@3.13.47` → `@tanstack/virtual-core@3.19.6`（`package-lock.json` 精确解析）
- 构建：`vite dev`（未压缩）；引擎：headless Brave `156.1.98.60`（Chromium）；机器：Apple M3 / macOS 27.0.1
- 本轮**没有修改**任何业务代码、依赖、lock、版本号；新增的只有本报告与 `perf/` 下的诊断量具（`perf/` 不进 tsconfig，也不进门禁）
- 5.13.0 的代码在 CI 上是绿的（Verify run `40205107353` 全部 job `success`），但**没有打 tag**：本次诊断找到了一个 P0（见 R1），当前列表还不到"最佳实践"

---

## 0. 结论摘要

1. **P0（已复现）**：列表把「末尾追加一条消息」误判成「切换会话」——用户上翻阅读超过 1.2 s 后来任何新消息，`scrollTop` 会在**下一帧从 72,540 直接跳到 143,242（+70,702 px）**。这是代码里的两个无条件贴底分支，不是测量误差。
2. **快速滚动的"白"不是整屏空白，而是视口内成片的未覆盖带**：冷缓存下 400 px/帧时 90 帧里 **45 帧** 有空白带（最大 342 px ≈ 视口 43%）；800 px/帧时 **83/90 帧**（最大 378 px）。慢速 80 px/帧时是 **0 帧**。机制是「条目数 overscan（6 条）< 单帧位移」+「测量被推迟到下一帧」+「估算与真实差最大 208 px」三者相乘。
3. **代码卡是最大的单次主线程阻塞**：冷跳进纯代码区，首帧 **164.1 ms**（longtask 166 ms，17 行）；原因是每张卡同步跑 `highlightAuto`（15 种语言）再 `highlight`，且**每张卡渲染一份完整主题 `<style>`**。文本区同条件 74.1 ms，长文本 60.3 ms，图片 54.6 ms。
4. **图片异步改高会推走视口下方的行**：图片在视口内完成加载时，下方一行上移 **116 px**（2 次高度变化），`scrollTop` 不变；同一位置、预览立即可用时位移 **0 px**（阴性对照）。骨架按估算上限 288 px 预留，横图真实高度约 117 px、失败占位 128 px。
5. **历史前插的锚定是对的**：前插 100 条（约 10,340 px）后，阅读锚点在 25 帧内偏移 **0 px**，`scrollTop` 精确 +10,340。问题不在前插，而在"加载失败/加载中没有任何可见状态"（R6）。
6. **没有单一旋钮能同时解决 400/800 px/帧**：A/B 里 overscan=36 让 400 档归零，却让 800 档更差（81 行、p95 97 ms、长帧 82/90、单帧 700 ms）。正确方向是**按像素与速度自适应 + 把测量挪回绘制前 + 降低单行首挂成本**，不是继续加 overscan。

---

## 1. 量具与口径（先证明量具能看见空白）

新增（只读、可复跑）：

| 文件 | 回答什么 |
|---|---|
| `perf/scrollprobe.html` / `.ts` / `.mjs` | 真实 `VirtualList` + 真实 `MessageItem`，逐帧量视口覆盖、空白带、行挂载/重定位、锚点漂移、估算误差 |
| `perf/scrollscenarios.mjs` | 每场景一次冷加载：代码区/文本区冷跳、图片区内异步改高、prepend/append、P0 复现 |
| `perf/scrollkinds.mjs` | 同一跳转位置，只换消息种类（文本/长文本/代码/图片）量首挂成本 |
| `perf/scrollab.mjs` | 运行时选项 A/B：`overscan` 6/18/36 × `useAnimationFrameWithResizeObserver` 开/关，每档 3 次独立冷加载 |

复跑（三个进程）：

```bash
npx vite --port 5199 --strictPort
"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
  --headless=new --disable-gpu --no-sandbox --user-data-dir=/tmp/brave-perf-scroll2026 \
  --remote-debugging-port=9223 --window-size=1280,900
node perf/scrollprobe.mjs 1200
node perf/scrollscenarios.mjs
node perf/scrollkinds.mjs
node perf/scrollab.mjs
```

**口径（写死在代码里，防止被读成别的）**

- 采样点在 `requestAnimationFrame` 回调内：浏览器顺序是 scroll steps → 微任务 → rAF → 绘制，所以读到的是"这一帧将要绘制"的 DOM。
- 空白带 = 视口 `[0, clientHeight]` 内没有任何 `[data-vlist-key]` 行覆盖、且宽度 > 1 px 的纵向区间。列表底是白色，所以这就是用户看到的白。
- 行高度取 `getBoundingClientRect().height`，不使用 `offsetHeight`（后者是整数，会造出半像素假缝）。
- 每帧位移用 `el.scrollTop = before + stepPx` 施加，等价于"这一帧用户甩了 stepPx"。不是触摸惯性的完整物理模型，但连续同向、同速的位移与惯性中段同形。

**量具自检（全部必须为真才采信）**

| 自检 | 读数 | 结论 |
|---|---|---|
| 容器真的能滚 | `scrollTop` 写 1234 读回 1234 | ✅ |
| 虚拟化真的生效 | 渲染行数 < 200（n=1200） | ✅ |
| 覆盖率量具能看见空白（阳性对照） | 藏掉视口中心一行 → 空白 192 px / 带 `[238,430]`；放回 → 0 px | ✅ 不是恒 0 的死量具 |
| 图片"立即可用"阴性对照 | 同区域、同选项，预览 0 延迟 → 下方行位移 **0 px**、高度变化 0 次 | ✅ 116 px 的位移归因于"异步晚到"而不是量具本身 |
| CPU 降频阳性对照 | 同一段定长循环：4× 档 3.23×、6× 档 4.66× | ✅ 降频真的落地 |

**这台量具买不到的**（后面结论不许越过）：

1. 没有 Rust 后端。图片/文件预览走的是**本页注入的 IPC stub**（真实 `read_file_preview` 名字、真实字节 → Blob → objectURL → `<img>` 全链路，只有字节来源是假的）。stub 返回 320×180 的真实 PNG。
2. 没有 ChatWindow 外壳（输入框、标题栏），视口略大；没有 store 的消息折叠与 footer 投递状态。
3. 仍是同一台 Mac 的模拟降频，不是低端 Android/低功耗 macOS 实机。
4. 切换会话时的 `listSwitching`（整列 `opacity: 0` 等布局落定）**不在本量具覆盖内**，只能列为候选（见 §5）。

---

## 2. 现状实现（审计起点复核）

| 项 | 现状 | 位置 |
|---|---|---|
| 库 | `useVirtualizer`（TanStack），消息列表与 LogViewer 两处；仓内没有 `vue-virtual-scroller` | `VirtualList.vue:64`、`LogViewer.vue:142` |
| overscan | **6 条**（ChatWindow 不传） | `VirtualList.vue:39`、`:73` |
| 行身份 | `local_id ?? msg_id ?? id`，不回退下标 | `VirtualList.vue:50-52`、`:74` |
| 锚定 | `anchorTo: "end"`；`followOnAppend: false`（应用自己的 `pinned` 独占贴底） | `VirtualList.vue:75`、`:78` |
| 实测 | 自定义 `measureElement`：0 高度拒绝、≤1 px 不重排、保留两位小数 | `VirtualList.vue:83-106` |
| 测量时机 | `useAnimationFrameWithResizeObserver: true` ⇒ RO 的回调被**推到下一帧** | `VirtualList.vue:82`；core `index.js:61/281` |
| 高度估算 | `estimateMessageHeight`：图片 288、文件 92、合并卡 96、任务卡 96+…、长文本按字符宽估算；`bubbleCache` 键 = 字号+msg_id，上限 50,000 | `messageHeight.ts:125-205`、`previewMetrics.ts:159` |
| 滚动物理所有权 | `pinned` / `settleTimer` / `pinHold` / `schedulePin` / `pendingJump` / `snap` 分散在组件与 ChatWindow，写入 `scrollTop` 的入口 ≥ 10 个 | `VirtualList.vue:129-528`、`ChatWindow.vue:924-1112` |
| 历史加载 | `scrollTop < 60` 时 emit `loadMore`；store 单飞 + `historyTops` + `pagesLoaded`（100×10=1000 条/会话） | `VirtualList.vue:252`、`useChatStore.ts:1658-1722` |

### 2.1 "复杂消息挂载"到底贵在哪（静态）

- 代码卡：`detectedLang` 先 `hljs.highlightAuto(code, 15 种语言)`，`html` 再 `hljs.highlight`；渲染时**每张卡**输出一个 `<component :is="'style'">`，内容是一整份 highlight.js 主题 CSS（`CodeBlock.vue:67`、`:88`、`:96`）。
- 长文本：`parseQuote` → `splitEmoji` → 每段 `linkify`，都在挂载时算（`MessageTextBubble.vue:94-112`）；估算用字符宽度推行数，和真实换行不保证一致。
- 图片：骨架按 `IMAGE_BUBBLE_HEIGHT = 288` 预留（`MessageImageBubble.vue:142-144`、`previewMetrics.ts:159`），失败态 128（`:168`）；`<img>` 上限也是 288（`:172`）。加载完成后的真实高度 = `min(288, 208 × 高/宽)`，横图必然低于 288。
- 文件卡：每行挂载都会 `media_present`（IPC，`api/index.ts:441`），附件图再 `read_file_preview`；本量具里 21 行中 10 次 IPC。

---

## 3. 根因（已证）

### R1 · P0：追加消息被当成"切会话"，阅读位置被无条件拽到底部

**代码**（`VirtualList.vue:373-403`）：

```ts
const isSwap = prevLastKey !== null && newLastKey !== null && newLastKey !== prevLastKey;
...
if (isSwap && !pinned) {          // ← 这里的 isSwap 也包含「末尾追加一条」
  pinned = true;
  emit("nearBottom", true);
}
...
if (isSwap && props.autoScrollOnSwap) {
  armSettleHold();
  if (!isFullSwap) {              // ← 非「整会话切换」= 追加：nextTick 直接贴底
    void nextTick(() => {
      ...
      setScrollTop(el.scrollHeight);
      ...
    });
  }
}
```

`isSwap` 的定义是"末条 key 变了"，它同时覆盖**整会话切换**与**追加**。于是有两条无条件贴底路径：

1. `autoScrollOnSwap=true`（ChatWindow 的常态）⇒ `nextTick` 里直接 `setScrollTop(scrollHeight)`；
2. `autoScrollOnSwap=false` ⇒ 先 `pinned=true`，随后 `watch(totalSize)` → `schedulePin()`（`:443-449`）在下一帧写 `scrollTop`。第 2 条只在 `recentScrollUp()` 过期后生效，所以表现为"有时被拽、有时不被拽"的概率型缺陷。

**复现（`node perf/scrollscenarios.mjs` 的 `appendYank`；生产形状 `?auto=1` 另跑）**

| 条件 | before | 第 0/1 帧 | 位移 | 之后 |
|---|---|---|---|---|
| `autoScrollOnSwap=true`（生产） | `scrollTop=72,540`，顶部 `m-601 @ -22` | **143,242**，顶部 `m-1193` | **+70,702 px** | 第 2-3 帧出现 287 px 底边空隙，第 4 帧再补一次（来回抖） |
| `autoScrollOnSwap=false`（库自身） | 同上 | 第 0 帧不动，第 1 帧 143,242 | **+70,702 px** | 同上 |

**影响**：用户"正在读历史"这一状态被完全破坏；同时解释了部分用户说的"滚动抽动"——不是测量抖动，是一次真实的跨屏跳转 + 底部反弹。

**与需求的冲突**：直接违反"用户主动滚动不得被贴底/迟到命令抢回""新消息只在接近底部时跟随"。

---

### R2 · 快速滚动的白色带：条目数缓冲不够 + 测量晚一帧 + 估算误差

**机制（三件事相乘，缺一不成）**

1. `overscan: 6` 是**条目数**。混合夹具的视口行高约 40–300 px，6 条 ≈ 240–1800 px，典型文本区只有 ~360 px。
2. `useAnimationFrameWithResizeObserver: true` 把 RO 的首次实测推迟到**下一帧**（core `index.js:61/281`）。行在这一帧按 `estimateSize` 定位并**已经被绘制**。
3. `estimateMessageHeight` 与真实渲染的差（§4.1）：长文本最多 42 px/行、附件图最多 208 px/行（失败占位）/ 181 px（成功横图）。差值就是这一帧的空白带。

慢速滚动时，行在距视口 6 条以外就挂载、下一帧被修正，等它进入视口时已经是对的 ⇒ **80 px/帧 0 帧空白**。快速滚动时，行直接进入视口 ⇒ 空白带被看见。

**实测（每档 90 帧，同一冷加载、同一位置）**

| 每帧位移 | 空白帧 | 最长连续 | 最大空白带 | p50 / p95 | 长帧 >50 ms |
|---|---|---|---|---|---|
| 80 px | **0/90** | 0 | 0 px | 16.5 / 23.7 | 0 |
| 200 px | 2/90（混合热缓存） | 1 | 42 px | 16.3 / 30.9 | 1 |
| 400 px | **45/90**（3 次冷加载中位） | 4 | **342 px** | 50.4（A/B 基线中位） | 5 |
| 800 px | **83/90** | 27 | **378 px** | 77.3 | 34 |

> 400/800 用 `perf/scrollab.mjs` 的三次独立冷加载中位数；200 用 `perf/scrollprobe.mjs` 的一轮混合扫描。两次的差异来自测量缓存冷/热，不矛盾——**冷缓存才是"刚打开会话就快速翻"的真实情形**。

**空白带的形状**（`down400` 某帧）：`[534,576] / [636,678] / [762,789]`，每条 42 px，正好是长文本行的估算误差；`down800` 某帧：`[153,379]`，226 px，正好是一张附件图的估算误差。不是随机的。

**估算误差（稳定后逐行对比，`estimateError`）**

| 类型 | n | 平均绝对误差 | 最大 | 首个误差样本 |
|---|---|---|---|---|
| 文本（短） | 5 | 3.6 px | 18 | 0, 0, 0, 0, 18 |
| 长文本 | 4 | **31.5 px** | **42** | -21, -42, -42, -21 |
| 代码 | 2 | 3.3 px | 6.5 | 0, 6.5 |
| system / recalled | 1 / 1 | 12 / 12 | 12 | -12 |
| 图片（kind=image） | 2 | 9 px | 18 | 0, 18 |
| 普通文件 | 1 | 12 | 12 | -12 |
| 附件图（file + subtype=image） | 1 | **208** | **208** | -208（无后端失败占位；stub 成功时 -181） |
| 附件代码（file + subtype=code） | 1 | **110** | **110** | -110 |

稳定后行间重叠/空隙为 0——因为 TanStack 已把实测值缓存；误差只发生在**该行第一次进入渲染窗口的那一帧**，正是快速滚动时每一帧都在发生的事。

**估算调用成本（排除项）**：冷滚 800 px/帧时 `estimateHeight` 约 **972 次/帧**（1200 条 × 0.8），耗时 **0.68 ms/帧**。它不是主因，但随条数线性增长；产品上界 1000 条/会话，可接受。

---

### R3 · 代码卡首挂阻塞主线程

**实测（`perf/scrollkinds.mjs`，同一跳转位置、同一 30 帧窗口）**

| 种类 | 首帧 | 渲染行数 | 空白帧 | longtask |
|---|---|---|---|---|
| 短文本 | 74.1 ms | 29 | 0 | 76 ms |
| 长文本 | 60.3 ms（第二帧 58.7） | 19 | 2（206.5 px） | 62 + 58 ms |
| **代码** | **164.1 ms** | 17 | 0 | **166 ms** |
| 图片 | 54.6 ms（第二次 50.8） | 16→19 | 4（最大 403.5 px） | 56 ms |

**归因**：

- `highlightAuto` 遍历 15 种语言 + 选中语言再 `highlight` 一次（`CodeBlock.vue:67/88`）；
- 每张卡渲染一份完整主题 `<style>`（`:96`），5 张卡就是 5 个 `<style>` + 全量样式重算；
- 没有按内容缓存：同一条代码在虚拟列表里反复挂载/卸载就反复高亮。

**影响**：冷跳进代码区一次卡 164 ms；快速滚动时若一帧进入 2–4 张代码卡，就会把该帧推到 100 ms+，与 R2 的"测量晚一帧"叠加——用户看到"代码卡先空白/未高亮，过一会才出来"。

**与 LogViewer 的对照**：LogViewer 用固定估算 26 px、`overscan: 12`、默认（绘制前）测量、行内容是纯文本，所以同一套库在它那里没有这类问题。差别不在库，在**行成本 + 测量时机 + 缓冲单位**。

---

### R4 · 图片在视口内完成加载 → 下方内容上跳 116 px

**对照实验（同位置、同选项，只改预览延迟）**

| 条件 | 被观察行（视口内第 4 行）位移 | `scrollHeight` 变化 | 重定位次数 | IPC |
|---|---|---|---|---|
| 预览延迟 **700 ms**（骨架先显示） | **116 px**（offset 150 → 34） | 3 次 | 31 | 10 |
| 预览 0 ms（挂载前就绪） | **0 px** | 0 次 | 0 | 10 |

**机制**：骨架按估算上限 288 px 预留；横图真实高度 = `min(288, 208 × 180/320) ≈ 117 px`，失败占位 128 px。图片位于视口内时，TanStack 的默认规则**故意不补 `scrollTop`**（core `index.js:1016-1035`：跨越视口上沿的条目变高/变矮被认为"变化发生在锚点下方"），于是锚点上方不变、下方整段上移。这不是缺陷，是"没有真实尺寸就只能事后修正"的必然结果。

**与用户描述的对应**：滚动中图片陆续解码完成，每次都会让下方内容跳一下；快速滚动时多张图同时完成，就是连续的抽动。

---

### R5 · 长文本估算偏差（42 px/行）

估算按字符宽度推行数（`textBubbleHeight`），真实渲染受标点避头尾、英文混排、表情 token 影响。42 px ≈ 一行 14 px × 1.625 行高的 1.8 倍。它是 R2 中最常见的空白带来源（一次进入 3 行长文本 ⇒ 126 px 空白）。

**方向**：不是"把估算调大"（会从空隙换成重叠），而是让**估算与渲染共用同一套换行度量**（或对长文本使用保守的固定占位 + 测量前不绘制）。

---

### R6 · 历史加载：位置锚定是对的，但失败/加载中不可见

- **前插锚定（已证）**：前插 100 条约 10,340 px 后，锚点行 `m-601` 的视口偏移 25 帧内**始终为 -22 px**（漂移 0），`scrollTop` 精确 +10,340。`anchorTo:"end"` 的前插路径可用，不需要手写补偿。
- **重复触发**：`scrollTop < 60` 期间每次重测都可能 emit `loadMore`；store 用 `loadingMore` 单飞 + `historyTops` 挡住重复 IPC（`useChatStore.ts:1658-1685`）。
- **失败**：`loadMorePage` 没有 `try/catch`（`:1688-1722`），`ChatWindow.onLoadMore` 是 `void chat.loadMoreMessages(convId)`（`ChatWindow.vue:1496-1499`）⇒ IPC 失败会变成 **unhandled rejection**，界面没有任何提示；用户停在顶部时下一帧又会再试，没有退避。
- **加载中**：没有任何"正在加载更早消息"的行/占位；用户只能从"列表不再变长"猜。

**结论**：位置不跳是真，但"加载语义"不完整——需求里的失败/取消/重复/快速触界规则只实现了一半。

---

### R7 · 身份：`local_id` 只进了虚拟列表的 key，没进合并/去重（候选，未证）

- 虚拟列表 `keyOf = local_id ?? msg_id ?? id`（正确）。
- `mergeMessages` 仍只按 `msg_id` 去重并整表 `sort`（`utils/messages.ts:16-31`）；
- `appendLocalOnly` 按 `tmp-*` / `file-failed-*` 前缀保留（`:188-199`）；
- `replaceOptimistic` 按 `msg_id === tmpMsgId` 查找（`:215-235`）。

后果：在"发送中收到 `loadMessages` 快照"的窗口里，真实行（`local_id` 与乐观行相同）和乐观行会**同时存在**，两行的虚拟列表 key 相同。本轮没有复现出用户可见故障（需要真实发送 + 切会话时序），所以只列为候选；实施时应把去重/替换也切到 `local_id`（以 `msg_id` 兜底）。

---

## 4. 排除项与澄清（避免继续在错的地方修）

| 说法 | 本轮读数 | 结论 |
|---|---|---|
| "整屏白屏是虚拟列表没渲染" | 跳转后 3 帧内铺满；滚动中视口从未 0 行 | 不是整屏空；是**带内空白 + 慢帧** |
| "估算重算（前缀和）是主因" | 0.68 ms/帧 @1200 条 | 不是；不要为此改算法 |
| "`BUBBLE_CACHE_MAX=50000` 的悬崖" | 产品上界 1000 条/会话 × 8 会话 = 8000 | 够不到 |
| "每张代码卡注入一份 `<style>` 是旧版本问题" | **现在仍然存在**（`CodeBlock.vue:96`） | 仍是成本项 |
| "截图里那一次 688 ms 长任务" | 发生在编辑 `perf/` 文件触发 Vite HMR 的那一轮 | **HMR 伪影，已剔除**；干净重载后同位置最长 166 ms |
| "切会话白屏" | `listSwitching` 会把整列 `opacity` 置 0 直到布局落定（`ChatWindow.vue:164-193`） | 候选，本量具未覆盖；需真 ChatWindow 页面另测 |
| "LogViewer 与聊天列表问题同源" | LogViewer：固定 26 px、overscan 12、绘制前测量、纯文本行 | 不同源；它反而是正确形状的参照 |

---

## 5. 候选方案对比（含 A/B 读数）

### 5.1 缓冲策略 A/B（`perf/scrollab.mjs`；每档 3 次独立冷加载，中位）

| 变体 | 每帧 400 px：空白帧 / 最大带 / p95 / 长帧 / 行数 | 每帧 800 px：空白帧 / 最大带 / p95 / 长帧 / 行数 |
|---|---|---|
| 基线 overscan 6 / RO 延帧 **（当前生产）** | **45/90** / 342 px / 50.4 ms / 5 / 20 | **83/90** / 378 px / 77.3 ms / 34 / 23 |
| 测量改绘制前（raf=false） | 19/90 / 342 / 74.1 / 19 / 20 | 33/90 / 210 / 64.6 / 33 / 23 |
| overscan 18 | 46/90 / 409 / 60.8 / 17 / 49 | **8/90** / 66 / 82.2 / 66 / 46 |
| raf=false + overscan 18 | 40/90 / 342 / 62.8 / 14 / 49 | **5/90** / 342 / 95.6 / 71 / 46 |
| overscan 36 | **0/90** / 0 / 66.3 / 24 / 81 | 46/90 / 342 / 97.0 / 82 / 80（单帧 700 ms） |

**读法**：

- **没有单一档同时赢两个速度**：条目数缓冲在 800 档有效（os18 把 83→8），但在 400 档无效（46）；os36 在 400 档归零，却把 800 档的 DOM 拉到 81 行、p95 97 ms、长帧 82/90，反而更差。
- **测量改到绘制前**单独能把 400 档 45→19、800 档 83→33，代价是同一帧里多付测量工作（p95 升高）。它治的是"按估算画出去"的那一帧，不治"根本没挂载"。
- 结论方向：**按像素与速度自适应缓冲**（buffer ≈ max(1.5×视口, 1.5×近几帧位移)，带方向偏置与硬上限）+ **测量前移** + **降低单行首挂成本**。三者缺一都会在另一档露出来。

### 5.2 库的对比（不换库，但要说清边界）

| 候选 | 现状 | 本轮结论 |
|---|---|---|
| 当前 `VirtualList` + TanStack 3.19.6 | 已在用 | 需要的能力（`rangeExtractor`、`anchorTo`、`measureElement`、`setOptions`、`useAnimationFrameWithResizeObserver`）**都在已安装版本里**；问题在配置与行成本 |
| 自研前缀和（迁移前） | 已替换 | 不做回退；迁移前的定位/白线问题已有记录 |
| `vue-virtual-scroller` | **未安装** | 没有在同一套量具上跑过，不允许用 README/演示页下结论；不纳入本轮推荐 |
| `@tanstack/vue-virtual` 升级 | 3.13.47 / core 3.19.6 | 先不升级：本次差距不来自缺 API；升级会牵 lock/门禁，收益未证 |

### 5.3 低性能设备（CDP CPU 降频，阳性对照 3.23× / 4.66×）

| 条件 | 400 px/帧 p50/p95/长帧 | 800 px/帧 p50/p95/长帧 |
|---|---|---|
| 满速 | 31 / 57.7 / 9 | 34 / 69.4 / 16 |
| 4× | 133 / 210 / **57/60** | 148 / 319 / **60/60** |
| 6× | 222 / 435 / **60/60** | 267 / 500 / **60/60** |

⇒ 慢设备上不是"多几帧白"，而是**每一帧都 >100 ms**（≈5–10 fps），呈现为一段一段地跳。缓冲与行成本两项都必须治，只调一个不会好。

---

## 6. 推荐方案（待确认后一次性实施）

### 6.1 先修 P0：滚动意图只有一个所有者

- `VirtualList.vue`：把 `isSwap` 拆成 `isAppend` / `isFullSwap`；**只有 `isFullSwap` 才重置 `pinned`**；删除追加路径里的 `nextTick setScrollTop(scrollHeight)`；`watch(totalSize)` 的 `schedulePin` 只允许在 `pinned && !recentScrollUp()` 下写，且 `pinned` 只由 `computeScrollState` 与显式 API 修改。
- `ChatWindow.vue`：追加贴底只保留现有 `willBeVisible = (isMine || nearBottom) && !recentScrollUp()` 一条判定；不再由列表组件二次决定。
- 目标状态机：`pinned | reading | jumping | restoring` 四态，`scrollTop` 写入点收敛到 `VirtualList` 内的一个函数（库的 anchor 是唯一例外）。

### 6.2 自适应缓冲（用 `rangeExtractor`，不在滚动处理器里做重活）

- 维护一个**非响应式**的 `lastFrameDelta` / `velocity`（rAF 里更新，O(1)）；
- `rangeExtractor` 按像素目标扩展：`bufferPx = clamp(max(1.5 × clientHeight, 1.5 × |velocity|), 400, 2400)`，前向 1.0×、后向 0.5×；同时用 `maxItems`（建议 40）封顶，避免 os36 的 81 行；
- 触底/触顶时自动收窄，避免"底部预渲染一大片空行"；
- 该函数只在 range 变化时被调用（TanStack memo），不在 scroll 事件里做数组遍历。

### 6.3 测量时机与批处理

- 先 A/B 验证 `useAnimationFrameWithResizeObserver: false` 在自适应缓冲下的组合读数；若 p95 可接受，则用它把"按估算绘制"的那一帧消掉。
- 若不能关，则对**新挂载的行**用保守占位（见 6.4），并让同一帧的多次 RO 合并成一次 `measure()`。
- 上限：单帧测量次数设阈值（如 30），超过就分帧，避免切会话风暴。

### 6.4 降低单行首挂成本

| 项 | 改动 | 观感变化 |
|---|---|---|
| 代码高亮 | `highlightAuto` + `highlight` 移到 Worker（或先 plaintext 再异步上色），按 `content` 哈希缓存；主题 `<style>` 提升为全局一份 | 首帧可能是无高亮文本，下一帧补色（已获授权） |
| 长文本 | 估算与渲染共用换行度量，或长文本首帧用"按行数分档的保守占位"；`parseQuote/splitEmoji/linkify` 结果按 msg_id 缓存 | 无明显变化 |
| 图片 | 优先在附件载荷里带 `w/h`（需协议/DB 决策，见 §8）；不带则把骨架高度改为**固定预览框**（如 288 上限 + `object-contain`，失败/成功都不改变外框），接受"框内留白"换取"零跳动" | 横图上下留白，但不再位移 |
| 文件卡 | 未进入视口前不调用 `media_present`/预览；进入后一次批量查询；状态行/投递页脚预留固定高度 | 卡片先以稳定骨架出现 |
| 任务卡 | 与估算共用同一份 `parseTodo` 结果（当前卡片/估算/fold 三处各解析一次） | 无 |

### 6.5 历史加载与身份

- `onLoadMore` 加 `catch`：失败时在列表顶部显示一条可重试的提示（或 toast 一次），不产生 unhandled rejection；同一会话的失败加 1–2 s 退避；`loadingMore` 期间在顶部显示"正在加载更早消息"的固定高度行（不影响锚定）。
- `mergeMessages` / `appendLocalOnly` / `replaceOptimistic` 的去重与替换切到 `local_id ?? msg_id`（保留 `msg_id` 兜底）；`sort` 改为按 `seq` 的有序插入（产品上界下不是瓶颈，但避免整表排序）。
- 消息异步回调用 `StaleGuard`（已授权）按 `convId + seq` 记账，旧会话结果不得改当前 `scrollTop`。

### 6.6 测试与验收（perf 继续不进门禁）

- 扩展现有 `perf/scrollprobe*`，新增断言型读数：
  - 快速滚动空白帧 ≤ 2/90、最大空白 ≤ 16 px（本机、冷加载、400/800 两档）；
  - P0：阅读中追加 → `scrollTop` 位移 0（25 帧，`auto=1` 与 `auto=0` 各一）；
  - 前插 100 条 → 锚点漂移 0（已有基线）；
  - 图片在视口内完成 → 下方行位移 ≤ 1 px（需要 §8 的尺寸决策）；
  - 冷跳代码区 → longtask < 50 ms；
  - 4× 降频 400 px/帧 p95 ≤ 100 ms、长帧 ≤ 10/60（当前 210 ms / 57/60）。
- 保留 `npm test` 里的契约测试（`virtualListContract.test.ts`），新增 `rangeExtractor` 与 `isAppend/isFullSwap` 的源码形状判据（防回退）。

---

## 7. 预计改动范围与风险

| 文件 | 改动 | 风险 |
|---|---|---|
| `src/components/VirtualList.vue` | P0 状态机、`rangeExtractor`、测量时机、上限 | 高；滚动位置是全仓最敏感逻辑，必须有现有 13 组探针 + 新的前后对照 |
| `src/components/ChatWindow.vue` | 删除重复贴底、加载错误态、`layoutKey` | 中 |
| `src/components/CodeBlock.vue`（+ Worker/缓存模块） | 异步高亮、全局主题 | 中；观感变化（先无色）已获授权 |
| `src/components/message/MessageImageBubble.vue` / `MessageFileBubble.vue` | 稳定占位/延迟 IPC | 中 |
| `src/utils/messageHeight.ts` | 长文本/附件图估算 | 中；低估会造成遮挡，必须用现有 `msgovf`/`mergeheight` 探针守住 |
| `src/utils/messages.ts` / `useChatStore.ts` | local_id 去重、加载失败态、StaleGuard | 中；有单测但需补跨窗口时序 |
| `src-tauri/**` / DB | 若选"附件尺寸"，需迁移（本轮未动） | 高；属协议/存储变更，需单独授权 |

---

## 8. 需要拍板的三件事

1. **附件图尺寸**：要不要在发送时把 `w/h` 写进消息载荷（DB 新列或 content JSON 扩展）？
   - 要：图片首帧就能预留真实高度，R4 归零；代价是一次 DB 迁移 + 协议兼容（旧消息无尺寸时回退骨架）。
   - 不要：保持 288 骨架 + 固定预览框（框内留白），把"位移"换成"留白"，零 DB 改动。
2. **加载更早历史的失败呈现**：顶部一条可重试提示（推荐）还是只 toast 一次？
3. **实施范围**：是否按 §6 一次性做完（含 Worker 高亮、`local_id` 去重、加载失败态），还是先只做 P0 + 缓冲 + 测量时机三项？

---

## 9. 复跑命令与读数归属

| 读数 | 命令 | 归属 |
|---|---|---|
| 空白带 / 估算误差 / 锚点 | `node perf/scrollprobe.mjs 1200` | 测量值 |
| P0 追加跳转 / 前插 / 图片改高 | `node perf/scrollscenarios.mjs` | 测量值 |
| 按消息种类的首挂成本 | `node perf/scrollkinds.mjs` | 测量值 |
| 缓冲 A/B（3 次冷加载） | `node perf/scrollab.mjs` | 测量值 |
| 4×/6× 降频 | 见 §5.3 的 CDP 脚本（`/tmp` 一次性脚本，未入库） | 模拟值，非真机 |
| "估算晚一帧"的机制 | `VirtualList.vue:82` + `virtual-core/index.js:61/281` | 代码证据 |
| 行身份 / 合并仍是 msg_id | `utils/messages.ts:16-31/188-199/215-235` | 代码证据，用户可见影响**未证** |
| 切会话 `opacity` 白屏 | `ChatWindow.vue:164-193` | 候选，未测 |

**本轮未做**：没有改 `src/`、依赖、lock、版本号；没有打 5.13.0 tag；没有发布 release。

---

## 10. 实施结果（2026-10-26，已按 §6 全量落地）

> 本节是**实施后**的复测，不是审计轮的预测。数字全部来自本轮复跑；命令与 §9 相同。

| 项 | 实施前 | 实施后 | 复跑 |
|---|---|---|---|
| 阅读中追加一条（生产 `auto=1`） | 第 1 帧 +70,702px | **0px（25 帧）** | `node perf/scrollscenarios.mjs` |
| 前插 100 条历史 | 锚点漂移 0（本来就对） | 0（回归保持） | 同上 |
| 图片在视口内延迟 700ms 完成 | 下方行上移 116–275px / 3 次改高 | **0px / 0 次改高** | 同上 |
| 冷缓存 400px/帧（90 帧） | 45 帧有白带，最大 342px | **0 帧** | `node perf/scrollprobe.mjs 1200` |
| 冷缓存 800px/帧（90 帧） | 83 帧有白带，最大 378px | **0 帧**，p95 53.6ms | 同上 |
| 向上 200/400/800px/帧 | 6/6/0 帧（混合热缓存） | **0/0/0 帧** | 同上 |
| 冷跳纯代码区首帧 | 164.1ms（longtask 166ms） | **49.2ms（longtask 60ms）** | `node perf/scrollkinds.mjs` |
| 视口中心藏一行的阳性对照 | 空白 192px | 空白 39–192px（随行高） | `scrollprobe` 自检 |

**落地内容**（文件级）：

- `src/components/VirtualList.vue`：`conversationKey` 切会话判据（P0）；`rangeExtractor` + `listBuffer`
  自适应缓冲；`useAnimationFrameWithResizeObserver:false`；`scrollEndThreshold:-1`（滚动位置单一所有者）；
  RO 回调里按 delta 同步贴底；非贴底只补完全在视口上方的行；切会话清 `pendingJump`。
- `src/utils/scrollIntent.ts` / `listBuffer.ts`：两个纯函数 + 真值表（`scrollIntent.test.ts` / `listBuffer.test.ts`）。
- `src/components/ChatWindow.vue`：传 `conversationKey`；列表外包一层 `relative h-full min-h-0`
  （修 `flex-1` 在非 flex 父级里高度塌陷）；顶部翻页失败/加载中提示；`onLoadMore` 捕获 + 1.5s 退避。
- `src/utils/messages.ts`：合并/保留/替换都按 `local_id ?? msg_id`；三条回归用例。
- `src/utils/previewMetrics.ts` / `messageHeight.ts` / `fileMeta.ts` / `MessageImageBubble.vue` / `MessageItem.vue`：
  `imageBubbleHeight` + `w/h` 透传；附件图预览 URL 到达前就渲染预留框；失败态保持预留高度。
- `src-tauri/src/network/file/share_walk.rs`：PNG/JPEG/GIF/WebP 文件头尺寸解析（无新依赖、无协议/DB 迁移）；
  1:1 收发、群文件完成、中继接收、群公告构建 content 时补可选 `w/h`；两条 Rust 单测。
- `src/utils/codeHighlightCore.ts` / `codeHighlight.ts` / `workers/highlight.worker.ts` / `styles/hljs-theme.css`：
  纯文本首帧 + Worker + LRU + 静态主题；`CodeBlock.vue` 不再同步跑自动检测、不再每实例挂 `<style>`。
- `src-tauri/tauri.conf.json`：CSP 增加 `worker-src 'self'`。
- 探针：`vlist` 13/13、`scrollrestore` 5/5、`scrollreact` 5/5（连跑 3 次）、`imgskel` 7/7、
  `msgovf` 80/80、新增 `historyerr` 6/6。

**仍然存在的边界（不假装已消）**：

1. **群文件/中继的接收气泡在 Offer 时没有 `w/h`**（协议刻意未改）：完成回填 content 时才带上，
   若用户正好看着这张图，仍可能看到一次高度修正。要彻底消掉需要把尺寸放进 Offer 帧（协议变更）。
2. **旧消息没有 `w/h`**：仍按 288 骨架预留，横图首次解码会收缩一次。
3. **代码首帧是纯文本**：Worker 回包后才上色（已授权的观感变化）；缓存命中时首帧就是彩色。
4. **真机未验**：以上都是 headless Chromium 的实测；WKWebView/WebView2/Android 的 Worker 与 CSP
   仍需真机确认（本机已加 `worker-src 'self'`，但未跑真机）。
5. **切会话 `opacity` 淡入**：未纳入本量具；若用户仍觉得"切会话白一下"，下一步应单独测
   `listSwitching` 的两帧透明窗口。

**本轮已改应用码**（与审计轮不同）：见上；5.13.0 尚未打 tag，等本次门禁全绿后再发布。

---

## 11. 验证边界（2026-10-26 收口时现读）

已跑通：

| 层 | 结果 |
|---|---|
| `npm run verify:local` | **24/24 步绿**（前端 1432、Rust 1217、clippy、Android、文档/领域图/panic 棘轮） |
| `perf/scrollprobe.mjs 1200` | 80–800px/帧上下扫 **0/90 帧空白**；估算/锚点读数见 §10 |
| `perf/scrollscenarios.mjs` | 追加 0px、前插 0px、图片延迟完成 0px/0 改高 |
| `perf/scrollkinds.mjs` | 代码首帧 49.2ms（原 164.1ms） |
| `--only=vlist` | 13/13 |
| `--only=scrollrestore` | 5/5 |
| `--only=scrollreact` | 5/5（另在最终调度改动前连跑 3 次 5/5） |
| `--only=imgskel` | 7/7 |
| `--only=msgovf` | 80/80 |
| `--only=historyerr`（新增） | 6/6 |
| `--only=emoji` / `--only=search` | 27/27 / 18/18 |

未跑通 / 不可当作绿的两处：

1. **单进程全量探针在 emoji → search 的段间切换处卡死**：`Runtime.evaluate` 90s 无回包
   （事件尾巴只有两次 `Page.navigatedWithinDocument`，没有产品异常），而 `--only=emoji`
   27/27、`--only=search` 18/18 各自单跑全绿。因此把这一段记为**量具段间切换问题**，
   不是产品红；产品侧受影响的段都已单独跑绿。根因未继续二分（按「卡死的量具要加自述，
   别继续二分」的纪律），下次动探针时应让段间切换显式等待路由落定/清空上一个 app。
2. **`accent` 2 条红是既有问题**：把本批新增的 `@import "./styles/hljs-theme.css"` 整行移除后
   同一探针仍以相同的 `color(srgb …)` 读数失败 ⇒ 与本批无关（浏览器把 `color-mix()`
   序列化成 `color(srgb …)`，探针的解析未接这个形状）。不在本批修。

真机边界：WKWebView / WebView2 / Android 的 Worker + `worker-src 'self'` 尚未实跑；
群文件/中继的 Offer 阶段仍无 `w/h`（完成回填才有），旧消息仍回退 288。
