#Requires -Version 7.0
param(
    [Parameter(Mandatory)][string]$PerlRuntimeDirectory,
    [Parameter(Mandatory)][string]$PerlSourceArchive,
    [Parameter(Mandatory)][string]$ExifToolSourceArchive,
    [Parameter(Mandatory)][string]$PerlBuildReceipt,
    [switch]$WriteLock
)
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$destination=[IO.Path]::GetFullPath((Join-Path $repo 'src-tauri/tools/exiftool'))
if (-not $destination.StartsWith($repo+'\',[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $destination)) { throw 'Preserve the existing bundle; prepare only into the absent managed directory.' }
$sources=@(
    @{name='perl-5.44.0.tar.gz';path=$PerlSourceArchive;bytes=21265451;sha256='3b855066b92491cb40e86affb1ca57d1a388aa43e51b91c7806a32c2f65f96c3';url='https://www.cpan.org/src/5.0/perl-5.44.0.tar.gz'},
    @{name='Image-ExifTool-13.59-source.tar.gz';path=$ExifToolSourceArchive;bytes=8653399;sha256='87d3317882fdae9cb4dcfe57a96a378d0132ffc02c731315bf128b19ddcf7aac';url='https://codeload.github.com/exiftool/exiftool/tar.gz/refs/tags/13.59';commit='2200871d9cef988051d2a99d67df3bda6cbb30a8'}
)
foreach ($source in $sources) {
    if ((Get-Item -LiteralPath $source.path).Length -ne $source.bytes -or (Get-FileHash -LiteralPath $source.path -Algorithm SHA256).Hash -ine $source.sha256) { throw "Source pin mismatch: $($source.name)" }
}
$build=Get-Content -LiteralPath $PerlBuildReceipt -Raw | ConvertFrom-Json
$runtimeInput=[IO.Path]::GetFullPath($PerlRuntimeDirectory).TrimEnd('\')
if ($build.version -ne '5.44.0' -or $build.sourceSha256 -ne $sources[0].sha256 -or -not $build.acceptance.passed -or $build.sourcePatched -ne $false -or [IO.Path]::GetFullPath($build.runtime).TrimEnd('\') -ne $runtimeInput) { throw 'The accepted source-build receipt must match this exact runtime and official source.' }
if (@(Get-ChildItem -LiteralPath $runtimeInput -Recurse -File).Count -ne @($build.files).Count) { throw 'Source-built runtime differs from its acceptance receipt.' }
foreach ($file in $build.files) {
    $target=[IO.Path]::GetFullPath((Join-Path $runtimeInput $file.path))
    if (-not $target.StartsWith($runtimeInput+'\',[StringComparison]::OrdinalIgnoreCase) -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ine $file.sha256) { throw 'Source-built runtime fingerprint mismatch.' }
}
if (-not (Test-Path -LiteralPath (Join-Path $PerlRuntimeDirectory 'perl.exe')) -or -not (Test-Path -LiteralPath (Join-Path $PerlRuntimeDirectory 'lib/Win32API/File.pm'))) { throw 'A complete source-built MSVC Perl runtime is required.' }
if (@(Get-ChildItem -LiteralPath $PerlRuntimeDirectory -Recurse -File | Where-Object { $_.Extension -in '.exe','.dll' -and $_.Name -match '^(libgcc|libstdc\+\+|libgmp|libwinpthread|perl532)|GMP\.xs\.dll$' }).Count) { throw 'Old GNU runtime files must not enter the source-built bundle.' }
New-Item -ItemType Directory -Path $destination | Out-Null
$runtime=Join-Path $destination 'exiftool_files'
Copy-Item -LiteralPath $PerlRuntimeDirectory -Destination $runtime -Recurse
$sourceDir=Join-Path $destination 'sources'
New-Item -ItemType Directory -Path $sourceDir | Out-Null
foreach ($source in $sources) { Copy-Item -LiteralPath $source.path -Destination (Join-Path $sourceDir $source.name) }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'build-metadata-perl.ps1') -Destination $sourceDir
Copy-Item -LiteralPath $PerlBuildReceipt -Destination (Join-Path $sourceDir 'perl-build-receipt.json')
$extracted=Join-Path $repo ('test-output/exiftool-preparation-'+[datetime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))
New-Item -ItemType Directory -Path $extracted | Out-Null
& tar.exe -xzf ([IO.Path]::GetFullPath($ExifToolSourceArchive)) -C $extracted
if ($LASTEXITCODE -ne 0) { throw 'ExifTool source extraction failed.' }
$exif=Join-Path $extracted 'exiftool-13.59'
Copy-Item -Path (Join-Path $exif 'lib/*') -Destination (Join-Path $runtime 'lib') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $exif 'windows_exiftool') -Destination (Join-Path $runtime 'exiftool.pl')
Copy-Item -LiteralPath (Join-Path $repo 'resources/run-exiftool.pl') -Destination (Join-Path $runtime 'run-exiftool.pl')
Copy-Item -LiteralPath (Join-Path $exif 'README') -Destination (Join-Path $runtime 'README')
New-Item -ItemType Directory -Path (Join-Path $runtime 'licenses') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $exif 'LICENSE') -Destination (Join-Path $runtime 'licenses/ExifTool-LICENSE.txt')
New-Item -ItemType Directory -Path (Join-Path $runtime 't/images') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $exif 't/images/ICC_Profile.icc') -Destination (Join-Path $runtime 't/images/ICC_Profile.icc')
Copy-Item -LiteralPath (Join-Path $repo 'resources/exiftool-NOTICE.txt') -Destination (Join-Path $destination 'PhotoGoGo-NOTICE.txt')
$lockPath=Join-Path $PSScriptRoot 'exiftool-bundle.lock.json'
if ($WriteLock) {
    $files=@(Get-ChildItem -LiteralPath $destination -Recurse -Force -File | Sort-Object FullName | ForEach-Object { [ordered]@{path=[IO.Path]::GetRelativePath($destination,$_.FullName).Replace('\','/');bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()} })
    $lock=[ordered]@{version='13.59';perlVersion='5.44.0';entrypoint='exiftool_files/perl.exe';redistribution=@{cleared=$false;reason='Await final source/CRT/runtime review'};sources=@($sources | ForEach-Object { $item=@{name=$_.name;bytes=$_.bytes;sha256=$_.sha256;url=$_.url};if ($_.commit) {$item.commit=$_.commit};$item });files=$files}
    $lock | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $lockPath -Encoding utf8
}
Copy-Item -LiteralPath $lockPath -Destination (Join-Path $destination 'build-manifest.json')
& (Join-Path $PSScriptRoot 'verify-exiftool-bundle.ps1') -BundleDirectory $destination
