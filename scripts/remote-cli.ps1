[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'status', 'stop', 'restart', 'ensure', 'run-window', 'watch')]
  [string]$Action = 'status',
  [string]$Tag = 'erkai-remote-cli',
  [string]$ManagerUrl = 'https://manager.xwserver.top',
  [string]$ProxyUrl = 'https://gateway.xwserver.top',
  [string]$AppDataRoot,
  [switch]$DebugCli,
  [switch]$Interactive,
  [int]$RestartDelaySeconds = 3,
  [int]$HealthWaitSeconds = 20
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Path $PSScriptRoot -Parent
$LauncherScript = Join-Path $PSScriptRoot 'remote-cli.ps1'
$SystemLauncherScript = 'C:\ProgramData\erkai\start-erkai-remote-cli-system.ps1'
$CliRoot = Join-Path $RepoRoot 'cli'
$CliEntry = Join-Path $CliRoot 'dist\index.js'
$RuntimeRoot = 'C:\Windows\Temp\erkai-remote-cli'
$StatePath = Join-Path $RuntimeRoot 'runtime-state.json'
$StopFlagPath = Join-Path $RuntimeRoot 'stop.flag'

if (-not $AppDataRoot -or -not $AppDataRoot.Trim()) {
  $AppDataRoot = Join-Path $RepoRoot 'artifacts\tmp-appdata'
}

$UserAppDataPath = [System.Environment]::GetEnvironmentVariable('APPDATA', 'Process')
$UserProfilePath = [System.Environment]::GetEnvironmentVariable('USERPROFILE', 'Process')
$GlobalNpmBinPath = if ($UserAppDataPath) {
  Join-Path $UserAppDataPath 'npm'
} elseif ($UserProfilePath) {
  Join-Path $UserProfilePath 'AppData\Roaming\npm'
} else {
  ''
}

function Get-EffectiveCommandPath {
  $pathValue = [System.Environment]::GetEnvironmentVariable('PATH', 'Process')
  if (
    $GlobalNpmBinPath -and
    (Test-Path -LiteralPath $GlobalNpmBinPath) -and
    (($pathValue -split ';') -notcontains $GlobalNpmBinPath)
  ) {
    return "$GlobalNpmBinPath;$pathValue"
  }

  return $pathValue
}

function Write-Step {
  param([string]$Message)
  Write-Host "[remote-cli] $Message"
}

function Ensure-Directory {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    $null = New-Item -ItemType Directory -Path $Path -Force
  }
}

function Read-JsonFile {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }

  try {
    $raw = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
    if (-not $raw) {
      return $null
    }
    return $raw | ConvertFrom-Json -ErrorAction Stop
  } catch {
    return $null
  }
}

