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
New-Item -ItemType Directory -Force -Path $udf, $appData, $appRoot | Out-Null
# tauri.scroll-smoke.conf.json resolves appDirectoriesOverride relative to the binary.
# Copying the release exe into this per-instance run directory gives each process a whole
# throwaway app directory, not just a uniquely named DB inside the user's normal profile.
$smokeExe = Join-Path $appRoot "gosslan.exe"
Copy-Item -LiteralPath $Exe -Destination $smokeExe -Force
# GOSSLAN_INSTANCE is the application's existing isolation contract: separate DB,
# TCP port and device fingerprint. WEBVIEW2_USER_DATA_FOLDER isolates the renderer profile.
$env:GOSSLAN_INSTANCE = "$Instance"
$env:WEBVIEW2_USER_DATA_FOLDER = $udf
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$CdpPort --remote-allow-origins=* --user-data-dir=$udf"
# Best-effort redirection for child processes; the authoritative isolation is the
# instance DB + UDF above (Windows KnownFolder APIs do not promise to honour env vars).
$env:APPDATA = $appData
$env:LOCALAPPDATA = $appData
$p = Start-Process -FilePath $smokeExe -ArgumentList @("--instance", "$Instance") -WorkingDirectory $RunRoot -PassThru
@{ pid = $p.Id; instance = $Instance; cdpPort = $CdpPort; userDataDir = $udf; exe = $smokeExe } | ConvertTo-Json -Compress
