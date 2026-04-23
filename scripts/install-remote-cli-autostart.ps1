[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('status', 'install-logon', 'install-boot', 'install-boot-elevated', 'remove-logon', 'remove-boot', 'remove-all')]
  [string]$Action = 'status',
  [string]$LogonTaskName = 'Erkai Remote CLI Autostart',
  [string]$BootTaskName = 'Erkai Remote CLI Startup',
  [string]$Tag = 'erkai-remote-cli',
  [string]$ManagerUrl = 'https://manager.xwserver.top',
  [string]$ProxyUrl = 'https://gateway.xwserver.top',
  [string]$AppDataRoot,
  [switch]$KeepStartupShortcut
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Path $PSScriptRoot -Parent
$RemoteCliScript = Join-Path $PSScriptRoot 'remote-cli.ps1'
$RuntimeRoot = 'C:\Windows\Temp\erkai-remote-cli'
$ProofPath = Join-Path $RuntimeRoot 'autostart-install.last.txt'
$ErrorPath = Join-Path $RuntimeRoot 'autostart-install.last.err.txt'
$LegacyShortcutPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\Erkai Remote CLI.lnk'
$LegacyLauncherPath = Join-Path $env:USERPROFILE 'bin\start-erkai-remote-cli.ps1'
$SystemLauncherPath = 'C:\ProgramData\erkai\start-erkai-remote-cli-system.ps1'

function Get-StablePathToken {
  param([string]$Value)

  $normalized = if ($Value) {
    [System.IO.Path]::GetFullPath($Value).ToLowerInvariant()
  } else {
    ''
  }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($normalized))
  } finally {
    $sha.Dispose()
  }

  return ([System.BitConverter]::ToString($hash)).Replace('-', '').Substring(0, 12).ToLowerInvariant()
}

function Get-DefaultAppDataRoot {
  $baseRoot = [System.Environment]::GetFolderPath('CommonApplicationData')
  if (-not $baseRoot) {
    $baseRoot = $env:ProgramData
  }
  if (-not $baseRoot) {
    $baseRoot = Join-Path $env:TEMP 'erkai-common-data'
  }

  $repoName = Split-Path -Path $RepoRoot -Leaf
  if (-not $repoName) {
    $repoName = 'repo'
  }
  $repoToken = Get-StablePathToken -Value $RepoRoot
  return Join-Path $baseRoot ("erkai\remote-cli\{0}-{1}" -f $repoName, $repoToken)
}

if (-not $AppDataRoot -or -not $AppDataRoot.Trim()) {
  $AppDataRoot = Get-DefaultAppDataRoot
}

function Write-Step {
  param([string]$Message)
  Write-Host "[remote-autostart] $Message"
}

function Ensure-Directory {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    $null = New-Item -ItemType Directory -Path $Path -Force
  }
}

function Test-IsAdmin {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  return $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
}

