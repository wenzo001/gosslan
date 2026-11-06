# v2 方向：Pulse

> **注意：本文件记录 v2.0 的紫罗兰方向；v2.1 已按「微信 / QQ / 飞书」的熟悉感收束。**
> 当前应以 [redesign-v2.1-note.md](redesign-v2.1-note.md) 与 [design-system-pulse README](../design-system-pulse/project/README.md) 为准。

> 给 15–25 岁用户的 Gosslan。保留 v1 的信息架构与功能闭环，换掉「太平、太 toB」的视觉与交互语气。

## 1. 为什么是 Pulse

v1「Still」解决的是「层级、标尺、状态」三件事，方向是对的，但视觉太克制：暖灰、单蓝、无情绪，像一套优秀的公司内部工具。15–25 岁用户每天用的是 Discord、Telegram、小红书、B 站、iMessage：他们习惯**高饱和但可控的强调色、圆润的形状、即时的反馈、可以表达自己的空间**。

Pulse 不是把界面做成霓虹灯，而是把「同频」这件事变得可感知：

- **同频的人，就在附近。** 局域网不是限制，是「此刻在同一空间」的社交线索。
- **表达自己。** 主题色、气泡配色、字号、回应，都是「我的聊天长什么样」。
- **每个动作都有回应。** 发送、收到、回应、置顶、传输，都有轻快的反馈。
- **不幼稚。** 不用卡通吉祥物、不用满屏 emoji、不用彩虹渐变；用克制的三色系统与精细的动效。

## 2. 视觉系统

### 色彩

| 角色 | Light | Dark | 用途 |
| --- | --- | --- | --- |
| canvas | `#F6F2FF` | `#100D18` | 窗口底，淡紫纸面 |
| chrome | `#EDE7FF` | `#17121F` | rail / 标题栏 / 底栏 |
| list | `#FBF8FF` | `#1A1524` | 会话列表 |
| content | `#FFFFFF` | `#201A2C` | 聊天画布 |
| raised | `#FFFFFF` | `#2A2238` | 菜单 / 弹窗 |
| field | `#F1EBFF` | `#2A2238` | 输入 / 搜索 |
| text | `#171226` | `#F6F2FF` | 主文字 |
| muted | `#5D5475` | `#B9B0D0` | 次级 |
| faint | `#7A7192` | `#8F86A8` | 11–12px |
| border | `#E8E0FA` | `#352B47` | 发丝线 |
| **Pulse 紫** | `#6C5CE7` | `#7C5CFF` | 主按钮 / 自己消息 / 选中 |
| **Spark 珊瑚** | `#FF6B6B` | `#FF8A8A` | 未读 / @我 / 热点 |
| **Mint 薄荷** | `#00C2A8` | `#35E0C0` | 在线 / 成功 / 已读 |
| **Lemon 柠檬** | `#FFC93C` | `#FFD166` | 置顶 / 高亮 / 提醒 |
| danger | `#F04452` | `#FF7A85` | 删除 / 失败 |
| 自己气泡 | `linear-gradient(135deg,#6C5CE7,#8B5CF6)` | `linear-gradient(135deg,#6C5CE7,#7C3AED)` | 白字 |
| 对方气泡 | `#F2EDFF` | `#2A2238` | 深字 |

四个强调色不是平均使用：**紫色是主色，珊瑚只给未读/@，薄荷只给在线/成功，柠檬只给置顶/提醒**。这样既活泼，又不会变成糖果罐。

### 字体

- 标题：**Space Grotesk**（几何、年轻、有个性）。
- 正文：**Inter**（中文回退 PingFang SC / Microsoft YaHei）。
- 代码：JetBrains Mono。
- 标题字重 600，正文 400/500；最小 11px；标题不超 32px（除空状态）。

### 形状与层级

- 控件圆角 10px，卡片 14px，面板 18px，**气泡 20px**，头像全圆，群头像 14px 圆角方形。
- 浮层阴影带颜色：`0 12px 32px rgba(108,92,231,.18)`；对话框 `0 24px 64px rgba(45,22,94,.28)`。
- 头像加入 2px 白环 + 柔和彩色投影；在线状态用薄荷点。
- 列表行 68px；未读用珊瑚胶囊；自己气泡是渐变紫。

### 动效

