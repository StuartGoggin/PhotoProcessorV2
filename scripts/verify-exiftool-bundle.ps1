#Requires -Version 7.0
param([Parameter(Mandatory)][string]$BundleDirectory, [switch]$SkipRuntime, [switch]$ForRelease)
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$root=[IO.Path]::GetFullPath($BundleDirectory).TrimEnd('\')
$lockPath=Join-Path $PSScriptRoot 'exiftool-bundle.lock.json'
$lock=Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
if ($ForRelease -and -not $lock.redistribution.cleared) { throw 'Metadata runtime redistribution gate is open. Resolve the corresponding-source/runtime decision before building a release.' }
$expected=@{}
foreach ($entry in $lock.files) { $expected[$entry.path]=$entry.sha256 }
$expected['PhotoGoGo-NOTICE.txt']=(Get-FileHash -LiteralPath (Join-Path $repo 'resources/exiftool-NOTICE.txt') -Algorithm SHA256).Hash
$expected['build-manifest.json']=(Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash
$expected['exiftool_files/run-exiftool.pl']=(Get-FileHash -LiteralPath (Join-Path $repo 'resources/run-exiftool.pl') -Algorithm SHA256).Hash
$expected['sources/build-metadata-perl.ps1']=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'build-metadata-perl.ps1') -Algorithm SHA256).Hash
$actual=@(Get-ChildItem -LiteralPath $root -Recurse -Force -File)
if ($actual.Count -ne $expected.Count) { throw "ExifTool runtime closure mismatch ($($actual.Count) files, expected $($expected.Count))." }
if (@(Get-ChildItem -LiteralPath $root -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'Linked metadata runtime entry refused.' }
foreach ($file in $actual) {
    $relative=[IO.Path]::GetRelativePath($root,$file.FullName).Replace('\','/')
    if (-not $expected.ContainsKey($relative) -or (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash -ine $expected[$relative]) { throw "ExifTool payload differs: $relative" }
}
if (-not $SkipRuntime) {
    $start=[Diagnostics.ProcessStartInfo]::new()
    $runtime=Join-Path $root 'exiftool_files'
    $start.FileName=Join-Path $runtime 'perl.exe'
    foreach ($arg in @('-Ilib','run-exiftool.pl')) { $start.ArgumentList.Add($arg) }
    foreach ($arg in @('-config','','-charset','filename=UTF8','-@','-')) { $start.ArgumentList.Add($arg) }
    $start.WorkingDirectory=$runtime
    $start.UseShellExecute=$false; $start.CreateNoWindow=$true
    $start.RedirectStandardInput=$true; $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
    # Prove independence from any installed Perl or ExifTool.
    $start.Environment['PATH']=''
    foreach ($key in @('LC_ALL','LC_CTYPE','LANG')) { $start.Environment[$key]='C' }
    foreach ($key in @($start.Environment.Keys | Where-Object { $_ -like 'PERL*' })) { $start.Environment.Remove($key) | Out-Null }
    $process=[Diagnostics.Process]::Start($start)
    try {
        $stdout=$process.StandardOutput.ReadToEndAsync(); $stderr=$process.StandardError.ReadToEndAsync()
        $process.StandardInput.WriteLine('-ver'); $process.StandardInput.Close()
        if (-not $process.WaitForExit(20000)) { $process.Kill($true); $process.WaitForExit(); throw 'Bundled metadata tool timed out.' }
        if ($process.ExitCode -ne 0 -or $stdout.GetAwaiter().GetResult().Trim() -cne $lock.version) { throw 'Bundled metadata tool version probe failed.' }
        $null=$stderr.GetAwaiter().GetResult()
    } finally { $process.Dispose() }
}
Write-Output "ExifTool $($lock.version): $($actual.Count) exact payload files verified; runtime tested=$(-not $SkipRuntime)."
