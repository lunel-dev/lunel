@echo off
setlocal
pwsh -NoProfile -File "%~dp0remote-cli.ps1" stop
endlocal
