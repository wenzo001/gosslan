# 聊天长列表滚动体验 · 审计与修复报告（2026-10-27）

- 范围：`src/components/VirtualList.vue`、`src/components/ChatWindow.vue`、`src/components/MessageItem.vue` 及其子组件、
  `src/utils/{messageHeight,listBuffer,scrollIntent,previewMetrics,scrollRestore,messages}.ts`、`src/stores/useChatStore.ts`
- 依赖（现读）：`@tanstack/vue-virtual@3.13.47` → `@tanstack/virtual-core@3.19.6`（`package-lock.json` 精确解析，两包各仅一份）
- 修复版本：**5.14.6**（`1e06bb58`）、**5.14.7**（`10e67a74`）、**5.14.8**（`85c71980`）；探针增强 `4c740144`。
  **5.14.6/5.14.7 已随 `v5.14.7` 发布**（tag `35efb210` = 当前 `origin/main`，Release 非 draft/非 pre，17 个资产，2026-10-27T01:37Z）。
  **5.14.8 与本文档提交只在本机**（`85c71980` 不在 `origin/main` 上，无 tag）——未 push 是既定边界，不是遗漏。
- 量具：`scripts/check-ui-runtime.mjs`（Chromium/headed）、`perf/*`、`perf/wk-check.html`（Chromium/WebKit 双引擎自驱动）、
  `perf/wk-scroll-sampler.js`（App 内 WKWebView 真机）

---

## 0. 结论摘要

用户点名的三格症状**全部定位到机制并已修复**，每格都有修复前后的机器读数：

| 症状 | 机制（一句话） | 修复后读数 |
|---|---|---|
| ④ 停稳在底部附近会"弹回/跳到底" | 上方行**收缩**时，库的补偿与应用的同写**两条路都不走** ⇒ 浏览器把 `scrollTop` 夹到新最大值（静置期**零 JS 写入**） | `gapAtSet 60 → gapPre 60`（修前 60 → 0） |
| ① 切会话"闪一下" | 不是白屏、也不是遮罩：内容帧 0 已就位，但落位被推到 ~120ms 后的收口 ⇒ **一帧跳 356/291px** | 跨帧跳 **0**；headed 下 `visibleBlankMs 0` |
| ③ 向上翻历史"成段顿/内容漂" | Vue 适配器的 options watcher 是 **pre-flush** ⇒ 库的 `anchorTo:"end"` 在 **spacer 还没长高**时写位置 ⇒ 必然被 clamp（库内目标 25355、落 17010）；那一帧 400–433ms 也是它 | 三页锚点漂移 **0 / 0 / 0**；前提帧 **16.8ms**、长帧 0 |

**顺带用读数砍掉的三项"看起来该优化"的东西**：
- fold/merge 增量化（C4）：500 条上 `merge 0.3–0.5ms`、`foldReactions 0–0.2ms`、`foldTodos 0.3ms` ⇒ 无收益，不做。
- 复杂行挂载成本（A4）：纯文本对照同样 16.8ms ⇒ 前插卡顿不是挂载；桩行对照失去判别力，不单独建。
- 测量缓存悬崖（E）：来回切 6 次会话 `itemSizeCache.size` 恒为 **60** ⇒ 不是可复现缺陷。

**未覆盖的格子（明写，不当成通过）**：Windows（WebView2 + 滚轮）本轮按用户口径排除；
macOS **引擎**这一层已有读数（`perf/wk-check.html` 在 Safari 27.2/WebKit 下跑真实 `VirtualList`，三格全绿，§12）；
macOS **App 内真机**（WKWebView + 真实会话切换，A8）**仍未取到**——采样器与手册已备好，只差在机器旁按一次键；
其余全部有 Chromium/headed 读数。

---

## 1. TanStack 版本与上游问题核对（源码级，不靠版本号推断）

- **#1227 / PR #1239 已在装版本里**：Issue《Up-scroll jank from uncompensated above-viewport resizes》2026-07-22 closed，
  PR #1239 同日 merged（`a5417b4b`），修复随 `3.17.7`（2026-07-28）发布；安装树 `dist/esm/index.js` 里能逐字读到该 PR
  的注释（"`resizeItem` uses that to decide whether the follow-up `notify` must be synchronous … (#1227)"）。
