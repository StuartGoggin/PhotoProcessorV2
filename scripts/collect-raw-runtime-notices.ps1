#Requires -Version 7.0
param([Parameter(Mandatory)][string[]]$Reports)
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'));Set-Location $repo
$work=Join-Path $repo 'test-output/raw-development/notices-audit'
$destination=Join-Path $repo 'src-tauri/tools/rawtherapee/third-party-licenses'
New-Item -ItemType Directory -Force $work,$destination | Out-Null
$byName=@{}
foreach($report in $Reports){foreach($p in (Get-Content -LiteralPath $report -Raw | ConvertFrom-Json).packages){if($p.sourceAccessible){$byName[$p.name]=$p}}}
$packages=@($byName.Values | Sort-Object binaryUrl -Unique)
$results=@()
foreach($p in $packages){
    if($p.name -notmatch '^[a-zA-Z0-9+_-]+$'){throw 'Invalid package name'}
    $dir=Join-Path $work $p.name;New-Item -ItemType Directory -Force $dir | Out-Null
    $archive=Join-Path $dir 'package.zst'
    $http=New-Object -ComObject WinHttp.WinHttpRequest.5.1;$http.SetTimeouts(30000,30000,120000,120000);$http.Open('GET',$p.binaryUrl,$false);$http.Send()
    if($http.Status -ne 200){throw "Package notice download failed: $($p.name)"}
    [IO.File]::WriteAllBytes($archive,$http.ResponseBody)
    if((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $p.binarySha256){throw 'Package changed since DLL provenance verification'}
    & 'C:\Program Files\7-Zip\7z.exe' x $archive ('-o'+$dir) -y *> (Join-Path $dir 'extract.log')
    if($LASTEXITCODE -ne 0){throw 'Package decompression failed'}
    $tar=Get-ChildItem -LiteralPath $dir -File | Where-Object {$_.Name -notin @('package.zst','extract.log')} | Select-Object -First 1
    $target=Join-Path $destination $p.name
    & 'C:\Program Files\7-Zip\7z.exe' x $tar.FullName 'ucrt64/share/licenses/*' ('-o'+$target) -r -y *> (Join-Path $dir 'notices.log')
    if($LASTEXITCODE -ne 0){throw 'Package licence extraction failed'}
    $count=@(Get-ChildItem -LiteralPath $target -File -Recurse -ErrorAction SilentlyContinue).Count
    $results+=@{package=$p.name;files=$count;binarySha256=$p.binarySha256;sourceUrl=$p.sourceUrl}
    foreach($f in @($archive,$tar.FullName)){$checked=[IO.Path]::GetFullPath($f);if(-not $checked.StartsWith($work+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected notice scratch path'};Remove-Item -LiteralPath $checked -Force}
    $results | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath (Join-Path $work 'report.json') -Encoding utf8
    Write-Output ($p.name+': '+$count+' licence files retained')
}
