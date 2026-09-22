[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)][string]$MastercamRoot = "",
  [string]$Configuration = "Release",
  [string]$DotnetPath = "",
  [switch]$ConfigureClients,
  [switch]$ListInstallations,
  [switch]$Uninstall
)
$ErrorActionPreference = "Stop"

$InstallManifestName = "MastercamMcp.Addin.install-manifest.json"
$SupportedReleases = @(2024, 2025, 2026, 2027)

function Quote-ProcessArgument([string]$Value) {
  if ($Value -notmatch '[\s"]') { return $Value }
  return '"' + ($Value -replace '(\\*)"','$1$1\"' -replace '(\\+)$','$1$1') + '"'
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

function Resolve-MastercamRelease([string]$Root) {
  $leaf = Split-Path $Root -Leaf
  if ($leaf -match 'Mastercam\s+(\d{4})') {
    return [int]$Matches[1]
  }

  $exe = Join-Path $Root "Mastercam.exe"
  if (-not (Test-Path $exe -PathType Leaf)) { return $null }

  try {
    $product = (Get-Item $exe).VersionInfo.ProductVersion
    if (-not $product) { return $null }
    $majorText = $product.Split('.')[0]
    $major = 0
    if (-not [int]::TryParse($majorText, [ref]$major)) { return $null }
    if ($major -ge 2024) { return $major }
    if ($major -ge 20 -and $major -le 99) { return 2000 + $major }
  } catch {
    return $null
  }
  return $null
}

function Assert-SafePayloadName([string]$Name) {
  if (-not $Name -or [System.IO.Path]::GetFileName($Name) -ne $Name) {
    throw "Unsafe install manifest entry: '$Name'"
  }
}

function Remove-InstalledPayload([string]$Chooks) {
  $manifestPath = Join-Path $Chooks $InstallManifestName
  if (Test-Path $manifestPath -PathType Leaf) {
    try {
      $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
      foreach ($entry in @($manifest.files)) {
        $name = if ($entry -is [string]) { [string]$entry } else { [string]$entry.name }
        Assert-SafePayloadName $name
        $target = Join-Path $Chooks $name
        if (Test-Path $target -PathType Leaf) {
          Remove-Item $target -Force
          Write-Output "Removed $target"
        }
      }
      Remove-Item $manifestPath -Force
      Write-Output "Removed $manifestPath"
      return
    } catch {
      throw "Could not safely uninstall the recorded Mastercam MCP payload: $($_.Exception.Message)"
    }
  }

  # Backward-compatible cleanup for installs made before manifest tracking.
  foreach ($file in @('MastercamMcp.Addin.dll', 'MastercamMcp.Addin.ft')) {
    $target = Join-Path $Chooks $file
    if (Test-Path $target) { Remove-Item $target -Force; Write-Output "Removed $target" }
  }
}

if ($ListInstallations) {
  Get-ChildItem 'C:\Program Files' -Directory -Filter 'Mastercam *' -ErrorAction SilentlyContinue |
    Select-Object @{Name='Version';Expression={$_.Name -replace '^Mastercam\s+', ''}}, FullName,
      @{Name='HasExecutable';Expression={Test-Path (Join-Path $_.FullName 'Mastercam.exe')}},
      @{Name='HasChooks';Expression={Test-Path (Join-Path $_.FullName 'chooks')}} | Format-Table -AutoSize
  exit 0
}

if ($Uninstall) {
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) {
    $args = @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Quote-ProcessArgument $PSCommandPath))
    if ($MastercamRoot) { $args += @('-MastercamRoot',(Quote-ProcessArgument $MastercamRoot)) }
    $args += '-Uninstall'
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
  $chooks = Join-Path (Resolve-Path $MastercamRoot).Path "chooks"
  if (-not (Test-Path $chooks)) { throw "The selected Mastercam root has no chooks directory" }
  Remove-InstalledPayload $chooks
  Write-Output "Removed the Mastercam MCP add in from the selected chooks directory"
  exit 0
}

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
$env:MASTERCAM_ROOT = (Resolve-Path $MastercamRoot).Path
$mastercamRelease = Resolve-MastercamRelease $env:MASTERCAM_ROOT
if (-not $mastercamRelease) {
  throw "Could not determine the Mastercam release from '$env:MASTERCAM_ROOT'. Pass a standard Mastercam installation folder; the installer will not guess an adapter."
}
if ($SupportedReleases -notcontains $mastercamRelease) {
  throw "Mastercam $mastercamRelease is not a verified release. Supported releases are $($SupportedReleases -join ', '). Unknown future releases fail closed until their NET-Hook/runtime mapping is validated."
}

