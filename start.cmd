@echo off
setlocal
title RoboMaster 3D Viewer
cd /d "%~dp0"

rem Auto-locate Python: prefer "python" on PATH, then the Windows "py" launcher.
set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY where py >nul 2>nul && set "PY=py -3"
if not defined PY (
  echo [ERROR] Python not found. Install Python 3 and add it to PATH,
  echo         or set your interpreter path in tools\config.json.
  echo.
  pause
  exit /b 1
)

echo Starting RoboMaster 3D Viewer ...
echo URL: http://127.0.0.1:8123/
echo Close this window to stop the service.
echo.
%PY% run.py %*

if errorlevel 1 (
  echo.
  echo [ERROR] Launch failed, see above.
  pause
)
