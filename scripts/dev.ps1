# Gosslan local dev launcher
#
# Works around two machine-specific environment traps (NOT project bugs):
#   1. cargo is not on PATH. rustup installs it under %USERPROFILE%\.cargo\bin,
#      but Windows explorer.exe does not push PATH changes to already-running
#      terminals (VS Code / WebStorm integrated terminals especially), so
#      `npm run tauri dev` fails with:
#      "failed to run 'cargo metadata' ... program not found"
#   2. A global http_proxy hijacks localhost. Tauri's devUrl is
#      http://localhost:1420; the proxy fails to forward and returns 502,
#      which shows up as a fully blank window. Additionally, localhost
#      resolves to IPv6 ::1 here while Vite listens on IPv4 127.0.0.1 only.
#
# Usage (from the project root):
#   powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
#
# This file is intentionally ASCII-only: Windows PowerShell 5.1 reads .ps1
# using the system ANSI codepage unless a BOM is present, which corrupts
# non-ASCII text and breaks parsing.

$ErrorActionPreference = "Stop"

function Add-ToPathIfExists {
    param([string]$Dir)
    if ([string]::IsNullOrWhiteSpace($Dir)) { return }
    if (-not (Test-Path $Dir)) { return }
    if (($env:Path -split ';') -notcontains $Dir) {
        $env:Path = "$Dir;$env:Path"
    }
}

# ---- 1. make sure cargo is reachable ----
$cargoBin = $null
if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
    $cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
}
$cargoExe = $null
if ($cargoBin) { $cargoExe = Join-Path $cargoBin "cargo.exe" }
if (-not $cargoExe -or -not (Test-Path $cargoExe)) {
    $found = Get-Command cargo -ErrorAction SilentlyContinue
    if ($found) { $cargoExe = $found.Source } else { $cargoExe = $null }
}
if (-not $cargoExe) {
    Write-Host "[ERROR] cargo not found." -ForegroundColor Red
    Write-Host "        Expected at: $cargoBin\cargo.exe" -ForegroundColor Yellow
    Write-Host "        Install Rust first: https://rustup.rs (stable-msvc toolchain)" -ForegroundColor Yellow
    exit 1
}
if ($cargoBin) { Add-ToPathIfExists $cargoBin }

# ---- 2. make sure node/npm are reachable (common Windows install locations) ----
$nodeDirs = New-Object System.Collections.ArrayList
foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:APPDATA, $env:LOCALAPPDATA)) {
    if ([string]::IsNullOrWhiteSpace($base)) { continue }
    [void]$nodeDirs.Add((Join-Path $base "nodejs"))
    [void]$nodeDirs.Add((Join-Path $base "nvm"))
    [void]$nodeDirs.Add((Join-Path $base "Programs\nodejs"))
}
foreach ($d in $nodeDirs) { Add-ToPathIfExists $d }

$npmExe = $null
foreach ($d in $nodeDirs) {
    if ([string]::IsNullOrWhiteSpace($d)) { continue }
    $cand = Join-Path $d "npm.cmd"
    if (Test-Path $cand) { $npmExe = $cand; break }
}
if (-not $npmExe) {
    $found = Get-Command npm -ErrorAction SilentlyContinue
    if ($found) { $npmExe = $found.Source }
}
if (-not $npmExe) {
    Write-Host "[ERROR] npm not found. Install Node.js first." -ForegroundColor Red
    exit 1
}

# ---- 3. keep the proxy away from loopback ----
foreach ($v in @("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY")) {
    if (Test-Path "env:$v") { Remove-Item "env:$v" -ErrorAction SilentlyContinue }
}
$env:NO_PROXY = "localhost,127.0.0.1,::1"
$env:no_proxy = $env:NO_PROXY

# ---- 4. preflight ----
if (-not (Test-Path "package.json")) {
    Write-Host "[ERROR] run this script from the project root (cwd: $PWD)" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path "node_modules")) {
    Write-Host "[info] node_modules missing, installing dependencies..." -ForegroundColor Cyan
    & $npmExe install
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

# ---- 5. launch ----
Write-Host ""
$cargoVer = "unknown"
try { $cargoVer = [string](& $cargoExe --version) } catch { }
Write-Host "cargo : $cargoVer" -ForegroundColor DarkGray
$nodeVer = "unknown"
$nodeExe = Get-Command node -ErrorAction SilentlyContinue
if ($nodeExe) { try { $nodeVer = [string](& $nodeExe.Source --version) } catch { } }
Write-Host "node  : $nodeVer" -ForegroundColor DarkGray
Write-Host "Starting Gosslan dev mode (first build takes 1-2 minutes)..." -ForegroundColor Green
Write-Host ""

& $npmExe run tauri dev
