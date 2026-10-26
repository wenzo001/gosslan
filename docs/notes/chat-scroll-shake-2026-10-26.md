# 群聊滚动区抖动：主题切换 / 新建群任务（2026-10-26 P0）

## 0. 结论

- **A 亮→暗抖动**：`layoutKey` 把 `app.dark` 当布局签名 → 每次切主题 `virtualizer.measure()` 清空全部实测高度 → 估算高度回填，一帧内 67 次 `scrollTop` 增量写入、4 次方向反转、单帧最大位移 1047px。暗色实际只改颜色（见 §2），不应触发测量。
- **B 新建群任务抖动**：新任务行在贴底态被 `measureElement` 先按“变矮”补了 −39.5px，随后 append 的贴底又把它推回 +170px，形成一次可见的上下闪；同时每个成员 ack/回显都会重置 300ms 瞬态窗口，settle 到期再写一次 `bottom`。
- 两者共享同一处状态机：`pinned` 下的高度补偿没有区分“视口内/上方”和“刚追加在底部”的行，且用户上滚判据没有排除“贴底 clamp”。修法是把补偿规则收成一条（增长跟底、收缩只补视口上方），贴底写入幂等，瞬态窗口只给切会话/整替换。

## 1. 现场

- 基线：GitHub 最新 release **v5.13.3**；本轮修复基于 `main = 8a2829f0`（之后另有并行门禁提交 `9a045d93`，不涉及本文件）。
- 复现：Brave（`GOSSLAN_CHROME` 指定）`--only=scrollshake`，真 ChatWindow + 真 store，群聊 40 条混合消息（含任务卡/文件/代码）。
- 红基线：A1 **73 写 / 67 次 measure-delta / 4 次反转 / maxΔ 1047px**；A2 历史中部锚点 `m-shake-12` → `m-shake-4`；B1 4 写 / 1 反转，先 −39.5px 再 +170px。

## 2. 为什么主题不该重测（CSS 证据）

`.dark` 只切 `--gosslan-*` 颜色与 `color-scheme`（`src/style.css:323-414`、`:1540-1546`）；hljs 明暗 padding 逐字相同（`styles/hljs-theme.css:6-11` vs `:50-55`）；滚动条宽 8px 两档相同（`style.css:1066-1082`）；无字体/行高/间距/边框宽变化。`scrollbar-gutter: stable` 也在。⇒ 主题是纯绘制变化，进入 `layoutKey` 只会制造测量风暴。

## 3. 改动

- `src/components/ChatWindow.vue:1907`：`layout-key` 只保留 `app.chatStyle.fontSize`。
- `src/components/VirtualList.vue`：
  - `measureElement` 贴底补偿：**变高**跟着底部走（除非整行在视口下方）；**变矮**只补“整行完全在视口上方”的行。刚追加/视口内底部的变矮交给 append 的贴底，不再先上拽再推回。
  - `schedulePin` / `pinToBottom` / `scrollToBottom`：`gap <= 1` 时不再重复写，消除同一帧多次 `bottom` 写。
  - 用户上滚判据加“已离开底部（gap>1）”：主题/字号测量引发的浏览器 clamp 不再被误判成用户意图。
  - `onItemsChanged`：`suppressTransient()` 只给 `convSwitch` / `swap`；append、ack、同 key 数组替换不续期 300ms。
  - 字号（真实度量变化）：测量前抓 `getAnchor()`（消息 key + 行内偏移）与是否贴底，`measure()` 后按同一身份恢复；底部则回底部。
  - 库的 `scrollToIndex` 写完后标记程序化，避免紧随的 scroll 事件被当成用户上滚。
- `src/stores/useAppStore.ts`：`theme-switching` 定时器改为单例，连续切主题不会叠定时器。
- `src/components/ChatWindow.vue`：强提醒 shake rAF、引用高亮定时器补卸载清理。

## 4. 开源/成熟做法对照与取舍

- **TanStack Virtual 3.19.6（已装）** 支持 `anchorTo:"end"`、`followOnAppend`、`scrollEndThreshold`、`isAtEnd`、`getDistanceFromEnd`、`scrollToEnd`。本轮做过 A/B：把贴底所有权完全交给库（开启 follow + 默认阈值、删掉自研 delta/pin 写）后，`vlist` 切会话反转、`scrollreact` 首帧 gap 回归（30 条里 3 红），因此**不整体迁移**；保留自研状态机，但采用库的规则：只在“更新前已到底”时跟随、稳定 key、按身份锚定。
- **use-stick-to-bottom（bolt.new 在用）**：单个 ResizeObserver、同时处理增长与收缩、靠程序化写入标记区分用户滚动、不 debounce。本修法的“增长跟底/收缩只补视口上方 + 程序化标记”与之一致。
- **React Virtuoso**：`followOutput` 只在底部跟随、`atBottomThreshold`、`atBottomStateChange`。对应到本仓就是 `pinned` + `recentScrollUp` + gap 判据。
- **GitHub Copilot 大 PR 渲染**：高度修正按**身份 + 偏移**而不是像素；本轮字号变化正是用 `getAnchor()` 做同类恢复。
- **Element/Matrix**：read marker + `scrollToEvent`；本仓已有 `scrollToAnchor`，保持。
- **原生 `overflow-anchor`**：与 JS 锚定二选一；虚拟列表用 transform 时不可靠，继续关闭（`style.css:1605`）。

## 5. 验证

- Brave：`--only=scrollshake,vlist,scrollreact,scrollrestore,todosync,msgovf,rowpair,task` → **717/717**；其中 `scrollshake` 16/16 覆盖：底部亮→暗→亮、历史中部连续切主题、新建 1/3 个任务、长描述+6 图任务卡、字号变化、用户上滚不抢、静默期后自己发消息一次性贴底、快速切主题+卸载。
- 本地：`npm test` 1416/1416、`npx vue-tsc --noEmit` 0、`npm run verify:local` 24/24。
- **BLOCKED**：真实 Tauri WKWebView / Windows WebView2 / Android WebView 未在本机跑；真机惯性滚动与系统覆盖层仍需人工验收。Brave 只证明 Chromium 渲染层，不替代这四格。

## 6. 残留边界

- 主题将来若真的改变字体/边框/滚动条宽度，需要独立 `metricsKey`；当前 CSS 证据表明没有。
- 贴底时的浏览器 clamp 现在被归为程序化；用户真实上滚离开底部后下一帧仍会被识别（探针有正向对照）。
- 真实 Windows runner 的 `scrollTop` 时序可能与 Chromium 不同，仍需发版后真机复核。
