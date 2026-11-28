# Launch one production Gosslan instance for the Windows WebView2 scroll smoke.
# The caller owns cleanup. No installer, dev server, browser download or user DB is used.
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$RunRoot,
  [Parameter(Mandatory = $true)][int]$Instance,
  [Parameter(Mandatory = $true)][int]$CdpPort
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path -LiteralPath $Exe)) { throw "release exe not found: $Exe" }
$udf = Join-Path $RunRoot "webview2-$Instance"
$appData = Join-Path $RunRoot "appdata-$Instance"
$appRoot = Join-Path $RunRoot "app-$Instance"
$dataRoot = Join-Path $appRoot "scroll-smoke-data"
New-Item -ItemType Directory -Force -Path $udf, $appData, $appRoot, $dataRoot | Out-Null
# tauri.scroll-smoke.conf.json resolves appDirectoriesOverride relative to the binary.
# Copying the release exe into this per-instance run directory gives each process a whole
# throwaway app directory, not just a uniquely named DB inside the user's normal profile.
$smokeExe = Join-Path $appRoot "gosslan.exe"
Copy-Item -LiteralPath $Exe -Destination $smokeExe -Force
# GOSSLAN_INSTANCE is the application's existing isolation contract: separate DB,
# TCP port and device fingerprint. WEBVIEW2_USER_DATA_FOLDER isolates the renderer profile.
$env:GOSSLAN_INSTANCE = "$Instance"
$env:WEBVIEW2_USER_DATA_FOLDER = $udf
# Best-effort redirection for child processes; appDirectoriesOverride is the authoritative
# whole-app isolation, while GOSSLAN_INSTANCE and the UDF keep identities and renderer state separate.
$env:APPDATA = $appData
$env:LOCALAPPDATA = $appData
$stdout = Join-Path $RunRoot "stdout-$Instance.log"
$stderr = Join-Path $RunRoot "stderr-$Instance.log"
$p = Start-Process -FilePath $smokeExe -ArgumentList @("--instance", "$Instance") -WorkingDirectory $RunRoot -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
Start-Sleep -Seconds 2
$exited = $p.HasExited
$exitCode = if ($exited) { [int]$p.ExitCode } else { $null }
if ($exited) { throw "smoke instance exited during startup: $exitCode" }
@{ pid = $p.Id; instance = $Instance; cdpPort = $CdpPort; userDataDir = $udf; exe = $smokeExe; dataRoot = $dataRoot; stdout = $stdout; stderr = $stderr; exited = $exited; exitCode = $exitCode } | ConvertTo-Json -Compress