- **#1227 的默认补偿规则后来又分两档**：首测 `itemStart < scrollOffset`、重测 `itemStart + itemSize <= scrollOffset
  && scrollDirection !== "backward"`（引 #1218）。本仓在 `VirtualList.vue` 里用自定义谓词统一成"整行完全在视口上方才补"，
  并**只在收敛窗口内退让**（见 §3）。
- **动量/越界写保护只对 iOS 生效**（`_canWriteScroll` 里 `isIOSWebKit()`）；库的 `_clampedAdjustment` /
  `_retryClampedAdjustment` **只覆盖 `applyScrollAdjustment`（重测补偿）**，**不覆盖 anchor 命令** —— 这正是 ③ 的成因。
- **Vue 适配器与 React 的差异**：`onChange` 在 Vue 适配器里**丢弃 `sync` 参数**（一律 `triggerRef`），所以 #1239 的
  "同帧提交"是 React 侧机制。实测本仓没有因此出问题（补偿写与 transform 提交在 Chromium 上观察不到分帧），
  但 WKWebView 的时序仍未验（见 §6）。
- **升级评估**：`3.19.7` 的 #1335/#1337、`3.19.8` 的 #1340 都不覆盖"应用自己的写"；`vue-virtual@3.13.48/49`
  分别精确锁 core `3.19.7/3.19.8`（配对 bump、无需 overrides）。用户口径：**先只 bump 跑同轨迹对照，再决定要不要自研**；
  目前三格已修好，bump 的对照基线因此变成"修好之后"的版本。

## 2. 滚动实现（现状）

- 滚动容器 = `VirtualList` 自己的 div（`overflow-y-auto` + `.vlist-no-anchor` 关闭原生锚定 + `pb-6`）；
  行绝对定位、`transform: translateY(start)`；`indexAttribute="data-index"`；`getItemKey = local_id ?? msg_id ?? id`。
- 关键选项：`anchorTo:"end"`、`followOnAppend:false`（贴底由应用 pin 独占）、`scrollEndThreshold:-1`（关掉库的
  wasAtEnd 每条 RO 各写一次）、自定义 `rangeExtractor`（自适应像素/速度缓冲，硬上限 56 行）、
  自定义 `measureElement`（0 高度拒写、≤1px 不重排、两位小数）。
- 写入者：应用侧 5 家（`setScrollTop` 统一入口，含 `schedulePin`/`pinToBottom`/`scrollToBottom`/`applyJump`/
  `scrollToAnchor`/`scrollToOffset`）+ 库 3 类（补偿、anchor、`scrollToIndex`）。**应用写入全部经过 `setScrollTop`**（标记程序化），
  库写入走 `scrollElement.scrollTo(...)`，**不经应用入口** —— 这是 §4 归因台账存在的前提。

## 3. 三处修复（逐条：根因 → 改动 → 读数）

### ④ 停稳在底部附近不再被夹到底（5.14.6）
- **实测**：停在离底 60px 静置 1.5s，期间**零 JS 写入**，`scrollTop` 却 3254 → 3230、`gap` 60 → 0。
  原因是内容**收缩**（估算被实测下修），浏览器把 `scrollTop` 夹到新最大值。
- **根因**：`shouldAdjustScrollPositionOnItemSizeChange` 里 `if (pinned) return false;` ⇒ "整行完全在视口上方"的行收缩时，
  库的补偿与应用的同步跟写**都不走**。
- **改动**：该判据只在**收敛窗口内**（`Date.now() < pinHoldUntil`）返回 false；窗口外"整行在视口上方"一律补。
- **读数**：`gapAtSet 60 → gapPre 60`（修前 60 → 0）。

### ① 切会话首帧就落在新会话的位置（5.14.6）
- **实测**：切到已缓存会话时，内容帧 0 就是新会话（`firstTargetFrame 0`、`maxBlank 0`），
  但滚动位置还停在上一条，随后**一帧跳 356px / 291px**。遮罩 `opacity-0` 全程 computed 值都是 1（无效）。
- **根因**：`onItemsChanged` 只 `armSettleHold()`，落位交给 ~120ms 后的收口。
- **改动**：convSwitch 分支先 `scrollToBottom()`（post-flush：DOM 已换、尚未绘制），再 arm 收敛窗口。
- **读数**：`topJumpAfterTarget` 356/291 → **0**；headed 下 `visibleBlankMs 0`。

### ③ 向上翻历史不再把正在读的那一行推走（5.14.7，5.14.8 改写第二半）
- **实测**：每页前插 100 条，加载瞬间 `scrollTop` **向下掉 267/279px**（本该变大），锚点行随后被推走 **710px**；
  三页里两页失守。期间写入全是库的 `scrollWithAdjustments < _scrollToOffset`（6–8 笔/页）。
- **根因（时序）**：Vue 适配器的 options watcher 是 **pre-flush** ⇒ 库的 anchor 写发生在 **spacer 高度 patch 之前** ⇒
  被浏览器 clamp（库内 `getOffsetForIndex(anchor)=25355`，实际落 17010）。库的 clamp 重试不覆盖 anchor 命令。
- **改动（两条，缺一不可）**：
  1. 在 `computeScrollState`（每帧滚动/写入后都会跑）里**持续**记「视口上沿那一行」的库内身份
     （`getVirtualItemForOffset`，`start − scrollTop`，O(log n)、不读 DOM）。**必须在变化之前**取：
     实测前插的 watcher 里现采会采成 `−1072`（应 −32），后续页甚至取不到 key。
  2. 在 `onItemsChanged` 里按同一目标重发一次；残差 ≤2px 就不写。
     **5.14.8 修正**：不能再假设"post-flush 时 spacer 已长高"——WebKit 下不成立（实测 `keptKey false`）。
     现在改成**每帧 `getTotalSize()` 连续两帧不变才发**，12 帧封顶（§12）。
- **读数**：Chromium 三页漂移 **0 / 0 / 0**；Safari/WebKit 前插锚点 `keptKey true`、drift 0.3px（§12）；
  `vlist` 的"prepend 20 条"守卫格保持绿（证明没把已正确的情形改坏）。

## 4. 根因分类（A–I）与最终状态

| 类 | 结论 | 证据 |
|---|---|---|
| A 缓冲不足（挂载晚） | **已消** | 合成 80–800px/帧 0/90 空白；真 wheel/swipe 也是 0 空白帧 |
| B 估算误差 | **部分消 / 余量不可见** | 图片 `w/h` 预留、代码卡 clamp 已在上批落地；本轮未再观测到可见跳位 |
| B′ 每行 patch 强制布局 | **候选，未证有害** | 机制可证（函数 ref 每次 patch 重调，`getBoundingClientRect`），但两臂无差 ⇒ 不做 |
| C 补偿不正确 | **已修**（④） | 见 §3 |
| D 主线程阻塞 | **已消（本轮无新增）** | 代码高亮 Worker（上批）；前插帧 400→16.8ms 是 ③ 的产物 |
| E 冷启动/重复计算 | **判否（悬崖）/ 冷路径已验** | 缓存曲线恒 60；冷切换骨架 25 帧、揭示后无空白 |
| F 时序冲突 | **已修**（①③） | 见 §3 |
| G CSS/锚定/动画 | **遮罩无效但无害** | computed opacity 全程 1；`overflow-anchor: none` 保持 |
| H 历史加载阻塞 | **已修**（③）+ 上批的失败可重试 | 见 §3；`historyerr` 段 |
| I 其他 | **真输入与合成不能互推** | 见 §5 对照表 |

## 5. 真输入 vs 合成（同夹具、同方向）

| 输入 | 位移 | 空白帧 | 单帧内容位移上限 | 帧 p50/max | 自证 |
|---|---|---|---|---|---|
| 合成 `scrollTop -= 40`×30 | −1049 | 0 | 42 | 16.7 / 33.3 | — |
| 真 wheel `deltaY=-120`×20 @16ms | **−3012** | 0 | **84** | 16.7 / 50–83 | 页面实收 wheel 20 次 |
| touch 手势 + fling | −817 | 0 | 60–61 | 16.7 / 50 | **动量 −128px** |
| 键盘 PageDown×6（焦点已在容器上） | 0 | — | — | — | **UNSUPPORTED**：本夹具/引擎未驱动 |

⇒ **合成位移不能外推**：真滚轮走 3 倍远、单帧内容位移大一倍。历史那批"0/90 空白"只覆盖合成档。
（键盘那一格在本夹具无判据，不许写成"键盘滚动没问题"。）

## 6. macOS / Windows 与真机边界

- **macOS（WKWebView，出货渲染器）**：本轮在做。工具 `perf/wk-scroll-sampler.js`（粘进 Safari Web Inspector 控制台，
  读数走 `log_frontend_error`，单行 2000 字上限 ⇒ 只发摘要，带 `selfCheck`）。前置已核：debug 构建 wry 会
  `setInspectable(true)`、Tauri 默认 `devtools=true`、本 App 未为主窗关掉；`__TAURI_INTERNALS__` 在真页面必然存在。
  **已知注意**：App 注册了全局 `contextmenu` 抑制（`src/App.vue`），所以**应用内右键「检查元素」不可用**，只能走 Safari。
- **Windows（WebView2 + 滚轮）**：本轮**未做**。取数方法：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port`
  + 同一套驱动（`Input.dispatchMouseEvent{type:'mouseWheel'}`）。CDP **发不出** line 模式滚轮（`deltaMode=1`），
  该子格只能真硬件。
