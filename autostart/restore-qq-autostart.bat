@echo off
rem Restore QQ autostart (original value of HKCU\...\Run\QQNT).
rem Backed up by Tianshu 2026-11-11 before switching to NapCat autostart.
rem ASCII-ONLY: this file is UTF-8 on disk but cmd reads it under the system
rem code page (GBK); non-ASCII bytes here would be mis-decoded.
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v QQNT /t REG_SZ /d "\"C:\Program Files\Tencent\QQNT\QQ.exe\" /background" /f
echo QQ autostart restored.
pause
