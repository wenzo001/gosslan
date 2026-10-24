# CSP 候选与代价（2026-10-16，**只写不改**）

负责人选"单独一轮再上"。这份是那一轮的起点材料。`src-tauri/tauri.conf.json` 现读仍是 `"csp": null`，
本文不落任何配置改动。

## 一、为什么它不是一行配置

> **2026-10-24 复核修正**：下面这条"`script-src 'self'` 会直接掐死首屏"的前提**不成立**。
> Tauri 2.12 在打包时会给内联 `<script>` 计算 `'sha256-…'`、给 `<style>` 注入 `'nonce-…'`
> （`tauri-codegen/src/context.rs` 的 `inject_script_hashes`，以及 `tauri-utils/src/html2.rs`
> 的 `inject_nonce_token`；本项目没有开 `dangerousDisableAssetCspModification`）。
> 所以严格 CSP 不需要先改构建链 —— 实际落地见 §五（方案已改为严格，两个
> `'unsafe-inline'` 已删除）。下面原文保留，作为当时的分析记录。

构建期 `vite.config.ts` 的 `gosslan:inline-boot`（约 36-42 行）把两份资源**以内联形式**塞进每个入口 HTML：

```
<!-- GOSSLAN_THEME_BOOT -->   →  <script>   …src/boot/theme-boot.js…   </script>
                                 <style>    …src/boot/skeleton.css…    </style>
```

于是：

- `script-src 'self'` 会**直接掐死首屏**（主题决策脚本跑不了 ⇒ 白屏或闪一下错误主题）；
- `style-src 'self'` 同理掐死骨架屏关键 CSS。

**两条路，选一：**

| 路 | 做法 | 代价 |
|---|---|---|
| A（小） | CSP 里给 `script-src 'self' 'unsafe-inline'` + `style-src 'self' 'unsafe-inline'` | 严格意义上这**没挡住**"注入脚本"这一类（`unsafe-inline` 就是给它开的）；挡住的只有外链资源与跨源取数 |
| B（正经） | 先把两个 boot 注入改成**外链文件**（构建期产出 `theme-boot.js`/`skeleton.css` 而非内联），再上不含 `unsafe-inline` 的 CSP | 动构建链 + 五个入口 HTML + 首屏时序（主题决策必须早于样式），是一次独立改动，不是配置项 |

我的建议：**先 B 再 CSP**；只有 B 做完，这一格才买到它名字承诺的东西。
若只想尽快收掉"外链资源"这一半，可以先上 A 并**在注释里明写 A 含 `unsafe-inline`、不防注入**，免得下一个人以为这格已经严了。

## 二、要放行的来源（现读，不是猜）

| 指令 | 需要 | 依据 |
|---|---|---|
| `default-src` | `'none'` | 兜底 |
| `script-src` | `'self'`（+ `'unsafe-inline'` 若走 A） | 五入口各 1 个外链 script（现读 `attr_script=1` × 5）+ 构建期内联注入 |
| `style-src` | `'self'`（+ `'unsafe-inline'`） | Tailwind 编译产物是外链 css；但运行时 Vue 会注入 style 标签，且 boot 有 `<style>` |
| `img-src` | `'self'` `blob:` `data:` | 前端 `blob:` 现读 **53 处**（图片预览/缩略图走 blob），`data:` 给 emoji/内联小图 |
| `connect-src` | `'self'` `ipc: http://ipc.localhost` `http://tauri.localhost` `blob:` | Tauri v2 IPC 与自定义协议在 Windows/Linux 上的形状；**这一条是最容易配错导致"点了没反应"的** |
| `worker-src` / `child-src` | `blob:` | 若将来上 worker；现读未见 worker，可先不写，缺了会白屏而不是报错 |
| `font-src` | `'self'` | 字体是打包资源 |
| `media-src` | `'self'` `blob:` | 语音/视频消息预览 |

> ⚠️ 上面这张表是**从代码读出来的必要条件，不是充分条件**。真正判它够不够，只有第 三 节那台真机。

## 三、上它的那一轮必须跑的冒烟（缺一条就不要合）

Windows 优先（它是主平台，也是 WebView2 与 macOS 行为不同的那一侧）：

1. 冷启动首屏：主题（深色/浅色）不闪、骨架屏出现后**平滑**换到真界面；
2. 图片消息：缩略图 + 点开预览 + 预览里缩放（blob 链路三条都在）；
3. **自定义协议预览**那一扇（`preview.html`）能出图，mac 与 Windows 都要看（两侧走的道不同）；
4. 收藏面板、群任务图元、待办图各开一次（都是 blob/协议的不同入口）；
5. 收发一条文本 + 一个文件（IPC `connect-src` 一断，症状就是"点了没反应"，**不会弹错**）；
6. 日志窗、设置窗、任务窗各开一次（多入口 HTML 各有自己的 CSP 生效面）。

`node scripts/verify.mjs` 与 `npm test` **判不到上面任何一条** —— 它们不看真 WebView 的网络策略。
所以这一格的证据只能是第 三 节的人工冒烟，或者是浏览器控制台里出现 `Refused to …` 的那一行。

## 四、这一格与本轮其余改动的关系

没有关系，故意分开发：本轮那四处（托盘图标翻转、`open_file_native` 边界、五家留痕、`messages.status` 第二家闸）
都是**行为面可本机验证**的；CSP 是唯一一条**必须真机验**的。混在一次发，白屏时分不清是谁干的。

## 五、2026-10-24 决策：最终采用**严格 CSP**（方案 A → 收紧）

- 用户先选方案 A（宽松），随后复核发现方案 A 的两个 `'unsafe-inline'` 在生产里
  **被 Tauri 的 nonce/hash 忽略**（见 §一 顶部的复核修正）。既然效果相同，
  配置就该诚实 —— 用户确认改为严格。
- 实际配置（`src-tauri/tauri.conf.json` → `app.security.csp`，逐字）：

  ```
  default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; font-src 'self'; media-src 'self' blob:; connect-src 'self' ipc: http://ipc.localhost http://tauri.localhost blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  ```

- 首屏为什么不会白屏：Tauri 打包时给内联 `<script>` 加 `'sha256-…'`、给 `<style>` 加
  `'nonce-…'`，两者都在 `script-src`/`style-src` 里生效；`'unsafe-inline'` 即使写着也会被忽略。
- `base-uri` / `form-action` / `frame-ancestors` **不从** `default-src` 继承，所以单独写；
  本应用没有 `<base>`、没有表单提交、也不会被别的页面嵌入。
- 机器判据：`lib_startup_config_tests::webview_csp_is_configured_with_the_sources_the_frontend_actually_needs`
  钉住"配置在场、必要来源齐全、`'unsafe-inline'` 数量为 0"。它**不能**替代 §三的真机冒烟。
- 未验证（NOT RUN）：§三那 6 条真机冒烟（Windows 优先）与 macOS 自定义协议预览。
  观察方法：浏览器/WebView 控制台里的 `Refused to …` 那一行。
- 若真机发现某条内联样式脚本没有被 Tauri 加 hash/nonce（症状是首屏白屏或样式丢失），
  正确做法是修构建注入点，**不要**把 `'unsafe-inline'` 加回来（它会被忽略，只会骗人）。
