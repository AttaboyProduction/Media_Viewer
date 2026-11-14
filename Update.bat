@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem Download the latest main ZIP from GitHub and merge into this folder.
rem Does not start or restart the app. Preserves local data\, media\, .venv\, etc.
rem Run Run.bat afterward so a new VERSION can force pip / frontend rebuild if needed.

rem If this bat is overwritten mid-run, cmd re-reads the new file and breaks
rem (e.g. 'P'' is not recognized). Always continue from a TEMP copy.
if /I not "%~1"=="--from-temp" (
  set "RUNNER=%TEMP%\scrap_download_update_runner_%RANDOM%"
  mkdir "%RUNNER%" 2>nul
  copy /Y "%~f0" "%RUNNER%\Update.bat" >nul
  if not exist "%~dp0scripts\update_from_github.ps1" (
    echo Missing scripts\update_from_github.ps1
    pause
    exit /b 1
  )
  copy /Y "%~dp0scripts\update_from_github.ps1" "%RUNNER%\update_from_github.ps1" >nul
  call "%RUNNER%\Update.bat" --from-temp "%CD%" "%RUNNER%"
  set "EXITCODE=%ERRORLEVEL%"
  rd /s /q "%RUNNER%" 2>nul
  exit /b %EXITCODE%
)

set "ROOT=%~2"
set "RUNNER=%~3"
if not defined ROOT set "ROOT=%CD%"

set "REPO_OWNER=AttaboyProduction"
set "REPO_NAME=Media_Viewer"
set "REPO_BRANCH=main"
set "ZIP_URL=https://github.com/%REPO_OWNER%/%REPO_NAME%/archive/refs/heads/%REPO_BRANCH%.zip"

echo.
echo === Scrap Download update ===
echo.
echo Downloading ZIP from GitHub...
echo %ZIP_URL%
echo.
echo Note: private repositories need a signed-in GitHub session or a public repo.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%RUNNER%\update_from_github.ps1" -ZipUrl "%ZIP_URL%" -Root "%ROOT%"
if errorlevel 1 goto :fail

echo.
echo Update finished. This script does not start the app.
echo Run Run.bat when you want to launch ^(it rebuilds if VERSION changed^).
echo.
exit /b 0

:fail
echo.
echo ZIP update failed. For a private repo, download the ZIP while signed in
echo through the GitHub website, or make the repo public.
echo.
echo Update failed.
pause
exit /b 1
