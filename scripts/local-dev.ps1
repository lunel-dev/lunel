[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'status', 'restart')]
  [string]$Action = 'status',
  [switch]$FreshManager,
  [string]$HostAddress = '127.0.0.1',
  [int]$ManagerPort = 8899,
  [int]$ProxyPort = 3000,
  [string]$ManagerAdminPassword = 'erkai-admin-pass',
  [string]$ProxyPassword = 'erkai-proxy-pass',
  [string]$ManagerDbPath = (Join-Path $env:TEMP 'erkai-manager.db')
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Path $PSScriptRoot -Parent
$RuntimeRoot = Join-Path $env:TEMP 'erkai-local-dev'
$RuntimeStatePath = Join-Path $RuntimeRoot 'stack-state.json'
$RequestedManagerPort = $ManagerPort
$RequestedProxyPort = $ProxyPort
$ResolvedManagerPort = $RequestedManagerPort
$ResolvedProxyPort = $RequestedProxyPort

function Write-Step {
  param([string]$Message)
  Write-Host "[local-dev] $Message"
}

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

$ResolvedHostAddress = Resolve-HostAddress -InputAddress $HostAddress
Set-ResolvedEndpoints -ManagerPortValue $ResolvedManagerPort -ProxyPortValue $ResolvedProxyPort

function Ensure-RuntimeRoot {
  if (-not (Test-Path -LiteralPath $RuntimeRoot)) {
    New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
  }
}

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

function Save-RuntimeState {
  Ensure-RuntimeRoot

  $payload = [ordered]@{
    hostAddress = $ResolvedHostAddress
    managerPort = $ResolvedManagerPort
    proxyPort = $ResolvedProxyPort
    managerUrl = $ManagerUrl
    proxyUrl = $ProxyUrl
    updatedAt = (Get-Date).ToString('o')
  }

  $payload | ConvertTo-Json | Set-Content -LiteralPath $RuntimeStatePath
}

function Remove-RuntimeState {
  Remove-Item -LiteralPath $RuntimeStatePath -Force -ErrorAction SilentlyContinue
}

function Sync-ResolvedEndpointsFromState {
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

function Get-ComponentConfig {
  param(
    [string]$Name,
    [int]$ManagerPortOverride = 0,
    [int]$ProxyPortOverride = 0
  )
  Ensure-RuntimeRoot

  $effectiveManagerPort = if ($ManagerPortOverride -gt 0) { $ManagerPortOverride } else { $ResolvedManagerPort }
  $effectiveProxyPort = if ($ProxyPortOverride -gt 0) { $ProxyPortOverride } else { $ResolvedProxyPort }
  $effectiveManagerUrl = "http://${ResolvedHostAddress}:$effectiveManagerPort"
  $effectiveProxyUrl = "http://${ResolvedHostAddress}:$effectiveProxyPort"

  switch ($Name) {
    'manager' {
      $arguments = @('run', 'src/index.ts')
      if ($FreshManager) {
        $arguments += '--new'
      }
      return @{
        Name = 'manager'
        Port = $effectiveManagerPort
        WorkingDirectory = Join-Path $RepoRoot 'manager'
        HealthUrl = "$effectiveManagerUrl/health"
        ExpectedMode = 'manager'
        PidPath = Join-Path $RuntimeRoot 'manager.pid'
        StdoutPath = Join-Path $RuntimeRoot 'manager.stdout.log'
        StderrPath = Join-Path $RuntimeRoot 'manager.stderr.log'
        Arguments = $arguments
        Environment = @{
          MANAGER_ADMIN_PASSWORD = $ManagerAdminPassword
          MANAGER_DB_PATH = $ManagerDbPath
          PORT = [string]$effectiveManagerPort
        }
      }
    }
    'proxy' {
      return @{
        Name = 'proxy'
        Port = $effectiveProxyPort
        WorkingDirectory = Join-Path $RepoRoot 'proxy'
        HealthUrl = "$effectiveProxyUrl/health"
        ExpectedMode = 'gateway'
        PidPath = Join-Path $RuntimeRoot 'proxy.pid'
        StdoutPath = Join-Path $RuntimeRoot 'proxy.stdout.log'
        StderrPath = Join-Path $RuntimeRoot 'proxy.stderr.log'
        Arguments = @('run', 'src/index.ts')
        Environment = @{
          MANAGER_URL = $effectiveManagerUrl
          PUBLIC_URL = $effectiveProxyUrl
          PROXY_PASSWORD = $ProxyPassword
          PORT = [string]$effectiveProxyPort
        }
      }
    }
    default {
      throw "Unknown component: $Name"
    }
  }
}

function Resolve-BunPath {
  $candidates = [System.Collections.Generic.List[string]]::new()
  try {
    $bunCommand = Get-Command bun -ErrorAction Stop
    if ($bunCommand.Source) {
      $candidates.Add($bunCommand.Source)
    }
  } catch {
    # Fall back to the known WinGet install path on this host.
  }

  $candidates.Add('C:\Users\bflry\AppData\Local\Microsoft\WinGet\Packages\Oven-sh.Bun_Microsoft.Winget.Source_8wekyb3d8bbwe\bun-windows-x64\bun.exe')

  foreach ($candidate in ($candidates | Select-Object -Unique)) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  throw "bun.exe not found. Install Bun first or add it to PATH."
}

function Get-RunningPid {
  param([string]$PidPath)
  if (-not (Test-Path -LiteralPath $PidPath)) {
    return 0
  }

  $rawLine = Get-Content -LiteralPath $PidPath -ErrorAction SilentlyContinue | Select-Object -First 1
  $raw = if ($null -eq $rawLine) { '' } else { [string]$rawLine }
  $raw = $raw.Trim()
  if (-not $raw) {
    Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
    return 0
  }

  $processId = 0
  if (-not [int]::TryParse($raw, [ref]$processId)) {
    Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
    return 0
  }

  if (-not (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
    Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
    return 0
  }

  return $processId
}

function Test-PortListening {
  param([int]$Port)
  $listeners = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  return [bool]($listeners | Select-Object -First 1)
}

function Get-ListeningProcessId {
  param([int]$Port)

  $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $listener) {
    return 0
  }

  return [int]$listener.OwningProcess
}

function Get-ListeningProcessInfo {
  param([int]$Port)

  $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $listener) {
    return $null
  }

  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue | Select-Object -First 1
  return [pscustomobject]@{
    LocalAddress = $listener.LocalAddress
    LocalPort = [int]$listener.LocalPort
    ProcessId = [int]$listener.OwningProcess
    Name = if ($process) { $process.Name } else { $null }
    ExecutablePath = if ($process) { $process.ExecutablePath } else { $null }
    CommandLine = if ($process) { $process.CommandLine } else { $null }
  }
}

