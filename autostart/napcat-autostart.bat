@echo off
rem NapCat autostart (silent, minimized) - Tianshu 2026-11-11
rem ASCII-ONLY. Do NOT put Chinese literals in this file: the file is saved
rem as UTF-8 but cmd.exe reads it under the system code page (GBK), so any
rem non-ASCII byte here would be mis-decoded and break path resolution.
rem Project root is derived from this script's own location (%~dp0..), so the
rem Chinese folder name never appears as a literal.

rem Self-minimize when launched from the Run key: restart ourselves minimized.
if not "%~1"=="min" (
    start /min "" "%~f0" min
    exit /b 0
)

chcp 65001 >nul 2>&1

rem Go to project root (parent of autostart\).
pushd "%~dp0.." || (
    echo [%date% %time%] PUSHD_FAIL "%~dp0.." > "%~dp0last-run.log"
    exit /b 1
)

set "LOG=%~dp0last-run.log"
echo [%date% %time%] autostart begin, cwd=%CD% > "%LOG%"

if not exist "src\launch.js" (
    echo [%date% %time%] MISSING src\launch.js >> "%LOG%"
    popd & exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
    echo [%date% %time%] MISSING node.exe >> "%LOG%"
    popd & exit /b 1
)

rem Skip if the bridge is already running (3001 has an ESTABLISHED connection).
netstat -ano | findstr ":3001" | findstr "ESTABLISHED" >nul 2>&1
if not errorlevel 1 (
    echo [%date% %time%] bridge already running, skip >> "%LOG%"
    popd & exit /b 0
)

echo [%date% %time%] launching node src\launch.js >> "%LOG%"
node src\launch.js >> "%LOG%" 2>&1
set "CODE=%ERRORLEVEL%"
echo [%date% %time%] launch.js exited code=%CODE% >> "%LOG%"
popd
exit /b %CODE%