if ($mastercamRelease -eq 2027) {
  $adapterName = "2027"
  $project = Join-Path $PSScriptRoot "native\MastercamMcp.Addin.2027\MastercamMcp.Addin.2027.csproj"
  $targetFramework = "net10.0-windows10.0.17763.0"
  $ftSource = Join-Path $PSScriptRoot "native\MastercamMcp.Addin.2027\MastercamMcp.Addin.ft"
} else {
  $adapterName = "Legacy"
  $project = Join-Path $PSScriptRoot "native\MastercamMcp.Addin.Legacy\MastercamMcp.Addin.Legacy.csproj"
  $targetFramework = "net48"
  $ftSource = Join-Path $PSScriptRoot "native\MastercamMcp.Addin.Legacy\MastercamMcp.Addin.ft"
}

Write-Output "Detected Mastercam $mastercamRelease -> adapter $adapterName ($targetFramework)"
if (-not (Test-Path $project -PathType Leaf)) { throw "Adapter project not found: $project" }
if (-not (Test-Path $ftSource -PathType Leaf)) { throw "Adapter metadata file not found: $ftSource" }

$packageJsonPath = Join-Path $PSScriptRoot "package.json"
if (-not (Test-Path $packageJsonPath -PathType Leaf)) { throw "package.json was not found beside install.ps1" }
$packageVersion = [string]((Get-Content $packageJsonPath -Raw | ConvertFrom-Json).version)
if (-not $packageVersion) { throw "Could not determine the mastercam-mcp package version" }
$serverPackageSpec = "mastercam-mcp@$packageVersion"

if (-not $DotnetPath) {
  $dotnetCommand = Get-Command dotnet -ErrorAction SilentlyContinue
  if ($dotnetCommand) { $DotnetPath = $dotnetCommand.Source }
  else { throw "dotnet was not found. Install the .NET SDK or pass -DotnetPath to dotnet.exe" }
}

& $DotnetPath build $project -c $Configuration -p:MASTERCAM_ROOT=$env:MASTERCAM_ROOT
if ($LASTEXITCODE -ne 0) { throw "Build failed for $project" }

$output = Join-Path (Split-Path $project -Parent) "bin\$Configuration\$targetFramework"
$dllSource = Join-Path $output "MastercamMcp.Addin.dll"
if (-not (Test-Path $dllSource -PathType Leaf)) {
  throw "Adapter build completed but expected DLL was not found: $dllSource"
}

$requiredManagedDependencies = @(
  'MastercamMcp.Addin.dll',
  'MastercamMcp.Protocol.dll',
  'MastercamMcp.Core.dll',
  'MastercamMcp.Adapter.Abstractions.dll'
)
foreach ($requiredFile in $requiredManagedDependencies) {
  $requiredPath = Join-Path $output $requiredFile
  if (-not (Test-Path $requiredPath -PathType Leaf)) {
    throw "Adapter build is incomplete: required dependency '$requiredFile' was not found in $output"
  }
}

# Install the managed dependency closure emitted by MSBuild. Never copy Mastercam's
# proprietary NET-Hook assemblies from the host installation into our payload.
$payloadFiles = @(Get-ChildItem $output -File | Where-Object {
  ($_.Extension -eq '.dll' -or $_.Extension -eq '.json') -and
  $_.Name -notmatch '^NETHook.*\.dll$'
})
if (-not ($payloadFiles | Where-Object { $_.Name -eq 'MastercamMcp.Addin.dll' })) {
  throw "No installable add-in payload was produced"
}

$chooks = Join-Path $env:MASTERCAM_ROOT "chooks"
if (-not (Test-Path $chooks -PathType Container)) { throw "The selected Mastercam root has no chooks directory" }

# Remove only files recorded by a previous manifest so stale dependencies do not linger.
$previousManifestPath = Join-Path $chooks $InstallManifestName
$previousNames = @()
if (Test-Path $previousManifestPath -PathType Leaf) {
  try {
    $previousManifest = Get-Content $previousManifestPath -Raw | ConvertFrom-Json
    $previousNames = @($previousManifest.files | ForEach-Object {
      $name = if ($_ -is [string]) { [string]$_ } else { [string]$_.name }
      Assert-SafePayloadName $name
      $name
    })
  } catch {
    throw "Existing Mastercam MCP install manifest is invalid; refusing to overwrite an installation that cannot be safely reconciled: $($_.Exception.Message)"
  }
}

