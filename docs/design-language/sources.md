# 来源与置信度

> 本文只记录结论怎么来的。置信度分五档：
> **A 官方文档** / **B 官方演讲或发布** / **C 逆向观察或缺陷记录** / **D 社区共识** / **E 个人推断**。
> 凡是 E 档的数字，都是本仓的设计决策，不是 Apple / Microsoft / Google 的原始参数。

## 1. 平台与设计语言

| ID | 结论 | 来源 | 类型 | 置信度 |
| --- | --- | --- | --- | --- |
| S1 | Liquid Glass 是 iOS 26 / iPadOS 26 / macOS 26 等平台的新材料，会反射与折射周围内容，并随内容动态变化 | [Apple Newsroom](https://www.apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/) | 官方发布 | B |
| S2 | Liquid Glass 属于 controls / navigation 层，**不要用在 content layer**；content layer 应使用标准材料 | [Apple HIG Materials](https://developer.apple.com/design/human-interface-guidelines/materials) | 官方文档 | A |
| S3 | Liquid Glass 让内容从控件下方透出，同时保持控件可读；玻璃不能采样玻璃，分组玻璃需要共享采样区域 | [WWDC25 Session 323](https://developer.apple.com/videos/play/wwdc2025/323/) | 官方演讲 | B |
| S4 | 自定义玻璃用 `glassEffect`，默认胶囊形，文字会自动使用 vibrancy 保持可读；强调视图才加 tint | [WWDC25 Meet with Apple 201](https://developer.apple.com/videos/play/meet-with-apple/201/) | 官方演讲 | B |
| S5 | UIKit 组件在 iOS 26 默认获得 Liquid Glass 外观；滚动时玻璃会自适应下方内容 | [WWDC25 Session 284](https://developer.apple.com/videos/play/wwdc2025/284/) | 官方演讲 | B |
| S6 | Windows Mica 是不透明、动态、只采样桌面壁纸一次的材料，面向长生命周期窗口，性能友好；高对比度/节能等场景回退实色 | [Microsoft Learn: Mica](https://learn.microsoft.com/en-ca/windows/apps/design/style/mica) | 官方文档 | A |
| S6a | Liquid Glass 分 `regular` 与 `clear`：regular 模糊并调亮度，适合文字多的 sidebar/popover/alert；clear 高度透明，只用于照片/视频上的组件，亮背景需加 35% 暗色 dimming | [Apple HIG Materials](https://developer.apple.com/design/human-interface-guidelines/materials) | 官方文档 | A |
| S7 | Windows Acrylic 面向短暂浮层；GPU 开销大，节能模式、关闭透明效果、低端硬件时自动变实色；不要并排铺多块 | [Microsoft Learn: Acrylic](https://learn.microsoft.com/en-ca/windows/apps/design/style/acrylic) | 官方文档 | A |
| S8 | Mica 用于长期存在的 UI 表面，Acrylic 用于 context menu / flyout 等短暂表面 | [Windows 应用最佳实践](https://learn.microsoft.com/en-us/windows/apps/get-started/best-practices) | 官方文档 | A |
| S9 | Material 3 Expressive 使用 motion springs、强调字体、形状与色调层级来拉开层级 | [Material 3 Expressive](https://m3.material.io/blog/building-with-m3-expressive) | 官方博客 | B |
| S10 | MD3 形状梯度为 0 / 4 / 8 / 12 / 16 / 28dp 与 full；按钮常用 Full 或 Small | [MD3 形状说明（社区整理）](https://vectree.io/c/md3) | 社区整理 | D |
| S11 | Windows Acrylic 的配方是 background + blur + exclusion blend + tint + noise | [Microsoft Learn: Acrylic](https://learn.microsoft.com/en-ca/windows/apps/design/style/acrylic) | 官方文档 | A |

## 2. Web 实现与性能

| ID | 结论 | 来源 | 类型 | 置信度 |
| --- | --- | --- | --- | --- |
| S12 | `backdrop-filter` 在 2024-09 起进入 Baseline 可用范围，现代浏览器普遍支持 | [MDN: backdrop-filter](https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter) | 官方文档 | A |
| S13 | `backdrop-filter` 会让引擎多做渲染 pass，应在必要处使用 | [WebKit Blog: Introducing Backdrop Filters](https://webkit.org/blog/3632/introducing-backdrop-filters/) | 官方博客 | B |
| S14 | 祖先的 `opacity < 1`、`filter`、`mask`、`clip-path`、`mix-blend-mode`、`backdrop-filter` 或对应 `will-change` 会建立 backdrop root，导致内层模糊采不到真实内容 | [MDN: backdrop-filter（Description / backdrop root）](https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter) | 官方文档 | A |
| S15 | WebKit 在 20+ 个 `backdrop-filter` 元素时出现过内存暴涨到数 GB、主线程阻塞的缺陷（GTK 2.54 回归） | [WebKit Bug 328065](https://bugs.webkit.org/show_bug.cgi?id=328065) | 缺陷记录 | C |
| S16 | `backdrop-filter: url(#...)` 在 Safari / Firefox 可以解析但不绘制，`CSS.supports()` 无法识别 | [liquid-glass-js GOTCHAS](https://github.com/Amir-Abushanab/liquid-glass-js/blob/HEAD/docs/GOTCHAS.md) | 社区观察 | D |
| S17 | CSS 版玻璃的常见结构是半透明底 + `backdrop-filter` + 半透明描边 + inset 顶部高光 | [html-in-canvas: Liquid Glass](https://html-in-canvas.dev/liquid-glass-effect/) / [dev.to: Liquid Glass CSS](https://dev.to/vitalbadjo/liquid-glass-css-the-apple-liquid-glass-effect-with-css-only-plus-svg-refraction-1hkd) | 社区教程 | D |
| S18 | SVG `feDisplacementMap` 可以做折射，但需要额外的位移图与滤镜链，成本高 | [LogRocket: Liquid Glass with CSS and SVG](https://blog.logrocket.com/how-create-liquid-glass-effects-css-and-svg/) | 社区教程 | D |
| S19 | `prefers-reduced-transparency` 在 Chrome / Edge 118+ 支持，**Firefox 不支持、Safari 不支持** | [MDN: prefers-reduced-transparency](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-transparency) | 官方文档 | A |
| S20 | 用户偏好 API 中的 `reducedTransparency` 仍是实验特性，主流浏览器未启用 | [MDN: User Preferences API](https://developer.mozilla.org/en-US/docs/Web/API/User_Preferences_API) | 官方文档 | A |
| S20a | Tauri 2 在 Windows 用 WebView2（Chromium），Android 用 Android WebView，macOS/iOS/Linux 用 WebKit | [Tauri: Webview Versions](https://v2.tauri.app/reference/webview-versions/) | 官方文档 | A |

## 3. 可访问性

| ID | 结论 | 来源 | 类型 | 置信度 |
| --- | --- | --- | --- | --- |
| S21 | 正文文字对比度至少 4.5:1；大字至少 3:1 | [WCAG 2.2 SC 1.4.3](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) | 官方标准 | A |
| S22 | 非文本内容（图标、边框、焦点指示）至少 3:1 | [WCAG 2.2 SC 1.4.11](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html) | 官方标准 | A |
| S23 | 焦点指示需要可见、与相邻颜色对比足够；2px 是常用下限 | [WCAG 2.2 SC 2.4.11 / 2.4.13](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html) | 官方标准 | A |
| S24 | 错误不能只靠颜色表达，需要文字或图标 | [WCAG 2.2 SC 1.4.1](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html) | 官方标准 | A |

## 4. 本仓观察

| ID | 结论 | 来源 | 类型 | 置信度 |
| --- | --- | --- | --- | --- |
| S25 | 现有玻璃只有 `blur(6px)` + `saturate(130%)`，无 1px 高光/描边/外阴影 | [style.css L1166-L1177](../../src/style.css#L1166-L1177) | 源码观察 | C |
| S26 | `.glass` 仅被 ImageLightbox 使用；BaseModal 注释已过期 | [ImageLightbox.vue L356](../../src/components/message/ImageLightbox.vue#L356)、[BaseModal.vue L132](../../src/components/BaseModal.vue#L132) | 源码观察 | C |
| S27 | 应用底色、侧栏、标题栏、会话列表均为平色，无环境渐变 | [style.css L101-L122](../../src/style.css#L101-L122)、[L325](../../src/style.css#L325) | 源码观察 | C |
| S28 | 输入框混用 `--gosslan-bg` / `bg-transparent` / `--gosslan-field` / 输入区 `--gosslan-panel`，内距 3 种、字号 2 种 | 见 [A.4](./README.md#a4-输入框现状) 的 grep 读数 | 源码观察 | C |
| S29 | 按钮手搓出 20 种 `px/py` 组合与 4 个圆角档位 | 见 [A.3](./README.md#a3-按钮现状) 的 grep 读数 | 源码观察 | C |
| S30 | 文本输入焦点规则体为空，且被焦点护栏认定为“有意留空” | [style.css L668-L682](../../src/style.css#L668-L682) | 源码观察 | C |
| S31 | `SecondaryBtn` 的 `large` 缺 `font-medium`，与 Primary/Danger 不一致 | [SecondaryBtn.vue L46](../../src/components/ui/SecondaryBtn.vue#L46) | 源码观察 | C |
| S32 | Tailwind `body` 为 13px，CSS `--gosslan-text-body` 为 14px，同名不同值 | [tailwind.config.js](../../tailwind.config.js)、[style.css](../../src/style.css) | 源码观察 | C |

## 5. 公开资料没有回答的问题

这些不能靠查文档解决，本文只能给设计决策：

1. **Apple 不公开 Liquid Glass 的模糊半径、alpha、saturate 数值。** 本文的 16/20/24px 与 .82/.88/.94 全是 E 档推断。
2. **Apple 不公开内容感知着色的算法。** Web 端无法低成本读取背后像素，本文改为固定主题 tint，E 档。
3. **WKWebView 是否响应系统“降低透明度”。** MDN 明确 Safari 不支持 `prefers-reduced-transparency`；macOS 系统设置是否间接影响 WKWebView 的 CSS 媒体查询，没有公开结论。因此本文要求提供应用内开关，而不是只依赖媒体查询。
4. **WebView2 / Android WebView 的具体性能阈值。** 没有官方帧率/元素数上限；本文的“同屏 8 个、3 层、≤40% 视口”是 E 档预算。
5. **玻璃在任意媒体上的对比度。** 只能实测合成后的颜色，不能用一个 token 值担保；本文给的是测量口径与禁止场景，不是保证值。

## 6. 复现本仓读数

```bash
grep -rn "backdrop-filter\|backdrop-blur" src --include="*.vue" --include="*.css"
grep -rh -A 6 '<button' src --include="*.vue" | grep -oE 'px-[0-9.]+ py-[0-9.]+' | sort | uniq -c | sort -rn
grep -rh -A 6 '<button' src --include="*.vue" | grep -oE 'rounded-\[var\(--gosslan-radius-[a-z]+\)\]' | sort | uniq -c
grep -rh -A 8 '<input' src --include="*.vue" | grep -oE 'px-[0-9.]+ py-[0-9.]+' | sort | uniq -c
grep -rn "bg-\[var(--gosslan-bg)\]\|bg-\[var(--gosslan-field)\]" src/components --include="*.vue" | wc -l
```

计数会随代码变化；引用具体数字时以当次运行结果为准。
