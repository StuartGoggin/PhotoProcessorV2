#Requires -Version 7.0
param(
    [Parameter(Mandatory)][string]$BundleDirectory,
    [Parameter(Mandatory)][string]$MetadataDirectory,
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Profile,
    [Parameter(Mandatory)][string]$EvidenceDirectory,
    [int]$ExpectedWidth=6014,
    [int]$ExpectedHeight=4016
)
$ErrorActionPreference='Stop'
$root=(Resolve-Path -LiteralPath $BundleDirectory).Path
$metadata=(Resolve-Path -LiteralPath $MetadataDirectory).Path
$inputPath=(Resolve-Path -LiteralPath $Source).Path
$profilePath=(Resolve-Path -LiteralPath $Profile).Path
& (Join-Path $PSScriptRoot 'verify-raw-bundle.ps1') -BundleDirectory $root -ForRelease
$evidence=[IO.Path]::GetFullPath($EvidenceDirectory)
New-Item -ItemType Directory -Path $evidence -Force | Out-Null
$scratch=[IO.Path]::GetFullPath((Join-Path $evidence ('raw-smoke-'+[guid]::NewGuid().ToString('N'))))
if(-not $scratch.StartsWith($evidence+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid smoke workspace'}
New-Item -ItemType Directory -Path $scratch | Out-Null
$sourceHash=(Get-FileHash -LiteralPath $inputPath -Algorithm SHA256).Hash
$timer=[Diagnostics.Stopwatch]::StartNew()
try {
    $settings=Join-Path $scratch 'settings';$cache=Join-Path $scratch 'cache';$profiles=Join-Path $settings 'profiles'
    New-Item -ItemType Directory -Path $profiles,$cache -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $root 'profiles/Neutral.pp3') -Destination (Join-Path $profiles 'Neutral.pp3')
    $profileDir=$profiles.Replace('\','/')
    [IO.File]::WriteAllText((Join-Path $settings 'options'),"[General]`nMultiUser=true`n[Profiles]`nDirectory=$profileDir`nRawDefault=Neutral`nImgDefault=Neutral`nUseBundledProfiles=false`nCustomProfileBuilder=`n[File Browser]`nParseExtensions=cr3;`nParseExtensionsEnabled=1;`n[Metadata]`nXMPSynchronization=none`n",[Text.UTF8Encoding]::new($false))
    $output=Join-Path $scratch 'decoded.jpg'
    $start=[Diagnostics.ProcessStartInfo]::new()
    $start.FileName=Join-Path $root 'rawtherapee-cli.exe';$start.WorkingDirectory=$root
    $start.UseShellExecute=$false;$start.CreateNoWindow=$true
    $start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
    foreach($arg in @('-q','-a','-o',$output,'-p',$profilePath,'-j95','-js3','-c',$inputPath)){$start.ArgumentList.Add($arg)}
    $start.Environment['PATH']='';$start.Environment['RT_SETTINGS']=$settings;$start.Environment['RT_CACHE']=$cache
    $start.Environment['OMP_NUM_THREADS']='8';$start.Environment['OMP_THREAD_LIMIT']='8'
    $process=[Diagnostics.Process]::Start($start)
    try{
        $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
        if(-not $process.WaitForExit(300000)){$process.Kill($true);$process.WaitForExit();throw 'Relocated RAW decode timed out'}
        $diagnostic=$stdout.GetAwaiter().GetResult()+$stderr.GetAwaiter().GetResult()
        if($process.ExitCode -ne 0 -or -not(Test-Path -LiteralPath $output)){throw ('Relocated RAW decode failed: '+$diagnostic.Substring(0,[Math]::Min(1600,$diagnostic.Length)))}
        $peakBytes=$process.PeakWorkingSet64
    }finally{$process.Dispose()}
    $probe=[Diagnostics.ProcessStartInfo]::new()
    $probe.FileName=Join-Path $metadata 'exiftool_files/perl.exe';$probe.WorkingDirectory=Join-Path $metadata 'exiftool_files'
    $probe.UseShellExecute=$false;$probe.CreateNoWindow=$true;$probe.RedirectStandardOutput=$true;$probe.RedirectStandardError=$true
    foreach($arg in @('-Ilib','run-exiftool.pl','-config','','-j','-n','-ImageWidth','-ImageHeight','-ProfileDescription',$output)){$probe.ArgumentList.Add($arg)}
    $probe.Environment['PATH']='';foreach($key in @('LC_ALL','LC_CTYPE','LANG')){$probe.Environment[$key]='C'}
    foreach($key in @($probe.Environment.Keys|Where-Object{$_ -like 'PERL*'})){$probe.Environment.Remove($key)|Out-Null}
    $process=[Diagnostics.Process]::Start($probe)
    try{
        $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
        if(-not $process.WaitForExit(20000)){$process.Kill($true);$process.WaitForExit();throw 'RAW dimension probe timed out'}
        if($process.ExitCode -ne 0){throw 'RAW dimension probe failed'}
        $info=@($stdout.GetAwaiter().GetResult()|ConvertFrom-Json)[0];$null=$stderr.GetAwaiter().GetResult()
    }finally{$process.Dispose()}
    if($info.ImageWidth -ne $ExpectedWidth -or $info.ImageHeight -ne $ExpectedHeight -or $info.ProfileDescription -ne 'RTv4_sRGB'){throw 'Relocated RAW output is not the accepted full-resolution/profile result'}
    if((Get-FileHash -LiteralPath $inputPath -Algorithm SHA256).Hash -ne $sourceHash){throw 'Original RAW changed during smoke test'}
    $report=@{complete=$true;withoutPath=$true;sourceHashUnchanged=$true;sourceSha256=$sourceHash;profileSha256=(Get-FileHash -LiteralPath $profilePath -Algorithm SHA256).Hash;width=$info.ImageWidth;height=$info.ImageHeight;icc=$info.ProfileDescription;elapsedMs=$timer.ElapsedMilliseconds;peakWorkingSetBytes=$peakBytes;outputSha256=(Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash}
    $report|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $evidence 'raw-runtime-smoke.json') -Encoding utf8
    Write-Output ('Relocated RAW worker: full decode without PATH; '+$info.ImageWidth+' x '+$info.ImageHeight+'; '+$timer.ElapsedMilliseconds+' ms')
}finally{
    if(-not $scratch.StartsWith($evidence+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe smoke cleanup target'}
    Remove-Item -LiteralPath $scratch -Recurse -Force
}