$newNames = @($payloadFiles | ForEach-Object { $_.Name }) + @('MastercamMcp.Addin.ft')
foreach ($oldName in $previousNames) {
  if ($newNames -notcontains $oldName) {
    $oldPath = Join-Path $chooks $oldName
    if (Test-Path $oldPath -PathType Leaf) { Remove-Item $oldPath -Force }
  }
}

$installed = @()
try {
  foreach ($file in $payloadFiles) {
    $target = Join-Path $chooks $file.Name
    Copy-Item $file.FullName $target -Force
    $installed += [pscustomobject]@{
      name = $file.Name
      sha256 = (Get-FileHash $target -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
  $ftTarget = Join-Path $chooks 'MastercamMcp.Addin.ft'
  Copy-Item $ftSource $ftTarget -Force
  $installed += [pscustomobject]@{
    name = 'MastercamMcp.Addin.ft'
    sha256 = (Get-FileHash $ftTarget -Algorithm SHA256).Hash.ToLowerInvariant()
  }

  $manifest = [ordered]@{
    schema = 'mastercam-mcp/install-manifest/v1'
    packageVersion = $packageVersion
    installedAt = (Get-Date).ToUniversalTime().ToString('o')
    mastercamRelease = $mastercamRelease
    adapter = $adapterName
    targetFramework = $targetFramework
    files = $installed
  }
  [System.IO.File]::WriteAllText(
    $previousManifestPath,
    ($manifest | ConvertTo-Json -Depth 8),
    (New-Object System.Text.UTF8Encoding($false))
  )
} catch [System.UnauthorizedAccessException] {
  throw "Mastercam is installed under a protected folder. Re-run this script from an administrator PowerShell window."
}

Write-Output "Installed Mastercam MCP for Mastercam $mastercamRelease (adapter: $adapterName, runtime: $targetFramework, files: $($installed.Count))"

if ($ConfigureClients) {
  $codexConfig = Join-Path $env:USERPROFILE ".codex\config.toml"
  $codexDirectory = Split-Path $codexConfig -Parent
  if (-not (Test-Path $codexDirectory)) { New-Item $codexDirectory -ItemType Directory | Out-Null }
  $codexText = if (Test-Path $codexConfig) { Get-Content $codexConfig -Raw } else { "" }
  if ($codexText -notmatch '(?m)^\[mcp_servers\.mastercam\]') {
    $codexEntry = @"
[mcp_servers.mastercam]
command = 'npx.cmd'
args = ['-y', '$serverPackageSpec', 'serve']
enabled = true

[mcp_servers.mastercam.env]
MASTERCAM_MCP_PROFILE = 'read'
MASTERCAM_MCP_BACKEND = 'live'
"@
    Write-AtomicText $codexConfig ($codexText + $codexEntry)
    Write-Output "Added the Mastercam MCP server to the Codex configuration pinned to $serverPackageSpec"
  } else {
    Write-Output "Codex already has a mastercam MCP entry; it was left unchanged to avoid overwriting user-managed configuration"
  }

  $claudeConfig = Join-Path $env:APPDATA "Claude\claude_desktop_config.json"
  $claudeDirectory = Split-Path $claudeConfig -Parent
  if (-not (Test-Path $claudeDirectory)) { New-Item $claudeDirectory -ItemType Directory | Out-Null }
  $claude = if (Test-Path $claudeConfig) { Get-Content $claudeConfig -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
  if (-not $claude.PSObject.Properties['mcpServers']) { $claude | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{}) }
  if (-not $claude.mcpServers.PSObject.Properties['mastercam']) {
    $claude.mcpServers | Add-Member -NotePropertyName mastercam -NotePropertyValue ([pscustomobject]@{
      command = 'npx.cmd'
      args = @('-y',$serverPackageSpec,'serve')
      env = [pscustomobject]@{ MASTERCAM_MCP_PROFILE = 'read'; MASTERCAM_MCP_BACKEND = 'live' }
    })
    Write-AtomicText $claudeConfig ($claude | ConvertTo-Json -Depth 20)
    Write-Output "Added the Mastercam MCP server to the Claude Desktop configuration pinned to $serverPackageSpec"
  } else {
    Write-Output "Claude Desktop already has a mastercam MCP entry; it was left unchanged to avoid overwriting user-managed configuration"
  }
}