function Format-ListeningProcessInfo {
  param([object]$Info)

  if ($null -eq $Info) {
    return 'unknown process'
  }

  $parts = [System.Collections.Generic.List[string]]::new()
  if ($Info.Name) {
    $parts.Add([string]$Info.Name)
  }
  $parts.Add("pid=$($Info.ProcessId)")
  if ($Info.ExecutablePath) {
    $parts.Add([string]$Info.ExecutablePath)
  }
  if ($Info.CommandLine) {
    $commandLine = [string]$Info.CommandLine
    if ($commandLine.Length -gt 180) {
      $commandLine = $commandLine.Substring(0, 180) + '...'
    }
    $parts.Add($commandLine)
  }

  return ($parts -join ' | ')
}

function Get-ComponentHealth {
  param([hashtable]$Config)

  try {
    return Invoke-RestMethod -Uri $Config.HealthUrl -TimeoutSec 2
  } catch {
    return $null
  }
}

function Test-ExpectedHealth {
  param(
    [hashtable]$Config,
    [object]$Health
  )

  return ($null -ne $Health) -and ($Health.status -eq 'ok') -and ($Health.mode -eq $Config.ExpectedMode)
}

function Resolve-ComponentProcessId {
  param([hashtable]$Config)

  $processId = Get-RunningPid -PidPath $Config.PidPath
  if ($processId -gt 0) {
    $matchingListener = Get-NetTCPConnection -State Listen -LocalPort $Config.Port -OwningProcess $processId -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($matchingListener) {
      $health = Get-ComponentHealth -Config $Config
      if (Test-ExpectedHealth -Config $Config -Health $health) {
        return $processId
      }
    }

    Remove-Item -LiteralPath $Config.PidPath -Force -ErrorAction SilentlyContinue
  }

  $listenerPid = Get-ListeningProcessId -Port $Config.Port
  if ($listenerPid -le 0) {
    return 0
  }

  $health = Get-ComponentHealth -Config $Config
  if (-not (Test-ExpectedHealth -Config $Config -Health $health)) {
    return 0
  }

  Set-Content -LiteralPath $Config.PidPath -Value ([string]$listenerPid) -NoNewline
  return $listenerPid
}

function Assert-PortAvailable {
  param(
    [int]$Port,
    [string]$ComponentName
  )
  if (Test-PortListening -Port $Port) {
    throw "$ComponentName cannot start because port $Port is already listening."
  }
}

