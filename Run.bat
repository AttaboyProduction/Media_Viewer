@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

rem Usage:
rem   Run.bat           Start (or open viewer if already running)
rem   Run.bat restart   Kill server/tray, then start without opening a second viewer
rem                     (used by in-app Reload)

if /I "%~1"=="restart" goto :restart
goto :start

:restart
rem Keep the current browser tab or app window; do not open a second viewer.
if not exist "%~dp0data" mkdir "%~dp0data"
echo 1 > "%~dp0data\.skip_open_viewer"
set "SCRAP_SKIP_OPEN_VIEWER=1"

rem -WindowStyle Hidden: Keep Reload quiet when started with CREATE_NO_WINDOW.
powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command ^
  "$root = (Resolve-Path '.').Path;" ^
  "Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -and $_.OwningProcess -gt 0 } | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue };" ^
  "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^python(w)?\.exe$' -and $_.CommandLine -and ($_.CommandLine -like \"*$root*launcher.py*\" -or $_.CommandLine -like \"*$root*uvicorn*backend.app.main*\") } | ForEach-Object { if ($_.ProcessId -gt 0) { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }"

rem Prefer Sleep over timeout: timeout requires a console and fails under CREATE_NO_WINDOW.
powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 2"

rem Wait until port 8000 is free so a relaunch does not hit the "already running" path mid-kill.
powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command ^
  "for ($i=0; $i -lt 30; $i++) { $c = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue; if (-not $c) { exit 0 }; Start-Sleep -Milliseconds 200 }; exit 0"

goto :start

:start
rem Reload / restart set SCRAP_SKIP_OPEN_VIEWER and data\.skip_open_viewer.
rem A normal Run clears a stale skip flag so "already running" still opens the viewer.
set "LAUNCHER_EXTRA="
if /I "%SCRAP_SKIP_OPEN_VIEWER%"=="1" (
  if not exist "%~dp0data" mkdir "%~dp0data"
  echo 1 > "%~dp0data\.skip_open_viewer"
  set "LAUNCHER_EXTRA=--no-open-viewer"
) else if exist "%~dp0data\.skip_open_viewer" (
  del /q "%~dp0data\.skip_open_viewer" >nul 2>&1
)

rem --- Use a healthy project venv if present (handles Yandex/sync copies from other PCs) ---
if exist "%~dp0.venv\Scripts\python.exe" (
  "%~dp0.venv\Scripts\python.exe" -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>&1
  if not errorlevel 1 (
    rem Detach so this console can close; tray/server keep running under pythonw.
    rem /B: no new console (Reload starts us under CREATE_NO_WINDOW).
    if exist "%~dp0.venv\Scripts\pythonw.exe" (
      start "" /B /D "%~dp0" "%~dp0.venv\Scripts\pythonw.exe" "%~dp0launcher.py" %LAUNCHER_EXTRA%
    ) else (
      start "" /B /D "%~dp0" "%~dp0.venv\Scripts\python.exe" "%~dp0launcher.py" %LAUNCHER_EXTRA%
    )
    exit /b 0
  )
  echo Existing .venv is broken or uses a missing Python. Recreating...
  rmdir /s /q "%~dp0.venv" 2>nul
)

set "PY_EXE="

rem --- Prefer py launcher 3.13 / 3.12 / 3.11 ---
where py >nul 2>&1
if not errorlevel 1 (
  for %%V in (3.13 3.12 3.11) do (
    if not defined PY_EXE (
      py -%%V -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>&1
      if not errorlevel 1 (
        for /f "delims=" %%P in ('py -%%V -c "import sys; print(sys.executable)" 2^>nul') do set "PY_EXE=%%P"
      )
    )
  )
)

