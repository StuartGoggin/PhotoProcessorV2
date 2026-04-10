param(
    [string]$FaceBundleSource = "",
    [switch]$SkipFaceBundle,
    [switch]$ForceFaceBundle
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not $SkipFaceBundle) {
    $ensureScript = Join-Path $PSScriptRoot "ensure-face-bundle.ps1"
    if ([string]::IsNullOrWhiteSpace($FaceBundleSource)) {
        & $ensureScript -Force:$ForceFaceBundle
    } else {
        & $ensureScript -BundleSource $FaceBundleSource -Force:$ForceFaceBundle
    }
}

npm run tauri build
