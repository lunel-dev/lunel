[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('install', 'remove', 'status')]
  [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'

$RuleDefinitions = @(
  @{
    DisplayName = 'Lunel LAN Manager 8899'
    Port = 8899
    Description = 'Allow Lunel manager LAN access on private networks.'
  }
  @{
    DisplayName = 'Lunel LAN Proxy 3000'
    Port = 3000
    Description = 'Allow Lunel proxy LAN access on private networks.'
  }
  @{
    DisplayName = 'Lunel LAN Expo Metro 8081'
    Port = 8081
    Description = 'Allow Expo Metro LAN access on private networks.'
  }
  @{
    DisplayName = 'Lunel LAN Expo DevTools 19000'
    Port = 19000
    Description = 'Allow Expo dev tools LAN access on private networks.'
  }
  @{
    DisplayName = 'Lunel LAN Expo DevTools 19001'
    Port = 19001
    Description = 'Allow Expo dev tools LAN access on private networks.'
  }
  @{
    DisplayName = 'Lunel LAN Expo DevTools 19002'
    Port = 19002
    Description = 'Allow Expo dev tools LAN access on private networks.'
  }
)

function Write-Step {
  param([string]$Message)
  Write-Host "[local-firewall] $Message"
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

function Install-Rule {
  param([hashtable]$Definition)

  $installProfiles = Get-InstallProfiles
  $profileLabel = $installProfiles -join ','

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
    foreach ($definition in $RuleDefinitions) {
      Install-Rule -Definition $definition
    }
  }
  'remove' {
    Assert-Administrator
    foreach ($definition in $RuleDefinitions) {
      Remove-RuleDefinition -Definition $definition
    }
  }
  'status' {
    Write-Step "active network categories: $((Get-ActiveNetworkCategories) -join ',')"
    foreach ($definition in $RuleDefinitions) {
      Show-RuleDefinition -Definition $definition
    }
  }
}
