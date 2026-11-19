@echo off
REM Starts THE GOAT live fixtures server. Keep this window open during the tournament.
REM Phones on the same Wi-Fi use the "On Wi-Fi" address printed below.
cd /d "%~dp0"
title THE GOAT - live fixtures server
node wifi-server.js
echo.
echo Server stopped.
pause
