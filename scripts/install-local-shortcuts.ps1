[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('install', 'remove', 'list')]
  [string]$Action = 'install',
  [string]$TargetFolder = ([Environment]::GetFolderPath('Desktop'))
)

$ErrorActionPreference = 'Stop'

$ShortcutDefinitions = @(
  @{
    Name = 'Lunel Local Start.lnk'
    Target = 'start-local-stack.cmd'
    Description = 'Start the local Lunel manager and proxy stack.'
  }
  @{
    Name = 'Lunel Local CLI.lnk'
    Target = 'open-local-cli.cmd'
    Description = 'Open a Lunel CLI dev window with local loopback env.'
  }
  @{
    Name = 'Lunel Local App.lnk'
    Target = 'open-local-app.cmd'
    Description = 'Open a Lunel Expo app window with local loopback env.'
  }
  @{
    Name = 'Lunel Local Stop.lnk'
    Target = 'stop-local-stack.cmd'
    Description = 'Stop the local Lunel manager and proxy stack.'
  }
  @{
    Name = 'Lunel LAN Start.lnk'
    Target = 'start-local-lan-stack.cmd'
    Description = 'Start the Lunel manager and proxy stack for phone/LAN testing.'
  }
  @{
    Name = 'Lunel LAN CLI.lnk'
    Target = 'open-local-lan-cli.cmd'
    Description = 'Open a Lunel CLI dev window with LAN env injected.'
  }
  @{
    Name = 'Lunel LAN App.lnk'
    Target = 'open-local-lan-app.cmd'
    Description = 'Open a Lunel Expo app window with LAN env injected.'
  }
  @{
    Name = 'Lunel LAN Stop.lnk'
    Target = 'stop-local-lan-stack.cmd'
    Description = 'Stop the Lunel LAN manager and proxy stack.'
  }
  @{
    Name = 'Lunel LAN Firewall.lnk'
    Target = 'install-local-lan-firewall.cmd'
    Description = 'Request admin rights and allow the Lunel LAN and Expo ports through Windows Firewall.'
  }
)

$ScriptRootPath = $PSScriptRoot
$RepoRoot = Split-Path -Path $PSScriptRoot -Parent
$CmdIcon = Join-Path $env:SystemRoot 'System32\cmd.exe'

function Write-Step {
  param([string]$Message)
  Write-Host "[local-shortcuts] $Message"
}

function Ensure-TargetFolder {
  if (-not (Test-Path -LiteralPath $TargetFolder)) {
    New-Item -ItemType Directory -Path $TargetFolder -Force | Out-Null
  }
}

function Get-ShortcutPath {
  param([string]$Name)

  return Join-Path $TargetFolder $Name
}

function New-Shortcut {
  param([hashtable]$Definition)

  $shortcutPath = Get-ShortcutPath -Name $Definition.Name
  $targetPath = Join-Path $ScriptRootPath $Definition.Target
  if (-not (Test-Path -LiteralPath $targetPath)) {
    throw "Shortcut target not found: $targetPath"
  }

  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $targetPath
  $shortcut.WorkingDirectory = $RepoRoot
  $shortcut.Description = $Definition.Description
  $shortcut.IconLocation = $CmdIcon
  $shortcut.Save()

  Write-Step "installed $shortcutPath -> $targetPath"
}

function Remove-Shortcut {
  param([hashtable]$Definition)

  $shortcutPath = Get-ShortcutPath -Name $Definition.Name
  if (Test-Path -LiteralPath $shortcutPath) {
    Remove-Item -LiteralPath $shortcutPath -Force
    Write-Step "removed $shortcutPath"
    return
  }

  Write-Step "missing $shortcutPath"
}

function Show-Shortcuts {
  $shell = New-Object -ComObject WScript.Shell
  foreach ($definition in $ShortcutDefinitions) {
    $shortcutPath = Get-ShortcutPath -Name $definition.Name
    if (-not (Test-Path -LiteralPath $shortcutPath)) {
      Write-Step "missing $shortcutPath"
      continue
    }

    $shortcut = $shell.CreateShortcut($shortcutPath)
    Write-Step "$shortcutPath -> target=$($shortcut.TargetPath) workdir=$($shortcut.WorkingDirectory)"
  }
}

Ensure-TargetFolder

switch ($Action) {
  'install' {
    foreach ($definition in $ShortcutDefinitions) {
      New-Shortcut -Definition $definition
    }
    Show-Shortcuts
  }
  'remove' {
    foreach ($definition in $ShortcutDefinitions) {
      Remove-Shortcut -Definition $definition
    }
  }
  'list' {
    Show-Shortcuts
  }
}
