[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateScript({ Test-Path $_ -PathType Container })][string]$MastercamRoot,
  [string]$Configuration = "Release"
)
$ErrorActionPreference = "Stop"
$project = Join-Path $PSScriptRoot "native\MastercamMcp.Addin\MastercamMcp.Addin.csproj"
$env:MASTERCAM_ROOT = (Resolve-Path $MastercamRoot).Path
dotnet build $project -c $Configuration -p:MASTERCAM_ROOT=$env:MASTERCAM_ROOT
$output = Join-Path $PSScriptRoot "native\MastercamMcp.Addin\bin\$Configuration\net48"
$chooks = Join-Path $env:MASTERCAM_ROOT "chooks"
if (-not (Test-Path $chooks)) { throw "The selected Mastercam root has no chooks directory" }
Copy-Item (Join-Path $output "MastercamMcp.Addin.dll") $chooks -Force
Write-Output "Installed the add in into the local Mastercam chooks directory"