- 标准 `cubic-bezier(.22,1,.36,1)`；回弹 `cubic-bezier(.34,1.56,.64,1)`。
- 发送：气泡从 0.96 弹到 1，180ms；回应：胶囊弹入 220ms；页面转场 240ms。
- 只动 `opacity` / `transform`；reduce 档只保留 120ms 淡入淡出。
- 不做持续背景动画；可以在空状态做一次性的光环扩散。

## 3. 关键交互改动

1. **添加好友改为整页「发现」**：不再用 440px 弹窗 + 半透明遮罩。整页渐变背景、附近的人卡片、LAN/蓝牙通道、邀请码入口、返回。遮罩「没盖全」的问题自然消失，探索感更强。
2. **输入区改成浮动圆角卡**：16px 外边距、22px 圆角、柔和阴影；表情/附件/发送都在卡内，更像现代社交 App。
3. **回应改成贴纸托盘**：长按消息，底部弹出大号回应（赞/开心/比心/稍后/收到），选中后气泡下弹入胶囊。
4. **移动端加浮动新建按钮**：列表页右下角 56px 渐变 FAB；底栏仍是 4 个 tab，不增加导航层级。
5. **个性化合并为一页**：主题色（预设 + 自定义取色）、气泡配色（6 套 + 自定义双色）、字号、动效、实时预览、同步说明。用户不用在「外观」和「聊天样式」之间来回跑。
6. **图片预览升级为完整窗口**：1120×820，深色渐变背景、悬浮工具栏、缩放/切换/保存/定位，补「文件已清理」态。
7. **搜索保留上下文**：跳转结果后保留「返回搜索」胶囊，不再关闭即丢失。
8. **多选批量操作**：长按进入多选，底部批量条（转发/收藏/删除），补齐批量闭环。
9. **强提醒回执**：消息下显示「已确认 2/3」，未确认的人可在详情里看到。
10. **传输完成后的下一步**：文件卡 100% 后保留「打开 / 在文件夹中显示」，并进入任务中心历史。

## 4. 覆盖策略

- **v1 的 34 块画板保留**，作为结构与功能基线。
- **v2 新增 Pulse 画板**：基础、Chats、Chat、Group、Discover、Personalize、Preview、StartupError、Mobile 四屏、两个原型。
- 其余页面（联系人、群资料、收藏、链接、共享目录、任务中心、搜索、设置、日志、深色、状态）在 v2 中沿用 v1 结构，按 Pulse token 迁移；迁移清单见下。

## 5. 迁移清单（v1 → Pulse）

| v1 画板 | v2 处理 |
| --- | --- |
| Foundations | 重画为 PulseFoundations |
| Layout | 结构保留，尺寸不变；颜色/字体迁移 |
| DesktopChats | 重画 PulseChats |
| DesktopOneToOne | 重画 PulseChat |
| DesktopGroupChat | 重画 PulseGroup |
| DesktopContacts | 结构保留，Pulse 配色 |
| DesktopRequests | 被 PulseDiscover 取代（整页） |
| DesktopGroupInfo | 结构保留，Pulse 配色；补文件/任务 tab |
| DesktopFavorites | 结构保留，Pulse 配色 |
| DesktopLinks | 结构保留，Pulse 配色；补导入预览 |
| DesktopShare | 结构保留，Pulse 配色 |
| DesktopTasks | 结构保留，Pulse 配色；补完成后打开 |
| DesktopSearch | 结构保留，Pulse 配色；补返回搜索 |
| DesktopSettings | 结构保留；新增 PulsePersonalize |
| DesktopGroupTasks | 结构保留，Pulse 配色 |
| DesktopLogs | 结构保留，Pulse 配色 |
| DesktopModals | 结构保留，Pulse 配色；补多选/批量 |
| DesktopDark | 结构保留，Pulse 深色 |
| DesktopShare | 结构保留 |
| Mobile* | 重画核心四屏；其余 Pulse 迁移 |
| Prototype* | 重画 Pulse 版 |

## 6. 不做什么

- 不做卡通吉祥物、不做满屏 emoji、不做无意义渐变。
- 不为了「年轻」牺牲可读性：正文仍 4.5:1，最小 11px。
- 不新增账号、通话、语音消息、输入中提示等现有代码不存在的功能。
- 不修改任何业务代码；这一轮仍然只做设计。
