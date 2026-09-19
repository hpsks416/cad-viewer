@echo off
reg add "HKCU\SOFTWARE\SolidWorks\SolidWorks 2025\General" /v "No Cef" /t REG_DWORD /d 1 /f
echo.
echo ExitCode=%ERRORLEVEL%   (0 = OK)
pause