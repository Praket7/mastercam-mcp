[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)][string]$MastercamRoot = "",
  [string]$Configuration = "Release",
  [string]$DotnetPath = "",
  [switch]$ConfigureClients
)
$ErrorActionPreference = "Stop"
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  $args = @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Quote-ProcessArgument $PSCommandPath))
  if ($MastercamRoot) { $args += @('-MastercamRoot',(Quote-ProcessArgument $MastercamRoot)) }
  if ($Configuration -ne 'Release') { $args += @('-Configuration',(Quote-ProcessArgument $Configuration)) }
  if ($DotnetPath) { $args += @('-DotnetPath',(Quote-ProcessArgument $DotnetPath)) }
  if ($ConfigureClients) { $args += '-ConfigureClients' }
  $elevated = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList ($args -join ' ')
  exit $elevated.ExitCode
}
if (-not $MastercamRoot) {
  $candidates = Get-ChildItem 'C:\Program Files' -Directory -Filter 'Mastercam *' -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName 'Mastercam.exe') -and (Test-Path (Join-Path $_.FullName 'chooks')) } |
    Sort-Object Name -Descending
  if ($candidates) { $MastercamRoot = $candidates[0].FullName }
  else { throw "Mastercam was not found. Pass -MastercamRoot with the installation folder." }
}
if (-not (Test-Path $MastercamRoot -PathType Container)) { throw "Mastercam root does not exist: $MastercamRoot" }
$project = Join-Path $PSScriptRoot "native\MastercamMcp.Addin\MastercamMcp.Addin.csproj"
$env:MASTERCAM_ROOT = (Resolve-Path $MastercamRoot).Path
if (-not $DotnetPath) {
  $dotnetCommand = Get-Command dotnet -ErrorAction SilentlyContinue
  if ($dotnetCommand) { $DotnetPath = $dotnetCommand.Source }
  else {
    $bundledDotnet = Join-Path $PSScriptRoot "work\dotnet-sdk\dotnet.exe"
    if (Test-Path $bundledDotnet) { $DotnetPath = $bundledDotnet }
    else { throw "dotnet was not found. Install the .NET SDK or pass -DotnetPath to dotnet.exe" }
  }
}
& $DotnetPath build $project -c $Configuration -p:MASTERCAM_ROOT=$env:MASTERCAM_ROOT
$output = Join-Path $PSScriptRoot "native\MastercamMcp.Addin\bin\$Configuration\net48"
$chooks = Join-Path $env:MASTERCAM_ROOT "chooks"
if (-not (Test-Path $chooks)) { throw "The selected Mastercam root has no chooks directory" }
try { Copy-Item (Join-Path $output "MastercamMcp.Addin.dll") $chooks -Force }
catch [System.UnauthorizedAccessException] {
  throw "Mastercam is installed under a protected folder. Re-run this script from an administrator PowerShell window to copy the add in into chooks."
}
Copy-Item (Join-Path $PSScriptRoot "native\MastercamMcp.Addin\MastercamMcp.Addin.ft") $chooks -Force
Write-Output "Installed the add in into the local Mastercam chooks directory"
if ($ConfigureClients) {
  $codexConfig = Join-Path $env:USERPROFILE ".codex\config.toml"
  $codexDirectory = Split-Path $codexConfig -Parent
  if (-not (Test-Path $codexDirectory)) { New-Item $codexDirectory -ItemType Directory | Out-Null }
  $codexText = if (Test-Path $codexConfig) { Get-Content $codexConfig -Raw } else { "" }
  if ($codexText -notmatch '(?m)^\[mcp_servers\.mastercam\]') {
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
  $claudeConfig = Join-Path $env:APPDATA "Claude\claude_desktop_config.json"
  $claudeDirectory = Split-Path $claudeConfig -Parent
  if (-not (Test-Path $claudeDirectory)) { New-Item $claudeDirectory -ItemType Directory | Out-Null }
  $claude = if (Test-Path $claudeConfig) { Get-Content $claudeConfig -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
  if (-not $claude.PSObject.Properties['mcpServers']) { $claude | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{}) }
  if (-not $claude.mcpServers.PSObject.Properties['mastercam']) {
    $claude.mcpServers | Add-Member -NotePropertyName mastercam -NotePropertyValue ([pscustomobject]@{ command = 'npx.cmd'; args = @('-y','mastercam-mcp@latest','serve'); env = [pscustomobject]@{ MASTERCAM_MCP_PROFILE = 'read' } })
    Write-AtomicText $claudeConfig ($claude | ConvertTo-Json -Depth 20)
    Write-Output "Added the Mastercam MCP server to the Claude Desktop configuration"
  }
}

function Quote-ProcessArgument([string]$Value) {
  if ($Value -notmatch '[\s"]') { return $Value }
  return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function Write-AtomicText([string]$Path, [string]$Content) {
  if (Test-Path $Path) {
    $backup = "$Path.$(Get-Date -Format yyyyMMdd-HHmmss).bak"
    Copy-Item $Path $backup -Force
    Write-Output "Backed up $Path to $backup"
  }
  $temporary = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
  try {
    [System.IO.File]::WriteAllText($temporary, $Content, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item $temporary $Path -Force
  } catch {
    if (Test-Path $temporary) { Remove-Item $temporary -Force }
    throw "Could not update $Path atomically: $($_.Exception.Message)"
  }
}
