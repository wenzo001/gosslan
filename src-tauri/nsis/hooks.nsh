; 安装器钩子（由 `bundle.windows.nsis.installerHooks` 引入，不 fork 官方模板）。
;
; ## 只做显示名，不碰升级锚点
;
; 这个文件不定义、也不修改 `${PRODUCTNAME}` / `${MANUFACTURER}` / `INSTALLMODE`。
; 升级检测用的是 `UNINSTKEY = ...\Uninstall\${PRODUCTNAME}`、安装目录回读用的是
; `MANUPRODUCTKEY = Software\${MANUFACTURER}\${PRODUCTNAME}`（见官方 installer.nsi），
; 两者都由 tauri.conf.json 的 `productName` / `publisher` / `identifier` 决定 ——
; 那几项在本轮一律没动，所以新版安装器仍然认得出旧版，不会装出第二份应用。
;
; ## `$(appDisplayName)` 为什么可用（已对 tauri 2.12.5 模板核实 include 顺序）
;
; 本文件在官方模板第 31–37 行被 `!include`，早于第 506–508 行的语言文件 include；
; 但 `NSIS_HOOK_POSTINSTALL` 是在第 778 行 `!insertmacro` 展开的，那时
; `nsis/zh-CN.nsh` / `nsis/en-US.nsh` 里的 `appDisplayName` / `appShortcutName`
; 早已定义完毕。宏体只是文本，`$(...)` 在展开点才求值 ⇒ 不存在未知 LangString。
; （若哪天 Tauri 把 POSTINSTALL 挪到语言 include 之前，这里会立刻编译失败，不会静默。）
;
; ## 快捷方式为什么先删再建
;
; 官方模板在**更新模式**（`$UpdateMode = 1`）里直接 `Return`，不会重建快捷方式，
; 所以旧版留下的 `Gosslan.lnk` 不会被改名。这里先校验 `.lnk` 的目标确实指向
; `$INSTDIR\${MAINBINARYNAME}.exe`（`IsShortCutTarget`），只删自己的那一份，
; 再按本地化名重建并补回 AUMID；不是本应用的快捷方式一律不动。
;
; 开始菜单目录未配置（`startMenuFolder` 为空）⇒ 快捷方式直接在 `$SMPROGRAMS` 下。
; ⚠️ 已知边界：图形安装的**桌面**快捷方式由完成页创建，晚于 POSTINSTALL。
; 因此：
;   - 完成页新建的那一枚仍是 `Gosslan.lnk`（静默/被动安装同样在建，但能改到）；
;   - 若桌面原来就有一份自己的快捷方式（本钩子会改名并重建为本地化名），完成页再建
;     一份 `Gosslan.lnk` 就会出现**两份**（5.16.95 实测回归）。所以下面在“确实改到了
;     桌面那一份”时把 `$NoShortcutMode` 置 1，让完成页的 `CreateOrUpdateDesktopShortcut`
;     直接返回，不再新建。没有旧快捷方式的全新安装不受影响（用户仍可在完成页勾选创建）。
;
; 已经装出两份的机器由应用首次启动时做一次性对账（`src-tauri/src/win_shortcut.rs`：
; 仅当两份目标都等于当前 exe 时删旧名那份）。
;
; 桌面快捷方式只在「原来就有一份且是自己的」时才重建 —— 用户没勾选桌面快捷方式
; （或更新模式没建过）时，不允许这里凭空多出一个。
;
; ⚠️ 模板把 `NSIS_HOOK_PREUNINSTALL` 插在 `CheckIfAppIsRunning` **之前**（第 823 行），
; 所以在「应用正在运行」弹窗上点取消会保留应用、但快捷方式已被删掉。这是模板的插入点
; 决定的，无法在钩子里回避；重跑安装器即可重建，故这里按需求保留 PREUNINSTALL 删除。

