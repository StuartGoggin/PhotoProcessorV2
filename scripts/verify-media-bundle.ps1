#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BundleDirectory,
    [Parameter(Mandatory)][string]$SourceArchive
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$bundle = (Resolve-Path -LiteralPath $BundleDirectory).Path
$manifest = Get-Content -Raw -LiteralPath (Join-Path $bundle 'build-manifest.json') | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1 -or $manifest.buildId -ne 'PhotoGoGo-rowtest1') { throw 'Unexpected managed media manifest.' }
$seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($entry in $manifest.files) {
    if ([IO.Path]::IsPathRooted($entry.path) -or $entry.path -match '(^|[\\/])\.\.([\\/]|$)') { throw 'Manifest paths must stay inside the media bundle.' }
    $path = [IO.Path]::GetFullPath((Join-Path $bundle $entry.path))
    if (-not $path.StartsWith($bundle + '\',[StringComparison]::OrdinalIgnoreCase) -or -not $seen.Add($path)) { throw 'Invalid or duplicate media manifest path.' }
    $file = Get-Item -LiteralPath $path
    if ($file.PSIsContainer -or $file.Length -ne $entry.length -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $entry.sha256) { throw "Media payload hash/length mismatch: $($entry.path)" }
}
$runtimeNames = @('ffmpeg.exe','ffprobe.exe','msvcp140.dll','vcruntime140.dll','vcruntime140_1.dll','vcomp140.dll')
foreach ($required in (@($runtimeNames | ForEach-Object { "bin/$_" }) + @('validation/quality-report.json','validation/media-report.json','validation/runtime-report.json','README-test-backend.txt'))) {
    if (-not $seen.Contains([IO.Path]::GetFullPath((Join-Path $bundle $required)))) { throw "Manifest is missing $required" }
}
foreach ($file in Get-ChildItem -LiteralPath $bundle -File -Recurse | Where-Object FullName -ne (Join-Path $bundle 'build-manifest.json')) {
    if (-not $seen.Contains($file.FullName)) { throw "Unmanifested media runtime: $($file.Name)" }
}
if (-not @(Get-ChildItem -LiteralPath (Join-Path $bundle 'licenses') -File).Count) { throw 'Media licenses are missing.' }
$ffmpegHash = (Get-FileHash -LiteralPath (Join-Path $bundle 'bin/ffmpeg.exe') -Algorithm SHA256).Hash
$quality = Get-Content -Raw -LiteralPath (Join-Path $bundle 'validation/quality-report.json') | ConvertFrom-Json
if (-not $quality.complete -or $quality.candidateSha256 -ne $ffmpegHash -or @($quality.results).Count -lt 3 -or @($quality.results | Where-Object { -not $_.matchesBaselinePixelsAndTimestamps }).Count) { throw 'Quality equivalence evidence does not validate this FFmpeg.' }
foreach ($threads in @(1,6,12)) {
    if (-not @($quality.results | Where-Object ompThreads -eq $threads).Count) { throw "Quality evidence lacks the $threads-worker case." }
}
$media = Get-Content -Raw -LiteralPath (Join-Path $bundle 'validation/media-report.json') | ConvertFrom-Json
if (-not $media.complete -or @($media.binaries).Count -ne 2) { throw 'Media smoke evidence is incomplete.' }
foreach ($check in @('filter/vidstabtransform','encoder/h264_nvenc','encoder/h264_qsv','decoder/libdav1d','muxer/image2pipe','synthetic-caption-video-audio-thumbnail-probe','software-av1-three-frame-decode')) {
    if ($media.checks -notcontains $check) { throw "Media smoke evidence lacks $check." }
}
foreach ($tool in @('ffmpeg','ffprobe')) {
    $hash = (Get-FileHash -LiteralPath (Join-Path $bundle "bin/$tool.exe") -Algorithm SHA256).Hash
    $matching = @($media.binaries | Where-Object { [IO.Path]::GetFileName($_.Path) -eq "$tool.exe" -and $_.Hash -eq $hash })
    if ($matching.Count -ne 1 -or $media.versions.$tool -notmatch 'PhotoGoGo-rowtest1') { throw "Media smoke evidence does not validate this $tool." }
}
$runtime = Get-Content -Raw -LiteralPath (Join-Path $bundle 'validation/runtime-report.json') | ConvertFrom-Json
if (-not $runtime.complete -or $runtime.architecture -ne 'x64' -or @($runtime.binaries).Count -ne $runtimeNames.Count) { throw 'Runtime closure evidence is incomplete.' }
foreach ($name in $runtimeNames) {
    $hash = (Get-FileHash -LiteralPath (Join-Path $bundle "bin/$name") -Algorithm SHA256).Hash
    if (@($runtime.binaries | Where-Object { $_.name -eq $name -and $_.sha256 -eq $hash }).Count -ne 1) { throw "Runtime closure evidence does not validate $name." }
}
$archive = Get-Item -LiteralPath $SourceArchive
if ($archive.Name -ne $manifest.sourceArchive.fileName -or (Get-FileHash -LiteralPath $archive.FullName -Algorithm SHA256).Hash -ne $manifest.sourceArchive.sha256) { throw 'Corresponding source archive is missing or does not match the bundle.' }
Write-Host "Managed media verified: $($seen.Count) payload files and $($archive.Name)."