- **永久拿不到**：mac 真机像素级 1 帧闪现（`screencapture` 帧率不够）⇒ 只能人眼。

**A8 现状与"能不能绕开 Inspector"（2026-10-27 现测）**：引擎层（Safari 27.2，§12）与 App 层（Chromium 里挂真
`ChatWindow`，`scrollswitch/scrollhist` 等段）都已有读数；**App 内 WKWebView 的帧级读数仍缺**，而它只有两条取数路：
① Safari 开发菜单（或应用内 ⌥⌘I）粘 `perf/wk-scroll-sampler.js`；② 勾「允许远程自动化」后由 `safaridriver` 自动跑。

今天把第三条候选（**系统无障碍控件树**）实测排除了：`scripts/ax-tree.mjs` 解析出来的节点只有 `{role,label}` 两个字段
（实测 66 个节点：12 AXButton / 21 AXPopUpButton / 24 AXStaticText / 9 AXImage，**带 frame/position 的是 0 个**），
消息列表也不作为 AX 子节点出现；单次 dump **3.6–13.2 s**。
⇒ 它能判「控件在不在、名字对不对」（它本来就是这个用途），**判不了滚动位置、锚点漂移和空带**。
换句话说：A8 不是"换个通道就能补"，它卡在一个**只有人能点的一次性开关**上。

## 7. 门禁与复跑

```bash
# 10 段滚动判据（Chromium，headless）
GOSSLAN_PROBE_PORT=5299 GOSSLAN_PROBE_CDP=9445 \
GOSSLAN_CHROME='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' \
  node scripts/check-ui-runtime.mjs --only=vlist,scrollreact,scrollrestore,imgskel,rowpair,msgovf,mergeheight,scrollswitch,scrollshake,scrollhist

# 需要真实可见性（动画）时
GOSSLAN_PROBE_HEADLESS=0 … node scripts/check-ui-runtime.mjs --only=scrollswitch

# 快速层
npm run verify

# WebKit（A8）：一条命令跑完三格；没勾「允许远程自动化」时退 2 并打出要勾的那句
node perf/wk-a8.mjs
```

现读（`85c71980` 5.14.8 上重跑）：10 段 **717 PASS / 0 FAIL / 1 UNSUPPORTED**（唯一 UNSUPPORTED 是 headless 量不到的
headed-only 格），该格 headed 单跑 **10/10** ⇒ 合起来 **718/718**；`npm test` **1427/1427**；`npm run build`（vue-tsc + vite）通过。

`npm run verify` 本地现读 **14 ✅ + 1 ❌ + 4 未跑**：红的是「领域依赖方向守门」——
棘轮报 `persistence→observability` 新长一对，首例 `src-tauri/src/export.rs:152 crate::mem_diag::note_big_alloc`；
该行**只存在于工作区、不在 HEAD**（`git show HEAD:src-tauri/src/export.rs | grep mem_diag` 为空），
属于并行会话在 `mem_diag` 埋点上的在途改动，不是本轮（本轮只碰 `VirtualList.vue`/探针/文档）。
按 fail-fast 未跑的四步已用**同一条命令**单跑：Change Budget ✅、CHANGELOG 结构 ✅、`npm test` ✅、`npm run build` ✅。

## 8. 修复后复跑上一批的三台夹具（2026-10-27，**在 5.14.8 树上现跑**）