function Resolve-PwshPathOrThrow {
  $candidates = @()
  $currentPwsh = Join-Path $PSHOME 'pwsh.exe'
  if (Test-Path -LiteralPath $currentPwsh) {
    $candidates += $currentPwsh
  }

  try {
    $candidates += (Get-Command pwsh -ErrorAction Stop).Source
  } catch {
  }

  $candidates += @(
    (Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'),
    'C:\Program Files\PowerShell\7\pwsh.exe'
  )

  foreach ($candidate in ($candidates | Where-Object { $_ } | Select-Object -Unique)) {
    if (Test-Path -LiteralPath $candidate) {
      return $candidate
    }
  }

  throw 'PowerShell 7 executable not found. Install PowerShell 7 before registering remote CLI autostart.'
}

function Get-WindowsPowerShellPath {
  return 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
}

function Write-SystemBootLauncher {
  $launcherDir = Split-Path -Path $SystemLauncherPath -Parent
  Ensure-Directory -Path $launcherDir

  $template = @'
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$repoRoot = '__REPO_ROOT__'
$cliEntry = Join-Path $repoRoot 'cli\dist\index.js'
$appDataRoot = '__APPDATA_ROOT__'
$userAppData = '__USER_APPDATA__'
$userProfile = '__USER_PROFILE__'
$globalNpmBin = '__GLOBAL_NPM_BIN__'
$managerUrl = '__MANAGER_URL__'
$proxyUrl = '__PROXY_URL__'
$tag = '__TAG__'
$logDir = 'C:\Windows\Temp\erkai-remote-cli'
$launcherLog = Join-Path $logDir 'boot-launcher.log'
$watchLog = Join-Path $logDir 'system-watch.log'
$statePath = Join-Path $logDir 'runtime-state.json'
$restartDelaySeconds = 3

function Ensure-Directory {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    $null = New-Item -ItemType Directory -Path $Path -Force
  }
}

function Write-Log {
  param([string]$Message)

  $timestamp = Get-Date -Format o
  Add-Content -LiteralPath $launcherLog -Value "[$timestamp] $Message"
}

function Write-State {
  param([hashtable]$State)

  ($State | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $statePath -Encoding UTF8
}

function Resolve-NodePath {
  $candidates = @()
  try {
    $candidates += (Get-Command node -ErrorAction Stop).Source
  } catch {
  }

  if ($env:NVM_SYMLINK) {
    $candidates += (Join-Path $env:NVM_SYMLINK 'node.exe')
  }

  $candidates += @(
    'C:\nvm4w\nodejs\node.exe',
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    'C:\Program Files\nodejs\node.exe'
  )

  foreach ($candidate in ($candidates | Where-Object { $_ } | Select-Object -Unique)) {
    if (Test-Path -LiteralPath $candidate) {
      return $candidate
    }
  }

  throw 'node.exe was not found for system boot launcher.'
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

function Get-EffectiveCommandPath {
  $pathValue = [System.Environment]::GetEnvironmentVariable('PATH', 'Process')
  if (
    $globalNpmBin -and
    (Test-Path -LiteralPath $globalNpmBin) -and
    (($pathValue -split ';') -notcontains $globalNpmBin)
  ) {
    return "$globalNpmBin;$pathValue"
  }

  return $pathValue
}

function Get-CliNodeProcesses {
  $entryPattern = [regex]::Escape($cliEntry)
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
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
  }
}

Ensure-Directory -Path $logDir
Ensure-Directory -Path $appDataRoot
Ensure-Directory -Path (Join-Path $appDataRoot 'lunel')

if (-not (Test-Path -LiteralPath $cliEntry)) {
  Write-Log "cli entry missing: $cliEntry"
  throw "CLI entrypoint not found: $cliEntry"
}

$nodePath = Resolve-NodePath
Write-Log "boot watcher starting. repoRoot=$repoRoot nodePath=$nodePath"

$staleCli = @(Get-CliNodeProcesses | Select-Object -ExpandProperty ProcessId)
if ($staleCli.Count -gt 0) {
  Write-Log ("stopping stale cli pid(s): {0}" -f ($staleCli -join ','))
  Stop-ProcessIds -Ids $staleCli
}

while ($true) {
  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $stdoutPath = Join-Path $logDir "cli-$timestamp.out.log"
  $stderrPath = Join-Path $logDir "cli-$timestamp.err.log"
  $envMap = @{
    APPDATA = $appDataRoot
    LUNEL_MANAGER_URL = $managerUrl
    LUNEL_PROXY_URL = $proxyUrl
    LUNEL_REMOTE_LAUNCHER_TAG = $tag
    PATH = (Get-EffectiveCommandPath)
  }
  if ($userAppData) {
    $envMap.LUNEL_USER_APPDATA = $userAppData
  }
  if ($userProfile) {
    $envMap.LUNEL_USER_PROFILE = $userProfile
  }
  if ($globalNpmBin -and (Test-Path -LiteralPath $globalNpmBin)) {
    $envMap.LUNEL_GLOBAL_NPM_BIN = $globalNpmBin
  }

  $process = Invoke-WithTemporaryEnvironment -EnvironmentMap $envMap -ScriptBlock {
    Start-Process `
      -FilePath $nodePath `
      -ArgumentList @($cliEntry) `
      -WorkingDirectory $repoRoot `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath `
      -PassThru
  }

  Write-State @{
    tag = $tag
    mode = 'boot-watch'
    interactive = $false
    watcherPid = $PID
    cliPid = $process.Id
    repoRoot = $repoRoot
    appDataRoot = $appDataRoot
    managerUrl = $managerUrl
    proxyUrl = $proxyUrl
    stdoutPath = $stdoutPath
    stderrPath = $stderrPath
    lastStartedAt = (Get-Date).ToString('o')
    lastExitCode = $null
  }
  Write-Log "started cli pid=$($process.Id)"

  Wait-Process -Id $process.Id
  $process.Refresh()
  $exitCode = $process.ExitCode

  Write-State @{
    tag = $tag
    mode = 'boot-watch'
    interactive = $false
    watcherPid = $PID
    cliPid = 0
    repoRoot = $repoRoot
    appDataRoot = $appDataRoot
    managerUrl = $managerUrl
    proxyUrl = $proxyUrl
    stdoutPath = $stdoutPath
    stderrPath = $stderrPath
    lastStartedAt = (Get-Date).ToString('o')
    lastExitCode = $exitCode
  }

  Write-Log "remote cli exited with code $exitCode; restarting in $restartDelaySeconds second(s)"
  Start-Sleep -Seconds $restartDelaySeconds
}

exit 0
'@

  $content = $template.Replace('__REPO_ROOT__', $RepoRoot).
    Replace('__APPDATA_ROOT__', $AppDataRoot).
    Replace('__USER_APPDATA__', $env:APPDATA).
    Replace('__USER_PROFILE__', $env:USERPROFILE).
    Replace('__GLOBAL_NPM_BIN__', (Join-Path $env:APPDATA 'npm')).
    Replace('__MANAGER_URL__', $ManagerUrl).
    Replace('__PROXY_URL__', $ProxyUrl).
    Replace('__TAG__', $Tag)

  Set-Content -LiteralPath $SystemLauncherPath -Value $content -Encoding UTF8
}

function Get-WatchArguments {
  return '-NoProfile -ExecutionPolicy Bypass -File "{0}" watch -Tag "{1}" -AppDataRoot "{2}" -ManagerUrl "{3}" -ProxyUrl "{4}"' -f $RemoteCliScript, $Tag, $AppDataRoot, $ManagerUrl, $ProxyUrl
}

function New-BootTaskXml {
  $command = Get-WindowsPowerShellPath
  $arguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $SystemLauncherPath

  return @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Start managed erkai remote CLI on system boot</Description>
    <Author>Codex</Author>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
    </BootTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>S-1-5-18</UserId>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$command</Command>
      <Arguments>$arguments</Arguments>
    </Exec>
  </Actions>
</Task>
"@
}

function Get-LegacyLauncherCommandLine {
  $pwshPath = Resolve-PwshPathOrThrow
  return '"{0}" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{1}"' -f $pwshPath, $LegacyLauncherPath
}

function New-ManagedTaskSettings {
  return New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Days 3650) `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable
}

function Get-TaskSnapshot {
  param([string]$TaskName)

  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $task) {
    return $null
  }

  return [pscustomobject]@{
    TaskName = $task.TaskName
    State = [string]$task.State
    Execute = [string]$task.Actions.Execute
    Arguments = [string]$task.Actions.Arguments
    UserId = [string]$task.Principal.UserId
    LogonType = [string]$task.Principal.LogonType
    RunLevel = [string]$task.Principal.RunLevel
  }
}

function Write-Proof {
  Ensure-Directory -Path $RuntimeRoot

  $lines = @(
    ('timestamp={0}' -f (Get-Date -Format o)),
    ('repoRoot={0}' -f $RepoRoot),
    ('remoteCliScript={0}' -f $RemoteCliScript),
    ('appDataRoot={0}' -f $AppDataRoot),
    ('legacyShortcutExists={0}' -f (Test-Path -LiteralPath $LegacyShortcutPath))
  )

  foreach ($taskName in @($LogonTaskName, $BootTaskName)) {
    $snapshot = Get-TaskSnapshot -TaskName $taskName
    if ($snapshot) {
      $lines += ('task={0}|state={1}|execute={2}|arguments={3}|user={4}|logonType={5}|runLevel={6}' -f $snapshot.TaskName, $snapshot.State, $snapshot.Execute, $snapshot.Arguments, $snapshot.UserId, $snapshot.LogonType, $snapshot.RunLevel)
    } else {
      $lines += ('task={0}|missing' -f $taskName)
    }
  }

  Set-Content -LiteralPath $ProofPath -Value $lines -Encoding UTF8
}

function Show-Status {
  Write-Step "repoRoot=$RepoRoot"
  Write-Step "remoteCliScript=$RemoteCliScript"
  Write-Step "appDataRoot=$AppDataRoot"
  Write-Step "legacyStartupShortcutExists=$(Test-Path -LiteralPath $LegacyShortcutPath)"
  Write-Step "proofPath=$ProofPath"

  foreach ($taskName in @($LogonTaskName, $BootTaskName)) {
    $snapshot = Get-TaskSnapshot -TaskName $taskName
    if ($snapshot) {
      Write-Step "task=$($snapshot.TaskName) state=$($snapshot.State) user=$($snapshot.UserId) logonType=$($snapshot.LogonType) runLevel=$($snapshot.RunLevel)"
      Write-Step "taskExecute=$($snapshot.Execute)"
      Write-Step "taskArguments=$($snapshot.Arguments)"
    } else {
      Write-Step "task=$taskName missing"
    }
  }
}

function Register-ManagedTask {
  param(
    [string]$TaskName,
    [Microsoft.Management.Infrastructure.CimInstance]$Trigger,
    [Microsoft.Management.Infrastructure.CimInstance]$Principal
  )

  if (-not (Test-Path -LiteralPath $RemoteCliScript)) {
    throw "Remote CLI script not found: $RemoteCliScript"
  }

  $pwshPath = Resolve-PwshPathOrThrow
  $taskAction = New-ScheduledTaskAction -Execute $pwshPath -Argument (Get-WatchArguments)
  $taskSettings = New-ManagedTaskSettings

  Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $Trigger -Principal $Principal -Settings $taskSettings -Force | Out-Null
}

function Remove-ManagedTask {
  param([string]$TaskName)

  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Step "removed task $TaskName"
  }
}

function Remove-LegacyShortcutIfNeeded {
  if ($KeepStartupShortcut) {
    return
  }

  if (Test-Path -LiteralPath $LegacyShortcutPath) {
    Remove-Item -LiteralPath $LegacyShortcutPath -Force
    Write-Step "removed legacy startup shortcut $LegacyShortcutPath"
  }
}

function Update-ExistingTaskAction {
  param(
    [string]$TaskName,
    [string]$CommandLine
  )

  & schtasks /Change /TN $TaskName /TR $CommandLine | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to update scheduled task action for $TaskName."
  }

  Write-Step "updated existing task action for $TaskName"
}

