@echo off
rem ============================================================
rem  NapCat one-click installer (download only, no redistribution)
rem  Tianshu QQ Bridge companion tool
rem
rem  IMPORTANT - ASCII ONLY.
rem  This file is saved as UTF-8 but cmd.exe reads it under the
rem  system code page (GBK). Any non-ASCII byte here would be
rem  mis-decoded and break execution. Keep it pure ASCII.
rem ============================================================
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1

echo ============================================
echo   NapCat one-click installer
echo ============================================
echo.
echo DISCLAIMER / read this first:
echo   This script only DOWNLOADS a community-maintained backup
echo   build of NapCat from third-party GitHub mirrors. It does
echo   NOT bundle, host or redistribute NapCat itself.
echo.
echo   - NapCat is NOT an official Tencent product.
echo   - The upstream project announced "Ending"; official
echo     downloads are gone. These mirrors are unofficial.
echo   - Using a non-official QQ client violates the QQ ToS and
echo     carries account risk (rate-limit / ban). USE A BURNER
echo     ACCOUNT, never your main account.
echo   - The mirrors are maintained by third parties and are not
echo     verified by this project. Review the source before use.
echo.
echo   By continuing you accept these risks yourself.
echo.
pause

rem ---------- configurable ----------
if "%~1"=="" (
  set "DEST=D:\NapCat"
) else (
  set "DEST=%~1"
)

rem Mirror list. Override the primary with env NAPCAT_MIRROR.
rem NOTE: only Creep-debug currently publishes a NapCat.Framework.zip.
rem Other forks kept their source but no release assets, so listing them
rem would only create dead links. Add your own mirror via NAPCAT_MIRROR.
set "MIRRORS="
if defined NAPCAT_MIRROR set "MIRRORS=!NAPCAT_MIRROR!"
set "MIRRORS=!MIRRORS! https://github.com/Creep-debug/NapCatQQ/releases/download/release/NapCat.Framework.zip"

rem ---------- env checks ----------
echo.
echo [1/5] Checking environment...

where curl >nul 2>&1
if errorlevel 1 (
  echo [ERROR] curl not found. Windows 10 1803+ ships curl.exe.
  echo         Update Windows or install curl manually.
  goto :fail
)
echo   curl: ok

where powershell >nul 2>&1
if errorlevel 1 (
  echo [ERROR] powershell not found. Needed to unzip.
  goto :fail
)
echo   powershell: ok

rem NapCat injects into QQ, so QQ must exist.
set "QQFOUND="
for %%P in (
  "C:\Program Files\Tencent\QQNT\QQ.exe"
  "C:\Program Files (x86)\Tencent\QQNT\QQ.exe"
) do (
  if exist %%P set "QQFOUND=%%~P"
)
if not defined QQFOUND (
  echo [WARN] QQ.exe not found in the usual locations.
  echo        NapCat injects into QQ, so install QQ NT first.
  echo        Continue anyway? Press Ctrl+C to abort.
  pause
) else (
  echo   QQ: !QQFOUND!
)

rem ---------- download ----------
echo.
echo [2/5] Downloading NapCat.Framework.zip ...
if not exist "%DEST%" mkdir "%DEST%" 2>nul
set "ZIP=%DEST%\NapCat.Framework.zip"
set "GOT="

for %%U in (!MIRRORS!) do (
  if not defined GOT (
    echo   trying: %%U
    curl -sL --fail --no-progress-meter --connect-timeout 15 --max-time 900 --retry 2 -o "%ZIP%.part" "%%U"
    if exist "%ZIP%.part" (
      for %%S in ("%ZIP%.part") do set "SZ=%%~zS"
      if !SZ! GTR 1048576 (
        move /y "%ZIP%.part" "%ZIP%" >nul
        echo   downloaded: !SZ! bytes
        set "GOT=1"
      ) else (
        echo   [WARN] file too small, trying next mirror
        del /q "%ZIP%.part" 2>nul
      )
    ) else (
      echo   [WARN] download failed, trying next mirror
    )
  )
)

if not defined GOT (
  echo [ERROR] All mirrors failed.
  echo.
  echo   GitHub release downloads are often unstable on some networks.
  echo   Options:
  echo     1) Retry later, or use a proxy / VPN.
  echo     2) Download manually in a browser from:
  echo        https://github.com/Creep-debug/NapCatQQ/releases
  echo        then unzip so that napimain.exe sits in a folder, and
  echo        point onebot.napcatRoot at it in bridge.config.json.
  echo     3) Use your own mirror:
  echo        set NAPCAT_MIRROR=https://your.mirror/NapCat.Framework.zip
  echo        then run this script again.
  goto :fail
)

rem ---------- verify zip ----------
echo.
echo [3/5] Verifying archive...
for %%S in ("%ZIP%") do set "ZIPSZ=%%~zS"
if !ZIPSZ! LSS 1048576 (
  echo [ERROR] Archive looks truncated: !ZIPSZ! bytes
  goto :fail
)
powershell -NoProfile -Command "$ErrorActionPreference='Stop'; Add-Type -A System.IO.Compression.FileSystem; try { $z=[IO.Compression.ZipFile]::OpenRead('%ZIP%'); Write-Host ('  entries: ' + $z.Entries.Count); $z.Dispose(); exit 0 } catch { Write-Host ('  [ERROR] not a valid zip: ' + $_.Exception.Message); exit 1 }"
if errorlevel 1 goto :fail
echo   archive: ok

rem ---------- extract ----------
echo.
echo [4/5] Extracting to %DEST%\NapCat.Framework ...
if exist "%DEST%\NapCat.Framework" (
  echo   [WARN] target already exists.
  echo         Rename or delete it if you want a clean install.
  pause
)
powershell -NoProfile -Command "$ErrorActionPreference='Stop'; Expand-Archive -Path '%ZIP%' -DestinationPath '%DEST%' -Force; exit 0"
if errorlevel 1 (
  echo [ERROR] extraction failed.
  goto :fail
)
echo   extracted.

rem ---------- locate ----------
echo.
echo [5/5] Locating napimain.exe ...
set "ROOT="
if exist "%DEST%\NapCat.Framework\napimain.exe" set "ROOT=%DEST%\NapCat.Framework"
if not defined ROOT if exist "%DEST%\napimain.exe" set "ROOT=%DEST%"

if not defined ROOT (
  echo [WARN] Could not find napimain.exe. Check the folder structure:
  dir /b "%DEST%"
  goto :done
)
echo   found: %ROOT%\napimain.exe

rem ---------- next steps ----------
echo.
echo ============================================
echo   Done. Next steps:
echo ============================================
echo   1. Launch:  %ROOT%\napiLoader.bat
echo      (a QQ window opens; scan the QR with a BURNER account)
echo   2. Open WebUI: http://127.0.0.1:6099
echo      token is in: %ROOT%\config\webui.json
echo   3. Add a WebSocket server: 127.0.0.1 : 3001
echo      copy its token into bridge.config.json (onebot.accessToken)
echo   4. Start the bridge:  npm run launch
echo.
echo   Note: WebUI port 6099 and WS port 3001 are the defaults
echo         this bridge expects. Change both sides if you differ.
echo.
goto :done

:fail
echo.
echo [FAILED] see messages above.
endlocal
exit /b 1

:done
echo.
endlocal
exit /b 0
