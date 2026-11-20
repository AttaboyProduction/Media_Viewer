@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem Restart the running app (same as Run.bat restart / in-app Reload).
rem Does not download from GitHub and does not overwrite local files.
rem Use Update.bat when you want a ZIP merge from GitHub main.

if not exist "%~dp0Run.bat" (
  echo Missing Run.bat next to Restart.bat
  pause
  exit /b 1
)

call "%~dp0Run.bat" restart
exit /b %ERRORLEVEL%
