# scripts/archive

这里存放**不再被门禁、CI 或 package.json 引用**的一次性或阶段性脚本。
归档不等于删除：保留它们是为了查历史行为，**不再维护**，也不要再往这里加入仍在使用的工具。

| 文件 | 用途 | 何时还会用到 | 状态 |
|---|---|---|---|
| `rename.mjs` | 一次性项目改名：按全小写 / 首字母大写 / 全大写三种形态替换全仓文本文件 | 基本不会再用。它会改写所有文本文件，今天再跑连 `aoci` 认知资产与 `CHANGELOG.md` 一起动 | 归档，不再维护 |
| `scrape-douyin-emoji.py` | 抓取抖音评论区表情包，产出图片与名称映射 | 需要重新抓表情源数据时。产物已折进 `src/data/emojis.ts`；输入快照与下载目录都不入库 | 归档，不再维护 |
| `build-android.ps1` | 旧版 Windows 本机出 APK 的便捷脚本（Debug / Release） | 一般用不到：正式入口是 `scripts/build-android-releases.sh`（CI 也在用） | 归档，不再维护 |
| `flatten-ios-icons.mjs` | 去掉 `src-tauri/icons/ios/*.png` 的 alpha 通道 | **上线前仍需执行**：每次重新生成 iOS 图标后都要跑一次，否则 App Store Connect 会因 alpha 通道拒收 | 归档，但保留可用；不算日常门禁 |

`rename.mjs` 必须在仓库根目录执行；`flatten-ios-icons.mjs` 与 `build-android.ps1`
已按 `scripts/archive/` 的层级修正了仓库根推导（上溯两级）。
