#Requires -Version 7.0
param([string]$CandidateDirectory='test-output/subject-handoff-slice1',[switch]$TestFaults)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$handoffRepo=Split-Path -Parent $PSScriptRoot
$handoffCandidate=[IO.Path]::GetFullPath((Join-Path $handoffRepo $CandidateDirectory))
$handoffAllowedRoot=[IO.Path]::GetFullPath((Join-Path $handoffRepo 'test-output'))+[IO.Path]::DirectorySeparatorChar
if (-not $handoffCandidate.StartsWith($handoffAllowedRoot,[StringComparison]::OrdinalIgnoreCase)) {
    throw 'Handoff build output must remain in the isolated worktree test-output.'
}
if (Test-Path -LiteralPath $handoffCandidate) {throw 'Retained build output already exists; choose a new candidate directory.'}
$handoffAncestor=$handoffCandidate
while ($handoffAncestor) {
    if (Test-Path -LiteralPath $handoffAncestor) {
        $handoffAncestorItem=Get-Item -LiteralPath $handoffAncestor -Force
        if (($handoffAncestorItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $handoffAncestorItem.PSIsContainer) {
            throw 'Handoff build ancestry must consist of ordinary directories.'
        }
    }
    $handoffNext=Split-Path -Parent $handoffAncestor
    if ($handoffNext -eq $handoffAncestor) {break}
    $handoffAncestor=$handoffNext
}
$handoffSources=@('src-tauri/native/subject_handoff/main.cpp','src-tauri/native/subject_finishing/gpu.h',
    'src-tauri/native/subject_finishing/core.h','src-tauri/native/subject_finishing/shaders.h','src-tauri/native/subject_finishing/process_owner.h',
    'scripts/build-subject-handoff.ps1')
$handoffPins=@($handoffSources | ForEach-Object {
    [pscustomobject]@{path=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $handoffRepo $_) -Algorithm SHA256).Hash.ToLowerInvariant()}
})
$handoffVsWhere=Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$handoffInstallation=& $handoffVsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or -not $handoffInstallation) {throw 'Existing MSVC and Windows SDK are required on the build PC only; nothing is installed.'}
$handoffDevCmd=Join-Path $handoffInstallation.Trim() 'Common7/Tools/VsDevCmd.bat'
$handoffEnvironment=& cmd.exe /d /s /c "call `"$handoffDevCmd`" -no_logo -arch=x64 -host_arch=x64 >nul && set"
if ($LASTEXITCODE -ne 0) {throw 'Cannot initialize the existing compiler.'}
foreach ($handoffLine in $handoffEnvironment) {
    if ($handoffLine -match '^([^=]+)=(.*)$') {[Environment]::SetEnvironmentVariable($Matches[1],$Matches[2],'Process')}
}
$handoffClaim=[IO.File]::Open($handoffCandidate+'.build-claim',[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
$handoffClaim.Dispose()
New-Item -ItemType Directory -Path $handoffCandidate | Out-Null
$handoffBin=Join-Path $handoffCandidate 'bin'
$handoffObjects=Join-Path $handoffCandidate 'objects'
New-Item -ItemType Directory -Path $handoffBin,$handoffObjects | Out-Null
$handoffExecutable=Join-Path $handoffBin 'PhotoGoGo-Finishing-Test.exe'
$handoffFaultOption=@()
if ($TestFaults) {$handoffFaultOption=@('/DPHOTOGOGO_HANDOFF_TEST_FAULTS')}
& cl.exe /nologo /std:c++17 /O2 /EHsc /W4 /WX /MT /DUNICODE /D_UNICODE @handoffFaultOption (Join-Path $handoffRepo $handoffSources[0]) "/Fo$handoffObjects/" "/Fe$handoffExecutable" /link d3d11.lib dxgi.lib d3dcompiler.lib ole32.lib shell32.lib uuid.lib user32.lib /DYNAMICBASE /NXCOMPAT /DEPENDENTLOADFLAG:0x800
if ($LASTEXITCODE -ne 0) {throw 'Native handoff compilation failed; retained output is not a validated candidate.'}
foreach ($handoffPin in $handoffPins) {
    if ((Get-FileHash -LiteralPath (Join-Path $handoffRepo $handoffPin.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $handoffPin.sha256) {
        throw 'Handoff source changed during build; no bound receipt was published.'
    }
}
$handoffReceipt=[ordered]@{schema=1;kind='native-handoff-readiness-build';sources=$handoffPins;
    executable=@{path='bin/PhotoGoGo-Finishing-Test.exe';sha256=(Get-FileHash -LiteralPath $handoffExecutable -Algorithm SHA256).Hash.ToLowerInvariant()};
    compileOptions=@('/std:c++17','/O2','/EHsc','/W4','/WX','/MT','/DYNAMICBASE','/NXCOMPAT','/DEPENDENTLOADFLAG:0x800');
    testFaultsEnabled=[bool]$TestFaults;
    mediaTestReady=$false;subjectQualityAccepted=$false;productionExportQualified=$false}
$handoffReceiptBytes=[Text.Encoding]::UTF8.GetBytes(($handoffReceipt | ConvertTo-Json -Depth 6))
$handoffReceiptFile=Join-Path $handoffCandidate 'build-receipt.json'
$handoffReceiptStream=[IO.File]::Open($handoffReceiptFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try {$handoffReceiptStream.Write($handoffReceiptBytes);$handoffReceiptStream.Flush($true)} finally {$handoffReceiptStream.Dispose()}
if ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($handoffReceiptFile))) -ne
    [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($handoffReceiptBytes))) {throw 'Build receipt read-back failed.'}
Write-Output "Built native readiness candidate: $handoffExecutable (not a video-test or release package)"
