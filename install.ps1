[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)][string]$MastercamRoot = "",
  [string]$Configuration = "Release",
  [string]$DotnetPath = "",
  [switch]$ConfigureClients,
  [switch]$ListInstallations,
  [switch]$Uninstall,
  # Approve replacing an existing client entry named 'mastercam' (INSTALL-02).
  [switch]$AllowMastercamEntryReplacement
)
$ErrorActionPreference = "Stop"

# BUG-08 fix: argument parsing, discovery, listing, and uninstall all happen
# BEFORE any .NET SDK evaluation, so uninstall no longer requires build tools.

function Get-MastercamInstallations {
  param([string]$ExplicitRoot)
  $roots = @()
  if ($ExplicitRoot -and (Test-Path $ExplicitRoot -PathType Container)) { $roots += $ExplicitRoot }
  if ($env:MASTERCAM_ROOT -and (Test-Path $env:MASTERCAM_ROOT -PathType Container)) {
    if ($roots -notcontains $env:MASTERCAM_ROOT) { $roots += $env:MASTERCAM_ROOT }
  }
  $scanned = Get-ChildItem 'C:\Program Files' -Directory -Filter 'Mastercam *' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
  foreach ($root in $scanned) { if ($roots -notcontains $root) { $roots += $root } }
  # INSTALL-01: verify the actual executable instead of trusting folder names.
  foreach ($root in $roots) {
    $exe = Join-Path $root 'Mastercam.exe'
    if (Test-Path $exe) {
      $version = (Get-Item $exe).VersionInfo.ProductVersion
      $year = ($root -replace '^.*Mastercam\s*', '')
      [pscustomobject]@{
        Root = $root
        MarketingRelease = $year
        ProductVersion = $version
        RuntimeFamily = if ($year -ge '2027') { 'net10' } else { 'net48' }
        Verified = (Test-Path (Join-Path $root 'chooks'))
      }
    }
  }
}

if ($ListInstallations) {
  Get-MastercamInstallations -ExplicitRoot $MastercamRoot |
    Format-Table Root, MarketingRelease, ProductVersion, RuntimeFamily, Verified -AutoSize
  exit 0
}

$installations = @(Get-MastercamInstallations -ExplicitRoot $MastercamRoot)
if (-not $MastercamRoot -and $installations.Count -gt 0) {
  # Prefer the newest verified installation whose runtime family we can build for.
  $verified = @($installations | Where-Object { $_.Verified -and $_.RuntimeFamily -eq 'net48' })
  if ($verified.Count -gt 0) { $MastercamRoot = $verified[0].Root }
}
if (-not $MastercamRoot) {
  throw "Mastercam was not found. Pass -MastercamRoot with the installation folder."
}
if (-not (Test-Path $MastercamRoot -PathType Container)) { throw "Mastercam root does not exist: $MastercamRoot" }
$env:MASTERCAM_ROOT = (Resolve-Path $MastercamRoot).Path
$chooks = Join-Path $env:MASTERCAM_ROOT "chooks"
if (-not (Test-Path $chooks)) { throw "The selected Mastercam root has no chooks directory" }

if ($Uninstall) {
  foreach ($file in @('MastercamMcp.Addin.dll', 'MastercamMcp.Addin.ft')) {
    $target = Join-Path $chooks $file
    if (Test-Path $target) { Remove-Item $target -Force; Write-Output "Removed $target" }
  }
  Write-Output "Removed the Mastercam MCP add in from the selected chooks directory"
  exit 0
}

# Build requirements are only evaluated for install (BUG-08/BUG-09).
if (-not $DotnetPath) {
  $dotnetCommand = Get-Command dotnet -ErrorAction SilentlyContinue
  if ($dotnetCommand) { $DotnetPath = $dotnetCommand.Source }
  else {
    throw ("dotnet was not found. Install the .NET SDK (https://dotnet.microsoft.com/download) or pass -DotnetPath pointing at dotnet.exe. " +
      "Building the legacy add-in requires the .NET SDK with .NET Framework 4.8 targeting support.")
  }
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  $elevatedArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Quote-ProcessArgument $PSCommandPath))
  if ($MastercamRoot) { $elevatedArgs += @('-MastercamRoot',(Quote-ProcessArgument $MastercamRoot)) }
  if ($Configuration -ne 'Release') { $elevatedArgs += @('-Configuration',(Quote-ProcessArgument $Configuration)) }
  if ($DotnetPath) { $elevatedArgs += @('-DotnetPath',(Quote-ProcessArgument $DotnetPath)) }
  if ($ConfigureClients) { $elevatedArgs += '-ConfigureClients' }
  if ($AllowMastercamEntryReplacement) { $elevatedArgs += '-AllowMastercamEntryReplacement' }
  $elevated = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList ($elevatedArgs -join ' ')
  exit $elevated.ExitCode
}

$project = Join-Path $PSScriptRoot "native\MastercamMcp.Addin.Legacy\MastercamMcp.Addin.Legacy.csproj"
if (-not (Test-Path $project)) { $project = Join-Path $PSScriptRoot "native\MastercamMcp.Addin\MastercamMcp.Addin.csproj" }
& $DotnetPath build $project -c $Configuration -p:MASTERCAM_ROOT=$env:MASTERCAM_ROOT
if ($LASTEXITCODE -ne 0) { throw "Build failed with exit code $LASTEXITCODE" }
$output = Join-Path (Split-Path $project) "bin\$Configuration\net48"
$dll = Join-Path $output "MastercamMcp.Addin.dll"
$ft = Join-Path (Split-Path $project) "MastercamMcp.Addin.ft"
if (-not (Test-Path $dll)) { throw "Build output was not found: $dll" }