function Write-State {
  param([hashtable]$State)

  Ensure-Directory -Path $RuntimeRoot
  ($State | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $StatePath -Encoding UTF8
}

function Remove-State {
  if (Test-Path -LiteralPath $StatePath) {
    Remove-Item -LiteralPath $StatePath -Force
  }
}

function Get-State {
  return Read-JsonFile -Path $StatePath
}

function Remove-StopFlag {
  if (Test-Path -LiteralPath $StopFlagPath) {
    Remove-Item -LiteralPath $StopFlagPath -Force
  }
}

function Set-StopFlag {
  Ensure-Directory -Path $RuntimeRoot
  Set-Content -LiteralPath $StopFlagPath -Value 'stop' -Encoding ASCII
}

function Test-PidAlive {
  param([int]$ProcessId)

  if ($ProcessId -le 0) {
    return $false
  }

  return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Resolve-CommandSource {
  param(
    [string]$Name,
    [string[]]$FallbackPaths = @()
  )

  try {
    return (Get-Command $Name -ErrorAction Stop).Source
  } catch {
    foreach ($candidate in $FallbackPaths) {
      if ($candidate -and (Test-Path -LiteralPath $candidate)) {
        return $candidate
      }
    }

    return $null
  }
}

function Get-PwshSourceOrThrow {
  $fallbacks = @()
  if ($PSVersionTable.PSEdition -eq 'Core') {
    $currentPwsh = Join-Path $PSHOME 'pwsh.exe'
    if (Test-Path -LiteralPath $currentPwsh) {
      $fallbacks += $currentPwsh
    }
  }

  $fallbacks += @(
    (Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'),
    'C:\Program Files\PowerShell\7\pwsh.exe'
  )

  $pwshSource = Resolve-CommandSource -Name 'pwsh' -FallbackPaths $fallbacks
  if (-not $pwshSource) {
    throw 'PowerShell 7 is required but was not found. Install PowerShell 7 and retry.'
  }

  return $pwshSource
}

function Invoke-WithTemporaryEnvironment {
  param(
    [hashtable]$EnvironmentMap,
    [scriptblock]$ScriptBlock
  )

  $previousValues = @{}
  foreach ($entry in $EnvironmentMap.GetEnumerator()) {
    $previousValues[$entry.Key] = [System.Environment]::GetEnvironmentVariable($entry.Key, 'Process')
    [System.Environment]::SetEnvironmentVariable($entry.Key, [string]$entry.Value, 'Process')
  }

  try {
    & $ScriptBlock
  } finally {
    foreach ($entry in $EnvironmentMap.GetEnumerator()) {
      [System.Environment]::SetEnvironmentVariable($entry.Key, $previousValues[$entry.Key], 'Process')
    }
  }
}

function Get-NodeSourceOrThrow {
  $fallbacks = @()
  if ($env:NVM_SYMLINK) {
    $fallbacks += (Join-Path $env:NVM_SYMLINK 'node.exe')
  }
  $fallbacks += @(
    'C:\nvm4w\nodejs\node.exe',
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    'C:\Program Files\nodejs\node.exe'
  )

  $nodeSource = Resolve-CommandSource -Name 'node' -FallbackPaths $fallbacks
  if (-not $nodeSource) {
    throw 'node is required but was not found in PATH. Install Node.js 18 or newer, then retry.'
  }

  $versionText = (& $nodeSource -p 'process.versions.node' 2>$null | Select-Object -First 1)
  if (-not $versionText) {
    throw 'node is installed but its version could not be read.'
  }

  $trimmedVersion = ([string]$versionText).Trim()
  $major = 0
  if (-not [int]::TryParse(($trimmedVersion -split '\.')[0], [ref]$major)) {
    throw "Unexpected Node.js version format: $trimmedVersion"
  }
  if ($major -lt 18) {
    throw "Node.js 18 or newer is required. Current version: $trimmedVersion"
  }

  return $nodeSource
}

function Assert-Prerequisites {
  Ensure-Directory -Path $RuntimeRoot
  Ensure-Directory -Path $AppDataRoot
  Ensure-Directory -Path (Join-Path $AppDataRoot 'lunel')

  if (-not (Test-Path -LiteralPath $CliRoot)) {
    throw "CLI root not found: $CliRoot"
  }
  if (-not (Test-Path -LiteralPath $CliEntry)) {
    throw "CLI entrypoint not found: $CliEntry. Run `cd cli && npm run build` first."
  }

  $null = Get-NodeSourceOrThrow
  $null = Get-PwshSourceOrThrow
}

function Get-ManagedWatcherProcesses {
  $scriptPattern = [regex]::Escape($LauncherScript)
  $systemLauncherPattern = [regex]::Escape($SystemLauncherScript)
  $tagPattern = [regex]::Escape($Tag)
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -and
      (
        (
          $_.CommandLine -match $scriptPattern -and
          $_.CommandLine -match '\bwatch\b' -and
          $_.CommandLine -match $tagPattern
        ) -or
        (
          $_.CommandLine -match $systemLauncherPattern
        )
      )
    }
}

function Get-CliNodeProcesses {
  $entryPattern = [regex]::Escape($CliEntry)
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -eq 'node.exe' -and
      $_.CommandLine -and
      $_.CommandLine -match $entryPattern
    }
}

function Stop-ProcessIds {
  param([int[]]$Ids)

  foreach ($id in ($Ids | Where-Object { $_ -gt 0 } | Select-Object -Unique)) {
    if (Test-PidAlive -ProcessId $id) {
      Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    }
  }
}

function Stop-StaleProcesses {
  $watcherIds = @(Get-ManagedWatcherProcesses | Select-Object -ExpandProperty ProcessId)
  $cliIds = @(Get-CliNodeProcesses | Select-Object -ExpandProperty ProcessId)

  if ($watcherIds.Count -gt 0 -or $cliIds.Count -gt 0) {
    Write-Step "Stopping stale processes. watcherPids=$($watcherIds -join ',') cliPids=$($cliIds -join ',')"
  }

  Stop-ProcessIds -Ids $watcherIds
  Start-Sleep -Milliseconds 500
  Stop-ProcessIds -Ids $cliIds
}

function Get-SavedSessionInfo {
  $configPath = Join-Path $AppDataRoot 'lunel\config.json'
  $config = Read-JsonFile -Path $configPath
  if ($null -eq $config) {
    return [pscustomobject]@{
      ConfigPath = $configPath
      Exists = $false
      HasRepoSession = $false
      SessionCount = 0
    }
  }

  $sessions = @($config.sessions)
  $repoSession = $sessions | Where-Object { $_.rootDir -eq $RepoRoot } | Select-Object -First 1
  return [pscustomobject]@{
    ConfigPath = $configPath
    Exists = $true
    HasRepoSession = $null -ne $repoSession
    SessionCount = $sessions.Count
  }
}

function Invoke-HealthProbe {
  param(
    [string]$Label,
    [string]$BaseUrl
  )

  try {
    $res = Invoke-RestMethod -Uri ($BaseUrl.TrimEnd('/') + '/health') -TimeoutSec 5
    return [pscustomobject]@{
      Label = $Label
      Url = $BaseUrl
      Reachable = $true
      Status = [string]$res.status
      Mode = [string]$res.mode
      Summary = ($res | ConvertTo-Json -Compress)
    }
  } catch {
    return [pscustomobject]@{
      Label = $Label
      Url = $BaseUrl
      Reachable = $false
      Status = ''
      Mode = ''
      Summary = $_.Exception.Message
    }
  }
}

function Get-EstablishedConnectionsForPid {
  param([int]$ProcessId)

  if ($ProcessId -le 0) {
    return @()
  }

  return @(Get-NetTCPConnection -OwningProcess $ProcessId -State Established -ErrorAction SilentlyContinue)
}

function Get-RemoteStatus {
  $state = Get-State
  $savedSession = Get-SavedSessionInfo
  $watchers = @(Get-ManagedWatcherProcesses)
  $cliNodes = @(Get-CliNodeProcesses)
  $watcherPid = if ($state -and $state.watcherPid) { [int]$state.watcherPid } else { 0 }
  $cliPid = if ($state -and $state.cliPid) { [int]$state.cliPid } else { 0 }
  $watcherAlive = $watcherPid -gt 0 -and @($watchers | Where-Object { $_.ProcessId -eq $watcherPid }).Count -gt 0
  $cliAlive = $cliPid -gt 0 -and @($cliNodes | Where-Object { $_.ProcessId -eq $cliPid }).Count -gt 0
  $connections = Get-EstablishedConnectionsForPid -ProcessId $cliPid
  $managerHealth = Invoke-HealthProbe -Label 'manager' -BaseUrl $ManagerUrl
  $proxyHealth = Invoke-HealthProbe -Label 'proxy' -BaseUrl $ProxyUrl
  $orphanCliPids = @($cliNodes | Where-Object { $_.ProcessId -ne $cliPid } | Select-Object -ExpandProperty ProcessId)
  $hasWorkingCli = $cliAlive -or $connections.Count -gt 0
  $healthy = (
    $hasWorkingCli -and
    $managerHealth.Reachable -and
    $managerHealth.Status -eq 'ok' -and
    $proxyHealth.Reachable -and
    $proxyHealth.Status -eq 'ok'
  )

  return [pscustomobject]@{
    AppDataRoot = $AppDataRoot
    State = $state
    SavedSession = $savedSession
    WatcherPid = $watcherPid
    WatcherAlive = $watcherAlive
    ManagedWatcherPids = @($watchers | Select-Object -ExpandProperty ProcessId)
    CliPid = $cliPid
    CliAlive = $cliAlive
    CliCommandPids = @($cliNodes | Select-Object -ExpandProperty ProcessId)
    OrphanCliPids = $orphanCliPids
    ConnectionCount = $connections.Count
    Connections = $connections
    ManagerHealth = $managerHealth
    ProxyHealth = $proxyHealth
    Healthy = $healthy
  }
}

function Show-Status {
  param([pscustomobject]$Status)

  Write-Step "repoRoot=$RepoRoot"
  Write-Step "appDataRoot=$($Status.AppDataRoot)"
  Write-Step "savedSessionExists=$($Status.SavedSession.Exists) repoSession=$($Status.SavedSession.HasRepoSession) sessionCount=$($Status.SavedSession.SessionCount)"
  Write-Step "watcherPid=$($Status.WatcherPid) watcherAlive=$($Status.WatcherAlive) managedWatchers=$((@($Status.ManagedWatcherPids) -join ','))"
  Write-Step "cliPid=$($Status.CliPid) cliAlive=$($Status.CliAlive) cliMatches=$((@($Status.CliCommandPids) -join ',')) orphanCli=$((@($Status.OrphanCliPids) -join ','))"
  Write-Step "manager reachable=$($Status.ManagerHealth.Reachable) status=$($Status.ManagerHealth.Status) mode=$($Status.ManagerHealth.Mode)"
  Write-Step "proxy reachable=$($Status.ProxyHealth.Reachable) status=$($Status.ProxyHealth.Status) mode=$($Status.ProxyHealth.Mode)"
  Write-Step "cliEstablishedConnections=$($Status.ConnectionCount)"

  if ($Status.State) {
    if ($Status.State.stdoutPath) {
      Write-Step "stdoutLog=$($Status.State.stdoutPath)"
    }
    if ($Status.State.stderrPath) {
      Write-Step "stderrLog=$($Status.State.stderrPath)"
    }
    if ($Status.State.lastExitCode -ne $null) {
      Write-Step "lastExitCode=$($Status.State.lastExitCode)"
    }
    if ($Status.State.lastStartedAt) {
      Write-Step "lastStartedAt=$($Status.State.lastStartedAt)"
    }
  }

  if ($Status.ConnectionCount -gt 0) {
    foreach ($connection in $Status.Connections) {
      Write-Step "connection pid=$($connection.OwningProcess) local=$($connection.LocalAddress):$($connection.LocalPort) remote=$($connection.RemoteAddress):$($connection.RemotePort)"
    }
  }

  if ($Status.Healthy) {
    Write-Step 'remote CLI is healthy.'
  } else {
    Write-Step 'remote CLI is not healthy.'
  }
}

function Wait-ForLaunchState {
  param([int]$TimeoutSeconds)

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $state = Get-State
    if ($state -and $state.watcherPid -and $state.cliPid) {
      return $state
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)

  return $null
}

function Wait-ForHealthyStatus {
  param([int]$TimeoutSeconds)

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $status = Get-RemoteStatus
    if ($status.Healthy) {
      return $status
    }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)

  return Get-RemoteStatus
}

