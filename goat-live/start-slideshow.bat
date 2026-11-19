@echo off
REM Opens the ads slideshow fullscreen in Chrome WITH SOUND (no click needed).
REM Uses its own Chrome profile so the sound flag works even if Chrome is already open.
REM Press Alt+F4 to close. Run start-server.bat (node wifi-server.js) first.
set URL=http://localhost:3000/ads
if not "%~1"=="" set URL=%~1
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --autoplay-policy=no-user-gesture-required --user-data-dir="%~dp0data\kiosk-profile" --no-first-run "%URL%"
