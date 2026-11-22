@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

rem Stop the normal MediaViewer server/tray, then start uvicorn on all interfaces
rem so a phone on the same Wi-Fi can open http://<this-pc-lan-ip>:8000
rem Console stays open (Ctrl+C to stop). Use Run.bat afterward for the normal tray app.

echo Stopping anything on port 8000 / MediaViewer launcher...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$root = (Resolve-Path '.').Path;" ^
  "Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -and $_.OwningProcess -gt 0 } | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue };" ^
  "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^python(w)?\.exe$' -and $_.CommandLine -and ($_.CommandLine -like \"*$root*launcher.py*\" -or $_.CommandLine -like \"*$root*uvicorn*backend.app.main*\") } | ForEach-Object { if ($_.ProcessId -gt 0) { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }"

powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 2"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "for ($i=0; $i -lt 30; $i++) { $c = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue; if (-not $c) { exit 0 }; Start-Sleep -Milliseconds 200 }; exit 0"

if not exist "%~dp0.venv\Scripts\python.exe" (
  echo Missing .venv - run Run.bat once first to install dependencies.
  pause
  exit /b 1
)

echo.
echo LAN addresses for this PC (open one on your phone, same Wi-Fi):
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } | ForEach-Object { Write-Host ('  http://{0}:8000' -f $_.IPAddress) }"
echo.
echo If Windows Firewall prompts, allow Python/port 8000 on private networks.
echo Press Ctrl+C to stop. Afterward, use Run.bat for the normal app.
echo.

"%~dp0.venv\Scripts\python.exe" -m uvicorn backend.app.main:app --host 0.0.0.0 --port 8000
set "EC=%ERRORLEVEL%"
echo.
echo Server exited with code %EC%.
pause
exit /b %EC%