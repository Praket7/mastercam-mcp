[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateScript({ Test-Path $_ -PathType Container })][string]$MastercamRoot,
  [string]$Configuration = "Release",
  [string]$DotnetPath = ""
)
$ErrorActionPreference = "Stop"
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
Write-Output "Installed the add in into the local Mastercam chooks directory"