; 计算本地化名字：$R9 = 显示名，$R8 = 快捷方式名（当前相同，保留两格便于以后分开）。
!macro Gosslan_ComputeNames
  StrCpy $R9 "$(appDisplayName)"
  StrCpy $R8 "$(appShortcutName)"
!macroend

; 只删「目标指向本应用 exe」的快捷方式；删到了就把 $R7 置 1（表示这一处原来有）。
; `IsShortCutTarget` 会改写 $0–$3，调用方不要依赖它们。
!macro Gosslan_DeleteOwnedShortcut DIR NAME
  ${If} ${FileExists} "${DIR}\${NAME}.lnk"
    !insertmacro IsShortCutTarget "${DIR}\${NAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 == 1
      Delete "${DIR}\${NAME}.lnk"
      StrCpy $R7 1
    ${EndIf}
  ${EndIf}
!macroend

; 目标位置没有同名 .lnk 时才创建，并沿用官方模板的图标 + AUMID 写法。
!macro Gosslan_CreateShortcutIfMissing DIR NAME
  ${IfNot} ${FileExists} "${DIR}\${NAME}.lnk"
    CreateShortcut "${DIR}\${NAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe" 0
    !insertmacro SetLnkAppUserModelId "${DIR}\${NAME}.lnk"
  ${EndIf}
!macroend

; 同一目录下的两个候选名（锚点名 + 本地化名）都先按目标校验；只要原来有一份是自己的，
; 就按当前语言重建一份。这样「中文装过 → 英文系统升级」也会把 小院儿.lnk 换回 Gosslan.lnk。
; 必须两个都试：只试锚点名会漏掉旧版本留下的中文快捷方式。
!macro Gosslan_RelocalizeShortcuts DIR
  StrCpy $R7 0
  !insertmacro Gosslan_DeleteOwnedShortcut "${DIR}" "${PRODUCTNAME}"
  !insertmacro Gosslan_DeleteOwnedShortcut "${DIR}" "小院儿"
  ${If} $R7 == 1
    !insertmacro Gosslan_CreateShortcutIfMissing "${DIR}" "$R8"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro Gosslan_ComputeNames
  ; 「应用和功能」里显示的名字：只写展示值，不参与升级检测（NSIS 检测只读
  ; UninstallString / DisplayVersion；WiX 迁移分支还要求 UninstallString 含 msiexec）。
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "$R9"
  !insertmacro Gosslan_RelocalizeShortcuts "$SMPROGRAMS"
  !insertmacro Gosslan_RelocalizeShortcuts "$DESKTOP"
  ; 桌面那一份确实被本钩子改名/重建过（$R7 = 1）⇒ 完成页不要再建 `Gosslan.lnk`，
  ; 否则桌面上会同时存在旧名与新名两份（5.16.95 实测）。
  ; `$NoShortcutMode` 是官方 installer.nsi 里的变量，只影响完成页的桌面快捷方式；
  ; 若上游改名，这里会在编译期报“变量未声明”，不会静默失效。
  ${If} $R7 == 1
    StrCpy $NoShortcutMode 1
  ${EndIf}

  ; ── 让 Explorer 丢掉 exe 的旧图标缓存（2026-11-07 用户报「软件内升级后图标还是旧的」）──
  ;
  ; 分层证据（详见 CHANGELOG 5.18.73 的「Windows 图标」小节）：
  ;   · 打包层已正确：`bundle.icon` 含 `icons/icon.ico`，NSIS 的 installerIcon /
  ;     uninstallerIcon 也指向它；新图标提交 81eb7de0（11-07 10:12）是 v5.18.71
  ;     （11-07 15:40）的祖先，包里带的就是新图标。
  ;   · 安装层已正确：本钩子会把目标指向本应用 exe 的快捷方式删掉重建，IconLocation
  ;     指回 `$INSTDIR\${MAINBINARYNAME}.exe`，不存在复用旧 LNK 的问题。
  ;   · 剩下的就是缓存层：Explorer 的 `iconcache_*.db` 按"路径 + 写入时间"缓存 exe 图标，
  ;     覆盖安装（同一个 exe 路径、同一条快捷方式）后经常仍然显示旧图，直到缓存被重建。
  ;
  ; `SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, 0, 0)` 是 Windows 官方提供的
  ; "让外壳重新读图标/关联"的通知，安装器收尾时发一次，等于替用户做了"重启 Explorer"。
  ; 它不改任何文件、不依赖管理员权限；失败也不影响安装（System::Call 报错会被 ClearErrors 吃掉）。
  ClearErrors
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x0000, p 0, p 0)'
  ClearErrors
