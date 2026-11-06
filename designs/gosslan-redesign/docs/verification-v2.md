# v2.2 Pulse 验证记录

日期：2026-11-06。以下只记录真实执行过的检查；没跑过的不写成“通过”。

## 1. 结构校验

```bash
node /tmp/baoyu-design/skills/claude-design/scripts/artifact.mjs check designs/gosslan-redesign/design-canvas-pulse
node /tmp/baoyu-design/skills/claude-design-system/scripts/artifact.mjs check designs/gosslan-redesign/design-system-pulse
```

结果：

- 画布：`title: Gosslan Pulse — Redesign v2.2`，`boardCount: 46`，`problems: 0`
- 设计系统：`title: Gosslan Pulse`，`namespace: GosslanPulse`，`problems: 0`

`check` 只验证结构，不渲染，也不检查脚本运行时的视觉效果。

## 2. 浏览器目视

| 检查项 | 结果 | 截图 |
| --- | --- | --- |
| 画布 `01 Pulse` 页 | 渲染正常；核心屏已切换为 62px 行、16px 卡片、20px 气泡；启动错误窗去掉渐变 | `test-results/pulse-v22-page1.png` |
| 画布 `02 Desktop coverage` 页 | 渲染正常；密集页面保持同一套表面与圆角 | `test-results/pulse-v22-canvas.png` |
| 画布 `03 Mobile` 页 | 渲染正常；52px 顶栏、64px 行、56px 底栏；未读角标未拉长 | `test-results/pulse-v22-mobile.png` |
| 画布 `05 Edge cases` 页 | 两块画板均渲染；长名称、99+、长 URL、文件、技术串、Toast、长草稿都在画板内收束 | `test-results/pulse-v22-edge.png` |
| 桌面边界画板 full window | 六类边界情况全部可读，无横向溢出 | `test-results/pulse-v22-edge-desktop-full.png` |
| 移动边界画板 full window | 两台 390×844 手机与右侧规则列均正常 | `test-results/pulse-v22-edge-mobile-full.png` |
| Foundations full window | 圆角刻度 6/10/16/20/22/999 与 v2.2 标签正常；内容高度 1150 不再被裁切 | `test-results/pulse-v22-foundations.png` |
| Layout full window | 右侧说明卡不再越界；1640 高度完整显示桌面/窄窗/移动三组 | `test-results/pulse-v22-layout.png` |
| 设计系统 Cover | 标题与 kicker 已更新为 v2.2，色块正常 | `test-results/pulse-v22-ds.png` |
| 品牌资产（Quick Look 渲染） | 小院吉祥物 512 正常；源文件为 SVG | `test-results/pulse-v22-mascot.png` |
| 应用图标（1024 / 32 / 16 实际导出） | 满版蓝底、奶油拱门、绿苗；16px 仍可读 | `test-results/pulse-v22-appicon-1024.png`、`test-results/pulse-v22-appicon-32.png`、`test-results/pulse-v22-appicon-16.png` |
| 应用图标画板 | macOS Dock、iOS 首页、Android 圆形/方圆遮罩、Windows 磁贴、尺寸梯正常 | `test-results/pulse-v22-appicon-board.png` |
| 图标总表（Quick Look 渲染） | 24 枚 Rounded 2.0 图标、中英文标签、24 网格正常 | `test-results/pulse-v22-icons-sheet.png` |
| 桌面空态整合 | 空态主图已换成小院标记；导航图标为新的圆角 2px 描边 | `test-results/pulse-v22-empty-mascot.png` |

## 3. 长内容注入测量（真实 DOM）

在 Play 模式的桌面/移动原型里直接写入极端字符串，然后读取 `scrollWidth/clientWidth` 与元素边界。

桌面原型（1000×680）：

| 检查项 | 读数 | 结论 |
| --- | --- | --- |
| 页面横向溢出 | `document 1000/1000`，`.app 1000/1000` | 无 |
| 聊天标题（约 50 字） | `.hName 474/648`，`overflow:hidden` + `ellipsis` | 单行省略 |
| 会话名（约 50 字） | `.rname 200/525`，行 `319/319` | 单行省略，不挤走时间/角标 |
| 长 URL 气泡 | 气泡 `392/392`，右边界 827.7 < 应用右边界 1000 | 在气泡内断行 |
| Toast 长文案 | 宽度 420，`-webkit-line-clamp:2`，高度 37px（13px 字号） | 两行截断 |

移动原型（390×844）：

| 检查项 | 读数 | 结论 |
| --- | --- | --- |
| 页面横向溢出 | `document 390/390`，`.phone 390/390` | 无 |
| 聊天标题（约 50 字） | `.hName 244/546`，`overflow:hidden` + `ellipsis` | 单行省略 |
| 会话名 / 预览 | `.rname 274/542`，预览 `286/738`，行 `390/390` | 两者单行省略 |
| 长 URL 气泡 | 气泡 `285/285`，右边界 378 < 手机右边界 390 | 在气泡内断行 |
| Toast 长文案 | 宽 358，右边界 374 < 390 | 不溢出、不挡输入区 |

画板完整性测量：

