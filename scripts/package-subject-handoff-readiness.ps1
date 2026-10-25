#Requires -Version 7.0
param(
    [string]$CandidateDirectory='test-output/subject-handoff-readiness-v7',
    [string]$FaultCandidateDirectory='test-output/subject-handoff-fault-v7',
    [string]$OutputDirectory='test-output/subject-handoff-readiness-package-v2'
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$handoffRepo=Split-Path -Parent $PSScriptRoot
$handoffTestRoot=[IO.Path]::GetFullPath((Join-Path $handoffRepo 'test-output'))+[IO.Path]::DirectorySeparatorChar
function Resolve-HandoffCandidate([string]$value) {
    $resolved=[IO.Path]::GetFullPath((Join-Path $handoffRepo $value))
    if (-not $resolved.StartsWith($handoffTestRoot,[StringComparison]::OrdinalIgnoreCase)) {throw 'Only isolated test-output candidates are admitted.'}
    $ancestor=$resolved
    while ($ancestor) {
        if (Test-Path -LiteralPath $ancestor) {
            $item=Get-Item -LiteralPath $ancestor -Force
            if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {throw 'Ordinary local package directories are required.'}
        }
        $next=Split-Path -Parent $ancestor
        if ($next -eq $ancestor) {break};$ancestor=$next
    }
    return $resolved
}
function Get-HandoffHash([string]$file) {
    $item=Get-Item -LiteralPath $file -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -le 0 -or $item.Length -gt 8MB) {
        throw 'Only ordinary bounded readiness artifacts are admitted.'
    }
    return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
}
$handoffCandidate=Resolve-HandoffCandidate $CandidateDirectory
$handoffFault=Resolve-HandoffCandidate $FaultCandidateDirectory
$handoffOutput=Resolve-HandoffCandidate $OutputDirectory
if (Test-Path -LiteralPath $handoffOutput) {throw 'Retained package output already exists; choose a new directory.'}
$handoffReceiptPath=Join-Path $handoffCandidate 'build-receipt.json'
$handoffReceiptHash=Get-HandoffHash $handoffReceiptPath
$handoffBuild=Get-Content -LiteralPath $handoffReceiptPath -Raw | ConvertFrom-Json
if ($handoffBuild.schema -ne 1 -or $handoffBuild.kind -ne 'native-handoff-readiness-build' -or $handoffBuild.testFaultsEnabled -ne $false -or
    $handoffBuild.mediaTestReady -ne $false -or $handoffBuild.subjectQualityAccepted -ne $false -or $handoffBuild.productionExportQualified -ne $false -or
    $handoffBuild.executable.path -ne 'bin/PhotoGoGo-Finishing-Test.exe') {throw 'Only the unmodified readiness-only normal build can be packaged.'}
$handoffExpectedSources=@('src-tauri/native/subject_handoff/main.cpp','src-tauri/native/subject_finishing/gpu.h',
    'src-tauri/native/subject_finishing/core.h','src-tauri/native/subject_finishing/shaders.h','src-tauri/native/subject_finishing/process_owner.h','scripts/build-subject-handoff.ps1')
