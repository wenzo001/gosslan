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
```

现读（`85c71980` 5.14.8 上重跑）：10 段 **717 PASS / 0 FAIL / 1 UNSUPPORTED**（唯一 UNSUPPORTED 是 headless 量不到的
headed-only 格），该格 headed 单跑 **10/10** ⇒ 合起来 **718/718**；`npm test` **1427/1427**；`npm run build`（vue-tsc + vite）通过。

`npm run verify` 本地现读 **14 ✅ + 1 ❌ + 4 未跑**：红的是「领域依赖方向守门」——
棘轮报 `persistence→observability` 新长一对，首例 `src-tauri/src/export.rs:152 crate::mem_diag::note_big_alloc`；
该行**只存在于工作区、不在 HEAD**（`git show HEAD:src-tauri/src/export.rs | grep mem_diag` 为空），
属于并行会话在 `mem_diag` 埋点上的在途改动，不是本轮（本轮只碰 `VirtualList.vue`/探针/文档）。
按 fail-fast 未跑的四步已用**同一条命令**单跑：Change Budget ✅、CHANGELOG 结构 ✅、`npm test` ✅、`npm run build` ✅。

## 8. 修复后复跑上一批的三台夹具（都在 5.14.7 上现跑）

| 夹具 | 关键读数 | 与上一批比 |
|---|---|---|
| `perf/scrollprobe.mjs 1200` | down 80/200/400/800、up 200/400/800、双向换向、慢读上滚：**blankFrames 全 0、maxBlank 0px**；p50 16.3–19.6ms | 持平（上批 0/90） |
| ↳ `up200 anchorDrift` | **152px，3/3 确定** | 做 A/B 换回改前版本后**同样 152px** ⇒ 既有特征（首次向上扫描时上方未测行的首测漂移），不是本轮引入，不再改 |
| `perf/scrollscenarios.mjs` | 前插漂移 **25 帧全 0**（scrollDelta 恰 10340）、追加漂移全 0、`appendYank.jumpedPx 0`、图片在视口内完成 **shiftPx 0 / heightChanges 0**、图片立即可用 shiftPx 0 | 全部持平 |
| `perf/scrollkinds.mjs` | code 首帧 **50.5ms / longtask 60ms / 空白 0**（上批 49.2ms）；text 98.6ms；long 54.7ms（1 帧空白 206px）；image 76.2ms | 持平 |

> 同一时段 `scrollscenarios` 曾报 `coldJump_code` 1 帧空白 + 72ms 长任务，`scrollkinds` 复测为 50.5ms/60ms/0
> ⇒ 那是**并跑浏览器造成的负载噪声**，不是代码变化。

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

## 12. 双引擎对照：③ 的修复被发现只在 Chromium 成立，改为「等 sizer 静定」（v5.14.7 → v5.14.8）

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