function Remove-ManagedTaskViaSchTasks {
  param([string]$TaskName)

  & schtasks /Delete /TN $TaskName /F | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to delete scheduled task $TaskName."
  }

  Write-Step "removed task $TaskName"
}

function Install-LogonTask {
  try {
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    Register-ManagedTask -TaskName $LogonTaskName -Trigger $trigger -Principal $principal
  } catch {
    $taskExists = $null -ne (Get-TaskSnapshot -TaskName $LogonTaskName)
    $isAccessDenied = $_.Exception.Message -match 'Access is denied|拒绝访问'
    if (-not $taskExists -or -not $isAccessDenied) {
      throw
    }

    if (-not (Test-Path -LiteralPath $LegacyLauncherPath)) {
      throw "Existing task fallback requires launcher: $LegacyLauncherPath"
    }

    Write-Step 'Register-ScheduledTask was denied; falling back to updating the existing logon task action only.'
    Update-ExistingTaskAction -TaskName $LogonTaskName -CommandLine (Get-LegacyLauncherCommandLine)
  }

  Remove-LegacyShortcutIfNeeded
  Write-Proof
  Show-Status
}

function Install-BootTask {
  if (-not (Test-IsAdmin)) {
    throw 'Installing the boot task requires an elevated PowerShell window.'
  }

  Write-SystemBootLauncher
  $xmlPath = Join-Path $RuntimeRoot 'boot-task.xml'
  Ensure-Directory -Path $RuntimeRoot
  Set-Content -LiteralPath $xmlPath -Value (New-BootTaskXml) -Encoding Unicode

  & schtasks /Create /TN $BootTaskName /XML $xmlPath /F | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to create boot task $BootTaskName."
  }

  if (Get-TaskSnapshot -TaskName $LogonTaskName) {
    Remove-ManagedTaskViaSchTasks -TaskName $LogonTaskName
  }
  Remove-LegacyShortcutIfNeeded
  Write-Proof
  Show-Status
}

