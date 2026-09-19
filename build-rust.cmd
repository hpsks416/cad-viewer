@echo off
setlocal enabledelayedexpansion
rem ============================================================
rem  ?? Rust ?????cad-viewer-server.exe?
rem  ???? Windows ???????????????Codex ???
rem  ? schannel ???????? tools\crates_mirror.py ???????
rem ============================================================

rem 1) ?? rustup ? cargo/rustc ? PATH ?
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

rem 2) ? vswhere ???? Visual Studio???? MSVC ?????
set "VSW=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
set "VCVARS="
if exist "%VSW%" (
    for /f "usebackq delims=" %%I in (`"%VSW%" -latest -products * -property installationPath`) do set "VCVARS=%%I\VC\Auxiliary\Build\vcvars64.bat"
)
if not defined VCVARS goto :novs
if not exist "%VCVARS%" goto :novs

echo [INFO] MSVC: %VCVARS%
call "%VCVARS%" >nul

rem 3) ?? rust-server ???
cd /d "%~dp0rust-server"
echo [INFO] cargo build --release ...
cargo build --release
if errorlevel 1 (
    echo.
    echo [ERROR] ??????????????? Codex?
    exit /b 1
)

echo.
echo [OK] ????: rust-server\target\release\cad-viewer-server.exe
exit /b 0

:novs
echo [ERROR] ??? Visual Studio 2022/2025 ? vcvars64.bat?
echo         ????????? C++ ???????????
exit /b 1
