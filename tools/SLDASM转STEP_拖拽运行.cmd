@echo off
setlocal EnableExtensions
if "%~1"=="" (
  echo 用法：把一个 .SLDASM 文件拖到这个 .cmd 上。
  echo Usage: drag a .SLDASM file onto this .cmd file.
  pause
  exit /b 1
)
echo Input: %~1
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0export_sldasm.ps1" -InputPath "%~1"
echo.
echo ---- script exit code: %ERRORLEVEL% ----
pause