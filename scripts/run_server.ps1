$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$PreferredPython = Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"

if (Test-Path $PreferredPython) {
  & $PreferredPython .\server.py
} else {
  py -3.12 .\server.py
}