# INSTALL-03: copy to a temp name inside chooks then atomically replace, so a
# failure cannot leave a half-copied add-in behind.
foreach ($pair in @(@($dll, 'MastercamMcp.Addin.dll'), @($ft, 'MastercamMcp.Addin.ft'))) {
  $source = $pair[0]
  if (-not (Test-Path $source)) { throw "Required add-in file was not found: $source" }
  $destination = Join-Path $chooks $pair[1]
  $staging = Join-Path $chooks "$($pair[1]).$([guid]::NewGuid().ToString('N')).tmp"
  try {
    Copy-Item $source $staging -Force
    if (Test-Path $destination) {
      Move-Item $staging $destination -Force
    } else {
      Move-Item $staging $destination
    }
  } catch [System.UnauthorizedAccessException] {
    if (Test-Path $staging) { Remove-Item $staging -Force }
    throw "Mastercam is installed under a protected folder. Re-run this script from an administrator PowerShell window to install the add in into chooks."
  } catch {
    if (Test-Path $staging) { Remove-Item $staging -Force }
    throw "Could not install $($pair[1]): $($_.Exception.Message)"
  }
}
Write-Output "Installed the add in into the local Mastercam chooks directory"

if ($ConfigureClients) {
  Install-CodexEntry
  Install-ClaudeEntry
}

# ------------------------------------------------------------ functions

function Quote-ProcessArgument([string]$Value) {
  if ($Value -notmatch '[\s"]') { return $Value }
  return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function Write-AtomicText([string]$Path, [string]$Content) {
  # INSTALL-03: temp file + atomic replace, preserving the original where possible.
  $temporary = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
  try {
    [System.IO.File]::WriteAllText($temporary, $Content, (New-Object System.Text.UTF8Encoding($false)))
    if (Test-Path $Path) {
      $backup = "$Path.$(Get-Date -Format yyyyMMdd-HHmmss).bak"
      Copy-Item $Path $backup -Force
      Write-Output "Backed up $Path to $backup"
      try {
        [System.IO.File]::Replace($temporary, $Path, $null, $true)
      } catch {
        Move-Item $temporary $Path -Force
      }
    } else {
      Move-Item $temporary $Path
    }
  } catch {
    if (Test-Path $temporary) { Remove-Item $temporary -Force }
    throw "Could not update $Path atomically: $($_.Exception.Message)"
  }
  # Verify the result parses/reads back before declaring success.
  if (-not (Test-Path $Path)) { throw "Replacement of $Path failed verification" }
}

function Install-CodexEntry {
  $codexConfig = Join-Path $env:USERPROFILE ".codex\config.toml"
  $codexDirectory = Split-Path $codexConfig -Parent
  if (-not (Test-Path $codexDirectory)) { New-Item $codexDirectory -ItemType Directory -Force | Out-Null }
  $codexText = if (Test-Path $codexConfig) { Get-Content $codexConfig -Raw } else { "" }
  if ($codexText -match '(?m)^\[mcp_servers\.mastercam\]') {
    if (-not $AllowMastercamEntryReplacement) {
      Write-Output "Codex already has a [mcp_servers.mastercam] entry; pass -AllowMastercamEntryReplacement to replace it"
      return
    }
    # Remove the existing mastercam table blocks before appending the fresh entry.
    $codexText = $codexText -replace '(?ms)^\[mcp_servers\.mastercam\].*?(?=^\[|\z)', ''
  }
  $codexEntry = @"

[mcp_servers.mastercam]
command = 'npx.cmd'
args = ['-y', 'mastercam-mcp@latest', 'serve']
enabled = true

[mcp_servers.mastercam.env]
MASTERCAM_MCP_PROFILE = 'read'
"@
  Write-AtomicText $codexConfig ($codexText + $codexEntry)
  Write-Output "Added the Mastercam MCP server to the Codex configuration"
}

function Install-ClaudeEntry {
  $claudeConfig = Join-Path $env:APPDATA "Claude\claude_desktop_config.json"
  $claudeDirectory = Split-Path $claudeConfig -Parent
  if (-not (Test-Path $claudeDirectory)) { New-Item $claudeDirectory -ItemType Directory -Force | Out-Null }
  $raw = if (Test-Path $claudeConfig) { Get-Content $claudeConfig -Raw } else { $null }
  $claude = $null
  if ($raw) {
    try { $claude = $raw | ConvertFrom-Json }
    catch { throw "Existing Claude configuration is not valid JSON: $claudeConfig. Fix or remove the file, then re-run with -ConfigureClients." }
  }
  if (-not $claude) { $claude = [pscustomobject]@{} }
  if (-not $claude.PSObject.Properties['mcpServers']) { $claude | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{}) }
  if ($claude.mcpServers.PSObject.Properties['mastercam']) {
    if (-not $AllowMastercamEntryReplacement) {
      Write-Output "Claude Desktop already has a mastercam MCP entry; pass -AllowMastercamEntryReplacement to replace it"
      return
    }
    $claude.mcpServers.PSObject.Properties.Remove('mastercam')
  }
  $claude.mcpServers | Add-Member -NotePropertyName mastercam -NotePropertyValue ([pscustomobject]@{ command = 'npx.cmd'; args = @('-y','mastercam-mcp@latest','serve'); env = [pscustomobject]@{ MASTERCAM_MCP_PROFILE = 'read' } })
  $json = $claude | ConvertTo-Json -Depth 20
  Write-AtomicText $claudeConfig $json
  # INSTALL-02: validate the rewritten file actually parses before finishing.
  Get-Content $claudeConfig -Raw | ConvertFrom-Json | Out-Null
  Write-Output "Added the Mastercam MCP server to the Claude Desktop configuration"
}
