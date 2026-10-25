param([switch]$VideoSmoke)
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
& cargo test --locked --release --lib --manifest-path src-tauri/Cargo.toml -- --test-threads=1
if ($LASTEXITCODE -ne 0) { throw "Native regressions failed ($LASTEXITCODE)" }
if ($VideoSmoke) {
    $env:PHOTOGOGO_FFMPEG = Join-Path $repoRoot 'src-tauri/tools/ffmpeg/bin/ffmpeg.exe'
    & cargo test --locked --release --lib --manifest-path src-tauri/Cargo.toml process_preview_video_smoke -- --ignored --nocapture --test-threads=1
    if ($LASTEXITCODE -ne 0) { throw 'Bounded video preview smoke failed.' }
}
