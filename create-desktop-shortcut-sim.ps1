# Create a "RoboMaster Sim" shortcut on the Windows desktop, pointing to start-sim.cmd.
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File create-desktop-shortcut-sim.ps1
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $root 'start-sim.cmd'
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'RoboMaster Sim.lnk'

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = $target
$sc.WorkingDirectory = $root
$sc.WindowStyle = 1
$sc.Description = 'RoboMaster Sim (daedalus + bridge + console)'
$sc.Save()

Write-Host "Shortcut created: $lnk"