function Start-WatcherProcess {
  param([switch]$Visible)

  Assert-Prerequisites
  Remove-StopFlag

  $pwshSource = Get-PwshSourceOrThrow
  $arguments = @(
    '-NoProfile',
    '-File', $LauncherScript,
    'watch',
    '-Tag', $Tag,
    '-ManagerUrl', $ManagerUrl,
    '-ProxyUrl', $ProxyUrl,
    '-AppDataRoot', $AppDataRoot,
    '-RestartDelaySeconds', $RestartDelaySeconds
  )

  if ($DebugCli) {
    $arguments += '-DebugCli'
  }
  if ($Visible) {
    $arguments += '-Interactive'
  }

  if ($Visible) {
    Start-Process -FilePath $pwshSource -ArgumentList $arguments -WorkingDirectory $RepoRoot | Out-Null
  } else {
    Start-Process -FilePath $pwshSource -ArgumentList $arguments -WorkingDirectory $RepoRoot -WindowStyle Hidden | Out-Null
  }

  $state = Wait-ForLaunchState -TimeoutSeconds 10
  if ($null -eq $state) {
    throw 'Watcher did not publish runtime state within 10 seconds.'
  }
}

function Start-RemoteCli {
  param([switch]$Visible)

  $status = Get-RemoteStatus
  if ($status.Healthy -and -not $Visible) {
    Show-Status -Status $status
    return
  }

  Stop-StaleProcesses
  Remove-State

  $savedSession = Get-SavedSessionInfo
  $useVisibleWindow = $Visible -or (-not $savedSession.HasRepoSession)
  Start-WatcherProcess -Visible:$useVisibleWindow

  if ($useVisibleWindow) {
    Write-Step 'Started remote CLI in a visible window. Use this when you need a QR code or live logs.'
    return
  }

  $healthy = Wait-ForHealthyStatus -TimeoutSeconds $HealthWaitSeconds
  Show-Status -Status $healthy
  if (-not $healthy.Healthy) {
    throw 'Remote CLI did not become healthy before timeout.'
  }
}

