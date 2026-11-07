param([Parameter(Mandatory)][string]$BundleDirectory)
$ErrorActionPreference='Stop'
$bundle=(Resolve-Path -LiteralPath $BundleDirectory).Path
$receipt=Get-Content -LiteralPath (Join-Path $bundle 'source-receipt.json') -Raw | ConvertFrom-Json
if(@($receipt.packages).Count -ne 2 -or -not (($receipt.schema -eq 1 -and $receipt.modified -eq $false) -or ($receipt.schema -eq 2 -and $receipt.modified -eq $true))){throw 'Invalid controller source receipt'}
$expected=@{ 'ajazz-sdk'=@{version='0.2.1';sha256='10320f86148f1774e444c8fdb5ae2bbccdffee23abc2c3848cb291293590c54c'}; 'hidapi'=@{version='2.6.7';sha256='818c0e1d27887aaf76fe737042e27a66b796a7b099e6d2e1a72d106c2dff3fa6'} }
$seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$allowed=@('source-receipt.json','README.txt','ajazz-sdk-0.2.1.crate','ajazz-sdk-LICENSE.txt','hidapi-2.6.7.crate','hidapi-LICENSE.txt')
$sourceFiles=@{}
if($receipt.modified){
    $patch=$receipt.modifiedSdk
    if($patch.directory -cne 'ajazz-sdk-photogogo' -or $patch.version -cne '0.2.1' -or $patch.basedOnCrateSha256 -cne $expected['ajazz-sdk'].sha256 -or ($patch.modifiedFiles -join ',') -cne 'src/device.rs,src/lib.rs' -or $patch.notes -cne 'PHOTOGOGO-CHANGES.md'){throw 'Unreviewed controller source modification'}
    $source=Join-Path $bundle $patch.directory
    if(@($patch.files).Count -lt 10 -or @($patch.files).Count -gt 128){throw 'Invalid controller source file count'}
    foreach($entry in $patch.files){
        if($entry.path -notmatch '^[a-zA-Z0-9_./-]+$' -or $entry.path -match '(^|/)\.\.(/|$)' -or $entry.path.StartsWith('/')){throw 'Invalid controller source path'}
        $target=[IO.Path]::GetFullPath((Join-Path $source $entry.path))
        if(-not $target.StartsWith($source+'\',[StringComparison]::OrdinalIgnoreCase) -or $sourceFiles.ContainsKey($target)){throw 'Invalid or duplicate controller source entry'}
        $sourceFiles[$target]=$entry
    }
    if(-not $sourceFiles.ContainsKey((Join-Path $source 'Cargo.toml')) -or -not $sourceFiles.ContainsKey((Join-Path $source $patch.notes))){throw 'Controller build source/notes missing'}
}
$checked=0
foreach($file in Get-ChildItem -LiteralPath $bundle -Recurse -File -Force){
    if($file.DirectoryName -ceq $bundle -and $file.Name -cin $allowed){continue}
    if(-not $sourceFiles.ContainsKey($file.FullName)){throw 'Unreviewed file in controller source bundle'}
    $pin=$sourceFiles[$file.FullName]
    if($file.Length -ne $pin.bytes -or (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pin.sha256){throw 'Controller compiled source differs from its receipt'}
    $checked++
}
if($checked -ne $sourceFiles.Count){throw 'Controller corresponding source is incomplete'}
foreach($entry in $receipt.packages){
    if(-not $expected.ContainsKey($entry.name) -or -not $seen.Add($entry.name)){throw 'Unexpected controller source package'}
    $pin=$expected[$entry.name];$filename=$entry.name+'-'+$pin.version+'.crate'
    if($entry.version -cne $pin.version -or $entry.file -cne $filename -or $entry.sha256 -cne $pin.sha256){throw 'Controller source does not match the reviewed pin'}
    if((Get-FileHash -LiteralPath (Join-Path $bundle $filename) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pin.sha256){throw 'Controller source archive checksum differs'}
    if((Get-Item -LiteralPath (Join-Path $bundle ($entry.name+'-LICENSE.txt'))).Length -lt 500){throw 'Controller licence notice is missing'}
}
if((Get-Content -LiteralPath (Join-Path $bundle 'ajazz-sdk-LICENSE.txt') -Raw) -notmatch 'Mozilla Public License'){throw 'Expected MPL notice is missing'}
if((Get-Content -LiteralPath (Join-Path $bundle 'README.txt') -Raw) -notmatch 'corresponding source'){throw 'Controller source-access notice is missing'}
Write-Host "Controller sources verified: pinned upstream archives, $checked modified SDK source files and licence notices."
