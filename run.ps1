# PhotoGoGoV2 Launcher
$msvcPath = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207\bin\Hostx64\x64"
$env:PATH = "$msvcPath;" + [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH","User")
$env:CARGO_TARGET_DIR = "C:\build\photogogo"

New-Item -ItemType Directory -Force "C:\build\photogogo" | Out-Null

# Free port 1420 if in use
Get-NetTCPConnection -LocalPort 1420 -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
}

Set-Location $PSScriptRoot
Write-Host "Starting PhotoGoGoV2..." -ForegroundColor Cyan
npm run tauri dev