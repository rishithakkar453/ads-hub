# PARTISANS Ads Hub — heartbeat / auto-restart
# Run by Task Scheduler every 5 minutes. If localhost:3003 doesn't respond,
# fires off the watchdog VBS to bring the tool back up. Otherwise does nothing.
$ErrorActionPreference = 'SilentlyContinue'

$projectDir = "C:\Users\Rishi\Documents\Github\partisans\ads-hub"
$vbsPath    = "$projectDir\start-ads-hub-watchdog-hidden.vbs"
$logPath    = "$projectDir\heartbeat.log"
$stamp      = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

# Check if the tool responds
$alive = $false
try {
  $r = Invoke-WebRequest -Uri "http://localhost:3003/api/ai/status" -UseBasicParsing -TimeoutSec 4
  if ($r.StatusCode -eq 200) { $alive = $true }
} catch { }

if ($alive) {
  Add-Content -Path $logPath -Value "[$stamp] OK"
  exit 0
}

# Not responding — start the watchdog
Add-Content -Path $logPath -Value "[$stamp] DOWN - starting watchdog"
$quotedPath = '"' + $vbsPath + '"'
Start-Process -FilePath "wscript.exe" -ArgumentList $quotedPath -WindowStyle Hidden
exit 0