!macroend

; ── 安装器接管证据（2026-11-09）─────────────────────────────────────────────
;
; 覆盖安装 / 手动跑安装器 / 卸载时，官方模板的 `CheckIfAppIsRunning` 会 `FindProcess*` +
; `KillProcess*`（按 exe 名强杀，见 tauri 2.11.4 的 `utils.nsh`）。被杀的那一轮
; **在进程内留不下任何东西** —— 这就是 2026-11-09 用户报的
; 「应用内升级后首次启动弹『上次运行被系统或外部结束』」的形状。
;
; 所以由安装器替它留证：杀进程**之前**（本钩子插在 `CheckIfAppIsRunning` 之前）先往
; 崩溃现场文件追加一行 `>>> code=INSTALLER_TAKEOVER mode=install|uninstall`。
; 应用下次启动按这条判成「安装器接管」（正常流程，不弹）。写进 crash 文件而不是另开一份：
; 判定读的就是该文件按启动路标切出的「上一轮」，写在同一处才落在同一段里。
;
; 两个边界，都要守住：
;  · **只在应用确实在跑时才写**。应用内更新里 updater 插件先 `exit(0)`、安装器随后才启动
;    （见 `commands/updater.rs` 的复核），安装器找不到进程 ⇒ 这里一行都不写；那条路径由
;    应用自己写的 `UPDATER_INSTALL_BEGIN` 负责。若在这里无条件写，"应用早已退出"的安装
;    会把上一轮真正的静默死亡盖成「安装器结束」⇒ 真崩溃漏报。
;  · 非静默安装随后会弹「应用正在运行，是否结束」确认框；用户点**取消**时安装 Abort、
;    应用继续活着，这一行会成为空证据。它只可能影响**同一轮后来的一次静默死亡**
;    （panic / abort / SIGTERM / BOOT_FAILED 优先级都更高，不受影响）；安装 Abort 后
;    文件与注册表都没动，下一次安装会正常再写。
;
; 返回值语义按官方模板核对过：`$R0 = 0` 表示**找到了进程**（模板紧接着就 Kill）。
; 若哪天上游换了检查原语，这里必须一起核对，不能静默沿用。

; 应用是否在跑 → $R0（0 = 找到了）。安装与卸载两个调用点共用这一个原语。
;
; 参数必须与模板 `CheckIfAppIsRunning` 传给 `FindProcess*` 的**完全一致**
; （`"$INSTDIR\${MAINBINARYNAME}.exe"`，tauri 2.11.4 `utils.nsh`）—— 我们这一行要表达的
; 就是"模板接下来会不会杀掉一个进程"，参数换了就等于换了一把尺子。
; `${INSTALLMODE}` 分支也必须跟模板同步（`currentUser` 用 `FindProcessCurrentUser`）。
!macro Gosslan_FindApp
  !if "${INSTALLMODE}" == "currentUser"
    nsis_tauri_utils::FindProcessCurrentUser "$INSTDIR\${MAINBINARYNAME}.exe"
  !else
    nsis_tauri_utils::FindProcess "$INSTDIR\${MAINBINARYNAME}.exe"
  !endif
  Pop $R0
!macroend

