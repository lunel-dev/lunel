[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('install', 'remove', 'status')]
  [string]$Action = 'status',
  [int]$ManagerPort = 0,
  [int]$ProxyPort = 0
)

$ErrorActionPreference = 'Stop'

$DefaultManagerPort = 8899
$DefaultProxyPort = 3000
$RuntimeRoot = Join-Path $env:TEMP 'erkai-local-dev'
$RuntimeStatePath = Join-Path $RuntimeRoot 'stack-state.json'
$DynamicRulePrefixes = @('Lunel LAN Manager ', 'Lunel LAN Proxy ')

function Write-Step {
  param([string]$Message)
  Write-Host "[local-firewall] $Message"
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

function Resolve-ManagedPort {
  param(
    [int]$RequestedPort,
    [string]$RuntimeProperty,
    [int]$DefaultPort
  )

  if ($RequestedPort -gt 0) {
    return $RequestedPort
  }

  $state = Get-RuntimeState
  if ($state -and $state.PSObject.Properties.Name -contains $RuntimeProperty) {
    $resolved = 0
    if ([int]::TryParse([string]$state.$RuntimeProperty, [ref]$resolved) -and $resolved -gt 0) {
      return $resolved
    }
  }

  return $DefaultPort
}

function Get-RuleDefinitions {
  param(
    [int]$ManagerPortValue,
    [int]$ProxyPortValue
  )

  return @(
    @{
      DisplayName = "Lunel LAN Manager $ManagerPortValue"
      Port = $ManagerPortValue
      Description = 'Allow Lunel manager LAN access on private networks.'
      Prefix = 'Lunel LAN Manager '
      Dynamic = $true
    }
    @{
      DisplayName = "Lunel LAN Proxy $ProxyPortValue"
      Port = $ProxyPortValue
      Description = 'Allow Lunel proxy LAN access on private networks.'
      Prefix = 'Lunel LAN Proxy '
      Dynamic = $true
    }
    @{
      DisplayName = 'Lunel LAN Expo Metro 8081'
      Port = 8081
      Description = 'Allow Expo Metro LAN access on private networks.'
      Prefix = ''
      Dynamic = $false
    }
    @{
      DisplayName = 'Lunel LAN Expo DevTools 19000'
      Port = 19000
      Description = 'Allow Expo dev tools LAN access on private networks.'
      Prefix = ''
      Dynamic = $false
    }
    @{
      DisplayName = 'Lunel LAN Expo DevTools 19001'
      Port = 19001
      Description = 'Allow Expo dev tools LAN access on private networks.'
      Prefix = ''
      Dynamic = $false
    }
    @{
      DisplayName = 'Lunel LAN Expo DevTools 19002'
      Port = 19002
      Description = 'Allow Expo dev tools LAN access on private networks.'
      Prefix = ''
      Dynamic = $false
    }
  )
}

$ResolvedManagerPort = Resolve-ManagedPort -RequestedPort $ManagerPort -RuntimeProperty 'managerPort' -DefaultPort $DefaultManagerPort
$ResolvedProxyPort = Resolve-ManagedPort -RequestedPort $ProxyPort -RuntimeProperty 'proxyPort' -DefaultPort $DefaultProxyPort
$RuleDefinitions = Get-RuleDefinitions -ManagerPortValue $ResolvedManagerPort -ProxyPortValue $ResolvedProxyPort

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

function Get-InstallProfiles {
  $profiles = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $null = $profiles.Add('Private')

  foreach ($category in (Get-ActiveNetworkCategories)) {
    $null = $profiles.Add($category)
  }

  return @($profiles | Sort-Object)
}

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-Administrator {
  if (Test-IsAdministrator) {
    return
  }

  throw 'Firewall changes require an elevated PowerShell session. Re-run this command as Administrator.'
}

function Get-ExistingRule {
  param([string]$DisplayName)

  return Get-NetFirewallRule -DisplayName $DisplayName -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Get-ExistingRulesByPrefix {
  param([string]$Prefix)

  return @(Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like "$Prefix*" })
}

function Remove-StaleDynamicRules {
  param([hashtable]$Definition)

  if (-not $Definition.Dynamic -or -not $Definition.Prefix) {
    return
  }

  foreach ($rule in (Get-ExistingRulesByPrefix -Prefix $Definition.Prefix)) {
    if ($rule.DisplayName -eq $Definition.DisplayName) {
      continue
    }

    Remove-NetFirewallRule -DisplayName $rule.DisplayName | Out-Null
    Write-Step "removed stale $($rule.DisplayName)"
  }
}

function Install-Rule {
  param([hashtable]$Definition)

  $installProfiles = Get-InstallProfiles
  $profileLabel = $installProfiles -join ','

  Remove-StaleDynamicRules -Definition $Definition
  $existing = Get-ExistingRule -DisplayName $Definition.DisplayName
  if ($existing) {
    Set-NetFirewallRule -DisplayName $Definition.DisplayName -Enabled True -Direction Inbound -Action Allow -Profile $installProfiles | Out-Null
    Write-Step "present $($Definition.DisplayName) port=$($Definition.Port) profiles=$profileLabel"
    return
  }

  New-NetFirewallRule `
    -DisplayName $Definition.DisplayName `
    -Description $Definition.Description `
    -Direction Inbound `
    -Action Allow `
    -Profile $installProfiles `
    -Protocol TCP `
    -LocalPort $Definition.Port | Out-Null

  Write-Step "installed $($Definition.DisplayName) port=$($Definition.Port) profiles=$profileLabel"
}

function Remove-RuleDefinition {
  param([hashtable]$Definition)

  if ($Definition.Dynamic -and $Definition.Prefix) {
    $matches = Get-ExistingRulesByPrefix -Prefix $Definition.Prefix
    if (-not $matches -or $matches.Count -eq 0) {
      Write-Step "missing dynamic rules for prefix $($Definition.Prefix.Trim())"
      return
    }

    foreach ($rule in $matches) {
      Remove-NetFirewallRule -DisplayName $rule.DisplayName | Out-Null
      Write-Step "removed $($rule.DisplayName)"
    }
    return
  }

  $existing = Get-ExistingRule -DisplayName $Definition.DisplayName
  if (-not $existing) {
    Write-Step "missing $($Definition.DisplayName)"
    return
  }

  Remove-NetFirewallRule -DisplayName $Definition.DisplayName | Out-Null
  Write-Step "removed $($Definition.DisplayName)"
}

function Show-RuleDefinition {
  param([hashtable]$Definition)

  if ($Definition.Dynamic -and $Definition.Prefix) {
    $matches = Get-ExistingRulesByPrefix -Prefix $Definition.Prefix
    if (-not $matches -or $matches.Count -eq 0) {
      Write-Step "missing dynamic rules for prefix $($Definition.Prefix.Trim())"
      return
    }

    foreach ($rule in ($matches | Sort-Object DisplayName)) {
      $ports = Get-NetFirewallPortFilter -AssociatedNetFirewallRule $rule -ErrorAction SilentlyContinue
      foreach ($port in $ports) {
        $stateLabel = if ($rule.DisplayName -eq $Definition.DisplayName) { 'active' } else { 'stale' }
        Write-Step "$($rule.DisplayName) state=$stateLabel enabled=$($rule.Enabled) profile=$($rule.Profile) protocol=$($port.Protocol) port=$($port.LocalPort)"
      }
    }
    return
  }

  $existing = Get-ExistingRule -DisplayName $Definition.DisplayName
  if (-not $existing) {
    Write-Step "missing $($Definition.DisplayName)"
    return
  }

  $ports = Get-NetFirewallPortFilter -AssociatedNetFirewallRule $existing -ErrorAction SilentlyContinue
  foreach ($port in $ports) {
    Write-Step "$($Definition.DisplayName) enabled=$($existing.Enabled) profile=$($existing.Profile) protocol=$($port.Protocol) port=$($port.LocalPort)"
  }
}

switch ($Action) {
  'install' {
    Assert-Administrator
    Write-Step "active network categories: $((Get-ActiveNetworkCategories) -join ',')"
    Write-Step "install profiles: $((Get-InstallProfiles) -join ',')"
    Write-Step "resolved manager port=$ResolvedManagerPort proxy port=$ResolvedProxyPort"
    foreach ($definition in $RuleDefinitions) {
      Install-Rule -Definition $definition
    }
  }
  'remove' {
    Assert-Administrator
    $definitionsToRemove = @()
    $definitionsToRemove += $RuleDefinitions | Where-Object { $_.Dynamic } | Group-Object Prefix | ForEach-Object { $_.Group[0] }
    $definitionsToRemove += $RuleDefinitions | Where-Object { -not $_.Dynamic }

    foreach ($definition in $definitionsToRemove) {
      Remove-RuleDefinition -Definition $definition
    }
  }
  'status' {
    Write-Step "active network categories: $((Get-ActiveNetworkCategories) -join ',')"
    Write-Step "resolved manager port=$ResolvedManagerPort proxy port=$ResolvedProxyPort"
    foreach ($definition in $RuleDefinitions) {
      Show-RuleDefinition -Definition $definition
    }
  }
}
