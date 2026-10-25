param([string]$Filter = 'naming_', [string]$TargetDirectory = '')
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$vsRoot = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsRoot) { throw 'C++ Build Tools is required.' }
$devCommand = Join-Path $vsRoot.Trim() 'Common7\Tools\VsDevCmd.bat'
$lines = & cmd.exe /d /s /c "call `"$devCommand`" -no_logo -arch=x64 -host_arch=x64 >nul && set"
if ($LASTEXITCODE -ne 0) { throw 'Could not load C++ build environment.' }
foreach ($line in $lines) { if ($line -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') } }
if ($TargetDirectory) { $env:CARGO_TARGET_DIR = $TargetDirectory }
# Naming tests need no media tools or installer payloads. Never change the release config.
$env:TAURI_CONFIG = '{"bundle":{"resources":[]}}'
& "$env:USERPROFILE\.cargo\bin\cargo.exe" test --locked --release --lib --manifest-path src-tauri/Cargo.toml $Filter -- --test-threads=1
if ($LASTEXITCODE -ne 0) { throw "Native event naming checks failed ($LASTEXITCODE)" }
