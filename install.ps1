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

$ManifestName = "MastercamMcp.Addin.install-manifest.json"

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

function Get-PackageVersion {
  $packagePath = Join-Path $PSScriptRoot "package.json"
  if (-not (Test-Path $packagePath -PathType Leaf)) {
    throw "package.json was not found beside install.ps1; cannot pin the MCP server version"
  }
  try {
    $package = Get-Content $packagePath -Raw | ConvertFrom-Json
    $version = [string]$package.version
    if (-not $version -or $version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
      throw "package.json contains an invalid version"
    }
    return $version
  } catch {
    throw "Could not read package version: $($_.Exception.Message)"
  }
}

function Test-SafeManifestFileName([string]$Name) {
  if (-not $Name) { return $false }
  if ([System.IO.Path]::GetFileName($Name) -ne $Name) { return $false }
  if ($Name -match '[\\/]') { return $false }
  return $true
}

function Read-InstallManifest([string]$Chooks) {
  $path = Join-Path $Chooks $ManifestName
  if (-not (Test-Path $path -PathType Leaf)) { return $null }
  try {
    $manifest = Get-Content $path -Raw | ConvertFrom-Json
    if ($manifest.schema -ne 'mastercam-mcp/install-manifest/v1') {
      throw "Unsupported manifest schema '$($manifest.schema)'"
    }
    return $manifest
  } catch {
    throw "Could not read existing Mastercam MCP install manifest: $($_.Exception.Message)"
  }
}

function Get-ManifestFileNames($Manifest) {
  $names = New-Object System.Collections.Generic.List[string]
  if ($null -eq $Manifest -or $null -eq $Manifest.files) { return $names }
  foreach ($entry in $Manifest.files) {
    $name = [string]$entry.fileName
    if (-not (Test-SafeManifestFileName $name)) {
      throw "Install manifest contains an unsafe file name: '$name'"
    }
    $names.Add($name)
  }
  return $names
}

function Remove-InstalledPayload([string]$Chooks) {
  $manifestPath = Join-Path $Chooks $ManifestName
  $manifest = Read-InstallManifest $Chooks
  if ($null -ne $manifest) {
    foreach ($name in (Get-ManifestFileNames $manifest)) {
      $target = Join-Path $Chooks $name
      if (Test-Path $target -PathType Leaf) {
        Remove-Item $target -Force
        Write-Output "Removed $target"
      }
    }
    if (Test-Path $manifestPath -PathType Leaf) {
      Remove-Item $manifestPath -Force
      Write-Output "Removed $manifestPath"
    }
    return
  }

  # Compatibility with installations created before the manifest existed.
  foreach ($file in @('MastercamMcp.Addin.dll', 'MastercamMcp.Addin.ft')) {
    $target = Join-Path $Chooks $file
    if (Test-Path $target -PathType Leaf) {
      Remove-Item $target -Force
      Write-Output "Removed $target"
    }
  }
}

function Get-InstallPayload([string]$Output, [string]$FtSource) {
  $payload = New-Object System.Collections.Generic.List[object]
  $allowedExtensions = @('.dll', '.json', '.config')
  foreach ($file in (Get-ChildItem $Output -File)) {
    $extension = [System.IO.Path]::GetExtension($file.Name).ToLowerInvariant()
    if ($allowedExtensions -notcontains $extension) { continue }

    # Mastercam SDK/runtime assemblies are supplied by Mastercam itself and
    # must never be redistributed or shadow-copied by this project.
    if ($file.Name -match '^NETHook.*\.dll$') { continue }
    if ($file.Name -match '^Mastercam\..*\.dll$') { continue }

    $payload.Add($file)
  }

  $addin = $payload | Where-Object { $_.Name -eq 'MastercamMcp.Addin.dll' }
  if (-not $addin) {
    throw "Build output does not contain MastercamMcp.Addin.dll"
  }

  $payload.Add((Get-Item $FtSource))
  return $payload
}

function Install-Payload([object[]]$Payload, [string]$Chooks, $PreviousManifest, [string]$PackageVersion, [int]$MastercamRelease, [string]$AdapterName, [string]$TargetFramework) {
  $previousNames = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  if ($null -ne $PreviousManifest) {
    foreach ($name in (Get-ManifestFileNames $PreviousManifest)) { [void]$previousNames.Add($name) }
  }

  $newNames = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $manifestFiles = New-Object System.Collections.Generic.List[object]

  foreach ($source in $Payload) {
    $name = [string]$source.Name
    if (-not (Test-SafeManifestFileName $name)) { throw "Unsafe payload file name: $name" }
    [void]$newNames.Add($name)
    $target = Join-Path $Chooks $name
    $sourceHash = (Get-FileHash $source.FullName -Algorithm SHA256).Hash.ToLowerInvariant()

    if (Test-Path $target -PathType Leaf) {
      $targetHash = (Get-FileHash $target -Algorithm SHA256).Hash.ToLowerInvariant()
      $ownedByPreviousInstall = $previousNames.Contains($name)
      $isProjectOwnedName = $name -like 'MastercamMcp.*'
      if ($targetHash -ne $sourceHash -and -not $ownedByPreviousInstall -and -not $isProjectOwnedName) {
        throw "Refusing to overwrite existing dependency '$target' with a different build. Remove or reconcile the conflicting assembly first."
      }
    }

    Copy-Item $source.FullName $target -Force
    $manifestFiles.Add([pscustomobject]@{
      fileName = $name
      sha256 = "sha256:$sourceHash"
    })
  }

  # Remove stale files that were installed by an older Mastercam MCP version,
  # but only after the new payload has staged successfully.
  foreach ($oldName in $previousNames) {
    if ($newNames.Contains($oldName)) { continue }
    if (-not (Test-SafeManifestFileName $oldName)) { continue }
    $oldTarget = Join-Path $Chooks $oldName
    if (Test-Path $oldTarget -PathType Leaf) {
      Remove-Item $oldTarget -Force
      Write-Output "Removed stale Mastercam MCP payload $oldTarget"
    }
  }

  $manifest = [ordered]@{
    schema = 'mastercam-mcp/install-manifest/v1'
    packageVersion = $PackageVersion
    mastercamRelease = $MastercamRelease
    adapter = $AdapterName
    targetFramework = $TargetFramework
    installedAt = [DateTime]::UtcNow.ToString('o')
    files = $manifestFiles
  }
  $manifestPath = Join-Path $Chooks $ManifestName
  Write-AtomicText $manifestPath ($manifest | ConvertTo-Json -Depth 8)
}