function Resolve-LaunchPort {
  param(
    [string]$ComponentName,
    [int]$RequestedPort,
    [scriptblock]$ConfigFactory,
    [int]$SearchWindow = 20
  )

  $firstConflict = $null
  for ($candidate = $RequestedPort; $candidate -lt ($RequestedPort + $SearchWindow); $candidate++) {
    $config = & $ConfigFactory $candidate
    $existingPid = Resolve-ComponentProcessId -Config $config
    if ($existingPid -gt 0) {
      if ($candidate -ne $RequestedPort) {
        Write-Step "$ComponentName already running on alternate port $candidate (pid=$existingPid)"
      }
      return $candidate
    }

    if (-not (Test-PortListening -Port $candidate)) {
      if ($candidate -ne $RequestedPort) {
        $conflictText = if ($firstConflict) { Format-ListeningProcessInfo -Info $firstConflict } else { 'another process' }
        Write-Step "$ComponentName requested port $RequestedPort is busy by $conflictText. Using port $candidate instead."
      }
      return $candidate
    }

    if ($candidate -eq $RequestedPort) {
      $firstConflict = Get-ListeningProcessInfo -Port $candidate
    }
  }

  $conflictText = if ($firstConflict) { Format-ListeningProcessInfo -Info $firstConflict } else { 'another process' }
  throw "$ComponentName cannot start because ports $RequestedPort-$($RequestedPort + $SearchWindow - 1) are unavailable. First conflict: $conflictText"
}

