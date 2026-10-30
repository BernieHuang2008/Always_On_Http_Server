$ErrorActionPreference = "Stop"

$TaskName = "AlwaysOnHttpServer"

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Removed startup task: $TaskName"
