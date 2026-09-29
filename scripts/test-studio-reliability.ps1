$ErrorActionPreference = 'Stop'
# The existing Studio runner establishes the supported MSVC environment and
# runs all inexpensive native regressions before the opt-in synthetic smoke.
& (Join-Path $PSScriptRoot 'test-video-studio.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Native regressions failed.' }
$repo = Split-Path -Parent $PSScriptRoot
$env:PHOTOGOGO_STUDIO_TEST_DIR = Join-Path $repo 'test-output'
$env:PHOTOGOGO_FFMPEG = Join-Path $repo 'src-tauri/tools/ffmpeg/bin/ffmpeg.exe'
if (-not (Test-Path -LiteralPath $env:PHOTOGOGO_FFMPEG -PathType Leaf)) { throw 'Bundled FFmpeg is required for the bounded reliability smoke.' }
& cargo test --locked --release --lib --manifest-path (Join-Path $repo 'src-tauri/Cargo.toml') studio_reliability_smoke -- --ignored --nocapture --test-threads=1
if ($LASTEXITCODE -ne 0) { throw 'Studio reliability smoke failed.' }