| 夹具 | 关键读数 | 与上一批比 |
|---|---|---|
| `perf/scrollprobe.mjs 1200`（5 次） | 全部方向 blankFrames **0/90**、maxBlank **0px**；p50 15–37ms | 持平（上批同为 0） |
| ↳ `up200 anchorDrift` | **152px，每次一致** | A/B 换回改前版本同样 152px ⇒ 既有特征（首次向上扫描时上方未测行的首测漂移），不是本轮引入 |
| ↳ 量具自检 | 5 次里 **1 次** `control.ok=false`（`restoredBlankPx 24`），该次读数**自己作废**；其余 4 次 `restoredBlankPx 0` | 夹具在负载下会偶发假红，但**不会假绿**（自检不过就不出读数） |
| `perf/scrollscenarios.mjs`（3 次） | 前插漂移 **25 帧全 0**、追加漂移全 0、`appendYank.jumpedPx 0`、图片在视口内 **shiftPx 0 / heightChanges 0**、图片立即可用同 0 | 全部持平 |
| ↳ `coldJump_code / coldJump_text` | **1 帧空白 61.5px / 111px**，且 `longTasks` 为空时也复现 ⇒ 上批把它写成"负载噪声"**是错的** | A/B（改前 `bc06d55d`）**1 帧 47.5px / 111px** ⇒ **既有特征**，不是本轮引入；带在案，不再改 |
| `perf/scrollkinds.mjs`（2 次） | code 首帧 **39.8ms / 0 空白 / 0 长任务**；text 61.3ms；long 33.8ms（**1 帧空白 206.5px**）；image 53.0ms | 持平；`long` 那 1 帧 A/B 里同样存在（改前 239px）⇒ 既有 |

**引擎侧计数（本轮新加，`perf/scrollprobe.mjs`）**：围着整套 870 帧场景从 CDP `Performance.getMetrics` 取前后差 ——
`LayoutCount 4 880–4 890`（**5.61 次/帧**）、`RecalcStyleCount 9 092–9 105`（**10.45 次/帧**）、
`TaskDuration 10.1–10.4s`、`ScriptDuration 0.6–0.9s`，5 次复跑几乎同值。A/B 到改前：`5.60–5.61 / 10.47` ⇒
**本轮没有增加重排/重算次数**（`RecalcStyleDuration` 反而从 0.75s 降到 0.47s）。
不报 `Nodes` Δ：同条件下三次读出 −9 905 / +3 859 / +49 659（含待回收节点），不可复现 —— DOM 增长只看 mem 档。

**A/B 方法（可复跑）**：`git worktree add /tmp/wt-prefix 1e06bb58~1`（不含本轮三处改动）→ 软链 `node_modules` →
在 worktree 里 `npx vite --port 5399` → 同一个 CDP（`PROBE_CDP`）、同一夹具、`PERF_PORT` 切端口。
两边都跑 2 次以上，读的是**同一台机、同一时段**；跑完 `git worktree remove --force`。前置：
worktree 里 `git status` 必须是干净的，否则 A/B 的两臂不只有一处差异。

> **更正一条上批写错的归因**：上批 `scrollscenarios` 报 `coldJump_code` 1 帧空白 + 72ms 长任务后，
> 因为 `scrollkinds` 复测出 0 空白，就写成"并跑浏览器的负载噪声"。本轮 3 次连跑 + 无长任务时也复现
> （61.5px），A/B 到改前版本同样 1 帧（47.5px）⇒ 它是**既有特征**，"噪声"那个结论不成立。
> 教训：**"换一台夹具没复现"不等于"上一次是噪声"** —— 两台夹具的不同格（`scrollkinds` 的 code 格与
> `scrollscenarios` 的 coldJump 格）根本不是同一个测量，前者为 0 不能否证后者。

## 9. 本批新增/强化的量具

- `--only=` 段名**现解析校验**：打错名字**退 2**（此前是"一段不跑 + 打绿 + 退 0"）；零判据判红；汇总增四态与"已选段"。
- **写入归因台账**（唯一安装器 `installScrollLedger`）：拦实例 `scrollTop` + `scrollTo`/`scrollBy`/`scrollIntoView`，
  owner（app/lib/harness/unowned）与 mark（最内两层调用，如 `setScrollTop<measureElement`）分开记，
  逐窗差量、`requested/readback`、`overContent`（按同帧 `sh-ch` 判"被内容夹住"）、帧间隔分布；
  `GOSSLAN_PROBE_A1=0` 作为**观察者效应门**。踩过的四个坑已写进注释：实参个数改了重载 ⇒ 静默无效；
  热路径读 `scrollTop` ⇒ 观察者效应；`+(+null)`=0 造假读数；观察者效应门是默认动作。
- 新段：`scrollhist`（前插链时间 + 锚点 + 纯函数耗时）、`scrollswitch`（切会话逐帧 hidden/blank/内容身份 + 缓存曲线）、
  `scrollinput`（真 wheel / touch+fling / PageDown 对照合成位移）。
- `perf/wk-scroll-sampler.js`：WKWebView 真机采样器（selfCheck：藏一行 ⇒ blank 必涨；不 ok 就别采数）。

## 10. 明确不做 / 待定

- **不做**：调 `overscan`/`maxRows`/任何阈值（`git diff` 里这些行一行没动）；换库；固定行高；关动态测量；
  一次性加载全部历史；协议/DB 变更。
- **暂缓（有理由）**：A2 白带 T1/T2/T3 分型 —— 症状②用户未点名，且真输入三档空白帧都是 0，再建分型不改变任何判断。
- **待定**：依赖 bump（用户口径"先只 bump 跑同轨迹对照"）；真机格读数（进行中）。

