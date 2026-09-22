#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$QualityReport,
    [Parameter(Mandatory)][string]$MediaReport,
    [Parameter(Mandatory)][string]$RuntimeReport
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$base = Join-Path $root 'test-output/ffmpeg-row-backport'
$bundle = Join-Path $root 'src-tauri/tools/ffmpeg'
$delivery = Join-Path $root 'test-output/media-delivery'
if (Test-Path -LiteralPath $bundle) { throw 'Refusing to overwrite an existing staged backend.' }
$null = New-Item -ItemType Directory -Path "$bundle/bin","$bundle/licenses","$bundle/validation",$delivery -Force
foreach ($name in @('ffmpeg.exe','ffprobe.exe','msvcp140.dll','vcruntime140.dll','vcruntime140_1.dll','vcomp140.dll')) {
    Copy-Item -LiteralPath "$base/ffmpeg-build/$name" -Destination "$bundle/bin/$name"
}
$licenseFiles = @{
    'ffmpeg-source/COPYING.GPLv2'='FFmpeg-GPLv2.txt'; 'ffmpeg-source/COPYING.GPLv3'='FFmpeg-GPLv3.txt'
    'ffmpeg-source/COPYING.LGPLv2.1'='FFmpeg-LGPLv2.1.txt'; 'ffmpeg-source/COPYING.LGPLv3'='FFmpeg-LGPLv3.txt'
    'ffmpeg-source/LICENSE.md'='FFmpeg-LICENSE.md'; 'vidstab-source/LICENSE'='vid.stab-LICENSE.txt'
    'x264-source/COPYING'='x264-COPYING.txt'; 'vpl-source/LICENSE'='Intel-VPL-LICENSE.txt'
    'freetype-VER-2-13-3/LICENSE.TXT'='FreeType-LICENSE.txt'; 'freetype-VER-2-13-3/docs/FTL.TXT'='FreeType-FTL.txt'
    'harfbuzz-10.4.0/COPYING'='HarfBuzz-COPYING.txt'; 'harfbuzz-10.4.0/src/ms-use/COPYING'='HarfBuzz-ms-use-COPYING.txt'
    'zlib-1.3.1/LICENSE'='zlib-LICENSE.txt'; 'dav1d-1.5.3/COPYING'='dav1d-COPYING.txt'
    # The NVIDIA interface-header license is embedded in this source header.
    'nv-codec-headers/include/ffnvcodec/nvEncodeAPI.h'='NVIDIA-nvEncodeAPI.h'
}
foreach ($entry in $licenseFiles.GetEnumerator()) { Copy-Item -LiteralPath (Join-Path $base $entry.Key) -Destination (Join-Path "$bundle/licenses" $entry.Value) }
Copy-Item -LiteralPath "$root/docs/ffmpeg-test-backend-readme.txt" -Destination "$bundle/README-test-backend.txt"
Copy-Item -LiteralPath "$root/docs/ffmpeg-row-backport-build.md","$root/docs/ffmpeg-dependency-recipe.md" -Destination $bundle
# Remove workstation-specific paths from distributed evidence, retaining hashes,
# arguments relative to the checkout, timings, outcomes and limitations.
foreach ($entry in @(@{source=$QualityReport;name='quality'},@{source=$MediaReport;name='media'},@{source=$RuntimeReport;name='runtime'})) {
    $json = Get-Content -Raw -LiteralPath $entry.source
    $json = $json.Replace($root.Replace('\','\\'),'CHECKOUT')
    $json | Set-Content -LiteralPath "$bundle/validation/$($entry.name)-report.json" -Encoding utf8
}

# Archive source in place: no duplicate source tree and no git metadata, media,
# object files, executables, raw build logs, or environment dumps.
$sourceDirs = @('ffmpeg-source','vidstab-source','nv-codec-headers','x264-source','vpl-source','freetype-VER-2-13-3','harfbuzz-10.4.0','zlib-1.3.1','make-4.4.1','nasm-2.16.03','pkgconf-pkgconf-2.3.0','dav1d-1.5.3','meson-1.9.1')
$files = [Collections.Generic.List[string]]::new()
foreach ($dir in $sourceDirs) {
    foreach ($file in Get-ChildItem -LiteralPath (Join-Path $base $dir) -File -Recurse -Force) {
        $relative = [IO.Path]::GetRelativePath($root,$file.FullName).Replace('\','/')
        if ($relative -match '/(\.git|__pycache__|WinRel|WinDebug|\.vs)/' -or $file.Extension -match '^\.(o|obj|a|lib|exe|dll|pdb|pyc|ilk|idb|ipch|tlog)$' -or $file.Name -match '^(config\.log|config\.status|.*\.log)$') { continue }
        $files.Add($relative)
    }
}
foreach ($path in @('scripts/diagnostics','test-output/ffmpeg-row-backport/prefix/lib/pkgconfig')) {
    foreach ($file in Get-ChildItem -LiteralPath (Join-Path $root $path) -Recurse -File) {
        if ($file.Extension -match '^\.(exe|dll|pdb|obj|o|pyc)$') { continue }
        $files.Add([IO.Path]::GetRelativePath($root,$file.FullName).Replace('\','/'))
    }
}
foreach ($path in @('docs/ffmpeg-row-backport-build.md','docs/ffmpeg-dependency-recipe.md','docs/ffmpeg-test-backend-readme.txt','scripts/test-low-disk-ffmpeg.ps1','scripts/benchmark-quality-pipeline.ps1','scripts/verify-media-bundle.ps1','scripts/test-media-bundle-manifest.ps1','test-output/quality-pipeline-20260921T202819652Z/motion.trf')) { $files.Add($path) }
$fileList = @($files | Sort-Object -Unique)
$fileList | Set-Content -LiteralPath "$delivery/source-files.txt" -Encoding utf8NoBOM
$archive = Join-Path $delivery 'PhotoGoGo-FFmpeg-rowtest1-source.tar.gz'
if (Test-Path -LiteralPath $archive) { throw 'Refusing to replace an existing source archive.' }
& tar.exe -czf $archive -C $root -T "$delivery/source-files.txt"
if ($LASTEXITCODE -ne 0) { throw 'Source archiving failed.' }
$listing = @(& tar.exe -tzf $archive)
if ($LASTEXITCODE -ne 0 -or @(Compare-Object $fileList $listing).Count) { throw 'Source archive file listing does not match its inputs.' }
$checkDir = Join-Path $delivery 'source-extraction-check'
$null = New-Item -ItemType Directory -Path $checkDir
$critical = @('test-output/ffmpeg-row-backport/vidstab-source/src/transformfixedpoint.c','test-output/ffmpeg-row-backport/vidstab-source/src/serialize.c','test-output/ffmpeg-row-backport/ffmpeg-source/configure','scripts/diagnostics/vidstab-backport/vidstab-v1.1.1.patch','scripts/diagnostics/build-ffmpeg-candidate.ps1','docs/ffmpeg-dependency-recipe.md')
& tar.exe -xzf $archive -C $checkDir @critical
if ($LASTEXITCODE -ne 0) { throw 'Source extraction verification failed.' }
foreach ($path in $critical) {
    if ((Get-FileHash -LiteralPath (Join-Path $root $path)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $checkDir $path)).Hash) { throw "Archived source differs: $path" }
}
$manifest = @{schemaVersion=1;buildId='PhotoGoGo-rowtest1';sourceArchive=@{fileName=[IO.Path]::GetFileName($archive);sha256=(Get-FileHash -LiteralPath $archive).Hash};files=@()}
foreach ($file in Get-ChildItem -LiteralPath $bundle -File -Recurse | Sort-Object FullName) {
    $manifest.files += @{path=[IO.Path]::GetRelativePath($bundle,$file.FullName).Replace('\','/');length=$file.Length;sha256=(Get-FileHash -LiteralPath $file.FullName).Hash}
}
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath "$bundle/build-manifest.json" -Encoding utf8
& "$root/scripts/verify-media-bundle.ps1" -BundleDirectory $bundle -SourceArchive $archive
@{complete=$true;sourceFiles=$fileList.Count;verifiedExtractedFiles=$critical;archive=(Get-FileHash -LiteralPath $archive | Select-Object Path,Hash);bundle=$bundle} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$delivery/package-report.json"
Write-Host "Staged backend and verified source archive: $archive"
