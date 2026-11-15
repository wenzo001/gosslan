# 应用名与可搜索性：中文「小院儿」/ 英文 "Gosslan"

> 日期：2026-11-15
> 需求（用户）：应用已全局叫「小院儿」；在 Mac / Windows / iOS / Android 上搜索时，
> **「小院儿」和「gosslan」都应该能找到这个应用**。

## 1. 结论先说

- **界面与安装器里的名字**：中文「小院儿」、英文 "Gosslan"，七处资源已一致（判据
  `src/utils/appName.test.ts` 钉着，改错一处就红）。
- **两个名字都能搜到**：macOS / Windows **可以**（机制不同，见下）；**Android / iOS 做不到**
  —— 那是平台限制，不是漏改。原因见 §3。
- 真机搜索结果**没有实机验收**，本节只写"机制上应该怎样"，不写"实测通过"。

## 2. 各平台现在是什么

| 平台 | 用户看到的名字 | 搜「小院儿」 | 搜「gosslan」 | 机制与依据 |
|---|---|---|---|---|
| macOS | Finder / Dock / 启动台：**小院儿**（中文系统） | 命中显示名 | 命中包目录名 | 包目录是 `Gosslan.app`（`productName`），显示名由 `CFBundleDisplayName` + `zh-Hans.lproj/InfoPlist.strings` 覆盖为「小院儿」。Spotlight 同时索引文件名与显示名 ⇒ 两个都能命中。**未实机验证** |
| Windows | 桌面 / 开始菜单：**小院儿**；「应用和功能」里也是小院儿 | 命中快捷方式 | 命中开始菜单别名 | 开始菜单原有那份被安装钩子改成 `小院儿.lnk`（`exe` 名 `Gosslan.exe` 不参与开始菜单搜索）⇒ 2026-11-15 起额外建一份**开始菜单别名** `Gosslan.lnk`（`src-tauri/nsis/hooks.nsh`），**桌面仍只有一个图标** |
| Android | 启动器：**小院儿**（中文系统）/ "Gosslan"（其它语言） | 命中 | **不保证** | 启动器搜索只匹配 `android:label`，且**一个应用只有一个标签**（`values-zh` 覆盖 `values`）。要两个都命中只能加第二个启动器图标（`<activity-alias>`），会把桌面变成两个图标 —— 已否决 |
| iOS | 主屏：**小院儿**（中文）/ "Gosslan"（英文） | 命中 | 未验证 | `CFBundleDisplayName` 由 `en.lproj/InfoPlist.strings` 分语言覆盖；`CFBundleName` 仍是 `Gosslan`（`productName`）。Spotlight 是否索引 `CFBundleName` 属系统行为，**未实机验证** |

## 3. 为什么移动端做不到「一个图标、两个名字都能搜到」

Android 与 iOS 的应用名都是**单值资源**，系统搜索按当前语言的显示名匹配；没有任何官方机制给
一个已安装应用挂"别名"。两条歪路都不采用：

1. **`<activity-alias>` + 第二个 label** ⇒ 桌面出现两个图标，用户会以为是两个应用。
2. **把 label 写成「小院儿 Gosslan」** ⇒ 搜索两个都能命中，但主屏名字变成中英混排，
   与"全局叫小院儿"的产品口径冲突。

如果以后产品上确实需要移动端也能用英文名搜到，只能在这两条里选一条，属产品裁决
（当前默认：**保持单一名字**）。

## 4. 别再踩：名字散在哪七处

改名前把这张表当清单，逐项改完跑 `node --experimental-strip-types --test src/utils/appName.test.ts`：

| # | 位置 | 作用 |
|---|---|---|
| 1 | `src/i18n/locales/zh-cn.ts` / `en-us.ts` 的 `app.name` | 应用内所有界面文案 |
| 2 | `src-tauri/tauri.conf.json` 的 `productName` | exe 名、安装目录、macOS `.app` 目录名、**升级锚点**（别改成中文） |
| 3 | `src-tauri/Info.plist` 的 `CFBundleDisplayName` | macOS / iOS 默认显示名 |
| 4 | `src-tauri/infoplist/zh-Hans.lproj/InfoPlist.strings` | macOS 中文显示名 |
| 5 | `src-tauri/infoplist/en.lproj/InfoPlist.strings` | macOS 英文显示名 |
| 6 | `src-tauri/gen/android/app/src/main/res/values/strings.xml` 与 `values-zh/strings.xml` | Android 启动器标签与前台服务通知 |
| 7 | `src-tauri/nsis/zh-CN.nsh` / `en-US.nsh`（`appDisplayName` / `appShortcutName`）+ `nsis/hooks.nsh` | Windows 安装器界面、快捷方式名、开始菜单别名 |

另有两处**运行期**名字不走资源文件：托盘提示（`src-tauri/src/tray.rs` 的 `tray_tooltip`）与
后端文案（`AppState::display_name()` / `is_zh()`），它们读语言决定中英，同样由上面的判据覆盖。