## 11. 残余边界（不假装已消）

1. 群文件/中继的 Offer 阶段没有 `w/h`（完成回填才有）⇒ 用户正看着那张图时仍可能有一次高度修正。
2. 旧消息无 `w/h`：按 288 骨架预留，横图首次解码会收缩一次。
3. ③ 的修法已不再假设"post-flush 时 spacer 已长高"，改为**等 `getTotalSize()` 静定再发**（§12）。
   残余：静定等待有上限（12 帧）；若那一瞬间还有异步内容在持续改高（图解码 / 字体），重发会放弃 ⇒ 回到未修正的漂移。
4. 键盘原生滚动在本夹具无判据（UNSUPPORTED），不是"没问题"。
5. 真机像素级 1 帧闪现只能人眼。
6. **冷跳 / 超长消息各有 1 帧空白**（`coldJump_code 61.5px`、`coldJump_text 111px`、`long 206.5px`）。
   A/B 到改前版本同样存在（47.5 / 111 / 239px）⇒ **既有特征，不是本轮引入**，本轮未动；
   要治得另立一题（方向是"跳转后首帧先按估算画、再等测量"之外的预测量策略），不在①②③范围内。
7. `up200 anchorDrift 152px`：首次向上扫描时上方未测行的首测漂移，A/B 证明既有，本轮不改。

## 12. 双引擎对照（**本节结论已被今晚的正控部分推翻，先读 12.1**）

### 12.1 ⚠️ 更正（2026-10-27 晚）：那次"WebKit 下失效"**不可复现**，5.14.8 只能算防御性改动

下午的记录是：在 Safari 27.2 手工跑这台夹具，读到 `keptKey=false`（m-188 → m-207，−131.5 → −66），
据此判定 5.14.7 的"post-flush 重发"在 WebKit 下被 clamp，于是有了 5.14.8 的静定门。

晚上把它搬进**真 WKWebView 宿主**（`perf/wk-host.swift`；wry 出货用的就是 WKWebView，能自动跑）后，先做了正控：

| 正控 | 做法 | 结果 |
|---|---|---|
| 锚点格有分辨力吗 | 把 `reissuePrependAnchor` **整段 `return`**（等于没有重发） | **`keptKey` 仍然 true**，drift 0.3 ⇒ **这格没有分辨力** |
| 两格扫描有分辨力吗 | 把 `rangeExtractor` 的缓冲整段摘掉（只渲染可视区） | **下滚 25 帧 / 上滚 26 帧空白**（79/81px）⇒ 有分辨力 |

再把**5.14.7 的代码**（`10e67a74`）放进同一个宿主，换 4 种窗口几何重跑：

| 几何 | A 格 | 下滚 | 上滚 |
|---|---|---|---|
| 1000×760 | `keptKey=true`，drift 0.3 | 0 帧 | 0 帧 |
| 1280×900 | `keptKey=true`，drift 0.5 | 0 帧 | 0 帧 |
| 900×1200 | `keptKey=true`，drift 0.3 | 0 帧 | 0 帧 |
| 1440×900 | `keptKey=true`，drift 0.8 | 0 帧 | 0 帧 |

再拿**唯一有分辨力的锚点判据**（`scrollhist`，Chromium + 真 `ChatWindow`，2026-10-27 白天的读数里它修前是
"0 / 丢 key / +710"）去打 **5.14.7 的原码**：`6/6 全绿`（"每页前插后正在读的那一行仍在原位，同 key 且 |Δoffset| ≤2px"）。

⇒ **"5.14.7 在 WebKit 下失效"这个结论，在出货渲染器上不成立，在有分辨力的判据上也看不到必要性。** 那次 Safari 读数现在也无法复核
（Safari 已开「仅限 HTTPS」：`http://127.0.0.1` 直接被 `WebKitErrorDomain:305` 拦掉，
`localhost` 会停在"此连接不安全"要人手点）⇒ 按现有证据它**归因不明**。

**所以三件事要改口径**：
1. 锚点这一格的**可信证据仍然只有 `scrollhist`（Chromium、真 ChatWindow）**：修前 0 / 丢 key / +710，修后 **0 / 0 / 0**。
   本夹具的 A 格从此**只打印、不判定**。
2. **5.14.8 的静定门没有可复现的必要性证据**。它的行为有界（最多等 12 帧、每帧一次 `getTotalSize()`），
   两个引擎的现有判据下都绿，但按"证据不足不该修"的口径，它是**防御性改动** —— 保留还是回退，需要拍板。
3. `perf/wk-a8.mjs` 现在只判**两格扫描**，并把"锚点格无分辨力"写进输出与注释。

以下 12.2 是当天的原始记录，保留它是为了让下一个人看到**结论是怎么被推翻的**。

### 12.2 原始记录（2026-10-27 下午，现已被 12.1 否证）

新增自驱动夹具 `perf/wk-check.html`（挂**真实 `VirtualList`**，页面自己跑「前插锚点 / 快速下滚 / 快速上滚」，
结果用 Image 信标回传本地服务）。同一份页面、同一段代码、同一组数据：

**v5.14.7 的写法（post-flush 直接重发一次）—— 两引擎不一致：**

| 引擎 | 前插锚点 | 下滚 / 上滚空白 |
|---|---|---|
| Chromium（headless Brave） | `keptKey true`，drift **0.3px** | 0 帧 / 0 帧，p50 16.7ms |
| **WebKit（Safari 27.2，AppleWebKit 605.1.15）** | **`keptKey false`**（m-188 → m-207，偏移 -131.5 → -66） | 0 帧 / 0 帧，p50 17ms |

