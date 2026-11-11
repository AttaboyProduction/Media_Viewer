@echo off
setlocal
cd /d "%~dp0.."

set "PY=.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

echo [order-tests] backend unittest (order islands)...
"%PY%" -m unittest tests.test_order_islands -v
if errorlevel 1 exit /b 1

echo [order-tests] backend unittest (viewer media list)...
"%PY%" -m unittest tests.test_media_list -v
if errorlevel 1 exit /b 1

echo [order-tests] backend unittest (tag multi-groups)...
"%PY%" -m unittest tests.test_tag_multi_groups -v
if errorlevel 1 exit /b 1

echo [order-tests] frontend rowReorder selftest...
pushd frontend
call npx --yes tsx src/utils/rowReorder.selftest.ts
set "FE_ERR=%ERRORLEVEL%"
if not "%FE_ERR%"=="0" goto frontend_done

echo [order-tests] frontend pagination selftest...
call npx --yes tsx src/utils/pagination.selftest.ts
set "FE_ERR=%ERRORLEVEL%"
if not "%FE_ERR%"=="0" goto frontend_done

echo [order-tests] frontend pageSizeOptions selftest...
call npx --yes tsx src/utils/pageSizeOptions.selftest.ts
set "FE_ERR=%ERRORLEVEL%"
:frontend_done
popd
if not "%FE_ERR%"=="0" exit /b %FE_ERR%

echo [order-tests] all passed
exit /b 0
