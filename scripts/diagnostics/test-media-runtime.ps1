#Requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$BinDirectory,[Parameter(Mandatory)][string]$ReportPath)
$ErrorActionPreference='Stop'
$bin=(Resolve-Path -LiteralPath $BinDirectory).Path
$vs='C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools'
$dumpbin=Join-Path $vs 'VC\Tools\MSVC\14.44.35207\bin\Hostx64\x64\dumpbin.exe'
$redist=Join-Path $vs 'VC\Redist\MSVC\14.44.35112\x64'
$runtime=@('msvcp140.dll','vcruntime140.dll','vcruntime140_1.dll','vcomp140.dll')
$system=@('PSAPI.DLL','ole32.dll','OLEAUT32.dll','SHLWAPI.dll','GDI32.dll','AVICAP32.dll','ADVAPI32.dll','Secur32.dll','ncrypt.dll','CRYPT32.dll','WS2_32.dll','USER32.dll','SHELL32.dll','KERNEL32.dll')
$records=@()
foreach ($name in (@('ffmpeg.exe','ffprobe.exe')+$runtime)) {
    $path=Join-Path $bin $name
    $hash=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
    if ($runtime -contains $name) {
        $folder=if($name -eq 'vcomp140.dll'){'Microsoft.VC143.OpenMP'}else{'Microsoft.VC143.CRT'}
        if ((Get-FileHash -LiteralPath (Join-Path "$redist/$folder" $name)).Hash -ne $hash) { throw "Runtime differs from installed Microsoft release redistributable: $name" }
    }
    $headers=(& $dumpbin /HEADERS $path) -join "`n"
    if ($LASTEXITCODE -ne 0 -or $headers -notmatch '8664 machine \(x64\)') { throw "Expected an x64 release binary: $name" }
    $output=(& $dumpbin /DEPENDENTS $path) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw "Import inspection failed: $name" }
    $imports=@([regex]::Matches($output,'(?im)^\s+([a-z0-9_.-]+\.dll)\s*$') | ForEach-Object {$_.Groups[1].Value})
    if (-not $imports.Count) { throw "No imports observed: $name" }
    foreach ($dependency in $imports) {
        if ($runtime -notcontains $dependency -and $system -notcontains $dependency -and $dependency -notmatch '^api-ms-win-crt-[a-z0-9-]+\.dll$') { throw "Unclosed non-system dependency: $name -> $dependency" }
    }
    $records+=@{name=$name;sha256=$hash;imports=$imports;fileVersion=(Get-Item -LiteralPath $path).VersionInfo.FileVersion}
}
@{complete=$true;architecture='x64';redistVersion='14.44.35112';binaries=$records;
    limitations=@('Windows system/API-set DLLs are supplied by Windows 11.','Dynamically loaded NVIDIA/Intel graphics driver modules are not redistributed or hardware-validated here.')} |
    ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
Write-Host "Runtime closure verified for both executables and all four app-local DLLs: $ReportPath"
