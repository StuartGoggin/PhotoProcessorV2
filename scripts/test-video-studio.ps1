param([switch]$Smoke)
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
# Reuse the existing release cache: a second debug build uses several GB.
$testArgs = @('test', '--locked', '--release', '--lib', '--manifest-path', 'src-tauri/Cargo.toml', 'studio')
& cargo @testArgs -- --test-threads=1
if ($LASTEXITCODE -ne 0) { throw "Studio tests failed ($LASTEXITCODE)" }
if ($Smoke) {
    # Recovery tests own process-global stores: always run each in a fresh process.
    foreach ($case in @('clear_jobs_smoke','restart_assembly_smoke','full_range_colour_smoke','render_smoke','lmms_audio_smoke')) {
        & cargo test --locked --release --lib --manifest-path src-tauri/Cargo.toml $case -- --ignored --nocapture --test-threads=1
        if ($LASTEXITCODE -ne 0) { throw "Studio smoke test failed: $case ($LASTEXITCODE)" }
    }
}
