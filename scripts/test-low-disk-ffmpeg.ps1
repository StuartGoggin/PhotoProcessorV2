<#
.SYNOPSIS
Compare a side-by-side FFmpeg candidate against an existing synthetic Quality
fixture and its baseline frame checksums, without copying or re-encoding input.
#>
[CmdletBinding()]
param(
    [string]$Candidate = 'test-output/ffmpeg-test/ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe',
    [string]$FixtureDir = 'test-output/quality-pipeline-20260921T202819652Z',
    [switch]$LegacyGaussian,
    [ValidateRange(1,2)][int]$Repeats = 1,
    [ValidateRange(60,300)][int]$TotalTimeoutSeconds = 180,
    [ValidateRange(512,4096)][int]$MinimumFreeMiB = 1024
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path -Parent $PSScriptRoot
if (@(Get-Process -Name ffmpeg,photogogo-v2 -ErrorAction SilentlyContinue).Count) {
    throw 'Leave existing render work untouched; run the comparison later.'
}
$binary = (Resolve-Path -LiteralPath (Join-Path $root $Candidate)).Path
$fixture = (Resolve-Path -LiteralPath (Join-Path $root $FixtureDir)).Path
$baseline = Get-Content -Raw -LiteralPath (Join-Path $fixture 'report.json') | ConvertFrom-Json
if (-not $baseline.complete -or $baseline.sourceBFrames -ne 3) { throw 'Expected the completed synthetic B-frame baseline.' }
$source = Join-Path $fixture 'source.mp4'
$sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
if ($sourceHash -ne $baseline.sourceSha256) { throw 'Synthetic baseline source hash differs.' }
$motion = Join-Path $fixture 'motion.trf'
$motionHash = (Get-FileHash -LiteralPath $motion -Algorithm SHA256).Hash
$expected = @(Get-Content -LiteralPath (Join-Path $fixture 'serial-quality-1.framemd5') | Where-Object { $_ -notmatch '^#' -and $_.Trim() })
if ($expected.Count -ne $baseline.frames) { throw 'Baseline checksum count differs.' }
$drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($root))
if ($drive.AvailableFreeSpace -lt ($MinimumFreeMiB * 1MB)) { throw "Keep at least $MinimumFreeMiB MiB free; no test started." }
$out = Join-Path $root ('test-output\low-disk-ffmpeg-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))
$null = New-Item -ItemType Directory -Path $out
Copy-Item -LiteralPath $motion -Destination (Join-Path $out 'motion.trf')
$results = [Collections.Generic.List[object]]::new()
$clock = [Diagnostics.Stopwatch]::StartNew()
$complete = $false
$failure = ''
$freeStart = $drive.AvailableFreeSpace
function Quote-Native([string]$Value) {
    if ($Value -notmatch '[\s"]' -and $Value.Length -gt 0) { return $Value }
    return '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}
try {
    $transform = 'vidstabtransform=input=motion.trf:smoothing=18:zoom=4:optzoom=2:zoomspeed=0.25:relative=1:crop=black:interpol=bicubic'
    if ($LegacyGaussian) { $transform += ':optalgo=gauss' }
    $filter = "$transform,unsharp=5:5:0.6:3:3:0.0,scale=3840:2160:force_original_aspect_ratio=decrease:out_range=tv,format=yuv420p,setparams=range=limited,pad=3840:2160:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=50"
    foreach ($repeat in 1..$Repeats) {
        $threadCounts = if ($repeat -eq 1) { @(1,6,12) } else { @(12,6,1) }
        foreach ($threads in $threadCounts) {
            if ($drive.AvailableFreeSpace -lt ($MinimumFreeMiB * 1MB) -or $clock.Elapsed.TotalSeconds -ge $TotalTimeoutSeconds) { throw 'Disk/time safety limit reached.' }
            $name = "threads$threads-repeat$repeat"
            $checksum = Join-Path $out "$name.framemd5"
            $nativeArgs = @('-hide_banner','-nostdin','-n','-loglevel','info','-progress','pipe:1','-nostats',
                '-threads','6','-filter_threads','1','-filter_complex_threads','1','-i',$source,'-frames:v',[string]$baseline.frames,
                '-vf',$filter,'-an','-c:v','rawvideo','-threads','1','-f','framemd5',$checksum)
            $process = [Diagnostics.Process]::new()
            $process.StartInfo.FileName = $binary
            $process.StartInfo.Arguments = ($nativeArgs | ForEach-Object { Quote-Native $_ }) -join ' '
            $process.StartInfo.WorkingDirectory = $out
            $process.StartInfo.UseShellExecute = $false
            $process.StartInfo.CreateNoWindow = $true
            $process.StartInfo.RedirectStandardOutput = $true
            $process.StartInfo.RedirectStandardError = $true
            $process.StartInfo.EnvironmentVariables['OMP_NUM_THREADS'] = [string]$threads
            $process.StartInfo.EnvironmentVariables['OMP_DYNAMIC'] = 'FALSE'
            $started = $false
            $watch = [Diagnostics.Stopwatch]::StartNew()
            $peak = 0L
            try {
                $null = $process.Start(); $started = $true
                $stdoutTask = $process.StandardOutput.ReadToEndAsync()
                $stderrTask = $process.StandardError.ReadToEndAsync()
                while (-not $process.WaitForExit(200)) {
                    $process.Refresh()
                    $peak = [math]::Max($peak, $process.WorkingSet64)
                    if ($watch.Elapsed.TotalSeconds -ge 90 -or $clock.Elapsed.TotalSeconds -ge $TotalTimeoutSeconds -or $drive.AvailableFreeSpace -lt ($MinimumFreeMiB * 1MB)) {
                        $process.Kill(); $process.WaitForExit()
                        throw 'Stopped owned candidate process at its disk/time safety limit.'
                    }
                }
                $watch.Stop()
                $stdout = $stdoutTask.GetAwaiter().GetResult()
                $stderr = $stderrTask.GetAwaiter().GetResult()
                $stderr | Set-Content -LiteralPath (Join-Path $out "$name.log") -Encoding UTF8
                if ($process.ExitCode -ne 0) { throw "$name failed with code $($process.ExitCode)." }
                $frames = [regex]::Matches($stdout, '(?m)^frame=(\d+)\r?$')
                if (-not $frames.Count -or [int]$frames[$frames.Count-1].Groups[1].Value -ne $baseline.frames -or $stdout -notmatch '(?m)^progress=end\r?$') {
                    throw 'Candidate did not complete the expected frame count.'
                }
                $actual = @(Get-Content -LiteralPath $checksum | Where-Object { $_ -notmatch '^#' -and $_.Trim() })
                $equal = ($expected -join "`n") -ceq ($actual -join "`n")
                $results.Add([pscustomobject]@{name=$name;ompThreads=$threads;wallSeconds=$watch.Elapsed.TotalSeconds;
                    cpuSeconds=$process.TotalProcessorTime.TotalSeconds;sampledPeakMiB=[math]::Round($peak/1MB,1);
                    frameCount=$actual.Count;matchesBaselinePixelsAndTimestamps=$equal;arguments=$nativeArgs})
                Write-Host "$name : $([math]::Round($watch.Elapsed.TotalSeconds,3))s, $([math]::Round($peak/1MB,1)) MiB peak, baseline equal=$equal"
                if (-not $equal) { throw 'Pixel/timestamp equivalence gate failed. Candidate must not be packaged.' }
            } finally {
                if ($started -and -not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
                if ($started -and -not (Test-Path -LiteralPath (Join-Path $out "$name.log"))) {
                    $stderrTask.GetAwaiter().GetResult() | Set-Content -LiteralPath (Join-Path $out "$name.log") -Encoding UTF8
                    $stdoutTask.GetAwaiter().GetResult() | Set-Content -LiteralPath (Join-Path $out "$name.progress.log") -Encoding UTF8
                    $results.Add([pscustomobject]@{name=$name;ompThreads=$threads;wallSeconds=$watch.Elapsed.TotalSeconds;
                        sampledPeakMiB=[math]::Round($peak/1MB,1);frameCount=0;matchesBaselinePixelsAndTimestamps=$false;
                        aborted=$true;freeEndMiB=[math]::Round($drive.AvailableFreeSpace/1MB,1)})
                }
                $process.Dispose()
            }
        }
    }
    if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne $sourceHash -or
        (Get-FileHash -LiteralPath $motion -Algorithm SHA256).Hash -ne $motionHash) { throw 'Baseline fixture changed.' }
    $complete = $true
} catch {
    $failure = $_.Exception.Message
    throw
} finally {
    [pscustomobject]@{complete=$complete;failure=$failure;candidate=$binary;
        candidateSha256=(Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash;
        fixture=$fixture;sourceSha256=$sourceHash;motionSha256=$motionHash;legacyGaussian=[bool]$LegacyGaussian;
        elapsedSeconds=$clock.Elapsed.TotalSeconds;minimumFreeMiB=$MinimumFreeMiB;freeStartGiB=[math]::Round($freeStart/1GB,3);
        freeEndGiB=[math]::Round($drive.AvailableFreeSpace/1GB,3);results=@($results.ToArray());
        limitations=@('Full Quality filter chain only; frame checksums instead of video encoding.',
            'Uses the existing first-pass motion data, not a new detection pass.',
            'No private footage, audio, production queue or NVIDIA execution validation.')} |
        ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $out 'report.json') -Encoding UTF8
    Write-Host "Report: $out\report.json"
}
