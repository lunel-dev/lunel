[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('show', 'cli-exec', 'app-exec', 'cli-shell', 'app-shell', 'cli-run-window', 'app-run-window')]
  [string]$Action = 'show',
  [switch]$SkipEnsureStack,
  [string]$HostAddress = '127.0.0.1',
  [int]$ManagerPort = 8899,
  [int]$ProxyPort = 3000,
  [Parameter()]
  [string]$CommandLine
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Path $PSScriptRoot -Parent
$LocalDevScript = Join-Path $PSScriptRoot 'local-dev.ps1'
$CliRoot = Join-Path $RepoRoot 'cli'
$AppRoot = Join-Path $RepoRoot 'app'
$MinimumNodeMajor = 18
$RuntimeRoot = Join-Path $env:TEMP 'erkai-local-dev'
$RuntimeStatePath = Join-Path $RuntimeRoot 'stack-state.json'

function Write-Step {
  param([string]$Message)
  Write-Host "[local-env] $Message"
}

function Resolve-HostAddress {
  param([string]$InputAddress)

  $raw = if ($InputAddress) { $InputAddress.Trim() } else { '' }
  if (-not $raw -or $raw -ieq 'loopback') {
    return '127.0.0.1'
  }

  if ($raw -ieq 'auto') {
    $primary = Get-NetIPConfiguration |
      Where-Object { $_.IPv4DefaultGateway -and $_.IPv4Address } |
      ForEach-Object { $_.IPv4Address | Select-Object -First 1 } |
      Select-Object -First 1

    if ($primary -and $primary.IPAddress) {
      return $primary.IPAddress
    }

    $fallback = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
      Select-Object -First 1

    if ($fallback -and $fallback.IPAddress) {
      return $fallback.IPAddress
    }

    throw 'Could not auto-detect a LAN IPv4 address. Pass -HostAddress <ipv4> explicitly.'
  }

  return $raw
}

$RequestedManagerPort = $ManagerPort
$RequestedProxyPort = $ProxyPort
$ResolvedHostAddress = Resolve-HostAddress -InputAddress $HostAddress
$ResolvedManagerPort = $RequestedManagerPort
$ResolvedProxyPort = $RequestedProxyPort

function Set-ResolvedEndpoints {
  param(
    [string]$HostAddressValue = $script:ResolvedHostAddress,
    [int]$ManagerPortValue,
    [int]$ProxyPortValue
  )

  if ($HostAddressValue -and $HostAddressValue.Trim()) {
    $script:ResolvedHostAddress = $HostAddressValue.Trim()
  }
  $script:ResolvedManagerPort = $ManagerPortValue
  $script:ResolvedProxyPort = $ProxyPortValue
  $script:ManagerUrl = "http://${script:ResolvedHostAddress}:$ManagerPortValue"
  $script:ProxyUrl = "http://${script:ResolvedHostAddress}:$ProxyPortValue"
}

Set-ResolvedEndpoints -ManagerPortValue $ResolvedManagerPort -ProxyPortValue $ResolvedProxyPort

function Get-RuntimeState {
  if (-not (Test-Path -LiteralPath $RuntimeStatePath)) {
    return $null
  }

  try {
    $raw = Get-Content -LiteralPath $RuntimeStatePath -Raw -ErrorAction Stop
    if (-not $raw) {
      return $null
    }
    return ($raw | ConvertFrom-Json -ErrorAction Stop)
  } catch {
    return $null
  }
}

function Sync-ResolvedEndpointsFromRuntimeState {
  $state = Get-RuntimeState
  if ($null -eq $state) {
    return $false
  }

  $managerPortValue = 0
  $proxyPortValue = 0
  if (
    -not [int]::TryParse([string]$state.managerPort, [ref]$managerPortValue) -or
    -not [int]::TryParse([string]$state.proxyPort, [ref]$proxyPortValue)
  ) {
    return $false
  }

  $hostAddressValue = if ($state.hostAddress) { [string]$state.hostAddress } else { $script:ResolvedHostAddress }
  Set-ResolvedEndpoints -HostAddressValue $hostAddressValue -ManagerPortValue $managerPortValue -ProxyPortValue $proxyPortValue
  return $true
}

function Resolve-CommandToRun {
  param(
    [string]$CommandToRun,
    [string]$DefaultCommand
  )

  if ($CommandToRun -and $CommandToRun.Trim()) {
    return $CommandToRun.Trim()
  }

  return $DefaultCommand
}

