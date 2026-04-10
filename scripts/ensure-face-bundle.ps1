param(
    [string]$BundleSource = "",
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Test-FaceBundleReady {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root
    )

    $pythonExe = Join-Path $Root "python-runtime\python.exe"
    $wheelhouse = Join-Path $Root "wheelhouse"
    $wheelCount = 0
    if (Test-Path $wheelhouse) {
        $wheelCount = (Get-ChildItem -Path $wheelhouse -Filter "*.whl" -File -ErrorAction SilentlyContinue | Measure-Object).Count
    }

    return (Test-Path $pythonExe) -and ($wheelCount -gt 0)
}

function Resolve-BundleRootFromExtract {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ExtractDir
    )

    # Accept either:
    # 1) archive root contains python-runtime/ and wheelhouse/
    # 2) archive root contains face-scan/ then python-runtime/ and wheelhouse/
    if ((Test-Path (Join-Path $ExtractDir "python-runtime")) -and (Test-Path (Join-Path $ExtractDir "wheelhouse"))) {
        return $ExtractDir
    }

    $nested = Join-Path $ExtractDir "face-scan"
    if ((Test-Path (Join-Path $nested "python-runtime")) -and (Test-Path (Join-Path $nested "wheelhouse"))) {
        return $nested
    }

    $candidate = Get-ChildItem -Path $ExtractDir -Directory -Recurse -ErrorAction SilentlyContinue |
        Where-Object {
            Test-Path (Join-Path $_.FullName "python-runtime") -and Test-Path (Join-Path $_.FullName "wheelhouse")
        } |
        Select-Object -First 1

    if ($candidate) {
        return $candidate.FullName
    }

    return $null
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$bundleRoot = Join-Path $repoRoot "src-tauri\resources\face-scan"
$pythonDir = Join-Path $bundleRoot "python-runtime"
$wheelhouseDir = Join-Path $bundleRoot "wheelhouse"

New-Item -ItemType Directory -Force -Path $pythonDir | Out-Null
New-Item -ItemType Directory -Force -Path $wheelhouseDir | Out-Null

if (-not $Force -and (Test-FaceBundleReady -Root $bundleRoot)) {
    Write-Output "Face bundle already present: $bundleRoot"
    exit 0
}

if ([string]::IsNullOrWhiteSpace($BundleSource)) {
    if (-not [string]::IsNullOrWhiteSpace($env:PHOTOGOGO_FACE_BUNDLE_SOURCE)) {
        $BundleSource = $env:PHOTOGOGO_FACE_BUNDLE_SOURCE
    } else {
        $defaultZip = Join-Path $repoRoot "src-tauri\resources\face-scan-bundle.zip"
        if (Test-Path $defaultZip) {
            $BundleSource = $defaultZip
        }
    }
}

if ([string]::IsNullOrWhiteSpace($BundleSource)) {
    throw "Face bundle missing. Set PHOTOGOGO_FACE_BUNDLE_SOURCE to a local zip path or https URL, or place src-tauri\\resources\\face-scan-bundle.zip"
}

$tempRoot = Join-Path $env:TEMP ("photogogo_face_bundle_" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

try {
    $zipPath = Join-Path $tempRoot "face-scan-bundle.zip"
    if ($BundleSource -match '^https?://') {
        Write-Output "Downloading face bundle from URL..."
        Invoke-WebRequest -Uri $BundleSource -OutFile $zipPath
    } else {
        if (-not (Test-Path $BundleSource)) {
            throw "Bundle source not found: $BundleSource"
        }
        Copy-Item -Path $BundleSource -Destination $zipPath -Force
    }

    $extractDir = Join-Path $tempRoot "extract"
    New-Item -ItemType Directory -Force -Path $extractDir | Out-Null

    Write-Output "Extracting face bundle..."
    Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

    $contentRoot = Resolve-BundleRootFromExtract -ExtractDir $extractDir
    if (-not $contentRoot) {
        throw "Bundle zip does not contain expected python-runtime and wheelhouse directories."
    }

    # Clear previous payload but keep placeholder files if present.
    Get-ChildItem -Path $pythonDir -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ne '.gitkeep' } |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path $wheelhouseDir -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ne '.gitkeep' } |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

    Write-Output "Applying bundled runtime and wheelhouse..."
    Copy-Item -Path (Join-Path $contentRoot "python-runtime\*") -Destination $pythonDir -Recurse -Force
    Copy-Item -Path (Join-Path $contentRoot "wheelhouse\*") -Destination $wheelhouseDir -Recurse -Force

    if (Test-Path (Join-Path $contentRoot "scripts\face_scan.py")) {
        $scriptsDir = Join-Path $bundleRoot "scripts"
        New-Item -ItemType Directory -Force -Path $scriptsDir | Out-Null
        Copy-Item -Path (Join-Path $contentRoot "scripts\face_scan.py") -Destination (Join-Path $scriptsDir "face_scan.py") -Force
    }

    if (-not (Test-FaceBundleReady -Root $bundleRoot)) {
        throw "Face bundle failed validation after extraction."
    }

    Write-Output "Face bundle ready: $bundleRoot"
}
finally {
    Remove-Item -Path $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
