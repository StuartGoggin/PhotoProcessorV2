param(
    [string]$PythonExe = ""
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcTauriDir = Split-Path -Parent $scriptDir
$bundleRoot = Join-Path $srcTauriDir "resources\face-scan"
$runtimeDir = Join-Path $bundleRoot "python-runtime"
$wheelhouseDir = Join-Path $bundleRoot "wheelhouse"

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
New-Item -ItemType Directory -Force -Path $wheelhouseDir | Out-Null

if ([string]::IsNullOrWhiteSpace($PythonExe)) {
    try {
        $PythonExe = (& py -3.11 -c "import sys; print(sys.executable)").Trim()
    } catch {
        try {
            $PythonExe = (& py -3.10 -c "import sys; print(sys.executable)").Trim()
        } catch {
            try {
                $PythonExe = (& py -3.9 -c "import sys; print(sys.executable)").Trim()
            } catch {
                try {
                    $PythonExe = (& python -c "import sys; print(sys.executable)").Trim()
                } catch {
                    throw "No usable Python found. Install Python 3.8-3.11 or pass -PythonExe explicitly."
                }
            }
        }
    }
}

if (-not (Test-Path $PythonExe)) {
    throw "Python executable not found: $PythonExe"
}

$version = (& $PythonExe -c "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')").Trim()
$major = [int]($version.Split('.')[0])
$minor = [int]($version.Split('.')[1])
if ($major -ne 3 -or $minor -lt 8 -or $minor -gt 11) {
    throw "Unsupported Python version $version. Use Python 3.8-3.11 for DeepFace/TensorFlow compatibility."
}

$pythonHome = (& $PythonExe -c "import sys; print(sys.base_prefix)").Trim()
if (-not (Test-Path $pythonHome)) {
    throw "Python base prefix not found: $pythonHome"
}

Write-Output "Using Python executable: $PythonExe"
Write-Output "Python home: $pythonHome"
Write-Output "Runtime destination: $runtimeDir"
Write-Output "Wheelhouse destination: $wheelhouseDir"

# Copy a portable runtime snapshot for bundled installs.
robocopy $pythonHome $runtimeDir /E /NFL /NDL /NJH /NJS /NP /XD "__pycache__" "Scripts\__pycache__" | Out-Null

# Download wheels for offline install in end-user app.
$packages = @(
    "deepface==0.0.95",
    "opencv-python==4.10.0.84",
    "tensorflow-cpu==2.15.1",
    "tf-keras==2.15.0"
)

& $PythonExe -m pip download --dest $wheelhouseDir @packages
if ($LASTEXITCODE -ne 0) {
    throw "pip download failed while preparing wheelhouse"
}

Write-Output "Face scan bundle prepared successfully."
Write-Output "You can now build the installer; Tauri bundles src-tauri/resources/face-scan/**/* automatically."