function Start-Component {
  param(
    [hashtable]$Config,
    [string]$BunPath
  )
  $existingPid = Resolve-ComponentProcessId -Config $Config
  if ($existingPid -gt 0) {
    Write-Step "$($Config.Name) already running (pid=$existingPid)"
    return [pscustomobject]@{
      pid = $existingPid
      alreadyRunning = $true
    }
  }

  Assert-PortAvailable -Port $Config.Port -ComponentName $Config.Name

  foreach ($path in @($Config.StdoutPath, $Config.StderrPath, $Config.PidPath)) {
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  }

  $previousEnvironment = @{}
  foreach ($entry in $Config.Environment.GetEnumerator()) {
    $envPath = "Env:$($entry.Key)"
    if (Test-Path -Path $envPath) {
      $previousEnvironment[$entry.Key] = (Get-Item -Path $envPath).Value
    } else {
      $previousEnvironment[$entry.Key] = $null
    }
    Set-Item -Path $envPath -Value ([string]$entry.Value)
  }

  try {
    $process = Start-Process -FilePath $BunPath `
      -ArgumentList $Config.Arguments `
      -WorkingDirectory $Config.WorkingDirectory `
      -RedirectStandardOutput $Config.StdoutPath `
      -RedirectStandardError $Config.StderrPath `
      -PassThru
  } finally {
    foreach ($entry in $previousEnvironment.GetEnumerator()) {
      $envPath = "Env:$($entry.Key)"
      if ($null -eq $entry.Value) {
        Remove-Item -Path $envPath -ErrorAction SilentlyContinue
      } else {
        Set-Item -Path $envPath -Value $entry.Value
      }
    }
  }

  Set-Content -LiteralPath $Config.PidPath -Value ([string]$process.Id) -NoNewline
  Write-Step "$($Config.Name) started (pid=$($process.Id))"
  return [pscustomobject]@{
    pid = $process.Id
    alreadyRunning = $false
  }
}

function Stop-Component {
  param([hashtable]$Config)
  $processId = Resolve-ComponentProcessId -Config $Config
  if ($processId -le 0) {
    Write-Step "$($Config.Name) is not running"
    return
  }

  Write-Step "stopping $($Config.Name) (pid=$processId)"
  Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue

  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if (-not (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
      break
    }
    Start-Sleep -Milliseconds 250
  }

  Remove-Item -LiteralPath $Config.PidPath -Force -ErrorAction SilentlyContinue
}

function Invoke-JsonRequest {
  param(
    [string]$Method,
    [string]$Uri,
    [hashtable]$Headers = @{},
    [object]$Body = $null
  )
  $params = @{
    Method = $Method
    Uri = $Uri
    Headers = $Headers
    TimeoutSec = 2
  }

  if ($null -ne $Body) {
    $params.ContentType = 'application/json'
    $params.Body = ($Body | ConvertTo-Json -Compress)
  }

  return Invoke-RestMethod @params
}

function Wait-ForHealth {
  param(
    [string]$Name,
    [string]$HealthUrl,
    [scriptblock]$IsReady
  )
  $lastError = $null
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    try {
      $response = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2
      if (& $IsReady $response) {
        return $response
      }
    } catch {
      $lastError = $_
    }
    Start-Sleep -Milliseconds 500
  }

  if ($lastError) {
    throw "$Name health check did not succeed in time: $($lastError.Exception.Message)"
  }

  throw "$Name health check did not reach the expected ready state in time."
}

function Register-ProxyWithManager {
  $login = Invoke-JsonRequest -Method 'Post' -Uri "$ManagerUrl/v1/admin/login" -Body @{
    password = $ManagerAdminPassword
  }
  $headers = @{
    Authorization = "Bearer $($login.token)"
  }

  $null = Invoke-JsonRequest -Method 'Post' -Uri "$ManagerUrl/v1/admin/add" -Headers $headers -Body @{
    url = $ProxyUrl
    proxyPassword = $ProxyPassword
  }
}

function Get-AdminProxyList {
  $login = Invoke-JsonRequest -Method 'Post' -Uri "$ManagerUrl/v1/admin/login" -Body @{
    password = $ManagerAdminPassword
  }
  $headers = @{
    Authorization = "Bearer $($login.token)"
  }

  return Invoke-JsonRequest -Method 'Get' -Uri "$ManagerUrl/v1/admin/list" -Headers $headers
}

function Get-ComponentStatus {
  param([hashtable]$Config)
  $processId = Resolve-ComponentProcessId -Config $Config
  $health = if ($processId -gt 0) { Get-ComponentHealth -Config $Config } else { $null }

  return [pscustomobject]@{
    name = $Config.Name
    pid = if ($processId -gt 0) { $processId } else { $null }
    running = ($processId -gt 0)
    port = $Config.Port
    health = $health
    stdoutLog = $Config.StdoutPath
    stderrLog = $Config.StderrPath
  }
}

function Show-Status {
  $null = Sync-ResolvedEndpointsFromState
  Write-Step "host=$ResolvedHostAddress managerUrl=$ManagerUrl proxyUrl=$ProxyUrl"
  $items = @(
    Get-ComponentStatus -Config (Get-ComponentConfig -Name 'manager')
    Get-ComponentStatus -Config (Get-ComponentConfig -Name 'proxy')
  )

  foreach ($item in $items) {
    $healthSummary = if ($item.health) {
      ($item.health | ConvertTo-Json -Compress -Depth 6)
    } else {
      'null'
    }
    Write-Step "$($item.name): running=$($item.running) pid=$($item.pid) port=$($item.port) health=$healthSummary"
    Write-Step "$($item.name) logs: stdout=$($item.stdoutLog) stderr=$($item.stderrLog)"
  }

  if ($items.running -contains $true) {
    Save-RuntimeState
  } else {
    Remove-RuntimeState
  }

  Show-LanAccessibilityHints
}

function Show-NextSteps {
  Write-Host "Host address: $ResolvedHostAddress"
  Write-Host "Manager URL: $ManagerUrl"
  Write-Host "Proxy URL: $ProxyUrl"
  Write-Host ''
  Write-Host 'CLI shell:'
  Write-Host "  `$env:LUNEL_MANAGER_URL='$ManagerUrl'"
  Write-Host "  `$env:LUNEL_PROXY_URL='$ProxyUrl'"
  Write-Host '  cd cli'
  Write-Host '  npm run dev'
  Write-Host ''
  Write-Host 'Expo shell:'
  Write-Host "  `$env:EXPO_PUBLIC_LUNEL_MANAGER_URL='$ManagerUrl'"
  Write-Host "  `$env:EXPO_PUBLIC_LUNEL_PROXY_URL='$ProxyUrl'"
  Write-Host '  cd app'
  Write-Host '  npm run start'
}

function Get-ActiveNetworkCategories {
  $categories = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $profiles = Get-NetConnectionProfile -ErrorAction SilentlyContinue

  foreach ($profile in $profiles) {
    $category = [string]$profile.NetworkCategory
    if ($category) {
      $null = $categories.Add($category)
    }
  }

  if ($categories.Count -eq 0) {
    $null = $categories.Add('Private')
  }

  return @($categories | Sort-Object)
}

function Show-LanAccessibilityHints {
  if ($ResolvedHostAddress -eq '127.0.0.1' -or $ResolvedHostAddress -eq 'localhost') {
    return
  }

  $categories = Get-ActiveNetworkCategories
  Write-Step "LAN network categories: $($categories -join ',')"

  foreach ($displayName in @('Lunel LAN Manager 8899', 'Lunel LAN Proxy 3000')) {
    $rule = Get-NetFirewallRule -DisplayName $displayName -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $rule) {
      Write-Step "warning: firewall rule missing for $displayName. Run 'npm run local:lan:firewall:install' in an elevated PowerShell session."
      continue
    }

    $profileText = [string]$rule.Profile
    $coversCurrentCategory = $false
    foreach ($category in $categories) {
      if ($profileText -match [Regex]::Escape($category)) {
        $coversCurrentCategory = $true
        break
      }
    }

    if (-not $coversCurrentCategory) {
      Write-Step "warning: firewall rule $displayName is limited to profile '$profileText' and may block current network '$($categories -join ',')'. Re-run 'npm run local:lan:firewall:install' as Administrator."
    }
  }
}

