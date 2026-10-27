#Requires -Version 7.0
param([string]$CandidateMap='test-output/raw-development/msys-candidates.json',[string]$OutputDirectory='test-output/raw-development/msys-package-audit')
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location $repo
$work=[IO.Path]::GetFullPath((Join-Path $repo $OutputDirectory))
if(-not $work.StartsWith($repo+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Audit output must be inside this checkout'}
New-Item -ItemType Directory -Force $work | Out-Null
$packages=(Get-Content -LiteralPath $CandidateMap -Raw | ConvertFrom-Json).packages
$results=@()
foreach($package in $packages){
    $request=Join-Path $work ($package.name+'.request.json')
    $package | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $request -Encoding utf8
    $found=$null
    foreach($candidate in $package.candidates){
        $packagePath=Join-Path $work 'candidate.pkg.tar.zst'
        $unpack=Join-Path $work 'unpacked'
        New-Item -ItemType Directory -Force $unpack | Out-Null
        $http=New-Object -ComObject WinHttp.WinHttpRequest.5.1
        $http.SetTimeouts(30000,30000,120000,120000)
        $http.Open('GET',('https://repo.msys2.org/mingw/ucrt64/'+$candidate),$false)
        $http.Send()
        if($http.Status -ne 200){continue}
        [IO.File]::WriteAllBytes($packagePath,$http.ResponseBody)
        $archiveHash=(Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash
        & 'C:\Program Files\7-Zip\7z.exe' x $packagePath ('-o'+$unpack) -y *> (Join-Path $work 'extract.log')
        if($LASTEXITCODE -ne 0){throw 'Cannot read official package container'}
        $tar=Get-ChildItem -LiteralPath $unpack -File | Select-Object -First 1
        $meta=Join-Path $work 'candidate.json'
        & node (Join-Path $PSScriptRoot 'read-raw-msys-package.cjs') $tar.FullName $request $meta
        if($LASTEXITCODE -ne 0){throw 'Cannot inspect official package metadata'}
        $evidence=Get-Content -LiteralPath $meta -Raw | ConvertFrom-Json
        foreach($file in @(Get-ChildItem -LiteralPath $unpack -File)){
            $checked=[IO.Path]::GetFullPath($file.FullName)
            if(-not $checked.StartsWith($work+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected audit scratch path'}
            Remove-Item -LiteralPath $checked -Force
        }
        Remove-Item -LiteralPath $packagePath -Force
        if($evidence.matched){
            $version=($evidence.version -replace '^\d+:','')
            $source='https://repo.msys2.org/mingw/sources/'+$evidence.base+'-'+$version+'.src.tar.zst'
            $head=New-Object -ComObject WinHttp.WinHttpRequest.5.1
            $head.SetTimeouts(30000,30000,30000,30000);$head.Open('HEAD',$source,$false);$head.Send()
            $found=@{name=$package.name;binaryUrl=('https://repo.msys2.org/mingw/ucrt64/'+$candidate);binarySha256=$archiveHash;sourceUrl=$source;sourceAccessible=($head.Status -eq 200);metadata=$evidence}
            break
        }
    }
    if(-not $found){$found=@{name=$package.name;matched=$false;dlls=$package.dlls}}
    $results+=$found
    @{packages=$results;complete=($results.Count -eq $packages.Count -and @($results|Where-Object {-not $_.sourceAccessible}).Count -eq 0)} | ConvertTo-Json -Depth 14 | Set-Content -LiteralPath (Join-Path $work 'report.json') -Encoding utf8
    Write-Output ($package.name+': '+$(if($found.sourceAccessible){'matched DLLs and source accessible'}else{'source closure still unresolved'}))
}