rem --- Known install locations (skip Microsoft Store stub) ---
if not defined PY_EXE (
  for %%P in (
    "%LocalAppData%\Programs\Python\Python313\python.exe"
    "%LocalAppData%\Programs\Python\Python312\python.exe"
    "%LocalAppData%\Programs\Python\Python311\python.exe"
    "%ProgramFiles%\Python313\python.exe"
    "%ProgramFiles%\Python312\python.exe"
    "%ProgramFiles%\Python311\python.exe"
  ) do (
    if not defined PY_EXE if exist %%~P (
      %%~P -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>&1
      if not errorlevel 1 set "PY_EXE=%%~P"
    )
  )
)

rem --- PATH python, but reject WindowsApps store stub ---
if not defined PY_EXE (
  where python >nul 2>&1
  if not errorlevel 1 (
    for /f "delims=" %%P in ('where python 2^>nul') do (
      if not defined PY_EXE (
        echo %%P | findstr /I /C:"\WindowsApps\" >nul
        if errorlevel 1 (
          %%P -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>&1
          if not errorlevel 1 set "PY_EXE=%%P"
        )
      )
    )
  )
)

rem --- Fresh PC: install Python 3.12 with winget, then rediscover ---
if not defined PY_EXE (
  where winget >nul 2>&1
  if errorlevel 1 (
    echo.
    echo Python 3.11+ is required and winget was not found.
    echo Install "App Installer" from the Microsoft Store, or install Python 3.12 from https://www.python.org/downloads/
    echo Then run Run.bat again.
    goto :fail
  )
  echo Python 3.11+ not found. Installing Python 3.12 via winget (needs network^)...
  winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements --scope user
  if errorlevel 1 (
    echo winget install failed. Install Python 3.12 manually, then run Run.bat again.
    goto :fail
  )
  rem Refresh PATH from the registry (winget often does not update this shell).
  call :refresh_path
  rem Wait briefly for files to appear on disk.
  set "PY_EXE="
  for /L %%I in (1,1,30) do (
    if not defined PY_EXE (
      if exist "%LocalAppData%\Programs\Python\Python312\python.exe" set "PY_EXE=%LocalAppData%\Programs\Python\Python312\python.exe"
      if not defined PY_EXE if exist "%LocalAppData%\Programs\Python\Python313\python.exe" set "PY_EXE=%LocalAppData%\Programs\Python\Python313\python.exe"
      if not defined PY_EXE (
        where py >nul 2>&1
        if not errorlevel 1 (
          py -3.12 -c "import sys" >nul 2>&1
          if not errorlevel 1 (
            for /f "delims=" %%P in ('py -3.12 -c "import sys; print(sys.executable)" 2^>nul') do set "PY_EXE=%%P"
          )
        )
      )
      if not defined PY_EXE timeout /t 1 /nobreak >nul
    )
  )
)

if not defined PY_EXE (
  echo Could not find Python 3.11+ after install. Close this window, open a new one, and run Run.bat again.
  goto :fail
)

echo Using Python: %PY_EXE%
rem First-time path: create venv via console Python, then detach with pythonw.
"%PY_EXE%" "%~dp0launcher.py" --bootstrap-only
if errorlevel 1 goto :fail
if exist "%~dp0.venv\Scripts\pythonw.exe" (
  start "" /B /D "%~dp0" "%~dp0.venv\Scripts\pythonw.exe" "%~dp0launcher.py" %LAUNCHER_EXTRA%
) else if exist "%~dp0.venv\Scripts\python.exe" (
  start "" /B /D "%~dp0" "%~dp0.venv\Scripts\python.exe" "%~dp0launcher.py" %LAUNCHER_EXTRA%
) else (
  start "" /B /D "%~dp0" "%PY_EXE%" "%~dp0launcher.py" %LAUNCHER_EXTRA%
)
exit /b 0

:refresh_path
for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USER_PATH=%%B"
for /f "tokens=2*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "SYS_PATH=%%B"
set "PATH=%LocalAppData%\Programs\Python\Python312;%LocalAppData%\Programs\Python\Python312\Scripts;%LocalAppData%\Programs\Python\Python313;%LocalAppData%\Programs\Python\Python313\Scripts;%USER_PATH%;%SYS_PATH%;%PATH%"
exit /b 0

:fail
echo.
echo Startup failed.
pause
exit /b 1