**成因（与预判一致）**：重发那一笔依赖"post-flush 时 spacer 已长高"。WebKit 的布局时序与 Chromium 不同，
post-flush 那一刻 spacer 仍是旧高度 ⇒ 新目标位置被 clamp 回旧上限，等于没修。
**而 macOS 出货的就是 WebKit（WKWebView 与 Safari 同引擎）⇒ v5.14.7 那笔对 macOS 用户无效。**

**v5.14.8 的写法（`85c71980`）**：`reissuePrependAnchor` 改为**有界静定门**——每帧读 `getTotalSize()`，
连续两帧不变才发那一次 `setScrollTop`；12 帧内不静定就放弃（不写，保持原状态）。

| 引擎 | 前插锚点 | 下滚 / 上滚空白 | 帧时间 |
|---|---|---|---|
| Chromium | `keptKey true`，drift **−0.5px** | 0 帧 / 0 帧 | p50 16.6ms |
| WebKit（Safari 27.2） | `keptKey true`，drift **0.3px** | 0 帧 / 0 帧 | p50 17ms |

**这台夹具的边界**（不许越过）：它挂的是真实 `VirtualList` + 等价行模板，**没有** ChatWindow/store；
所以它只回答"VirtualList 的锚定/空白/帧时间在两个引擎上是否一致"，不替代 App 内会话切换的真机读数。
真机格（A8，App 内 WKWebView + 真实会话切换）仍未取到读数。

**WKWebView 那一格现在能自动跑（2026-10-27 晚，`node perf/wk-a8.mjs`）**：不再需要 Inspector、不需要
「允许远程自动化」、也不需要人点。做法是 `perf/wk-host.swift` 编一个小宿主（NSWindow + WKWebView，
`.accessory` 不进 Dock），把 `perf/wk-check.html` 装进去 —— **跑的就是出货那个 WKWebView**，页面自己驱动、
自己用 Image 信标回传。三条传输都留着：`wkwebview`（默认）/ `open`（Safari，受「仅限 HTTPS」影响）/ `webdriver`。
判据只有**两格扫描**（下滚/上滚 `blankFrames===0`），正控是"摘掉 `rangeExtractor` 的缓冲 ⇒ 25/26 帧空白"。
**锚点格不判**（正控证明它无分辨力，见 §12.1）。引擎身份必须 `AppleWebKit` + 厂商 Apple：
WKWebView 的 UA 里没有 `Safari/` 段，所以 `safari` 会是 false、`wkwebview` 才是 true —— 两者不许混用。

早期更麻烦的两条路（现已不需要）记在这里备查：`safaridriver` 要人在 Safari 设置里勾一次「允许远程自动化」；
Safari 开了「仅限 HTTPS」后 `http://127.0.0.1` 会被 `WebKitErrorDomain:305` 拦掉。

## 13. 资源不持续增长（`PERF_ONLY=mem`，2026-10-27 在 5.14.8 上现跑）

量具是仓库里已有的那台：`perf/run.mjs` 的 mem 档 —— `HeapProfiler.collectGarbage` + `Performance.getMetrics`，
**不给页面加任何钩子**（量具一改被量对象，量的就是量具自己）。跑法：

```bash
# 需要一台 vite + 一台带 --remote-debugging-port=9223 的浏览器（run.mjs 的 CDP 端口是硬编码 9223）
PERF_ONLY=mem PERF_MEM_STEPS=900 PERF_MEM_BLOCK=900 PERF_PORT=5299 node perf/run.mjs 20000
```

| 读数（900 步/方向，跑完先 GC 再采） | 结果 |
|---|---|
| `JSHeapUsedSize` 前后差（9 次） | **−0.11 … +0.53 MB**，其中 8 次落在 ±0.11 内 |
| `JSEventListeners` | 恒 **12**，前后差 **0**（9/9） |
| `Nodes` / `document.querySelectorAll('*')` | 359–370 / 192–198 —— **随方向变、不随步数累积** |
| 逐块曲线（每 900 步一点） | 8.38 → 8.45 MB，**没有上行台阶** |

⇒ "这条路径上没有随滚动累积的东西"是有读数的结论；**但不是"没有泄漏"的证明** ——
V8 的 `self_size` 不含字符串/Blob 的外部内存（边界见 `perf/heapDelta.mjs` 文件头）。

**必须一起写下来的夹具特征**：`down` 方向有两种模态 —— 「暖」（`offsetsRebuilds 0`、长帧 0–1）与
「冷」（`offsetsRebuilds` 500–4500、长帧 60–784）。**两臂都会进冷模态**（改前 2/5、改后 1/4），
而且改前的冷模态更差（133 / 784 长帧 vs 改后 60）。⇒ 这是**夹具的缓存态**性质，不是本轮回归；
判回归只能看同一臂的**分布**，单看一次跑会得出相反结论（本表就是按分布在读）。

## 14. 验收九项 → 读数在哪（自审用；有就是有，缺就写缺）

