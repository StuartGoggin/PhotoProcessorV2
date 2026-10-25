#Requires -Version 7.0
param([switch]$ReferenceOnly, [string]$CandidateDirectory)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$subjectRepo = Split-Path -Parent $PSScriptRoot
$subjectSourceNames = @('core.h','gpu.h','mask_cache.h','process_owner.h','media_contract.h','media_pipeline.h','main.cpp','tests.cpp')
$subjectSourcePins = @($subjectSourceNames | ForEach-Object {
    $subjectSourcePath = Join-Path $subjectRepo "src-tauri/native/subject_finishing/$_"
    [pscustomobject]@{ path = "src-tauri/native/subject_finishing/$_"; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $subjectSourcePath).Hash.ToLowerInvariant() }
})
$subjectVsWhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$subjectInstallation = & $subjectVsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or -not $subjectInstallation) {
    throw 'Existing MSVC and Windows SDK are required. No dependency is installed by this script.'
}
$subjectDevCmd = Join-Path $subjectInstallation.Trim() 'Common7/Tools/VsDevCmd.bat'
$subjectEnvLines = & cmd.exe /d /s /c "call `"$subjectDevCmd`" -no_logo -arch=x64 -host_arch=x64 >nul && set"
if ($LASTEXITCODE -ne 0) { throw 'Could not initialize the existing MSVC environment.' }
foreach ($subjectEnvLine in $subjectEnvLines) {
    if ($subjectEnvLine -match '^([^=]+)=(.*)$') {
        [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
    }
}
if ($CandidateDirectory) {
    $subjectCandidate = [IO.Path]::GetFullPath((Join-Path $subjectRepo $CandidateDirectory))
    $subjectCandidateRoot = [IO.Path]::GetFullPath((Join-Path $subjectRepo 'test-output')) + [IO.Path]::DirectorySeparatorChar
    if (-not $subjectCandidate.StartsWith($subjectCandidateRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Candidate builds must stay inside this isolated repository test-output directory.'
    }
    if (Test-Path -LiteralPath $subjectCandidate) { throw 'Candidate output already exists; retained evidence is never overwritten.' }
    # A lexical prefix is insufficient if a descendant directory is a junction.
    # Inspect existing ancestors before creating anything; do not follow redirection.
    $subjectAncestor = $subjectCandidate
    while ($subjectAncestor) {
        if (Test-Path -LiteralPath $subjectAncestor) {
            $subjectAncestorItem = Get-Item -LiteralPath $subjectAncestor -Force
            if ($subjectAncestorItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'Candidate output ancestry must not contain a reparse point.'
            }
            if (-not $subjectAncestorItem.PSIsContainer) { throw 'Candidate output ancestor must be a directory.' }
        }
        $subjectAncestor = Split-Path -Parent $subjectAncestor
    }
    $subjectObjects = Join-Path $subjectCandidate 'objects'
    $subjectTools = Join-Path $subjectCandidate 'worker'
    # CreateNew is the atomic claim: concurrent ordinary invocations cannot
    # both become owners, even if their preceding absence checks raced.
    # Retain the claim after failure; retries must select a fresh evidence name.
    $subjectBuildClaim = [IO.File]::Open($subjectCandidate + '.build-claim', [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $subjectBuildClaim.Dispose()
    New-Item -ItemType Directory -Path $subjectCandidate | Out-Null
} else {
    $subjectObjects = Join-Path $subjectRepo 'test-output/subject-finishing-build'
    $subjectTools = Join-Path $subjectRepo 'src-tauri/tools/subject-finishing'
}
New-Item -ItemType Directory -Path $subjectObjects, $subjectTools -Force | Out-Null
$subjectTest = Join-Path $subjectObjects 'subject-finishing-reference-tests.exe'
$subjectSource = Join-Path $subjectRepo 'src-tauri/native/subject_finishing/tests.cpp'
& cl.exe /nologo /std:c++17 /O2 /EHsc /W4 /WX /MT $subjectSource "/Fo$subjectObjects/" "/Fe$subjectTest" /link /DYNAMICBASE /NXCOMPAT
if ($LASTEXITCODE -ne 0) { throw 'Subject finishing reference compilation failed.' }
& $subjectTest
if ($LASTEXITCODE -ne 0) { throw 'Subject finishing reference validation failed.' }
if (-not $ReferenceOnly) {
    $subjectMain = Join-Path $subjectRepo 'src-tauri/native/subject_finishing/main.cpp'
    $subjectWorker = Join-Path $subjectTools 'photogogo-subject-finishing.exe'
    & cl.exe /nologo /std:c++17 /O2 /EHsc /W4 /WX /MT /DUNICODE /D_UNICODE $subjectMain "/Fo$subjectObjects/" "/Fe$subjectWorker" /link d3d11.lib dxgi.lib d3dcompiler.lib /DYNAMICBASE /NXCOMPAT
    if ($LASTEXITCODE -ne 0) { throw 'Subject finishing GPU worker compilation failed.' }
    & (Join-Path $PSScriptRoot 'test-subject-finishing-worker.ps1') -WorkerPath $subjectWorker
    if ($LASTEXITCODE -ne 0) { throw 'Subject finishing GPU worker validation failed.' }
    $subjectRunner=Join-Path $subjectTools 'runner'
    New-Item -ItemType Directory -Path $subjectRunner -Force | Out-Null
    foreach ($subjectModule in @('subject_mask_worker.py','subject_mask_job.py','subject_masks_contract.py','subject_mask_cache.py','subject_media_contract.py','subject_process.py')) {
        Copy-Item -LiteralPath (Join-Path $subjectRepo "src-tauri/scripts/$subjectModule") -Destination (Join-Path $subjectRunner $subjectModule) -Force
    }
}
foreach ($subjectPin in $subjectSourcePins) {
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $subjectRepo $subjectPin.path)).Hash.ToLowerInvariant() -ne $subjectPin.sha256) {
        throw 'Native source changed during candidate build; no bound build receipt will be published.'
    }
}
if ($CandidateDirectory) {
    $subjectReceipt = [ordered]@{
        schema = 1; referenceOnly = [bool]$ReferenceOnly; sources = $subjectSourcePins
        reference = @{ path = 'objects/subject-finishing-reference-tests.exe'; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $subjectTest).Hash.ToLowerInvariant() }
        worker = $(if ($ReferenceOnly) { $null } else { @{ path = 'worker/photogogo-subject-finishing.exe'; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $subjectWorker).Hash.ToLowerInvariant() } })
        compileOptions = @('/std:c++17','/O2','/EHsc','/W4','/WX','/MT','/DYNAMICBASE','/NXCOMPAT')
        subjectQualityAccepted = $false; exportQualified = $false
    }
    $subjectReceiptBytes = [Text.Encoding]::UTF8.GetBytes(($subjectReceipt | ConvertTo-Json -Depth 5))
    $subjectReceiptPath = Join-Path $subjectCandidate 'build-receipt.json'
    $subjectReceiptStream = [IO.File]::Open($subjectReceiptPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $subjectReceiptStream.Write($subjectReceiptBytes); $subjectReceiptStream.Flush($true) }
    finally { $subjectReceiptStream.Dispose() }
    if ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($subjectReceiptPath))) -ne
        [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($subjectReceiptBytes))) {
        throw 'Candidate build receipt read-back failed.'
    }
}
