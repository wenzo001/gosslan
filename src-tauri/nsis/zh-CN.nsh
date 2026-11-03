; 简体中文安装器语言文件（Level 1：只做显示名本地化，不动升级锚点）。
;
; 为什么整份复制而不是只写增量：Tauri 对同一种语言**只 include 一个文件**
; （`customLanguageFiles` 命中时替换内置语言文件，见 tauri-bundler `nsis/mod.rs`），
; 漏一条 `LangString` 就会在界面上渲染成英文兜底或空串。本文件的 30 条 = 内置 27 条
; + `chooseHowToInstall` + 本文件新增的 `appDisplayName` / `appShortcutName`；
; 除这三条与「产品显示名」外，逐字与内置 `SimpChinese.nsh` 一致。
;
; 为什么 `appRunning*` 里不保留 `{{product_name}}`：那三个占位符是安装器运行时用
; `StrReplace "$(appRunning)" "{{product_name}}" "${PRODUCTNAME}"` 替换的，而
; `${PRODUCTNAME}` 恒为 "Gosslan"（升级锚点，不能改）。这里直接写死「小院儿」，
; 占位符不存在 ⇒ StrReplace 找不到可替换片段 ⇒ 中文界面显示「小院儿」。
;
; 为什么另加 `chooseHowToInstall`：Tauri 模板先读正确拼写的它、再回落到只用于
; 旧自定义文件的 `choowHowToInstall`；内置文件两者都没写 ⇒ 默认安装器该处是空标题。
; 这里补上正确拼写，顺便把产品名换成「小院儿」。

LangString addOrReinstall ${LANG_SIMPCHINESE} "添加/重新安装组件"
LangString alreadyInstalled ${LANG_SIMPCHINESE} "已安装"
LangString alreadyInstalledLong ${LANG_SIMPCHINESE} "小院儿 ${VERSION} 已经安装了。选择你想要执行的操作后点击下一步以继续。"
; 安装器钩子（`nsis/hooks.nsh`）读这两条：显示名与快捷方式名。中英文各自一份，
; 写法与 Tauri 模板里的 `$(createDesktop)` 等 LangString 完全同构。
LangString appDisplayName ${LANG_SIMPCHINESE} "小院儿"
LangString appRunning ${LANG_SIMPCHINESE} "小院儿 正在运行！请关闭后再试。"
LangString appRunningOkKill ${LANG_SIMPCHINESE} "小院儿 正在运行！$\n点击确定以终止运行。"
LangString appShortcutName ${LANG_SIMPCHINESE} "小院儿"
LangString chooseMaintenanceOption ${LANG_SIMPCHINESE} "选择要执行的维护操作。"
LangString chooseHowToInstall ${LANG_SIMPCHINESE} "选择你想要安装 小院儿 的方式。"
LangString createDesktop ${LANG_SIMPCHINESE} "创建桌面快捷方式"
LangString dontUninstall ${LANG_SIMPCHINESE} "请勿卸载"
LangString dontUninstallDowngrade ${LANG_SIMPCHINESE} "请勿卸载（此安装程序禁止未卸载就进行版本降级的操作）"
LangString failedToKillApp ${LANG_SIMPCHINESE} "无法终止 小院儿。请关闭后再试。"
LangString installingWebview2 ${LANG_SIMPCHINESE} "正在安装 WebView2..."
LangString newerVersionInstalled ${LANG_SIMPCHINESE} "有一个更新版本的 小院儿 已经安装了！不推荐你安装旧的版本。如果你真的想要安装这个旧的版本，推荐先卸载当前版本。选择你想要执行的操作后点击下一步以继续。"
LangString older ${LANG_SIMPCHINESE} "旧的"
LangString olderOrUnknownVersionInstalled ${LANG_SIMPCHINESE} "系统中已存在版本为 $R4 的小院儿。推荐先卸载当前版本后再进行安装。选择你想要执行的操作后点击下一步以继续。"
LangString silentDowngrades ${LANG_SIMPCHINESE} "降级操作在此安装程序上已禁用，无法进行安静安装，请使用图形操作界面。$\n"
LangString unableToUninstall ${LANG_SIMPCHINESE} "无法卸载！"
LangString uninstallApp ${LANG_SIMPCHINESE} "卸载 小院儿"
LangString uninstallBeforeInstalling ${LANG_SIMPCHINESE} "安装前卸载"
LangString unknown ${LANG_SIMPCHINESE} "未知"
LangString webview2AbortError ${LANG_SIMPCHINESE} "无法安装 WebView2！没有它，此应用就无法运行。尝试重启安装程序。"
LangString webview2DownloadError ${LANG_SIMPCHINESE} "错误：无法下载 WebView2 - $0"
LangString webview2DownloadSuccess ${LANG_SIMPCHINESE} "WebView2 引导程序下载成功"
LangString webview2Downloading ${LANG_SIMPCHINESE} "正在下载 WebView2 引导程序..."
LangString webview2InstallError ${LANG_SIMPCHINESE} "错误：安装 WebView2 时失败，错误代码：$1"
LangString webview2InstallSuccess ${LANG_SIMPCHINESE} "成功安装 WebView2"
LangString deleteAppData ${LANG_SIMPCHINESE} "删除应用程序数据"
