#Requires -Version 7.0
param([string]$SourceArchive='test-output/raw-development/rawtherapee-5.13.tar.xz')
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'));Set-Location $repo
$bundle=[IO.Path]::GetFullPath((Join-Path $repo 'src-tauri/tools/rawtherapee'))
if(-not $bundle.StartsWith($repo+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected runtime directory'}
if(-not(Test-Path -LiteralPath (Join-Path $bundle 'rawtherapee-cli.exe'))){throw 'Extract the pinned official RawTherapee installer with the documented portable extractor first.'}
$dependencies=Get-Content (Join-Path $PSScriptRoot 'raw-runtime-dependencies.lock.json') -Raw | ConvertFrom-Json
if($dependencies.packages.Count -ne 62 -or @($dependencies.packages|Where-Object {-not $_.sourceAccessible}).Count){throw 'Exact runtime dependency source audit is incomplete'}
foreach($p in $dependencies.packages){foreach($dll in $p.metadata.checks){if((Get-FileHash -LiteralPath (Join-Path $bundle $dll.file) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $dll.expected){throw "Runtime DLL changed: $($dll.file)"}}}
if((Get-FileHash -LiteralPath $SourceArchive -Algorithm SHA256).Hash -ne '23BDFF4B1817E1274C11A94B11D21CAC59E9C1B1D209795D3194710EE73E77BF'){throw 'RAW engine corresponding-source archive is not the pinned official source'}
# A CLI worker does not need GUI executables, themes, fonts, browser profiles or
# an unverified updated lens database. Retain all camera/ICC/DCP data and notices.
foreach($name in @('icons','images','languages','lib','profiles','share','sounds')){
    $target=Join-Path $bundle $name
    if(Test-Path -LiteralPath $target){$resolved=(Resolve-Path -LiteralPath $target).Path;if(-not $resolved.StartsWith($bundle+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected runtime pruning target'};if((Get-Item -LiteralPath $resolved).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Runtime contains a linked directory'};if(Get-ChildItem -LiteralPath $resolved -Recurse -Force | Where-Object {$_.Attributes -band [IO.FileAttributes]::ReparsePoint}){throw 'Runtime contains a linked resource'};Remove-Item -LiteralPath $resolved -Recurse -Force}
}
Get-ChildItem -LiteralPath $bundle -File -Filter '*.exe' | Where-Object {$_.Name -ne 'rawtherapee-cli.exe'} | ForEach-Object {Remove-Item -LiteralPath $_.FullName -Force}
$options=@'
[General]
MultiUser=true
UseSystemTheme=false
[Profiles]
CustomProfileBuilder=
UseBundledProfiles=false
[File Browser]
ParseExtensions=cr3;
ParseExtensionsEnabled=1;
[Metadata]
XMPSynchronization=none
'@
[IO.File]::WriteAllText((Join-Path $bundle 'options'),$options+"`n",[Text.UTF8Encoding]::new($false))
$profiles=Join-Path $bundle 'profiles';New-Item -ItemType Directory -Force $profiles | Out-Null
[IO.File]::WriteAllText((Join-Path $profiles 'Neutral.pp3'),"[Version]`nAppVersion=5.13`nVersion=353`n",[Text.UTF8Encoding]::new($false))
$sourceDir=Join-Path $bundle 'source';New-Item -ItemType Directory -Force $sourceDir | Out-Null
Copy-Item -LiteralPath $SourceArchive -Destination (Join-Path $sourceDir 'rawtherapee-5.13.tar.xz') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'raw-runtime-dependencies.lock.json') -Destination (Join-Path $sourceDir 'dependencies.json') -Force
$lines=@('RawTherapee 5.13 isolated CLI runtime','', 'Engine source (also included as rawtherapee-5.13.tar.xz):','https://github.com/RawTherapee/RawTherapee/releases/download/5.13/rawtherapee-5.13.tar.xz','', 'Unmodified runtime dependency sources and package/build definitions:')
foreach($p in $dependencies.packages){$lines+=($p.name+' '+$p.metadata.version+"`n"+$p.sourceUrl)}
$lines+=@('', 'Each DLL is matched by SHA-256 to the identified official MSYS2 package.','dependencies.json records binary package hashes, source locations and per-DLL evidence.','Original engine notices are in ../LICENSE, ../AUTHORS.txt and ../licenses/.','Additional package notices are retained in ../third-party-licenses/.','This is a separate unmodified engine process. PhotoGoGo owns only the explicit options file and its generated processing recipes.','GPL/LGPL rights, including modifying/replacing this engine and libraries under their licences, are retained.','No warranty is supplied by the upstream engine or libraries.')
[IO.File]::WriteAllLines((Join-Path $sourceDir 'SOURCE-AND-NOTICES.txt'),$lines,[Text.UTF8Encoding]::new($false))
$manifestPath=Join-Path $bundle 'runtime-manifest.json'
$files=@(Get-ChildItem -LiteralPath $bundle -File -Recurse | Where-Object {$_.FullName -ne $manifestPath} | Sort-Object FullName | ForEach-Object {@{path=$_.FullName.Substring($bundle.Length+1).Replace('\','/');bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}})
$manifest=@{schemaVersion=1;engine='RawTherapee';version='5.13';installerSha256='d27df7ebde717c5efa114338a4b1cf1c426a439e5a1a92e142e87868cbe45383';sourceSha256='23bdff4b1817e1274c11a94b11d21cac59e9c1b1d209795d3194710ee73e77bf';files=$files}
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding utf8NoBOM
Write-Output ('Prepared isolated RAW runtime: '+$files.Count+' files; '+(($files|Measure-Object bytes -Sum).Sum)+' bytes')
