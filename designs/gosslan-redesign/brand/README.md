# 小院 / Gosslan brand assets

- `xiaoyuan-mark.svg` — 128 网格品牌标记（无表情），用于导航、角标、16–32px。
- `xiaoyuan-mascot.svg` — 128 网格吉祥物（门洞里有眼睛和微笑），用于空态/欢迎/状态页。
- `app-icon-light.svg` — 1024 满版蓝底 + 奶油拱门 + 绿苗，用于 iOS / Windows / 网页。
- `app-icon-dark.svg` — 1024 深色满版版本。
- `app-icon-macos.svg` — 1024 带 22.37% 连续圆角的 macOS 版本。
- `app-icon-ios.svg` — 1024 满版方图（系统负责圆角，导出时去掉 alpha）。
- `app-icon-android.svg` — 1024 adaptive 版本，前景缩进 66% 安全区。
- `app-icon-android-fg.svg` / `-bg.svg` / `-mono.svg` — 自适应图标的三层源文件（前景透明、
  背景纯蓝、单色层白色剪影供 Android 13 themed icon 读 alpha）。`icon-manifest.json`
  把这三层一起交给 `tauri icon`，产物落在 `src-tauri/icons/android/`。
- `app-icon-tinted.svg` — 单色 tinted 版本。
- `png/app-icon-16…1024.png` — 从 light 母版导出的尺寸梯。
- `icons.svg` — Rounded 2.0 图标总表（24 枚，带中英文标签），用于设计评审；实际实现按单枚 SVG 路径落地。

规则：

- 蓝 `#2F6BFF`、奶油 `#FFF8EA`、绿 `#07C160`；不超过三色。
- 16px 时去掉表情，小苗收成一个绿点；门洞加宽 2px。
- 不写实屋顶、不加窗户格子、不把“院”字塞进图标、不用红色做身体。
- App 图标导出时保留方形画布；macOS 圆角由系统或导出流程处理。
