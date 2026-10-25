#Requires -Version 7.0
param()
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$report=Join-Path $repo ('test-output/exiftool-runtime-'+[datetime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))
New-Item -ItemType Directory -Path $report | Out-Null
$relocated=Join-Path $report 'relocated café 馬'
Copy-Item -LiteralPath (Join-Path $repo 'src-tauri/tools/exiftool') -Destination $relocated -Recurse
& (Join-Path $PSScriptRoot 'verify-exiftool-bundle.ps1') -BundleDirectory $relocated
$probe=Join-Path $relocated 'exiftool_files/README'
[IO.File]::AppendAllText($probe,'tamper fixture')
$tamperRejected=$false
try { & (Join-Path $PSScriptRoot 'verify-exiftool-bundle.ps1') -BundleDirectory $relocated -SkipRuntime } catch { $tamperRejected=$true }
if (-not $tamperRejected) { throw 'Tampered metadata bundle was accepted.' }
Copy-Item -LiteralPath (Join-Path $repo 'src-tauri/tools/exiftool/exiftool_files/README') -Destination $probe -Force
$missing=Join-Path $relocated 'exiftool_files/perl.exe'
Remove-Item -LiteralPath $missing
$missingRejected=$false
try { & (Join-Path $PSScriptRoot 'verify-exiftool-bundle.ps1') -BundleDirectory $relocated -SkipRuntime } catch { $missingRejected=$true }
if (-not $missingRejected) { throw 'Incomplete metadata bundle was accepted.' }
Copy-Item -LiteralPath (Join-Path $repo 'src-tauri/tools/exiftool/exiftool_files/perl.exe') -Destination $missing
$config=Join-Path $report 'hostile-config'
New-Item -ItemType Directory -Path $config | Out-Null
[IO.File]::WriteAllText((Join-Path $config '.ExifTool_config'),'die "Unexpected user config loaded";')
$keys=@('PERL5OPT','PERL5LIB','PERLLIB','PERL5DB','EXIFTOOL_HOME','PHOTOGOGO_TEST_EXIFTOOL')
$prior=@{}
foreach ($key in $keys) { $prior[$key]=[Environment]::GetEnvironmentVariable($key,'Process') }
try {
    foreach ($key in $keys) { [Environment]::SetEnvironmentVariable($key,'PHOTOGOGO_INVALID_SENTINEL','Process') }
    $env:EXIFTOOL_HOME=$config
    $env:PHOTOGOGO_TEST_EXIFTOOL=Join-Path $relocated 'exiftool_files/perl.exe'
    $binary=Get-ChildItem (Join-Path $repo 'src-tauri/target/release/deps/photogogo_v2_lib-*.exe') | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if (-not $binary) { throw 'Build native tests first.' }
    & $binary.FullName bundled_exiftool_ --ignored --nocapture --test-threads=1 *> (Join-Path $report 'metadata.log')
    if ($LASTEXITCODE -ne 0) { throw 'Real metadata/config/environment regression failed.' }
} finally { foreach ($key in $keys) { [Environment]::SetEnvironmentVariable($key,$prior[$key],'Process') } }
@{ complete=$true; relocatedWithoutPath=$true; tamperRejected=$tamperRejected; missingRuntimeRejected=$missingRejected; realMetadataWithHostileConfigAndEnvironment=$true; testBinary=$binary.Name } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $report 'report.json') -Encoding utf8
Write-Output "Metadata runtime acceptance passed: $report"
