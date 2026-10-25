# Create a "RoboMaster 3D Viewer" shortcut on the Windows desktop, pointing to start.cmd.
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File create-desktop-shortcut.ps1
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $root 'start.cmd'
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'RoboMaster 3D Viewer.lnk'

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = $target
$sc.WorkingDirectory = $root
$sc.WindowStyle = 1
$sc.Description = 'RoboMaster 3D Viewer (one-click launch)'
$sc.Save()

Write-Host "Shortcut created: $lnk"
