@echo off
rem SPDX-License-Identifier: Apache-2.0
rem FontFox dev launcher: ASCII-only on purpose (cmd.exe codepage safe).
rem All user-facing text lives in dev.ps1 (UTF-8 with BOM).
setlocal
cd /d "%~dp0"
title FontFox dev mode

where pwsh >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dev.ps1"
) else (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0dev.ps1"
)

if errorlevel 1 (
  echo.
  echo Launcher exited with an error. See messages above.
  pause
)
