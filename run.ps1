param(
    [switch]$Detach,
    [switch]$CleanTarget
)

$ErrorActionPreference = "Continue"

# PhotoGoGoV2 Launcher
$msvcPath = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207\bin\Hostx64\x64"
$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"

$machinePath = [System.Environment]::GetEnvironmentVariable("PATH", "Machine")
$userPath = [System.Environment]::GetEnvironmentVariable("PATH", "User")
$env:PATH = "$msvcPath;$cargoBin;$machinePath;$userPath"
$env:CARGO_TARGET_DIR = "C:\build\photogogo"

if ($CleanTarget -and (Test-Path $env:CARGO_TARGET_DIR)) {
    Write-Host "Cleaning cargo target cache: $env:CARGO_TARGET_DIR" -ForegroundColor Yellow
    Remove-Item $env:CARGO_TARGET_DIR -Recurse -Force -ErrorAction SilentlyContinue
}

New-Item -ItemType Directory -Force $env:CARGO_TARGET_DIR | Out-Null

# Free port 1420 if in use
Get-NetTCPConnection -LocalPort 1420 -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
}

Set-Location $PSScriptRoot
Write-Host "Starting PhotoGoGoV2..." -ForegroundColor Cyan
Write-Host "Note: tauri dev is a long-running watch process; this window stays open by design." -ForegroundColor DarkCyan

if ($Detach) {
    Write-Host "Launching in a separate window (detached mode)." -ForegroundColor DarkCyan
    Start-Process -FilePath "powershell.exe" -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", "Set-Location '$PSScriptRoot'; `$env:PATH='$env:PATH'; `$env:CARGO_TARGET_DIR='$env:CARGO_TARGET_DIR'; npm run tauri dev"
    return
}

try {
    npm run tauri dev
}
catch {
    Write-Host "Launcher failed: $($_.Exception.Message)" -ForegroundColor Red
    throw
}