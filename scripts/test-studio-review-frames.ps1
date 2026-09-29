$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'test-video-studio.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Native Studio regressions failed.' }
$repo = Split-Path -Parent $PSScriptRoot
$env:PHOTOGOGO_STUDIO_TEST_DIR = Join-Path $repo 'test-output'
$env:PHOTOGOGO_FFMPEG = Join-Path $repo 'src-tauri/tools/ffmpeg/bin/ffmpeg.exe'
& cargo test --locked --release --lib --manifest-path (Join-Path $repo 'src-tauri/Cargo.toml') studio_review_frames_smoke -- --ignored --nocapture --test-threads=1
if ($LASTEXITCODE -ne 0) { throw 'Review-frame smoke failed.' }
& cargo test --locked --release --lib --manifest-path (Join-Path $repo 'src-tauri/Cargo.toml') scorecard_delivery_smoke -- --ignored --nocapture --test-threads=1
if ($LASTEXITCODE -ne 0) { throw 'Scorecard delivery smoke failed.' }