| # | 要记的东西 | 现状 | 读数/证据位置 |
|---|---|---|---|
| 1 | 空白视口次数 / 时长 | **有** | §8 `blankFrames / maxBlankPx`（9 组扫描）；① 的 `visibleBlankMs`（headed） |
| 2 | 帧时间分布 | **有** | §8 `p50 / p95 / maxFrame` + 逐帧 `frameTops` 曲线（台账里有） |
| 3 | 长帧 | **有** | §8 `longFrames / longTasks（worst 前 5）`；`scrollkinds` 分类型 |
| 4 | 主线程阻塞 | **有（按引擎换量具）** | Chromium：`longtask` 条目（§8 `longTasks` 的 count/worst）；WebKit **没有 longtask API** ⇒ 用帧间隔（§12 的 `p50/frameMax` 与空白帧数）代替。**不许**把两列并成一张表比较 |
| 5 | 进入可视范围 → 真正可见的延迟 | **有（视口级 + 持续时间）** | 覆盖率量具本来就是**逐行取矩形**再算空带 ⇒ 少一行就必然表现为一条空带：`maxBlankPx`（缺口有多宽）、`longestBlankRun`（连续几帧）、`firstFullBlankFrame`（跳转后第几帧铺满）、① 的 `visibleBlankMs`。**没有**逐行身份级延迟（要往被量对象里挂钩子，不做） |
| 6 | 测量/重测/挂载卸载次数 | **有（引擎侧 + 数据侧）** | 引擎侧：`Performance.getMetrics` 围着整套场景取前后差 ⇒ **5.61 次 layout / 10.45 次 style recalc 每帧**（5 次复跑同值，见 §8）；数据侧：`add/rem`（挂载/卸载）、`styleMut`（measure 写 transform）、`itemSizeCache.size`、`offsetsRebuilds`。**没有**逐次 `measureElement` 计数——引擎侧那两个数就是它的可观测量，再加计数会改被量对象 |
| 7 | 锚点偏移 | **有** | §8 `anchorDrift`（up200 152px 既有）/ `prepend drift 25×0`；§12 双引擎 `keptKey + drift` |
| 8 | DOM / CPU / 内存增长 | **有** | §13（9 次 900 步：堆 Δ、listeners、nodes/dom、逐块曲线） |
| 9 | 冷热与双平台差异 | **部分** | 冷热：`coldJump_*`、`imageColdThenWarm`、`scrollswitch` 缓存曲线；平台：§12 双引擎（mac 两引擎都有），**Windows NOT RUN**（用户本轮排除） |

读完这张表的正确结论：**九项里八项在本轮有读数**，其中 4/5/6 三项是"换了一把量具"得到的
（WebKit 没有 longtask ⇒ 帧间隔；逐行身份级延迟与逐次 `measureElement` 计数要往被量对象里挂钩子 ⇒ 用引擎侧的
layout/style 计数与空带持续时间代替）。**只剩第 9 项的 Windows 一列是 NOT RUN**（用户本轮排除，方法见 §6），
它不是"没问题"，是没测。

## 15. 八个问题的最终回答（**实施之后**重答；计划文档里那一版是实施前的）

1. **最值得优先处理的三件**：① **写入归因台账**——它是"静置期零 JS 写入"的唯一证词，④ 能定性全靠它；
   ② **④ 的补偿谓词**（`pinned` 整条豁免 ⇒ 上方行收缩时两条补偿路都不走）；③ **③ 的时序**——
   "读数取在变化之前、写入发在布局之后"，并且要补上 WebKit 的 sizer 静定门。三件都已落地。
2. **证据不足、当前不该修的**：`up200 anchorDrift 152px`、`coldJump`/`long` 的单帧空带（两者 A/B 都证明既有）、
   fold/merge 增量化（0.3–0.5 ms）、行挂载成本（纯文本对照同样 16.8 ms）、测量缓存悬崖（`itemSizeCache.size` 恒 60）。
   共同点：机制说得出，**读数表明无可观测代价**。
3. **必要 / 可简化的量具**：必要——写入归因台账（唯一能分 app/lib 的地方）、空带检测 + 自检控制组、
   双引擎夹具（**就是它抓到了 WebKit 失效**）、`PERF_ONLY=mem`（资源不增长唯一的读数）。
   可简化——`scrollinput` 的 touch+fling 与合成位移对照（只需证明"合成不能外推"一次）；
   引擎侧 layout/style 计数（怀疑重排时再跑，不必每轮进网）。
4. **最小风险的第一项产品码修复**：④ 的谓词——`if (pinned) return false` 改成"只在收敛窗口内 return false"，
   3 行、可单点回退、且有正控格（"真贴底仍会跟"）守着。
5. **WKWebView 接不上时的调整**：最后走的是"自己写宿主"这条路——`perf/wk-host.swift` 起一个真 WKWebView
   （出货那个渲染器）跑 `perf/wk-check.html`，`node perf/wk-a8.mjs` 一条命令出数，不需要任何授权。
   剩下的缺口只有 **App 内**（真 `ChatWindow` + 真库 + 真进程）那一层：它仍要靠 Chromium 上挂真 `ChatWindow` 的
   `scrollswitch/scrollhist` 兜"应用层没额外破坏"，**不**把 WKWebView 的 App 内读数记成通过。
6. **最易破坏既有行为的修复**：④ 的谓词收窄（会改写 `scrollreact/scrollshake` 里"容差内跟高"的若干格）与
   ③ 的重发（多写一次 `scrollTop`）。守它们的正是那两组正控格；10 段 718/718 就是这条防线现在的读数。
7. **最重要的未知项**：**Windows（WebView2 + 离散滚轮）整列**——零读数，且输入模型与 macOS 不同。
8. **进入下一阶段的条件**：A8 拿到至少一次 App 内 WKWebView 读数，**或**明确接受"引擎层 + 应用层"两层替代；
   依赖 bump 按用户口径单独做一次同轨迹对照（3.13.47 → 3.13.49 / core 3.19.6 → 3.19.8）。

**决策摘要（一句话）**：①②③ 都已定位到机制、修好、并有两层读数；剩下的三件事分别需要**人点一次**（A8 的勾）、
**已明确排除**（Windows）、**等你拍板**（依赖 bump）——在拿到它们之前不建议再动产品码。

## 16. 方案排序与分阶段实施（交付第 7、8 项；状态是现读）

**排序口径**：先看「能不能解释用户点名的症状 → 有没有正控证明没改坏 → 能不能单点回退」，再比成本。
**规模小不构成排在前面的理由。**

