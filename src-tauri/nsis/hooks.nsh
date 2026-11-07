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
  CreateDirectory "$APPDATA\com.gosslan.app\logs"
  ClearErrors
  FileOpen $R6 "$APPDATA\com.gosslan.app\logs\installer-marker.txt" w
  ${If} ${Errors}
    ClearErrors
  ${Else}
    FileWrite $R6 "version=${VERSION}$\r$\n"
    FileWrite $R6 "installdir=$INSTDIR$\r$\n"
    FileClose $R6
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 更新时官方模板不会删快捷方式，这里也跳过；真正卸载才清掉本地化名的那一份。
  ${If} $UpdateMode <> 1
    !insertmacro Gosslan_DeleteOwnedShortcut "$SMPROGRAMS" "${PRODUCTNAME}"
    !insertmacro Gosslan_DeleteOwnedShortcut "$SMPROGRAMS" "小院儿"
    !insertmacro Gosslan_DeleteOwnedShortcut "$DESKTOP" "${PRODUCTNAME}"
    !insertmacro Gosslan_DeleteOwnedShortcut "$DESKTOP" "小院儿"
  ${EndIf}
!macroend