; 应用在跑 ⇒ 模板接下来会结束它 ⇒ 先留一行接管证据（安装/卸载两种 mode）。
; 写不进去一律忽略：证据是诊断用的锦上添花，绝不能把安装/卸载变成失败。
;
; 路径必须与 Rust 侧 `logging::crash_file_in` 一致：`<app_data>/logs/<stem>-crash.log`。
; 生产里 `stem` 恒为 `${MAINBINARYNAME}`（只有 E2E 多开会带 `GOSSLAN_INSTANCE=n` 变成
; `gosslan-1`，那条路线不走安装器）。app_data 目录用 `${BUNDLEID}`，与官方模板卸载段
; 的 `RmDir /r "$APPDATA\${BUNDLEID}"` 同一个来源 —— 不要在这里写死包名，改名就两端一起断。
!macro Gosslan_NoteInstallerTakeover MODE
  ClearErrors
  !insertmacro Gosslan_FindApp
  ${If} $R0 = 0
    CreateDirectory "$APPDATA\${BUNDLEID}\logs"
    ClearErrors
    FileOpen $R6 "$APPDATA\${BUNDLEID}\logs\${MAINBINARYNAME}-crash.log" a
    ${If} ${Errors}
      ClearErrors
    ${Else}
      FileWrite $R6 ">>> code=INSTALLER_TAKEOVER mode=${MODE} version=${VERSION}$\r$\n"
      FileClose $R6
    ${EndIf}
  ${EndIf}
  ClearErrors
!macroend

; 安装器路标（覆盖安装/升级时写一行「目标版本 + 安装目录」）。
;
; 为什么要它：`CheckIfAppIsRunning` 是**强制终止**旧进程（`FindProcess` + `KillProcess`，
; 按 exe 名匹配，见官方模板第 7523 行），旧进程不会留下任何"我要被安装器换掉了"的痕迹。
; 事后只能靠猜 —— 现在由安装器在杀进程**之前**写一个文件，应用下次启动读进运行日志。
;
; 时间戳取文件自己的 mtime（NSIS 没有取本地时间的原语）；应用把 mtime 一并写进日志，
; 于是「安装器在 T 时刻跑过、版本是多少、装到哪个目录」三件事都能从日志里直接读到。
;
; 写失败**一律忽略**：路标是诊断用的锦上添花，绝不能让它把安装变成失败。
!macro NSIS_HOOK_PREINSTALL
  ClearErrors
  CreateDirectory "$APPDATA\${BUNDLEID}\logs"
  ClearErrors
  FileOpen $R6 "$APPDATA\${BUNDLEID}\logs\installer-marker.txt" w
  ${If} ${Errors}
    ClearErrors
  ${Else}
    FileWrite $R6 "version=${VERSION}$\r$\n"
    FileWrite $R6 "installdir=$INSTDIR$\r$\n"
    FileClose $R6
  ${EndIf}
  ; 在模板强杀旧进程之前留一行「安装器接管」证据（只在应用确实在跑时）。
  !insertmacro Gosslan_NoteInstallerTakeover "install"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 更新时官方模板不会删快捷方式，这里也跳过；真正卸载才清掉本地化名的那一份。
  ${If} $UpdateMode <> 1
    !insertmacro Gosslan_DeleteOwnedShortcut "$SMPROGRAMS" "${PRODUCTNAME}"
    !insertmacro Gosslan_DeleteOwnedShortcut "$SMPROGRAMS" "小院儿"
    !insertmacro Gosslan_DeleteOwnedShortcut "$DESKTOP" "${PRODUCTNAME}"
    !insertmacro Gosslan_DeleteOwnedShortcut "$DESKTOP" "小院儿"
  ${EndIf}
  ; 卸载同样会在 `CheckIfAppIsRunning` 里强杀正在运行的实例 —— 同样先留证据。
  ; 卸载没有 POST 钩子，只能当场判定（边界见上面「安装器接管证据」的说明）。
  !insertmacro Gosslan_NoteInstallerTakeover "uninstall"
!macroend