function Set-CodexMastercamConfig([string]$Text, [string]$PackageSpec) {
  $lines = $Text -split "`r?`n"
  $out = New-Object System.Collections.Generic.List[string]
  $skipping = $false
  foreach ($line in $lines) {
    if ($line -match '^\s*\[mcp_servers\.mastercam(?:\.env)?\]\s*$') {
      $skipping = $true
      continue
    }
    if ($skipping -and $line -match '^\s*\[') { $skipping = $false }
    if (-not $skipping) { $out.Add($line) }
  }

  $base = ($out -join "`r`n").TrimEnd()
  $entry = @"
[mcp_servers.mastercam]
command = 'npx.cmd'
args = ['-y', '$PackageSpec', 'serve']
enabled = true

[mcp_servers.mastercam.env]
MASTERCAM_MCP_PROFILE = 'read'
MASTERCAM_MCP_BACKEND = 'live'
"@
  if ($base) { return $base + "`r`n`r`n" + $entry.Trim() + "`r`n" }
  return $entry.Trim() + "`r`n"
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
  throw "Could not determine the Mastercam release from '$env:MASTERCAM_ROOT'. Pass a standard Mastercam 2024-2027 installation folder; the installer will not guess an adapter."
}
if ($mastercamRelease -lt 2024 -or $mastercamRelease -gt 2027) {
  throw "Mastercam $mastercamRelease is not in the verified adapter matrix (2024-2027). Future releases fail closed until their API/runtime compatibility is validated."
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

if (-not $DotnetPath) {
  $dotnetCommand = Get-Command dotnet -ErrorAction SilentlyContinue
  if ($dotnetCommand) { $DotnetPath = $dotnetCommand.Source }
  else { throw "dotnet was not found. Install the .NET SDK or pass -DotnetPath to dotnet.exe" }
}

& $DotnetPath build $project -c $Configuration -p:MASTERCAM_ROOT=$env:MASTERCAM_ROOT
if ($LASTEXITCODE -ne 0) { throw "Build failed for $project" }

$output = Join-Path (Split-Path $project -Parent) "bin\$Configuration\$targetFramework"
if (-not (Test-Path $output -PathType Container)) {
  throw "Adapter build completed but output directory was not found: $output"
}

$payload = @(Get-InstallPayload $output $ftSource)
$chooks = Join-Path $env:MASTERCAM_ROOT "chooks"
if (-not (Test-Path $chooks -PathType Container)) { throw "The selected Mastercam root has no chooks directory" }
$previousManifest = Read-InstallManifest $chooks
$packageVersion = Get-PackageVersion

try {
  Install-Payload $payload $chooks $previousManifest $packageVersion $mastercamRelease $adapterName $targetFramework
} catch [System.UnauthorizedAccessException] {
  throw "Mastercam is installed under a protected folder. Re-run this script from an administrator PowerShell window."
}

Write-Output "Installed Mastercam MCP $packageVersion for Mastercam $mastercamRelease (adapter: $adapterName, runtime: $targetFramework)"
Write-Output "Installed $($payload.Count) manifest-tracked payload files into $chooks"

if ($ConfigureClients) {
  $packageSpec = "mastercam-mcp@$packageVersion"

  $codexConfig = Join-Path $env:USERPROFILE ".codex\config.toml"
  $codexDirectory = Split-Path $codexConfig -Parent
  if (-not (Test-Path $codexDirectory)) { New-Item $codexDirectory -ItemType Directory | Out-Null }
  $codexText = if (Test-Path $codexConfig) { Get-Content $codexConfig -Raw } else { "" }
  Write-AtomicText $codexConfig (Set-CodexMastercamConfig $codexText $packageSpec)
  Write-Output "Configured Codex to use pinned server package $packageSpec"

  $claudeConfig = Join-Path $env:APPDATA "Claude\claude_desktop_config.json"
  $claudeDirectory = Split-Path $claudeConfig -Parent
  if (-not (Test-Path $claudeDirectory)) { New-Item $claudeDirectory -ItemType Directory | Out-Null }
  $claude = if (Test-Path $claudeConfig) { Get-Content $claudeConfig -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
  if (-not $claude.PSObject.Properties['mcpServers']) {
    $claude | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{})
  }
  $claudeEntry = [pscustomobject]@{
    command = 'npx.cmd'
    args = @('-y',$packageSpec,'serve')
    env = [pscustomobject]@{ MASTERCAM_MCP_PROFILE = 'read'; MASTERCAM_MCP_BACKEND = 'live' }
  }
  if ($claude.mcpServers.PSObject.Properties['mastercam']) {
    $claude.mcpServers.mastercam = $claudeEntry
  } else {
    $claude.mcpServers | Add-Member -NotePropertyName mastercam -NotePropertyValue $claudeEntry
  }
  Write-AtomicText $claudeConfig ($claude | ConvertTo-Json -Depth 20)
  Write-Output "Configured Claude Desktop to use pinned server package $packageSpec"
}
