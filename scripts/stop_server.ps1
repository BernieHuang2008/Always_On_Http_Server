$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path

$Processes = Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -match "server\.py" -and
    $_.CommandLine -match [regex]::Escape($Root)
  }

if (-not $Processes) {
  Write-Host "No Always On HTTP Server process found for: $Root"
  exit 0
}

$Processes | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force
  Write-Host "Stopped process $($_.ProcessId)"
}