| 排序 | 项 | 收益 | 风险 | 状态 |
|---|---|---|---|---|
| 1 | 写入归因台账（app/lib/unowned 分开记） | 让"谁写的 `scrollTop`"可判——④ 能定性全靠它 | 极低（只在探针里） | **已完成**（`1e06bb58`） |
| 2 | ④ 补偿谓词收窄 | 直接消掉"停稳后弹回" | 中（会改写若干"容差内跟高"的格）⇒ 正控格 + 10 段 718/718 | **已完成**（5.14.6） |
| 3 | ① 切会话同帧落位 | 消掉一帧 356/291px 的跳 | 低（只动 convSwitch 分支） | **已完成**（5.14.6） |
| 4 | ③ 取值前置 + 布局后重发 | 消掉上翻时锚点被推走 | 中（多写一次 `scrollTop`）⇒ `vlist/scrollhist` 守着 | **已完成**（5.14.7 → 5.14.8 静定门） |
| 5 | 依赖 bump（vue-virtual 3.13.47→3.13.49 / core 3.19.6→3.19.8） | 上游已修项与本轮结论一致 | 低-中（锁文件 + 一次同轨迹对照） | **未做**（用户口径：单独一笔、先 bump 再定要不要自研） |
| — | A2 白带 T1/T2/T3 分型 | 只在症状②被点名时才有用 | — | **暂缓**（②未点名；真输入三档空带均 0） |
| — | B′ `measureRowRef` 去 rect、B1/B2 估值预留加码 | 机制可证，但两臂无差 | 低 | **不做**（读数不支持） |
| — | E1 测量缓存改有界驱逐 | 悬崖不可复现（`itemSizeCache.size` 恒 60） | — | **不做** |
| — | 调大 overscan / `maxRows` / 阈值 | 只会掩盖根因 | 高（用户明令禁止） | **不做** |

**阶段与验收**
- Phase A 只读审计：A–I 分类 + 量具有效性表 + 不确定性表 ⇒ 报告 §4 / §9。
- Phase B 量具：关掉 `--only` 假绿通道、写入归因台账、`scrollhist/scrollswitch/scrollinput`、双引擎夹具 ⇒ 报告 §9 / §12。
- Phase C 修 ④①：**5.14.6**；Phase D 修 ③：**5.14.7**（Chromium 通过）→ **5.14.8**（WebKit 也通过，静定门）。
- Phase E（未开始）：A8 一次 App 内读数 / Windows 整列 / 依赖 bump —— 三件都要人拍板或人点一次。

**当前验收读数（5.14.8）**：10 段滚动判据 **718/718**（headed 补齐那格）；`npm test` **1427/1427**；
`vue-tsc + vite build` 通过；资源 900 步 × 9 次**无增长台阶**；引擎侧 **5.61 layout / 10.45 style recalc 每帧**，A/B 与改前一致。

## 17. 判据功率表：每个修好的症状，都有一条**修前会红**的判据（2026-10-27 现跑）

背景：晚间在 WKWebView 里发现 `perf/wk-check.html` 的锚点格**没有分辨力**（把修复整段摘掉它仍是绿的，§12.1）。
按"先证能红，再信它绿"的口径，把 HEAD 的探针拿到**修前代码**（`bc06d55d` = `1e06bb58~1`）上跑同一批段：

```bash
git worktree add /tmp/wt-power 1e06bb58~1 --detach && ln -s <repo>/node_modules /tmp/wt-power/node_modules
cp -R scripts perf /tmp/wt-power/          # 用 HEAD 的探针跑修前的源码 —— 只有"被测那一层"不同
cd /tmp/wt-power && GOSSLAN_PROBE_PORT=5296 GOSSLAN_PROBE_CDP=9252 \
  node scripts/check-ui-runtime.mjs --only=scrollreact,scrollshake,scrollswitch,scrollhist,vlist
```

| 症状 | 判据（探针里的原文标题） | 修前 `bc06d55d` | 现在 5.14.8 | 结论 |
|---|---|---|---|---|
| ④ 停稳后弹回 | 「A11 静止期（离底 60px、什么也不做 1.5s）：位置不许自己变（gap 仍 ≥59）」 | **❌** | ✅ | 有功率 |
| ③ 上翻推走正在读的行 | 「向上翻历史：每页前插后，正在读的那一行仍在原位（同 key 且 \|Δoffset\| ≤2px）」 | **❌** | ✅ | 有功率（**③ 唯一有功率的判据**） |
| ① 切会话闪一下 | 「切到已缓存会话：目标会话出现后滚动位置不再跨帧跳（≤2px/帧）」 | **❌** | ✅ | 有功率 |
| 其余 51 格 | —— | ✅ | ✅ | 与本轮三症状无关（或本来就对） |

修前那轮统计：**PASS 51 / FAIL 3 / UNSUPPORTED 1**（UNSUPPORTED 与现在同一格：headed-only 的可见空白时长）。
⇒ 这三格不是"恰好现在绿"，而是**被修前代码自己证过会红**；反过来说，⑤ 里那条"修前也绿"的段不承担这三格的举证。

**由此定下两条规矩**（写在这里防止以后再犯）：
1. 新增/改写任何一格滚动判据，**必须先造一次红**（摘掉被测机制或回到修前代码），把那次读数记下来；没红过的格只能算"没报警"，不算"守住了"。
2. 一台夹具上的"红"不能跨夹具外推：`wk-check.html` 的锚点格在 Safari 上红过一次，但用修前代码在 WKWebView 宿主的 4 种几何下都绿
   ⇒ 那次红**既不能证明修复有效，也不能证明修复必要**。跨宿主/跨几何的结论必须各自带正控（§12.1）。