function Get-CommandSourceOrThrow {
  param(
    [string]$Name,
    [string]$InstallHint
  )

  try {
    return (Get-Command $Name -ErrorAction Stop).Source
  } catch {
    throw "$Name is required but was not found in PATH. $InstallHint"
  }
}

function Get-NodeVersionInfo {
  $nodeSource = Get-CommandSourceOrThrow -Name 'node' -InstallHint 'Install Node.js 18 or newer, then retry.'
  $versionText = (& $nodeSource -p 'process.versions.node' 2>$null)
  if (-not $versionText) {
    throw 'node is installed but its version could not be read. Reinstall Node.js 18 or newer, then retry.'
  }

  $trimmedVersion = ([string]($versionText | Select-Object -First 1)).Trim()
  $major = 0
  if (-not [int]::TryParse(($trimmedVersion -split '\.')[0], [ref]$major)) {
    throw "Unexpected Node.js version format: $trimmedVersion"
  }

  return @{
    Source = $nodeSource
    Version = $trimmedVersion
    Major = $major
  }
}

function Assert-PathExists {
  param(
    [string]$Path,
    [string]$Label,
    [string]$FixHint
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    throw "$Label not found: $Path. $FixHint"
  }
}

function Assert-LaunchPrerequisites {
  param(
    [string]$TargetName,
    [string]$WorkingDirectory,
    [string[]]$RequiredPaths,
    [string]$InstallHint
  )

  Assert-PathExists -Path $WorkingDirectory -Label "$TargetName working directory" -FixHint 'Check that the repository was cloned completely.'
  Assert-PathExists -Path (Join-Path $WorkingDirectory 'package.json') -Label "$TargetName package.json" -FixHint 'Check that the repository files are intact.'

  $nodeInfo = Get-NodeVersionInfo
  if ($nodeInfo.Major -lt $MinimumNodeMajor) {
    throw "$TargetName requires Node.js $MinimumNodeMajor or newer. Current version: $($nodeInfo.Version). Upgrade Node.js, then retry."
  }

  $npmSource = Get-CommandSourceOrThrow -Name 'npm' -InstallHint 'Install Node.js with npm included, then retry.'
  $npmVersion = (& $npmSource -v 2>$null)
  if (-not $npmVersion) {
    throw 'npm is installed but its version could not be read. Reinstall Node.js with npm, then retry.'
  }

  foreach ($requiredPath in $RequiredPaths) {
    Assert-PathExists -Path $requiredPath -Label "$TargetName dependency" -FixHint $InstallHint
  }

  Write-Step "$TargetName preflight ok: node=$($nodeInfo.Version) npm=$(([string]($npmVersion | Select-Object -First 1)).Trim())"
}

function Ensure-LocalStack {
  if ($SkipEnsureStack) {
    return
  }

  & $LocalDevScript start -HostAddress $ResolvedHostAddress -ManagerPort $RequestedManagerPort -ProxyPort $RequestedProxyPort
  $null = Sync-ResolvedEndpointsFromRuntimeState
}

function Invoke-WithScopedEnvironment {
  param(
    [hashtable]$Environment,
    [string]$WorkingDirectory,
    [string]$CommandToRun
  )

  if (-not $CommandToRun -or -not $CommandToRun.Trim()) {
    throw 'A command is required.'
  }

  $previousEnvironment = @{}
  foreach ($entry in $Environment.GetEnumerator()) {
    $envPath = "Env:$($entry.Key)"
    if (Test-Path -Path $envPath) {
      $previousEnvironment[$entry.Key] = (Get-Item -Path $envPath).Value
    } else {
      $previousEnvironment[$entry.Key] = $null
    }
    Set-Item -Path $envPath -Value ([string]$entry.Value)
  }

  Push-Location $WorkingDirectory
  try {
    Invoke-Expression $CommandToRun
    $exitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
    if ($exitCode -ne 0) {
      throw "Command failed with exit code ${exitCode}: $CommandToRun"
    }
  } finally {
    Pop-Location
    foreach ($entry in $previousEnvironment.GetEnumerator()) {
      $envPath = "Env:$($entry.Key)"
      if ($null -eq $entry.Value) {
        Remove-Item -Path $envPath -ErrorAction SilentlyContinue
      } else {
        Set-Item -Path $envPath -Value $entry.Value
      }
    }
  }
}

