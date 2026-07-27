@echo off
REM PARTISANS Ads Hub — WATCHDOG launcher
REM Runs server.js in an infinite loop. If node.exe dies for any reason
REM (crash, OOM kill, manual stop), this script restarts it after 5 seconds.
REM Every restart is logged to watchdog.log so you can see how often it dies.
cd /d "%~dp0"
set PORT=3003

:loop
echo [%date% %time%] starting server >> watchdog.log
"C:\Program Files\nodejs\node.exe" server.js
echo [%date% %time%] server exited (code %ERRORLEVEL%) - restarting in 5s >> watchdog.log
timeout /t 5 /nobreak >nul
goto loop