function Start-LocalStack {
  $bunPath = Resolve-BunPath
  if ($FreshManager) {
    Stop-LocalStack
  }

  $managerPortToUse = Resolve-LaunchPort -ComponentName 'manager' -RequestedPort $RequestedManagerPort -ConfigFactory {
    param($candidatePort)
    Get-ComponentConfig -Name 'manager' -ManagerPortOverride $candidatePort -ProxyPortOverride $ResolvedProxyPort
  }
  Set-ResolvedEndpoints -ManagerPortValue $managerPortToUse -ProxyPortValue $ResolvedProxyPort

  $proxyPortToUse = Resolve-LaunchPort -ComponentName 'proxy' -RequestedPort $RequestedProxyPort -ConfigFactory {
    param($candidatePort)
    Get-ComponentConfig -Name 'proxy' -ManagerPortOverride $ResolvedManagerPort -ProxyPortOverride $candidatePort
  }
  Set-ResolvedEndpoints -ManagerPortValue $ResolvedManagerPort -ProxyPortValue $proxyPortToUse

  $managerConfig = Get-ComponentConfig -Name 'manager'
  $proxyConfig = Get-ComponentConfig -Name 'proxy'
  $managerStart = Start-Component -Config $managerConfig -BunPath $bunPath
  $managerHealth = Wait-ForHealth -Name 'manager' -HealthUrl $managerConfig.HealthUrl -IsReady {
    param($response)
    $response.status -eq 'ok' -and $response.mode -eq 'manager'
  }

  $proxyStart = Start-Component -Config $proxyConfig -BunPath $bunPath
  $proxyBaseHealth = Wait-ForHealth -Name 'proxy' -HealthUrl $proxyConfig.HealthUrl -IsReady {
    param($response)
    $response.status -eq 'ok' -and $response.mode -eq 'gateway'
  }

  if ($managerStart.alreadyRunning -and $proxyStart.alreadyRunning) {
    Write-Step 'stack already healthy; skipping re-registration.'
    Write-Step "manager base health: $($managerHealth | ConvertTo-Json -Compress -Depth 5)"
    Write-Step "proxy ready: $($proxyBaseHealth | ConvertTo-Json -Compress -Depth 5)"
    Save-RuntimeState
    Show-LanAccessibilityHints
    Show-NextSteps
    return
  }

  Register-ProxyWithManager
  $null = Wait-ForHealth -Name 'manager-control' -HealthUrl $managerConfig.HealthUrl -IsReady {
    param($response)
    ($response.status -eq 'ok') -and ($response.connectedProxies -ge 1) -and ($response.ring -contains $ProxyUrl)
  }
  $proxyHealth = Wait-ForHealth -Name 'proxy-connectivity' -HealthUrl $proxyConfig.HealthUrl -IsReady {
    param($response)
    $response.status -eq 'ok' -and $response.managerReachable -eq $true
  }
  $verifiedList = Get-AdminProxyList

  Write-Step "manager base health: $($managerHealth | ConvertTo-Json -Compress -Depth 5)"
  Write-Step "proxy ready: $($proxyHealth | ConvertTo-Json -Compress -Depth 5)"
  Write-Step "admin list: $($verifiedList | ConvertTo-Json -Compress -Depth 6)"
  Save-RuntimeState
  Show-LanAccessibilityHints
  Show-NextSteps
}

function Stop-LocalStack {
  $null = Sync-ResolvedEndpointsFromState
  Stop-Component -Config (Get-ComponentConfig -Name 'proxy')
  Stop-Component -Config (Get-ComponentConfig -Name 'manager')
  Remove-RuntimeState
}

switch ($Action) {
  'start' {
    Start-LocalStack
    Show-Status
  }
  'stop' {
    Stop-LocalStack
    Show-Status
  }
  'restart' {
    Stop-LocalStack
    Start-LocalStack
    Show-Status
  }
  'status' {
    Show-Status
  }
}
