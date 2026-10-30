$ErrorActionPreference = "Stop"

$TaskName = "AlwaysOnHttpServer"
$Root = Split-Path -Parent $PSScriptRoot
$VbsPath = Join-Path $PSScriptRoot "start_hidden.vbs"

$Action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$VbsPath`""
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Days 365)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Principal $Principal `
  -Settings $Settings `
  -Description "Start Always On HTTP Server without opening a console window." `
  -Force | Out-Null

Write-Host "Installed startup task: $TaskName"
Write-Host "Project root: $Root"
Write-Host "Start target: $VbsPath"