if ((($handoffExpectedSources | Sort-Object) -join ',') -cne (($handoffBuild.sources.path | Sort-Object) -join ',')) {throw 'Unexpected readiness source inventory.'}
$handoffBinary=Join-Path $handoffCandidate $handoffBuild.executable.path
function Confirm-HandoffBuild {
    if ((Get-HandoffHash $handoffReceiptPath) -cne $handoffReceiptHash -or (Get-HandoffHash $handoffBinary) -cne $handoffBuild.executable.sha256) {
        throw 'The normal executable or its build receipt changed.'
    }
    foreach ($source in $handoffBuild.sources) {
        if ((Get-HandoffHash (Join-Path $handoffRepo $source.path)) -cne $source.sha256) {throw 'The normal build source pins are stale.'}
    }
}
Confirm-HandoffBuild
$handoffTests=@(
    @{script='test-subject-handoff.mjs';seam='native-user-run-readiness';candidate=$handoffBinary},
    @{script='test-subject-handoff-write-lease.mjs';seam='native-report-ancestor-write-lease';candidate=$handoffBinary},
    @{script='test-subject-handoff-paths.mjs';seam='native-report-path-refusal';candidate=$handoffBinary},
    @{script='test-subject-handoff-executable-alias.mjs';seam='native-executable-alias-refusal';candidate=$handoffBinary},
    @{script='test-subject-handoff-redaction.mjs';seam='native-unclassified-failure-redaction';candidate=(Join-Path $handoffFault 'bin/PhotoGoGo-Finishing-Test.exe')},
    @{script='test-subject-handoff-timeout.mjs';seam='native-hardware-inspection-deadline';candidate=(Join-Path $handoffFault 'bin/PhotoGoGo-Finishing-Test.exe')}
)
$handoffTestResults=@()
Push-Location $handoffRepo
try {
    foreach ($test in $handoffTests) {
        $testOutput=@(& node.exe (Join-Path $PSScriptRoot $test.script) $test.candidate)
        if ($LASTEXITCODE -ne 0 -or $testOutput.Count -ne 1) {throw 'Native readiness validation failed; no package published.'}
        $result=$testOutput[0] | ConvertFrom-Json
        if ($result.event -ne 'passed' -or $result.seam -ne $test.seam -or $result.productionExportQualified -ne $false) {throw 'Unexpected validation result.'}
        $handoffTestResults+=@{seam=$test.seam;passed=$true;scriptSha256=(Get-HandoffHash (Join-Path $PSScriptRoot $test.script))}
    }
} finally {Pop-Location}
# Independently inspect the actual PE, not just declared link options.
$handoffVsWhere=Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$handoffVs=(& $handoffVsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath).Trim()
if ($LASTEXITCODE -ne 0 -or -not $handoffVs) {throw 'Existing PE inspection tool unavailable; nothing is installed.'}
$handoffCompilerVersion=(Get-Content -LiteralPath (Join-Path $handoffVs 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt')).Trim()
$handoffDumpBin=Join-Path $handoffVs ('VC/Tools/MSVC/'+$handoffCompilerVersion+'/bin/Hostx64/x64/dumpbin.exe')
$handoffPe=(& $handoffDumpBin /loadconfig /imports $handoffBinary) -join "`n"
if ($LASTEXITCODE -ne 0 -or $handoffPe -notmatch '(?m)^\s+0800 Dependent Load Flag\s*$') {throw 'Actual startup DLL policy is not verified.'}
$handoffPeVersion=[regex]::Match($handoffPe,'(?m)^Microsoft \(R\) COFF/PE Dumper Version ([0-9.]+)')
if (-not $handoffPeVersion.Success) {throw 'Actual PE tool version cannot be recorded.'}
$handoffImports=@([regex]::Matches($handoffPe,'(?im)^\s+([a-z0-9_.-]+\.dll)\s*$') | ForEach-Object {$_.Groups[1].Value.ToLowerInvariant()} | Sort-Object -Unique)
$handoffExpectedImports=@('d3d11.dll','dxgi.dll','d3dcompiler_47.dll','ole32.dll','user32.dll','kernel32.dll') | Sort-Object
if (($handoffImports -join ',') -cne ($handoffExpectedImports -join ',')) {throw 'Unexpected non-system DLL prerequisite.'}
Confirm-HandoffBuild
$handoffClaim=[IO.File]::Open($handoffOutput+'.package-claim',[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
$handoffClaim.Dispose()
New-Item -ItemType Directory -Path $handoffOutput | Out-Null
$handoffPayload=Join-Path $handoffOutput 'payload'
New-Item -ItemType Directory -Path $handoffPayload | Out-Null
$handoffFiles=@()
function Add-HandoffFile([string]$source,[string]$relative) {
    $before=Get-HandoffHash $source
    $target=Join-Path $handoffPayload $relative
    [IO.Directory]::CreateDirectory((Split-Path -Parent $target)) | Out-Null
    $input=[IO.File]::Open($source,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        $output=[IO.File]::Open($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try {$input.CopyTo($output);$output.Flush($true)} finally {$output.Dispose()}
    } finally {$input.Dispose()}
    if ((Get-HandoffHash $target) -cne $before -or (Get-HandoffHash $source) -cne $before) {throw 'Package copy identity changed.'}
    $script:handoffFiles+=@{path=$relative;bytes=(Get-Item -LiteralPath $target).Length;sha256=$before}
}
function Write-HandoffJson([string]$relative,$value) {
    $target=Join-Path $handoffPayload $relative
    [IO.Directory]::CreateDirectory((Split-Path -Parent $target)) | Out-Null
    $bytes=[Text.Encoding]::UTF8.GetBytes(($value | ConvertTo-Json -Depth 10))
    $stream=[IO.File]::Open($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {$stream.Write($bytes);$stream.Flush($true)} finally {$stream.Dispose()}
    $expected=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    if ((Get-HandoffHash $target) -cne $expected) {throw 'Package JSON read-back failed.'}
    if ($relative -ne 'package-receipt.json') {$script:handoffFiles+=@{path=$relative;bytes=$bytes.Length;sha256=$expected}}
}
Add-HandoffFile $handoffBinary 'bin/PhotoGoGo-Finishing-Test.exe'
Add-HandoffFile $handoffReceiptPath 'evidence/development-build-receipt.json'
Add-HandoffFile (Join-Path $handoffRepo 'docs/subject-handoff-readiness-README.txt') 'README.txt'
foreach ($source in $handoffBuild.sources) {Add-HandoffFile (Join-Path $handoffRepo $source.path) ('source/'+$source.path)}
Write-HandoffJson 'evidence/readiness-validation.json' @{schema=1;kind='native-readiness-qualification';tests=$handoffTestResults;
    actualPeDependentLoadFlag='0800';actualDirectImports=$handoffImports;sourceCount=6;sourceAndBinaryBoundBeforeAndAfter=$true;
    developerPeToolVersion=$handoffPeVersion.Groups[1].Value;developerCompilerDirectoryVersion=$handoffCompilerVersion;
    interactivePickerExercised=$false;nvidiaMediaTested=$false;
    inferenceRuntimeBundled=$false;mediaTestReady=$false;subjectQualityAccepted=$false;productionExportQualified=$false}
Confirm-HandoffBuild
Write-HandoffJson 'package-receipt.json' @{schema=1;kind='photogogo-readiness-control-package';testFaultsEnabled=$false;
    unsigned=$true;files=$handoffFiles;mediaTestReady=$false;subjectQualityAccepted=$false;productionExportQualified=$false;
    createdAtUtc=[DateTime]::UtcNow.ToString('o')}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$handoffZip=Join-Path $handoffOutput 'PhotoGoGo-Readiness-Test.zip'
$handoffZipStream=[IO.File]::Open($handoffZip,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try {
    $archive=[IO.Compression.ZipArchive]::new($handoffZipStream,[IO.Compression.ZipArchiveMode]::Create,$true)
    try {
        foreach ($file in @($handoffFiles)+@(@{path='package-receipt.json'})) {
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,(Join-Path $handoffPayload $file.path),$file.path,[IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    } finally {$archive.Dispose()}
    $handoffZipStream.Flush($true)
} finally {$handoffZipStream.Dispose()}
Confirm-HandoffBuild
Write-Output (@{event='readinessPackageCreated';zip=$handoffZip;sha256=(Get-HandoffHash $handoffZip);mediaTestReady=$false;productionExportQualified=$false} | ConvertTo-Json -Compress)
