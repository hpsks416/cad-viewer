@echo off
setlocal
title RoboMaster Sim (merged launch)
cd /d "%~dp0"

set "ROOT=%CD%"

rem Locate the daedalus simulator directory (../../simulator_source/daedalus-*/simulator).
set "SIM="
pushd "%ROOT%\..\..\simulator_source" 2>nul
if not errorlevel 1 (
  for /d %%d in (daedalus-*) do if not defined SIM if exist "%%d\simulator\run_host.bat" set "SIM=%%~fd\simulator"
  popd
)
if not defined SIM (
  echo [ERROR] daedalus simulator not found under ..\..\simulator_source\daedalus-*\simulator
  echo         Adjust the path in this script if the source lives elsewhere.
  pause
  exit /b 1
)

set "BRIDGE=%ROOT%\sim_console\bridge.py"
set "CONFIG=%ROOT%\sim_console\simulator-config.json"

rem Auto-locate Python.
set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY where py >nul 2>nul && set "PY=py -3"
if not defined PY (
  echo [ERROR] Python not found.
  pause
  exit /b 1
)

echo Found simulator: %SIM%
echo Config: %CONFIG%

rem Kill any old daedalus (7666/7667) + bridge (8124) to avoid "address already in use".
for %%p in (7666 7667 8124) do (
  for /f "tokens=5" %%q in ('netstat -ano ^| findstr :%%p ^| findstr LISTENING') do (
    taskkill /F /PID %%q >nul 2>nul
  )
)

rem Set config path so the started daedalus window inherits it.
set "DAEDALUS_CONFIG_PATH=%CONFIG%"

echo [1/3] Building + starting daedalus (first build slow, later incremental)...
start "daedalus-simulator" /min /d "%SIM%" cmd /k run_host.bat

echo [2/3] Starting bridge ...
start "sim-bridge" /min /d "%ROOT%" cmd /k %PY% "%BRIDGE%"

echo [3/3] Opening console ...
start "" "http://127.0.0.1:8124/"

echo.
echo Started:
echo   daedalus-simulator : TCP 7666 (image) / 7667 (command)
echo   sim-bridge         : http://127.0.0.1:8124/
echo   browser console    : http://127.0.0.1:8124/
echo   config node editor : http://127.0.0.1:8124/config.html
echo.
echo Close each window to stop the corresponding service.
pause
