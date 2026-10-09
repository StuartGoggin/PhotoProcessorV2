#Requires -Version 7.0
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = Split-Path -Parent $PSScriptRoot
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$installation = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or -not $installation) { throw 'Existing MSVC/Windows SDK tools are required; this script does not install dependencies.' }
$devCmd = Join-Path $installation.Trim() 'Common7/Tools/VsDevCmd.bat'
$lines = & cmd.exe /d /s /c "call `"$devCmd`" -no_logo -arch=x64 -host_arch=x64 >nul && set"
if ($LASTEXITCODE -ne 0) { throw 'Could not initialise the existing MSVC environment.' }
foreach ($line in $lines) {
    if ($line -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') }
}
$output = Join-Path $repoRoot 'src-tauri/tools/gpu-tripod'
$objects = Join-Path $repoRoot 'test-output/gpu-tripod-build'
New-Item -ItemType Directory -Path $output, $objects -Force | Out-Null
$source = Join-Path $repoRoot 'src-tauri/native/gpu_tripod/main.cpp'
$binary = Join-Path $output 'photogogo-gpu-tripod.exe'
$shaderSource = Join-Path $repoRoot 'src-tauri/native/gpu_tripod/compile_shaders.cpp'
$shaderCompiler = Join-Path $objects 'compile-shaders.exe'
& cl.exe /nologo /std:c++17 /O2 /EHsc /W4 /MT /DUNICODE /D_UNICODE $shaderSource "/Fo$objects/" "/Fe$shaderCompiler" /link d3dcompiler.lib /DYNAMICBASE /NXCOMPAT
if ($LASTEXITCODE -ne 0) { throw 'Original shader compiler build failed.' }
& $shaderCompiler (Join-Path $objects 'compiled-shaders.h')
if ($LASTEXITCODE -ne 0) { throw 'Original shader compilation failed.' }
& cl.exe /nologo /std:c++17 /O2 /EHsc /W4 /MT /DUNICODE /D_UNICODE /DPHOTOGOGO_EMBED_SHADERS "/I$objects" $source "/Fo$objects/" "/Fe$binary" /link d3d11.lib dxgi.lib /DYNAMICBASE /NXCOMPAT
if ($LASTEXITCODE -ne 0) { throw 'GPU Tripod compilation failed.' }
& (Join-Path $PSScriptRoot 'test-gpu-tripod.ps1') -WorkerPath $binary
if ($LASTEXITCODE -ne 0) { throw 'GPU Tripod hardware validation failed.' }
$receipt = [pscustomobject]@{
    engine = 'gpu-tripod-d3d11-v1'
    builtAtUtc = [DateTime]::UtcNow.ToString('o')
    worker = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash
    sources = @(Get-ChildItem -LiteralPath (Split-Path -Parent $source) -File | Where-Object Extension -in '.cpp','.h' | Sort-Object Name | ForEach-Object {
        [pscustomobject]@{ name=$_.Name; sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
    })
}
[IO.File]::WriteAllText((Join-Path $objects 'build-receipt.json'),($receipt | ConvertTo-Json -Depth 5))
