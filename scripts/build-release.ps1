#Requires -Version 7.0
param(
    [string]$FaceBundleSource = "",
    [switch]$SkipFaceBundle,
    [switch]$ForceFaceBundle,
    [switch]$SkipDependencyInstall,
    [Parameter(Mandatory)][string]$MediaSourceArchive
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Import-MsvcBuildEnvironment {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path -LiteralPath $vswhere)) {
        throw "Visual Studio Build Tools was not found. Install Desktop development with C++ and the Windows SDK, then rerun this command."
    }

    $installationPath = & $vswhere -latest -products * `
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
        -property installationPath
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($installationPath)) {
        throw "Visual Studio Build Tools with the C++ workload was not found. Install Desktop development with C++ and the Windows SDK, then rerun this command."
    }

    $devCmd = Join-Path $installationPath.Trim() "Common7\Tools\VsDevCmd.bat"
    if (-not (Test-Path -LiteralPath $devCmd)) {
        throw "Visual Studio's developer environment script is missing: $devCmd"
    }

    $environmentLines = & cmd.exe /d /s /c "call `"$devCmd`" -no_logo -arch=x64 -host_arch=x64 >nul && set"
    if ($LASTEXITCODE -ne 0) {
        throw "Visual Studio's developer environment could not be initialised."
    }

    foreach ($line in $environmentLines) {
        if ($line -match '^([^=]+)=(.*)$') {
            [System.Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], "Process")
        }
    }
}

$npmInvoker = Join-Path $PSScriptRoot "invoke-npm.ps1"
if (-not (Test-Path -LiteralPath $npmInvoker)) {
    throw "Build launcher is missing: $npmInvoker"
}

$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if (Test-Path -LiteralPath $cargoBin) {
    $env:PATH = "$cargoBin;$env:PATH"
}

Import-MsvcBuildEnvironment

# A release must ship the exact media pair exercised by the evidence reports,
# together with its runtime closure and corresponding-source deliverable.
& (Join-Path $PSScriptRoot 'verify-media-bundle.ps1') `
    -BundleDirectory (Join-Path $repoRoot 'src-tauri/tools/ffmpeg') `
    -SourceArchive $MediaSourceArchive

$cargo = Get-Command cargo.exe -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
if (-not $cargo) {
    throw "Rust/Cargo was not found. Install the Rust MSVC stable toolchain, reopen PowerShell, then rerun this command."
}

& $cargo.Source --version 2>$null
if ($LASTEXITCODE -ne 0) {
    throw "Rustup is installed but no active Rust toolchain is available. Install the Rust MSVC stable toolchain, reopen PowerShell, then rerun this command."
}

$linker = Get-Command link.exe -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
if (-not $linker) {
    throw "The Microsoft C++ linker (link.exe) was not found. Install Visual Studio Build Tools with Desktop development with C++ and the Windows SDK, then run this command from a Developer PowerShell."
}

if (-not $SkipDependencyInstall) {
    & $npmInvoker "ci" "--no-audit"
    if ($LASTEXITCODE -ne 0) {
        throw "npm ci failed. Check connectivity to registry.npmjs.org and rerun the release command."
    }
}

$requiredDependency = Join-Path $repoRoot "node_modules\@tauri-apps\cli-win32-x64-msvc\cli.win32-x64-msvc.node"
if (-not (Test-Path -LiteralPath $requiredDependency)) {
    throw "Node dependencies are incomplete: expected $requiredDependency. Run the release command without -SkipDependencyInstall after restoring npm registry connectivity."
}

if (-not $SkipFaceBundle) {
    $ensureScript = Join-Path $PSScriptRoot "ensure-face-bundle.ps1"
    if ([string]::IsNullOrWhiteSpace($FaceBundleSource)) {
        & $ensureScript -Force:$ForceFaceBundle
    } else {
        & $ensureScript -BundleSource $FaceBundleSource -Force:$ForceFaceBundle
    }
}

& $npmInvoker "run" "tauri" "--" "build" "--" "--locked"
if ($LASTEXITCODE -ne 0) {
    throw "Tauri build failed. See the command output above for the first compiler or bundler error."
}