function Start-ElevatedInstall {
  if (Test-IsAdmin) {
    Install-BootTask
    return
  }

  $windowsPowerShell = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
  $command = @(
    '&',
    ("'{0}'" -f $PSCommandPath.Replace("'", "''")),
    'install-boot',
    '-LogonTaskName',
    ("'{0}'" -f $LogonTaskName.Replace("'", "''")),
    '-BootTaskName',
    ("'{0}'" -f $BootTaskName.Replace("'", "''")),
    '-Tag',
    ("'{0}'" -f $Tag.Replace("'", "''")),
    '-ManagerUrl',
    ("'{0}'" -f $ManagerUrl.Replace("'", "''")),
    '-ProxyUrl',
    ("'{0}'" -f $ProxyUrl.Replace("'", "''")),
    '-AppDataRoot',
    ("'{0}'" -f $AppDataRoot.Replace("'", "''"))
  )
  if ($KeepStartupShortcut) {
    $command += '-KeepStartupShortcut'
  }
  $command += '; exit $LASTEXITCODE'

  Start-Process -Verb RunAs -FilePath $windowsPowerShell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ($command -join ' ')) | Out-Null
  Write-Step 'UAC install prompt opened for boot task registration.'
}

try {
  switch ($Action) {
    'status' {
      Write-Proof
      Show-Status
    }
    'install-logon' {
      Install-LogonTask
    }
    'install-boot' {
      Install-BootTask
    }
    'install-boot-elevated' {
      Start-ElevatedInstall
    }
    'remove-logon' {
      Remove-ManagedTask -TaskName $LogonTaskName
      Write-Proof
      Show-Status
    }
    'remove-boot' {
      if (-not (Test-IsAdmin)) {
        throw 'Removing the boot task requires an elevated PowerShell window.'
      }
      Remove-ManagedTaskViaSchTasks -TaskName $BootTaskName
      Write-Proof
      Show-Status
    }
    'remove-all' {
      if (Test-IsAdmin -and (Get-TaskSnapshot -TaskName $BootTaskName)) {
        Remove-ManagedTaskViaSchTasks -TaskName $BootTaskName
      }
      if (Get-TaskSnapshot -TaskName $LogonTaskName) {
        Remove-ManagedTask -TaskName $LogonTaskName
      }
      Write-Proof
      Show-Status
    }
  }
} catch {
  Ensure-Directory -Path $RuntimeRoot
  $message = "[{0}] {1}" -f (Get-Date -Format o), $_.Exception.Message
  Set-Content -LiteralPath $ErrorPath -Value $message -Encoding UTF8
  throw
}