function Stop-RemoteCli {
  Set-StopFlag
  Stop-StaleProcesses
  Start-Sleep -Milliseconds 500
  Stop-StaleProcesses
  Remove-State
  Remove-StopFlag
  Write-Step 'remote CLI stopped.'
}

function Watch-RemoteCli {
  Assert-Prerequisites
  Remove-StopFlag

  Write-Step "watcher starting. repoRoot=$RepoRoot appDataRoot=$AppDataRoot interactive=$Interactive"

  while (-not (Test-Path -LiteralPath $StopFlagPath)) {
    $nodeSource = Get-NodeSourceOrThrow
    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $stdoutPath = Join-Path $RuntimeRoot "cli-$timestamp.out.log"
    $stderrPath = Join-Path $RuntimeRoot "cli-$timestamp.err.log"
    $envMap = @{
      APPDATA = $AppDataRoot
      LUNEL_MANAGER_URL = $ManagerUrl
      LUNEL_PROXY_URL = $ProxyUrl
      LUNEL_REMOTE_LAUNCHER_TAG = $Tag
      PATH = (Get-EffectiveCommandPath)
    }
    if ($UserAppDataPath) {
      $envMap.LUNEL_USER_APPDATA = $UserAppDataPath
    }
    if ($UserProfilePath) {
      $envMap.LUNEL_USER_PROFILE = $UserProfilePath
    }
    if ($GlobalNpmBinPath -and (Test-Path -LiteralPath $GlobalNpmBinPath)) {
      $envMap.LUNEL_GLOBAL_NPM_BIN = $GlobalNpmBinPath
    }
    $nodeArguments = @($CliEntry)
    if ($DebugCli) {
      $nodeArguments += '--debug'
    }

    if ($Interactive) {
      $process = Invoke-WithTemporaryEnvironment -EnvironmentMap $envMap -ScriptBlock {
        Start-Process `
          -FilePath $nodeSource `
          -ArgumentList $nodeArguments `
          -WorkingDirectory $RepoRoot `
          -NoNewWindow `
          -PassThru
      }
      Write-State @{
        tag = $Tag
        mode = 'watch'
        interactive = $true
        watcherPid = $PID
        cliPid = $process.Id
        repoRoot = $RepoRoot
        appDataRoot = $AppDataRoot
        managerUrl = $ManagerUrl
        proxyUrl = $ProxyUrl
        stdoutPath = ''
        stderrPath = ''
        lastStartedAt = (Get-Date).ToString('o')
        lastExitCode = $null
      }
      Wait-Process -Id $process.Id
    } else {
      $process = Invoke-WithTemporaryEnvironment -EnvironmentMap $envMap -ScriptBlock {
        Start-Process `
          -FilePath $nodeSource `
          -ArgumentList $nodeArguments `
          -WorkingDirectory $RepoRoot `
          -RedirectStandardOutput $stdoutPath `
          -RedirectStandardError $stderrPath `
          -PassThru
      }
      Write-State @{
        tag = $Tag
        mode = 'watch'
        interactive = $false
        watcherPid = $PID
        cliPid = $process.Id
        repoRoot = $RepoRoot
        appDataRoot = $AppDataRoot
        managerUrl = $ManagerUrl
        proxyUrl = $ProxyUrl
        stdoutPath = $stdoutPath
        stderrPath = $stderrPath
        lastStartedAt = (Get-Date).ToString('o')
        lastExitCode = $null
      }
      Wait-Process -Id $process.Id
    }

    $process.Refresh()
    $exitCode = $process.ExitCode
    Write-State @{
      tag = $Tag
      mode = 'watch'
      interactive = [bool]$Interactive
      watcherPid = $PID
      cliPid = 0
      repoRoot = $RepoRoot
      appDataRoot = $AppDataRoot
      managerUrl = $ManagerUrl
      proxyUrl = $ProxyUrl
      stdoutPath = if ($Interactive) { '' } else { $stdoutPath }
      stderrPath = if ($Interactive) { '' } else { $stderrPath }
      lastStartedAt = (Get-Date).ToString('o')
      lastExitCode = $exitCode
    }

    if (Test-Path -LiteralPath $StopFlagPath) {
      break
    }

    Write-Step "CLI exited with code $exitCode. Restarting in $RestartDelaySeconds seconds."
    Start-Sleep -Seconds $RestartDelaySeconds
  }

  Write-Step 'watcher exiting.'
}

switch ($Action) {
  'status' {
    Show-Status -Status (Get-RemoteStatus)
  }
  'start' {
    Start-RemoteCli
  }
  'run-window' {
    Start-RemoteCli -Visible
  }
  'stop' {
    Stop-RemoteCli
  }
  'restart' {
    Stop-RemoteCli
    Start-RemoteCli
  }
  'ensure' {
    $status = Get-RemoteStatus
    if ($status.Healthy) {
      Show-Status -Status $status
    } else {
      Write-Step 'Health check failed. Restarting remote CLI.'
      Stop-RemoteCli
      Start-RemoteCli
    }
  }
  'watch' {
    Watch-RemoteCli
  }
}
