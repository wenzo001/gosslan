# =============================================================================
#  构建 Windows 生产包（NSIS 安装包 .exe）——「每次提交测试都出一个能装的包」
#
#  与 CI（.github/workflows/build.yml）产出的东西**完全一致**：
#    产物：src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\*.exe
#    并额外复制一份到 dist-windows\ 并打印 SHA-256，便于直接发给别人试。
#
#  用法（项目根目录）：
#    npm run dist:win:test
#    # 或
#    .\scripts\build-windows-release.ps1
#
#  参数：
#    -SkipGuards   跳过构建前的护栏（npm test / cargo test）。**默认不跳**：
#                  包能装上但功能是坏的，比没有包更浪费时间。
#    -Portable     额外产出一个免安装的便携版 zip（默认不产，按要求只要 NSIS）。
#
#  为什么必须带 --features bluetooth：
#    BLE 传输在 Cargo 里是 **可选 feature**（ADR-0015 §2：默认关闭，
#    不开时依赖不下载、代码不编译、产物与旧版逐字节一致）。
#    不带这个 flag 打出来的包 **就是没有蓝牙**，界面上的蓝牙开关永远起不来。
# =============================================================================
[CmdletBinding()]
param(
    [switch]$SkipGuards,
    [switch]$Portable
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$target = "x86_64-pc-windows-msvc"
$outDir = Join-Path $root "dist-windows"

function Step($n, $text) {
    Write-Host ""
    Write-Host "==> $n $text" -ForegroundColor Cyan
}

function Fail($text) {
    Write-Host ""
    Write-Host "!! $text" -ForegroundColor Red
    exit 1
}

$version = (Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
Write-Host "Gosslan Windows 生产包构建 —— 版本 $version / target $target / features=bluetooth" -ForegroundColor Green

# ---------------------------------------------------------------------------
# 0/5 环境自检：Rust 目标 + MSVC 链接器
#   缺 MSVC 时 cargo 会报一句很难懂的 "linker `link.exe` not found"，
#   这里提前说清楚。
# ---------------------------------------------------------------------------
Step "0/5" "环境自检"
$hostTarget = (rustc -vV | Select-String '^host:').ToString().Split(':')[1].Trim()
if ($hostTarget -ne $target) {
    Fail "当前 Rust host 是 $hostTarget，本脚本只支持在 Windows x64 上打 $target。请用 CI 或换机器。"
}
$installed = rustup target list --installed
if ($installed -notcontains $target) {
    Write-Host "    安装 Rust 目标 $target ..."
    rustup target add $target
    if ($LASTEXITCODE -ne 0) { Fail "rustup target add $target 失败" }
}
Write-Host "    Rust host / 目标 OK"

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vswhere) {
    $vc = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($vc) { Write-Host "    MSVC: $vc" } else { Fail "找到 Visual Studio 但没有 C++ 生成工具（VC.Tools.x86.x64）" }
} else {
    Write-Host "    警告：未找到 vswhere，假设 MSVC 已就绪（构建失败时请装 VS C++ 生成工具）" -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# 1/5 护栏：统一入口 verify.mjs（--SkipGuards 显式跳过）
#
# verify.mjs 串起 11 步守卫：check-test-manifest / check-invariant-exceptions /
# check-ble-constants / check-domain-map / check-domain-deps / check-change-budget /
# version:changelog / npm test / npm run build / cargo test --features bluetooth /
# verify-guards（默认只跑前端子集）。
# 比原来的"前端 + Rust --lib 手工串"覆盖更全 —— 原来漏了全量 cargo test、领域图、
# BLE 常量单一来源、不变量例外登记等静态守卫。
#
# ⚠️ -SkipGuards 必须**显式传入理由字符串**（例如 -SkipGuards "临时跳过：先修 cargo fmt"）。
#     不加理由 = 等同于未跳过，强制跑全量。理由会打印进日志，事后可以 grep 追溯。
# ---------------------------------------------------------------------------
if (-not $SkipGuards) {
    Step "1/5" "统一验证入口（npm run verify）"
    npm run verify
    if ($LASTEXITCODE -ne 0) { Fail "verify 未通过 —— 已中止打包（坏包比没有包更浪费时间）。确要跳过请加 -SkipGuards <理由>" }
} else {
    if (-not ($SkipGuards -is [string]) -or ($SkipGuards -eq "")) {
        Fail "-SkipGuards 必须带理由字符串（例如 -SkipGuards '临时跳过：先修 cargo fmt'）。空理由视同未跳过。"
    }
    Write-Host "⚠️  护栏已跳过（-SkipGuards）。理由：$SkipGuards" -ForegroundColor Yellow
    Write-Host "    这次发布的产物质量**未经验证**，请在发布前补跑 npm run verify" -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# 3/5 正式打包：tauri build --features bluetooth
#   · beforeBuildCommand (npm run build) 会先跑 vue-tsc + vite build，前端类型错会在这里拦下
#   · NSIS 首次构建需要 makensis：Tauri 会自动下载到 target 缓存（要联网）
# ---------------------------------------------------------------------------
Step "3/5" "打包 NSIS 安装包（tauri build --features bluetooth）"
npm run tauri -- build --features bluetooth --bundles nsis --target $target
if ($LASTEXITCODE -ne 0) { Fail "tauri build 失败" }

$nsisDir = Join-Path $root "src-tauri\target\$target\release\bundle\nsis"
if (-not (Test-Path $nsisDir)) { Fail "未找到产物目录：$nsisDir" }
$installers = Get-ChildItem $nsisDir -Filter *.exe
if (-not $installers) { Fail "NSIS 目录里没有 .exe：$nsisDir" }

# ---------------------------------------------------------------------------
# 4/5 收集产物到 dist-windows/（可选的便携版）
# ---------------------------------------------------------------------------
Step "4/5" "收集产物到 dist-windows/"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
foreach ($f in $installers) {
    Copy-Item $f.FullName (Join-Path $outDir $f.Name) -Force
    Write-Host "    $($f.Name)"
}

if ($Portable) {
    $exe = Join-Path $root "src-tauri\target\$target\release\gosslan.exe"
    if (Test-Path $exe) {
        $zip = Join-Path $outDir "gosslan_${version}_x64-portable.zip"
        if (Test-Path $zip) { Remove-Item $zip -Force }
        Compress-Archive -Path $exe -DestinationPath $zip -Force
        Write-Host "    $(Split-Path -Leaf $zip)（便携版：解压双击 gosslan.exe）"
    } else {
        Write-Host "    警告：未找到便携版 exe，跳过 zip" -ForegroundColor Yellow
    }
}

# ---------------------------------------------------------------------------
# 5/5 校验清单（打包最容易"看着成功其实没蓝牙"）
# ---------------------------------------------------------------------------
Step "5/5" "产物校验"
Write-Host "    构建命令带 --features bluetooth ⇒ 本包**已编入**蓝牙传输（Cargo 层已保证）" -ForegroundColor Green
$mainExe = Join-Path $root "src-tauri\target\$target\release\gosslan.exe"
if (Test-Path $mainExe) {
    $sizeMb = [math]::Round((Get-Item $mainExe).Length / 1MB, 1)
    Write-Host "    gosslan.exe 大小：${sizeMb} MB"
    # 旁证（不当作硬判据）：release 开了 lto + strip，符号被剥掉，所以只本地快速扫一遍字符串。
    # 扫不到**不代表**没编进去（真验证在 Cargo 的 feature 上），所以这里只提示、不失败。
    $text = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($mainExe))
    if ($text -match 'btleplug') {
        Write-Host "    ✔ 二进制的字符串表里能看到 btleplug（旁证）" -ForegroundColor Green
    } else {
        Write-Host "    · 字符串表里看不到 btleplug（lto+strip 的正常结果，不影响结论）" -ForegroundColor DarkGray
    }
} else {
    Write-Host "    警告：未找到 release/gosslan.exe，跳过大小检查" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "===== 产物 =====" -ForegroundColor Green
Get-ChildItem $outDir -File | ForEach-Object {
    $hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
    Write-Host ("  {0}  ({1:N1} MB)" -f $_.Name, ($_.Length / 1MB))
    Write-Host ("    SHA256 {0}" -f $hash)
}
Write-Host ""
Write-Host "安装包可直接双击安装；装完在设置页打开「蓝牙」。" -ForegroundColor Green