- 六个页面逐页检查，46 块画板全部渲染完成：`body.scrollWidth/scrollHeight` 均未超过 iframe 尺寸，横向/纵向溢出 0 块。
- 修正了三处纵向裁切：`Foundations` 980→1150（新增圆角刻度）、`Layout` 880→1640（原内容 1621 被裁）、`DesktopModals` 840→1100（原内容 1081）、`PulseGapClosures` 720→940（原内容 922）。
- 移动端 16 块画板全部为 390×844，`body` 与 iframe 尺寸一致，无横向/纵向溢出。
- 桌面 coverage 页 14 块画板全部渲染且无溢出；此前 Modals / GapClosures 的高度问题已修正。

边界画板静态测量：

- 桌面边界板：`.board 1360/1360`，三个气泡 `scrollWidth == clientWidth`，名称列 `client < scroll`（省略生效），`overflow:visible` 的横向越界元素 0 个。
- 移动边界板：`.board 1180/1180`，两台手机均 `390/390`，三个气泡 `285/285`，标题 `238/339`（省略生效），横向越界元素 0 个。

## 3.5 品牌与图标

- 小院标记、吉祥物、浅色/深色应用图标已导出为 SVG：`designs/gosslan-redesign/brand/`。
- 应用图标另有 macOS / iOS / Android adaptive / tinted 四个版本；PNG 尺寸梯 16/32/64/128/256/512/1024 已从 light 母版导出。
- 母版采用满版蓝底 + 奶油拱门 + 绿苗，界面不再嵌套第二个圆角方块；16px 小苗收成绿点。
- 16px 标记去掉表情、把小苗收成一个绿点；32/64/128 保留门洞与小苗。
- 高频图标已批量替换：会话 38 处、通讯录 30、收藏 26、链接 15、我的 11、返回 21、新建 20、发送 19、搜索 46、更多 39、附件 10、关闭 16。
- 空态已使用小院标记（`DesktopChats`、`MobileEmpty`），不是孤立的一张品牌图。

## 3.6 状态去重与图标复用

- 移动会话列表移除遗留的无样式 FAB；在线状态只保留头像右下角一个点。
- 联系人列表去掉行内第二个 `<i>` 点和“在线/离线”字样：8 条在线行、6 条离线行、3 条原型行；状态由分组标题和头像点表达。
- 1:1 聊天头去掉 meta 里的第二个点与“在线”文字：桌面 1 处、移动 1 处、原型 2 处；只保留头像点和“局域网/设备”上下文。
- 群资料成员行去掉 5 处重复的“在线/离线”文字；个人资料页与“我的”页同步去掉重复文字。
- 桌面、移动端、设置/任务/日志等窗口共用同一套路径；桌面 rail 23px、移动 tab 21px、header 20px、inline 16px，只改尺寸。
- 6 处旧的调色盘图标统一替换为设置滑杆图标；高频图标（会话/通讯录/收藏/链接/我的/返回/新建/发送/搜索/更多/附件/关闭）已全量替换。
- 原型聊天头补上 `isGroupChat` 条件：个人头像已有在线点时，meta 不再显示第二个点；离线个人显示灰点 + 设备上下文。
- 原型 DOM 复测：林一聊天头 meta 为 `iPhone · 局域网`（无 `<i>` 点），头像点 class 为 `dot`；周岚 meta 为 `Windows`，头像点为 `dot off`；设计组头像无点，meta 保留一个 `<i>` + `5 位成员 · 3 人在线`。
- 图标 path 已在桌面 rail 与移动 tab 共用：会话/通讯录/收藏/链接/我的等只改 23/21px 尺寸。

状态去重后的目视：

| 检查项 | 截图 |
| --- | --- |
| 移动会话列表：头像点唯一，无 FAB | `test-results/pulse-v22-mobile-list-clean.png` |
| 移动联系人：分组标题 + 头像点，无行内第二点 | `test-results/pulse-v22-mobile-contacts-clean.png` |
| 移动 1:1 头：头像点 + “局域网”，无第二个点 | `test-results/pulse-v22-mobile-header-clean.png` |

## 4. 交互验证（Play 模式）

桌面原型：

1. 点会话 → 进入聊天。
2. 点消息 → 菜单出现（回复/转发/复制/收藏/删除）。
3. 点「复制⌘C」→ Toast 出现；长文案被限制为两行。
4. 点「新建会话」→ 添加好友整页；返回正常。

移动原型：

1. 顶栏「+」→ 添加好友整页；返回列表。
2. 点会话 → 聊天页；发送消息、回应「赞」正常。
3. 返回 → 底栏恢复。

## 5. 未验证 / 限制

- 本轮长文本注入后的原型截图因内置浏览器表面不可用（`NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`）没有拍成；已用 DOM 读数记录，边界画板本身有截图。
- 品牌与图标画板用 Quick Look 渲染截图（静态 HTML/SVG）；画布内实际渲染由结构校验与 DOM 尺寸测量覆盖。
- 导出的 PNG 尺寸梯来自 Quick Look 渲染；iOS 上架用的 1024 图仍需在最终导出流程中去除 alpha 通道（当前 PNG 视觉不透明，但保留 alpha）。
- 46 块画板没有逐块做像素级检查；已目视 `01 Pulse`、`02 Desktop coverage`、`05 Edge cases`，移动核心页沿用同一套规则。
- 交互原型是设计演示，不含真实网络、加密、持久化。
- 输入草稿在原型里是单行 `<input>`；正式实现应为可增长到 5 行的 `<textarea>`，见 `docs/edge-cases.md`。

## 6. 业务代码边界

```bash
git status --short -- src src-tauri package.json tailwind.config.js
```

输出为空。v2.2 只修改 `designs/gosslan-redesign/` 下的设计文件。
