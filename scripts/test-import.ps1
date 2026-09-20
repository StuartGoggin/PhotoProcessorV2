param([string]$Case = 'import_scheduler', [switch]$Native)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$installation = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $installation) { throw 'C++ Build Tools is required.' }
$devCmd = Join-Path $installation.Trim() 'Common7\Tools\VsDevCmd.bat'
$lines = & cmd.exe /d /s /c "call `"$devCmd`" -no_logo -arch=x64 -host_arch=x64 >nul && set"
if ($LASTEXITCODE -ne 0) { throw 'Could not load build environment.' }
foreach ($line in $lines) {
    if ($line -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') }
}
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
if ($Native) {
    & cargo test --locked --release --lib --manifest-path src-tauri/Cargo.toml import -- --test-threads=1
} else {
    if ($Case -notin @('import_scheduler', 'import_safety', 'import_devices')) { throw 'Unknown test suite.' }
    New-Item -ItemType Directory -Path test-output -Force | Out-Null
    & rustc --edition 2021 --test "tests/$Case.rs" -o "test-output/$Case-tests.exe"
    if ($LASTEXITCODE -ne 0) { throw 'Import test compile failed.' }
    & "./test-output/$Case-tests.exe" --test-threads=1
}
if ($LASTEXITCODE -ne 0) { throw "Import tests failed ($LASTEXITCODE)" }
