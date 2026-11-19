@echo off
REM One-time setup so phones on the academy Wi-Fi can open THE GOAT (port 3000).
REM - Marks the current Wi-Fi as a Private (trusted) network
REM - Allows TCP port 3000 only on Private networks and only from the local network
REM Windows will ask for administrator permission: click Yes.
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-NetConnectionProfile | Where-Object { $_.InterfaceAlias -like 'Wi-Fi*' } | Set-NetConnectionProfile -NetworkCategory Private;" ^
  "Get-NetFirewallRule -DisplayName 'GOAT Fixtures (TCP 3000)' -ErrorAction SilentlyContinue | Remove-NetFirewallRule;" ^
  "New-NetFirewallRule -DisplayName 'GOAT Fixtures (TCP 3000)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -Profile Private -RemoteAddress LocalSubnet | Out-Null;" ^
  "Get-NetConnectionProfile | Format-Table Name, NetworkCategory -AutoSize;" ^
  "Write-Host 'Done. Phones on this Wi-Fi can now open the GOAT pages.' -ForegroundColor Green"
pause
