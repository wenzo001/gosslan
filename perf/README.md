# perf/ —— 长会话压测台（手动运行）

用**真实的 `VirtualList` 组件**与**真实的高度估算函数**灌入 5 万 / 10 万条合成消息，
采集滚动帧间隔与定位准确度，用来回答"长会话会不会卡、跳转准不准"。

## 怎么跑

需要三个进程（分别在终端里开着）：

```bash
# 1) dev server（压测页只是普通 Vite 页面）
npx vite --port 5199 --strictPort

# 2) 带调试端口的 headless 浏览器（用本机已装的 Chromium 内核浏览器即可）
"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
  --headless=new --disable-gpu --no-sandbox --user-data-dir=/tmp/brave-perf \
  --remote-debugging-port=9223 --window-size=1280,900 \
  "http://127.0.0.1:5199/perf/vlist.html?n=100000"

# 3) 采集（node 22+ 自带 WebSocket，无需装依赖）
node perf/probe.mjs 9223     # 先断言虚拟化是否生效
node perf/run.mjs 100000     # 再采帧间隔与定位数据
```

## ⚠️ 已知问题：先看断言，再看数据

**跑之前必须确认 `node perf/probe.mjs` 输出 `virtualizationOK: true`**
（即 `renderedRows` 远小于总数）。当前状态是 **false**：滚动容器高度已正确约束成 700px，
组件**仍然把 10 万行全部渲染**了 —— 这是尚未定位清楚的问题，嫌疑点是
`viewport` 只在 `ResizeObserver` 回调里更新，容器尺寸变化后如果 RO 不再触发，
视口会停留在旧的大值，`end` 就覆盖全表。

在断言为 true 之前，`run.mjs` 采到的帧间隔**不能当作线上结论**（条件比真实聊天页更糟）。

## 与真实聊天页的差异

- 行模板用等价结构（头像 + 昵称 + 气泡），未挂 `MessageItem` 的交互/右键/引用逻辑；
- 图片/文件行用等高的占位块（与估算假设对齐），避免"实测 vs 估算"的巨大偏差掩盖真实信号；
- 没有 ChatHeader / 输入框，视口略大。以上只会让数据**偏乐观**，不影响结论方向。

## 测出来的两颗地雷（待修，见 `.workbuddy/artifacts/vlist-perf-selfcheck.md`）

1. `offsets` 是全表前缀和（O(n)），`commitHeight` 每次实测高度变化（>1px）都会触发**整表重算**；
2. 重算循环里对每条都调 `estimateHeight`，而它对 `file` 类消息会 `JSON.parse(content)`
   → 一次重算 ≈ N 次估算 + N/10 次 JSON 解析。
