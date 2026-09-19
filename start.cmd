@echo off
setlocal
title RoboMaster 3D Viewer
cd /d "%~dp0"

echo Starting RoboMaster 3D Viewer...
echo URL: http://127.0.0.1:8123/
echo Press Ctrl+C to stop.
echo.

python run.py

echo.
echo Viewer exited. If it failed, check that Python is installed and in PATH.
pause