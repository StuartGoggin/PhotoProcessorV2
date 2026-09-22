#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root ('test-output\media-manifest-' + [Guid]::NewGuid().ToString('N'))
$bundle = Join-Path $out 'bundle'
$null = New-Item -ItemType Directory -Path "$bundle/bin","$bundle/licenses","$bundle/validation"
# Tiny text fixtures exercise the packaging contract; they are never executed.
foreach ($name in @('ffmpeg','ffprobe')) { "$name fixture" | Set-Content -LiteralPath "$bundle/bin/$name.exe" }
foreach ($name in @('msvcp140.dll','vcruntime140.dll','vcruntime140_1.dll','vcomp140.dll')) { "$name fixture" | Set-Content -LiteralPath "$bundle/bin/$name" }
'license fixture' | Set-Content -LiteralPath "$bundle/licenses/COPYING.txt"
'readme fixture' | Set-Content -LiteralPath "$bundle/README-test-backend.txt"
'archive fixture' | Set-Content -LiteralPath "$out/source.zip"
$hashes = @('ffmpeg','ffprobe') | ForEach-Object { Get-FileHash -LiteralPath "$bundle/bin/$_.exe" | Select-Object Path,Hash }
@{complete=$true;candidateSha256=$hashes[0].Hash;results=@(1,6,12 | ForEach-Object { @{ompThreads=$_;matchesBaselinePixelsAndTimestamps=$true} })} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$bundle/validation/quality-report.json"
@{complete=$true;binaries=@($hashes);versions=@{ffmpeg='PhotoGoGo-rowtest1';ffprobe='PhotoGoGo-rowtest1'};checks=@('filter/vidstabtransform','encoder/h264_nvenc','encoder/h264_qsv','decoder/libdav1d','muxer/image2pipe','synthetic-caption-video-audio-thumbnail-probe','software-av1-three-frame-decode')} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$bundle/validation/media-report.json"
@{complete=$true;architecture='x64';binaries=@(Get-ChildItem -LiteralPath "$bundle/bin" -File | ForEach-Object { @{name=$_.Name;sha256=(Get-FileHash -LiteralPath $_.FullName).Hash} })} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$bundle/validation/runtime-report.json"
$manifest = @{schemaVersion=1;buildId='PhotoGoGo-rowtest1';sourceArchive=@{fileName='source.zip';sha256=(Get-FileHash -LiteralPath "$out/source.zip").Hash};files=@()}
foreach ($file in Get-ChildItem -LiteralPath $bundle -Recurse -File) { $manifest.files += @{path=[IO.Path]::GetRelativePath($bundle,$file.FullName);length=$file.Length;sha256=(Get-FileHash -LiteralPath $file.FullName).Hash} }
function Save-Manifest { $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath "$bundle/build-manifest.json" }
function Verify { & "$PSScriptRoot/verify-media-bundle.ps1" -BundleDirectory $bundle -SourceArchive "$out/source.zip" }
function Must-Reject([string]$Label) {
    $rejected=$false
    try { Verify } catch { $rejected=$true }
    if (-not $rejected) { throw "Expected rejection: $Label" }
    Write-Host "PASS rejection: $Label"
}
Save-Manifest
Verify
$savedHash=$manifest.files[0].sha256
$manifest.files[0].sha256='0'*64
Save-Manifest
Must-Reject 'modified payload'
$manifest.files[0].sha256=$savedHash
$savedPath=$manifest.files[0].path
$manifest.files[0].path='../outside.txt'
Save-Manifest
Must-Reject 'path traversal'
$manifest.files[0].path=$savedPath
$savedSource=$manifest.sourceArchive.sha256
$manifest.sourceArchive.sha256='0'*64
Save-Manifest
Must-Reject 'wrong source archive'
$manifest.sourceArchive.sha256=$savedSource
Save-Manifest
$probeEntry = @($manifest.files | Where-Object { [IO.Path]::GetFileName($_.path) -eq 'ffprobe.exe' })[0]
$originalProbe = [IO.File]::ReadAllBytes("$bundle/bin/ffprobe.exe")
$originalProbeHash = $probeEntry.sha256
$originalProbeLength = $probeEntry.length
Copy-Item -LiteralPath "$bundle/bin/ffmpeg.exe" -Destination "$bundle/bin/ffprobe.exe" -Force
$probeEntry.sha256=(Get-FileHash -LiteralPath "$bundle/bin/ffprobe.exe").Hash
$probeEntry.length=(Get-Item -LiteralPath "$bundle/bin/ffprobe.exe").Length
Save-Manifest
Must-Reject 'FFmpeg accidentally copied as ffprobe with refreshed outer manifest'
[IO.File]::WriteAllBytes("$bundle/bin/ffprobe.exe",$originalProbe)
$probeEntry.sha256=$originalProbeHash
$probeEntry.length=$originalProbeLength
Save-Manifest
foreach ($case in @('quality-report','media-report','runtime-report')) {
    $evidencePath="$bundle/validation/$case.json"
    $originalEvidence=[IO.File]::ReadAllBytes($evidencePath)
    $entry=@($manifest.files | Where-Object { [IO.Path]::GetFileName($_.path) -eq "$case.json" })[0]
    $originalHash=$entry.sha256
    $originalLength=$entry.length
    $evidence=Get-Content -Raw -LiteralPath $evidencePath | ConvertFrom-Json
    if ($case -eq 'quality-report') { foreach ($row in $evidence.results) { $row.ompThreads=1 } }
    elseif ($case -eq 'media-report') { $evidence.checks=@() }
    else { $evidence.binaries[0].sha256='0'*64 }
    $evidence | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $evidencePath
    $entry.sha256=(Get-FileHash -LiteralPath $evidencePath).Hash
    $entry.length=(Get-Item -LiteralPath $evidencePath).Length
    Save-Manifest
    Must-Reject "$case missing semantic coverage with refreshed outer manifest"
    [IO.File]::WriteAllBytes($evidencePath,$originalEvidence)
    $entry.sha256=$originalHash
    $entry.length=$originalLength
    Save-Manifest
}
'untracked runtime' | Set-Content -LiteralPath "$bundle/bin/unexpected.dll"
Must-Reject 'unmanifested runtime'
Write-Host 'Manifest contract: valid fixture and eight rejection cases passed.'
