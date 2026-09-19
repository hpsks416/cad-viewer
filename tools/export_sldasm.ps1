# SolidWorks 2025 SLDASM -> STEP AP214（保留零件级颜色）后台 COM 导出器
# 兼容 Windows PowerShell 5.1。默认不改注册表。加 -ForceNoCef 才临时写 No Cef。
param(
  [Parameter(Mandatory=$true)][string]$InputPath,
  [string]$OutputPath = "",
  [string]$StepAP = "214",
  [switch]$KeepOpen,
  [switch]$ForceNoCef,
  [int]$StartupTimeoutSec = 900
)

$ErrorActionPreference = 'Stop'
function Log($m) { Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }

$logFile = Join-Path $PSScriptRoot 'export_log.txt'
try { Start-Transcript -Path $logFile -Force -ErrorAction SilentlyContinue } catch {}

try {

  if(-not (Test-Path -LiteralPath $InputPath)) { throw "输入文件不存在: $InputPath" }
  $InputPath = (Resolve-Path -LiteralPath $InputPath).Path
  if(-not $OutputPath) { $OutputPath = [System.IO.Path]::ChangeExtension($InputPath, '.STEP') }

  $cefKey = 'HKCU:\SOFTWARE\SolidWorks\SolidWorks 2025\General'
  $cefOriginal = $null
  $cefChanged = $false
  if($ForceNoCef) {
    try {
      $g = Get-ItemProperty -Path $cefKey -ErrorAction Stop
      $cefOriginal = $g.'No Cef'
      Set-ItemProperty -Path $cefKey -Name 'No Cef' -Value 1 -Type DWord -ErrorAction Stop
      $cefChanged = $true
      Log ("No Cef 已临时设为 1（原值: $cefOriginal）")
    } catch { Log ("警告：无法设置 No Cef: " + $_.Exception.Message) }
  } else {
    try { $g = Get-ItemProperty -Path $cefKey -ErrorAction Stop; Log ("当前 No Cef = " + $g.'No Cef' + "（未修改）") } catch {}
  }

  $apValue = $null
  switch($StepAP) {
    '203' { $apValue = 0 }
    '214' { $apValue = 1 }
    '242' { $apValue = 2 }
    default { $apValue = $null }
  }

  Log "启动 SolidWorks COM 实例（冷启动可能 1-5 分钟）..."
  $startSw = [System.Diagnostics.Stopwatch]::StartNew()
  $hb = [System.Threading.Timer]::new({ param($s) [Console]::WriteLine(("[{0}] 仍在启动 SolidWorks... 已耗时 {1:N0}s" -f (Get-Date -Format 'HH:mm:ss'), $s.Elapsed.TotalSeconds)) }, $startSw, 15000, 15000)

  $sw = $null
  try {
    $sw = New-Object -ComObject SldWorks.Application
  } catch {
    $hb.Dispose()
    Log ("创建 SolidWorks 实例失败: " + $_.Exception.Message)
    if($_.Exception.InnerException) { Log ("  内层异常: " + $_.Exception.InnerException.Message) }
    throw $_
  }

  $ready = $false
  $deadline = (Get-Date).AddSeconds($StartupTimeoutSec)
  $rev = ""
  while((Get-Date) -lt $deadline) {
    try { $rev = $sw.RevisionNumber(); if($rev) { $ready = $true; break } } catch { }
    Start-Sleep -Seconds 3
  }
  $hb.Dispose()
  $startSw.Stop()
  if(-not $ready) { throw ("SolidWorks 启动超时（" + $StartupTimeoutSec + "s），进程可能卡住，请结束 SLDWORKS.exe 后重试") }
  Log ("SolidWorks 就绪，版本 " + $rev + "（启动耗时 " + [int]$startSw.Elapsed.TotalSeconds + "s）")

  try { $sw.Visible = $false } catch { }

  $curStepAP = 0
  try { $curStepAP = $sw.GetUserPreferenceIntegerValue(75) } catch {}
  if($null -eq $apValue) { $useAP = $curStepAP } else { $useAP = $apValue }
  $apNames = @('AP203','AP214','AP242')
  $apName = $apNames[$useAP]
  if($null -eq $apName) { $apName = "值$useAP" }
  try {
    [void]$sw.SetUserPreferenceIntegerValue(75, $useAP)
    [void]$sw.SetUserPreferenceToggle(787, $true)
    [void]$sw.SetUserPreferenceToggle(786, $false)
    [void]$sw.SetUserPreferenceToggle(397, $true)
    [void]$sw.SetUserPreferenceToggle(396, $true)
    [void]$sw.SetUserPreferenceToggle(497, $true)
    Log ("STEP 导出偏好已设置（swStepAP=$useAP -> $apName，外观=开，AtomicSave=关）")
  } catch { Log ("设置偏好警告: " + $_.Exception.Message) }

  Log "打开装配体: $InputPath"
  $errs = 0; $warns = 0
  $doc = $sw.OpenDoc6($InputPath, 2, 1, "", [ref]$errs, [ref]$warns)
  if(-not $doc) { throw "OpenDoc6 失败 errors=$errs warnings=$warns" }
  Log ("已打开: " + $doc.GetTitle() + "  errors=$errs warnings=$warns")

  Log ("导出 STEP: $OutputPath")
  $expSw = [System.Diagnostics.Stopwatch]::StartNew()
  $hb2 = [System.Threading.Timer]::new({ param($s) [Console]::WriteLine(("[{0}] 导出进行中... 已耗时 {1:N0}s" -f (Get-Date -Format 'HH:mm:ss'), $s.Elapsed.TotalSeconds)) }, $expSw, 15000, 15000)
  $saveErrs = 0; $saveWarns = 0
  $ok = $false
  try {
    $ok = $doc.Extension.SaveAs($OutputPath, 0, 1, $null, [ref]$saveErrs, [ref]$saveWarns)
  } finally { $hb2.Dispose() }
  $expSw.Stop()
  if(-not $ok) { throw "SaveAs 失败 errors=$saveErrs warnings=$saveWarns" }
  $elapsed = $expSw.Elapsed.TotalSeconds

  if(Test-Path -LiteralPath $OutputPath) {
    $len = (Get-Item -LiteralPath $OutputPath).Length
    Log ("导出完成: {0:N2} MB，耗时 {1:N1}s" -f ($len/1MB), $elapsed)
    try {
      $head = [System.IO.File]::ReadAllText($OutputPath).Substring(0, [Math]::Min(20000, $len))
      $schema = ([regex]::Match($head, "FILE_SCHEMA\s*\(\s*'([^']+)'")).Groups[1].Value
      $hasColor = $head -match "COLOUR_RGB|SURFACE_STYLE|PRESENTATION_STYLE"
      Log ("校验: FILE_SCHEMA=$schema  /  含颜色定义=" + ($hasColor))
      if($schema -ne 'AUTOMOTIVE_DESIGN') { Log "警告：输出不是 AP214，实际为 $schema" }
    } catch { Log ("校验警告: " + $_.Exception.Message) }
  } else {
    Log "SaveAs 返回成功但未找到输出文件"
  }

  try { $sw.CloseDoc($doc.GetTitle()) } catch {}
  if(-not $KeepOpen) { Log "退出 SolidWorks..."; try { $sw.ExitApp() } catch {} } else { Log "保留 SolidWorks 实例（KeepOpen）" }

  if($cefChanged) { try { Set-ItemProperty -Path $cefKey -Name 'No Cef' -Value $cefOriginal -Type DWord -ErrorAction Stop; Log ("No Cef 已恢复为 $cefOriginal") } catch {} }

  Log "DONE"

} catch {
  Log "FATAL: " + $_.Exception.Message
  if($_.Exception.InnerException) { Log "  InnerException: " + $_.Exception.InnerException.Message }
  Log ("  Stack: " + $_.ScriptStackTrace)
} finally {
  try { Stop-Transcript -ErrorAction SilentlyContinue } catch {}
}