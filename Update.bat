@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

rem Fetch the latest project files, then relaunch so the VERSION gate can rebuild.
rem Prefer git pull when this folder is a clone; otherwise download the GitHub ZIP.
rem Preserves local data\, media\, .venv\, and other machine-only folders.

set "REPO_OWNER=AttaboyProduction"
set "REPO_NAME=Media_Viewer"
set "REPO_BRANCH=main"
set "ZIP_URL=https://github.com/%REPO_OWNER%/%REPO_NAME%/archive/refs/heads/%REPO_BRANCH%.zip"

echo.
echo === Scrap Download update ===
echo.

if exist "%~dp0.git\" (
  echo Detected git clone. Pulling %REPO_BRANCH%...
  where git >nul 2>&1
  if errorlevel 1 (
    echo git was not found on PATH. Install Git for Windows, or delete the .git folder
    echo and run Update.bat again to use the ZIP download path.
    goto :fail
  )
  git -C "%~dp0" pull --ff-only origin %REPO_BRANCH%
  if errorlevel 1 (
    echo.
    echo git pull failed. Fix conflicts or network access, then try again.
    goto :fail
  )
  goto :relaunch
)

echo No .git folder. Downloading ZIP from GitHub...
echo %ZIP_URL%
echo.
echo Note: private repositories require a git clone ^(with your login^) instead of ZIP.
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
  echo ZIP update failed. If the repo is private, clone it with Git and use Update.bat
  echo from that clone ^(git pull^), or download ZIP while signed in via the GitHub UI.
  goto :fail
)

:relaunch
echo.
echo Relaunching so a new VERSION can force pip / frontend rebuild if needed...
call "%~dp0Run.bat" restart
exit /b %ERRORLEVEL%

:fail
echo.
echo Update failed.
pause
exit /b 1
