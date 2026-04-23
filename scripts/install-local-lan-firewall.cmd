@echo off
setlocal
where pwsh.exe >nul 2>nul
if errorlevel 1 (
  echo pwsh.exe not found in PATH. Install PowerShell 7 first.
  pause
  exit /b 1
)
set "SCRIPT_DIR=%~dp0"
set "FIREWALL_SCRIPT=%SCRIPT_DIR%configure-local-lan-firewall.ps1"
pwsh.exe -NoProfile -ExecutionPolicy Bypass -Command "$scriptPath = '%FIREWALL_SCRIPT%'; Start-Process -FilePath 'pwsh.exe' -Verb RunAs -Wait -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File', $scriptPath, 'install')"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo install-local-lan-firewall failed with exit code %EXIT_CODE%.
  pause
)
exit /b %EXIT_CODE%
