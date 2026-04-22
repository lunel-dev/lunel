@echo off
setlocal
where pwsh.exe >nul 2>nul
if errorlevel 1 (
  echo pwsh.exe not found in PATH. Install PowerShell 7 first.
  pause
  exit /b 1
)
set "SCRIPT_DIR=%~dp0"
pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%local-dev.ps1" start -FreshManager -HostAddress auto %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo start-local-lan-stack failed with exit code %EXIT_CODE%.
  pause
)
exit /b %EXIT_CODE%
