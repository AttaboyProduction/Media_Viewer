@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

rem Download the latest main ZIP from GitHub and merge into this folder.
rem Does not start or restart the app. Preserves local data\, media\, .venv\, etc.
rem Run Run.bat afterward so a new VERSION can force pip / frontend rebuild if needed.

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

set "TMP=%TEMP%\scrap_download_update_%RANDOM%"
set "ZIP=%TMP%\source.zip"
mkdir "%TMP%" 2>nul

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop';" ^
  "$zipUrl = '%ZIP_URL%';" ^
  "$zipPath = '%ZIP%';" ^
  "$tmp = '%TMP%';" ^
  "$root = (Resolve-Path '%~dp0').Path;" ^
  "Write-Host 'Downloading...';" ^
  "Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing;" ^
  "Write-Host 'Extracting...';" ^
  "Expand-Archive -Path $zipPath -DestinationPath $tmp -Force;" ^
  "$inner = Get-ChildItem -Path $tmp -Directory | Select-Object -First 1;" ^
  "if (-not $inner) { throw 'ZIP had no top-level folder' };" ^
  "$src = $inner.FullName;" ^
  "$exclude = @('data', 'media', '.venv', 'venv', 'node_modules', 'frontend\dist', 'downloads', 'downloaded_content', 'backup');" ^
  "Write-Host ('Merging into ' + $root);" ^
  "Get-ChildItem -Path $src -Force | ForEach-Object {" ^
  "  if ($exclude -contains $_.Name) { return };" ^
  "  $dest = Join-Path $root $_.Name;" ^
  "  if ($_.PSIsContainer) {" ^
  "    robocopy $_.FullName $dest /E /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null;" ^
  "    if ($LASTEXITCODE -ge 8) { throw ('robocopy failed for ' + $_.Name + ' code ' + $LASTEXITCODE) };" ^
  "    $global:LASTEXITCODE = 0;" ^
  "  } else {" ^
  "    Copy-Item -LiteralPath $_.FullName -Destination $dest -Force;" ^
  "  }" ^
  "};" ^
  "Write-Host 'Files updated.';" ^
  "Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue"

if errorlevel 1 (
  echo.
  echo ZIP update failed. If the repo is private, download the ZIP while signed in
  echo via the GitHub UI, or make the repo public.
  goto :fail
)

echo.
echo Update finished. This script does not start the app.
echo Run Run.bat when you want to launch ^(it rebuilds if VERSION changed^).
echo.
exit /b 0

:fail
echo.
echo Update failed.
pause
exit /b 1