function Start-InjectedWindow {
  param(
    [hashtable]$Environment,
    [string]$WorkingDirectory,
    [string]$Label,
    [string[]]$Commands,
    [string]$CompletionMessage
  )

  $assignments = @()
  foreach ($entry in $Environment.GetEnumerator()) {
    $escapedValue = ([string]$entry.Value).Replace("'", "''")
    $assignments += "`$env:$($entry.Key) = '$escapedValue'"
  }

  $escapedDirectory = $WorkingDirectory.Replace("'", "''")
  $commandParts = @(
    '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)'
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)'
    '$OutputEncoding = [Console]::OutputEncoding'
    $assignments
    "Set-Location '$escapedDirectory'"
  )

  if ($Commands) {
    $commandParts += $Commands
  }

  $command = $commandParts -join '; '

  $pwsh = (Get-Command pwsh -ErrorAction Stop).Source
  Start-Process -FilePath $pwsh -ArgumentList @('-NoExit', '-Command', $command) | Out-Null
  Write-Step $CompletionMessage
}

function Open-InjectedShell {
  param(
    [hashtable]$Environment,
    [string]$WorkingDirectory,
    [string]$Label
  )

  Start-InjectedWindow `
    -Environment $Environment `
    -WorkingDirectory $WorkingDirectory `
    -Label $Label `
    -Commands @(
      "`$host.UI.RawUI.WindowTitle = 'Lunel Local $Label Shell'"
      "Write-Host '[local-env] $Label shell ready at $WorkingDirectory'"
    ) `
    -CompletionMessage "$Label shell started in a new window."
}

function Open-InjectedCommandWindow {
  param(
    [hashtable]$Environment,
    [string]$WorkingDirectory,
    [string]$Label,
    [string]$CommandToRun
  )

  if (-not $CommandToRun -or -not $CommandToRun.Trim()) {
    throw 'A command is required.'
  }

  $escapedCommand = $CommandToRun.Replace("'", "''")

  Start-InjectedWindow `
    -Environment $Environment `
    -WorkingDirectory $WorkingDirectory `
    -Label $Label `
    -Commands @(
      "`$host.UI.RawUI.WindowTitle = 'Lunel Local $Label'"
      "Write-Host '[local-env] $Label window ready at $WorkingDirectory'"
      "Write-Host '[local-env] Running: $escapedCommand'"
      "Invoke-Expression '$escapedCommand'"
      'if ($LASTEXITCODE -ne 0) { Write-Host "[local-env] Command exited with code $LASTEXITCODE" -ForegroundColor Red }'
    ) `
    -CompletionMessage "$Label command window started."
}

function Show-EnvironmentSummary {
  $null = Sync-ResolvedEndpointsFromRuntimeState
  Write-Step "Host address: $ResolvedHostAddress"
  Write-Step "CLI env: LUNEL_MANAGER_URL=$ManagerUrl LUNEL_PROXY_URL=$ProxyUrl"
  Write-Step "App env: EXPO_PUBLIC_LUNEL_MANAGER_URL=$ManagerUrl EXPO_PUBLIC_LUNEL_PROXY_URL=$ProxyUrl"
  Write-Host ''
  Write-Host 'Quick commands:'
  Write-Host '  npm run local:cli:dev'
  Write-Host '  npm run local:cli:window'
  Write-Host '  npm run local:cli:shell'
  Write-Host '  npm run local:app:start'
  Write-Host '  npm run local:app:window'
  Write-Host '  npm run local:app:shell'
  Write-Host ''
  Write-Host 'Explorer launchers:'
  Write-Host '  scripts\start-local-stack.cmd'
  Write-Host '  scripts\open-local-cli.cmd'
  Write-Host '  scripts\open-local-app.cmd'
  Write-Host '  scripts\stop-local-stack.cmd'
  Write-Host '  scripts\start-local-lan-stack.cmd'
  Write-Host '  scripts\open-local-lan-cli.cmd'
  Write-Host '  scripts\open-local-lan-app.cmd'
  Write-Host '  scripts\stop-local-lan-stack.cmd'
  Write-Host '  scripts\install-local-lan-firewall.cmd'
  Write-Host ''
  Write-Host 'Desktop shortcuts:'
  Write-Host '  npm run local:shortcuts:install'
  Write-Host '  npm run local:shortcuts:list'
  Write-Host '  includes Local + LAN shortcut sets'
  Write-Host ''
  Write-Host 'LAN / phone commands:'
  Write-Host '  npm run local:lan:start'
  Write-Host '  npm run local:lan:env'
  Write-Host '  npm run local:lan:app:start'
  Write-Host '  npm run local:lan:cli:window'
  Write-Host '  npm run local:lan:firewall:install'
  Write-Host '  scripts\install-local-lan-firewall.cmd'
  Write-Host ''
  Write-Host 'Launcher preflight checks:'
  Write-Host '  node >= 18'
  Write-Host '  npm in PATH'
  Write-Host '  cli\\node_modules + typescript'
  Write-Host '  app\\node_modules + expo'
  Write-Host ''
  Write-Host 'Phone testing note:'
  Write-Host '  repo app / Expo build only'
  Write-Host '  phone and PC must stay on the same private Wi-Fi'
}

function Get-CliEnvironment {
  return @{
    LUNEL_MANAGER_URL = $ManagerUrl
    LUNEL_PROXY_URL = $ProxyUrl
  }
}

function Get-AppEnvironment {
  return @{
    EXPO_PUBLIC_LUNEL_MANAGER_URL = $ManagerUrl
    EXPO_PUBLIC_LUNEL_PROXY_URL = $ProxyUrl
  }
}

$cliInstallHint = "Run 'cd $CliRoot; npm install' and retry."
$appInstallHint = "Run 'cd $AppRoot; npm install' and retry."

switch ($Action) {
  'show' {
    Show-EnvironmentSummary
  }
  'cli-exec' {
    Assert-LaunchPrerequisites -TargetName 'CLI' -WorkingDirectory $CliRoot -RequiredPaths @(
      (Join-Path $CliRoot 'node_modules')
      (Join-Path $CliRoot 'node_modules\.bin\tsc.cmd')
    ) -InstallHint $cliInstallHint
    Ensure-LocalStack
    Invoke-WithScopedEnvironment -Environment (Get-CliEnvironment) -WorkingDirectory $CliRoot -CommandToRun $CommandLine
  }
  'app-exec' {
    Assert-LaunchPrerequisites -TargetName 'App' -WorkingDirectory $AppRoot -RequiredPaths @(
      (Join-Path $AppRoot 'node_modules')
      (Join-Path $AppRoot 'node_modules\.bin\expo.cmd')
    ) -InstallHint $appInstallHint
    Ensure-LocalStack
    Invoke-WithScopedEnvironment -Environment (Get-AppEnvironment) -WorkingDirectory $AppRoot -CommandToRun $CommandLine
  }
  'cli-shell' {
    Assert-LaunchPrerequisites -TargetName 'CLI' -WorkingDirectory $CliRoot -RequiredPaths @(
      (Join-Path $CliRoot 'node_modules')
      (Join-Path $CliRoot 'node_modules\.bin\tsc.cmd')
    ) -InstallHint $cliInstallHint
    Ensure-LocalStack
    Open-InjectedShell -Environment (Get-CliEnvironment) -WorkingDirectory $CliRoot -Label 'CLI'
  }
  'app-shell' {
    Assert-LaunchPrerequisites -TargetName 'App' -WorkingDirectory $AppRoot -RequiredPaths @(
      (Join-Path $AppRoot 'node_modules')
      (Join-Path $AppRoot 'node_modules\.bin\expo.cmd')
    ) -InstallHint $appInstallHint
    Ensure-LocalStack
    Open-InjectedShell -Environment (Get-AppEnvironment) -WorkingDirectory $AppRoot -Label 'App'
  }
  'cli-run-window' {
    Assert-LaunchPrerequisites -TargetName 'CLI' -WorkingDirectory $CliRoot -RequiredPaths @(
      (Join-Path $CliRoot 'node_modules')
      (Join-Path $CliRoot 'node_modules\.bin\tsc.cmd')
    ) -InstallHint $cliInstallHint
    Ensure-LocalStack
    Open-InjectedCommandWindow -Environment (Get-CliEnvironment) -WorkingDirectory $CliRoot -Label 'CLI' -CommandToRun (Resolve-CommandToRun -CommandToRun $CommandLine -DefaultCommand 'npm run dev')
  }
  'app-run-window' {
    Assert-LaunchPrerequisites -TargetName 'App' -WorkingDirectory $AppRoot -RequiredPaths @(
      (Join-Path $AppRoot 'node_modules')
      (Join-Path $AppRoot 'node_modules\.bin\expo.cmd')
    ) -InstallHint $appInstallHint
    Ensure-LocalStack
    Open-InjectedCommandWindow -Environment (Get-AppEnvironment) -WorkingDirectory $AppRoot -Label 'App' -CommandToRun (Resolve-CommandToRun -CommandToRun $CommandLine -DefaultCommand 'npm run start')
  }
}
