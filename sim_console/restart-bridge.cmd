@echo off
setlocal
cd /d "%~dp0"

rem Kill any old bridge holding 8124 first (avoids "address already in use")
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :8124 ^| findstr LISTENING') do (
  taskkill /F /PID %%p >nul 2>nul
)

rem Locate Python
set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY where py >nul 2>nul && set "PY=py -3"
if not defined PY (
  echo [ERROR] Python not found.
  pause
  exit /b 1
)

echo Bridge starting on http://127.0.0.1:8124/  (close this window to stop)
%PY% bridge.py
