#Requires -Version 7.0
param([string]$BundleDirectory='src-tauri/tools/rawtherapee',[switch]$ForRelease)
$ErrorActionPreference='Stop'
$root=(Resolve-Path -LiteralPath $BundleDirectory).Path
$manifest=Get-Content -LiteralPath (Join-Path $root 'runtime-manifest.json') -Raw | ConvertFrom-Json
if($manifest.schemaVersion -ne 1 -or $manifest.version -ne '5.13' -or $manifest.files.Count -lt 1 -or $manifest.files.Count -gt 5000){throw 'Unsupported RAW runtime manifest'}
$names=@{};foreach($f in $manifest.files){if($names.ContainsKey($f.path)){throw 'Duplicate RAW resource'};$names[$f.path]=$true}
if(@(Get-ChildItem -LiteralPath $root -File -Recurse).Count -ne $manifest.files.Count+1){throw 'RAW runtime closure has unexpected files'}
if(@(Get-ChildItem -LiteralPath $root -Recurse -Force | Where-Object {$_.Attributes -band [IO.FileAttributes]::ReparsePoint}).Count){throw 'Linked RAW resource refused'}
foreach($f in $manifest.files){if($f.path -match '(^|/)\.\.(/|$)|^[\\/]|:'){throw 'Invalid runtime path'};$path=[IO.Path]::GetFullPath((Join-Path $root $f.path));if(-not $path.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Runtime path escaped bundle'};if((Get-Item -LiteralPath $path).Length -ne $f.bytes -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $f.sha256){throw "RAW runtime integrity mismatch: $($f.path)"}}
foreach($name in @('rawtherapee-cli.exe','camconst.json','options','profiles/Neutral.pp3','iccprofiles/output/RTv4_sRGB.icc','LICENSE','source/SOURCE-AND-NOTICES.txt','source/rawtherapee-5.13.tar.xz','source/dependencies.json')){if(-not $names.ContainsKey($name)){throw "Required RAW resource missing from integrity manifest: $name"}}
if($ForRelease){$d=Get-Content (Join-Path $root 'source/dependencies.json') -Raw | ConvertFrom-Json;if($d.packages.Count -ne 62 -or @($d.packages|Where-Object {-not $_.sourceAccessible}).Count){throw 'RAW dependency source evidence is incomplete'};if(@(Get-ChildItem (Join-Path $root 'third-party-licenses') -File -Recurse).Count -lt 90){throw 'RAW component notices are incomplete'}}
Write-Output ('RAW runtime integrity verified: '+$manifest.files.Count+' resources, pinned engine and corresponding source')
