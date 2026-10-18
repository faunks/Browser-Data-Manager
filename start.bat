@echo off
rem Double-click launcher. Does the real work in start.ps1 (the bypass flag avoids
rem "running scripts is disabled" errors and the "downloaded from the internet" block).
title Browser Data Manager
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo Browser Data Manager stopped with an error ^(exit code %RC%^).
  pause
)
exit /b %RC%
