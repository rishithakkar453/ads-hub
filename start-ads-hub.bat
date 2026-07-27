@echo off
REM PARTISANS Ads Hub launcher
REM Double-click to start the tool, or this is called by Windows on login.
cd /d "%~dp0"
set PORT=3003
"C:\Program Files\nodejs\node.exe" server.js
pause
