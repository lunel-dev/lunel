@echo off
setlocal
pwsh -NoProfile -File "%~dp0install-remote-cli-autostart.ps1" install-boot-elevated
endlocal
