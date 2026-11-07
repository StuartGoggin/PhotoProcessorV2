param([Parameter(Mandatory)][string]$BundleDirectory)
$ErrorActionPreference='Stop'
$bundle=(Resolve-Path -LiteralPath $BundleDirectory).Path
$receipt=Get-Content -LiteralPath (Join-Path $bundle 'source-receipt.json') -Raw | ConvertFrom-Json
if($receipt.schema -ne 1 -or $receipt.modified -ne $false -or @($receipt.packages).Count -ne 2){throw 'Invalid controller source receipt'}
$expected=@{ 'ajazz-sdk'=@{version='0.2.1';sha256='10320f86148f1774e444c8fdb5ae2bbccdffee23abc2c3848cb291293590c54c'}; 'hidapi'=@{version='2.6.7';sha256='818c0e1d27887aaf76fe737042e27a66b796a7b099e6d2e1a72d106c2dff3fa6'} }
$seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$allowed=@('source-receipt.json','README.txt','ajazz-sdk-0.2.1.crate','ajazz-sdk-LICENSE.txt','hidapi-2.6.7.crate','hidapi-LICENSE.txt')
foreach($file in Get-ChildItem -LiteralPath $bundle -Recurse -File){if($file.DirectoryName -cne $bundle -or $file.Name -cnotin $allowed){throw 'Unreviewed file in controller source bundle'}}
foreach($entry in $receipt.packages){
    if(-not $expected.ContainsKey($entry.name) -or -not $seen.Add($entry.name)){throw 'Unexpected controller source package'}
    $pin=$expected[$entry.name];$filename=$entry.name+'-'+$pin.version+'.crate'
    if($entry.version -cne $pin.version -or $entry.file -cne $filename -or $entry.sha256 -cne $pin.sha256){throw 'Controller source does not match the reviewed pin'}
    if((Get-FileHash -LiteralPath (Join-Path $bundle $filename) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pin.sha256){throw 'Controller source archive checksum differs'}
    if((Get-Item -LiteralPath (Join-Path $bundle ($entry.name+'-LICENSE.txt'))).Length -lt 500){throw 'Controller licence notice is missing'}
}
if((Get-Content -LiteralPath (Join-Path $bundle 'ajazz-sdk-LICENSE.txt') -Raw) -notmatch 'Mozilla Public License'){throw 'Expected MPL notice is missing'}
if((Get-Content -LiteralPath (Join-Path $bundle 'README.txt') -Raw) -notmatch 'corresponding source'){throw 'Controller source-access notice is missing'}
Write-Host 'Controller sources verified: exact ajazz-sdk 0.2.1 and hidapi 2.6.7, unmodified sources and licence notices.'
