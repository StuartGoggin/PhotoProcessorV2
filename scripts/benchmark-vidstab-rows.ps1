<#
.SYNOPSIS
Bounded, isolated upstream transform test. Does not replace or invoke production FFmpeg.
#>
[CmdletBinding()]
param(
    [string]$BuildDir = 'test-output/parallel-vidstab-build',
    [ValidateRange(1, 10)][int]$FramesPerSweep = 5,
    [ValidateRange(60, 300)][int]$TotalTimeoutSeconds = 180
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = Split-Path -Parent $PSScriptRoot
if (@(Get-Process -Name ffmpeg,photogogo-v2 -ErrorAction SilentlyContinue).Count) {
    throw 'Leave active FFmpeg/PhotoGoGo work untouched; run the benchmark later.'
}
$build = (Resolve-Path -LiteralPath (Join-Path $repoRoot $BuildDir)).Path
$runDir = Join-Path $repoRoot ('test-output\vidstab-rows-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))
$null = New-Item -ItemType Directory -Path $runDir
$total = [Diagnostics.Stopwatch]::StartNew()
$results = [Collections.Generic.List[object]]::new()
function Invoke-Bounded([string]$Label, [string]$File, [string]$Arguments, [int]$Threads) {
    if ($total.Elapsed.TotalSeconds -ge $TotalTimeoutSeconds) { throw 'Total time limit reached.' }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo.FileName = $File
    $process.StartInfo.Arguments = $Arguments
    $process.StartInfo.WorkingDirectory = $runDir
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    $process.StartInfo.EnvironmentVariables['OMP_NUM_THREADS'] = [string]$Threads
    $process.StartInfo.EnvironmentVariables['OMP_DYNAMIC'] = 'FALSE'
    $started = $false
    $watch = [Diagnostics.Stopwatch]::StartNew()
    try {
        $null = $process.Start(); $started = $true
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        while (-not $process.WaitForExit(200)) {
            if ($watch.Elapsed.TotalSeconds -ge 90 -or $total.Elapsed.TotalSeconds -ge $TotalTimeoutSeconds) {
                $process.Kill(); $process.WaitForExit()
                throw "Stopped owned benchmark PID $($process.Id): time limit for $Label."
            }
        }
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
        ($stdout + "`n" + $stderr) | Set-Content -LiteralPath (Join-Path $runDir "$Label.log") -Encoding UTF8
        if ($process.ExitCode -ne 0) { throw "$Label failed ($($process.ExitCode)); see $runDir\$Label.log" }
        Write-Host "$Label ($([math]::Round($watch.Elapsed.TotalSeconds,2))s): $($stdout.Trim())"
        return $stdout
    } finally {
        if ($started -and -not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
        $process.Dispose()
    }
}
$complete = $false
$failure = ''
try {
    foreach ($repeat in 1,2) {
        $threadCounts = if ($repeat -eq 1) { @(1,6,12) } else { @(12,6,1) }
        foreach ($threads in $threadCounts) {
            $label = "quality-4k-threads$threads-repeat$repeat"
            $stdout = Invoke-Bounded $label (Join-Path $build 'Release\rowbench.exe') "quality 3840 2160 $FramesPerSweep" $threads
            if ($stdout -notmatch "actual_threads=$threads(?:\r?\n)") { throw "Actual OpenMP thread count did not match $threads." }
            if ($stdout -notmatch '([0-9.]+) ms/frame\s+\[([0-9a-f]{16})\]') { throw 'Missing timing/checksum result.' }
            $results.Add([pscustomobject]@{label=$label;threads=$threads;millisecondsPerFrame=[double]$Matches[1];frameHash=$Matches[2]})
        }
    }
    if (@($results.frameHash | Select-Object -Unique).Count -ne 1) { throw 'Thread counts changed frame output.' }
    foreach ($threads in 1,12) {
        $null = Invoke-Bounded "regression-threads$threads" (Join-Path $build 'Release\tests.exe') '--testBASE --testINC --testTPR --testCG --testIP' $threads
    }
    $equivalence = Invoke-Bounded 'row-equivalence' (Join-Path $build 'Release\rowbench.exe') 'row-equivalence' 1
    if ($equivalence -notmatch 'byte_equal_frame_pairs=192') { throw 'Missing 192-frame-pair byte equivalence proof.' }
    $complete = $true
} catch {
    $failure = $_.Exception.Message
    throw
} finally {
    [pscustomobject]@{
        complete=$complete;failure=$failure;elapsedSeconds=$total.Elapsed.TotalSeconds
        upstreamCommit='e2445c4081658318223762a696eb1c645c2d7168'
        framesPerSweep=$FramesPerSweep;sweepsPerCase=3;width=3840;height=2160
        byteEqualFramePairs=if ($complete) {192} else {0}
        results=@($results.ToArray())
        limitations=@('Synthetic fixed-transform bicubic YUV420P only; no decoder, encoder, audio or production queue.',
            'Frame hash is upstream FNV-1a of one warm-up output, not a whole-clip equivalence check.',
            'Each number is the fastest of three upstream sweeps, not end-to-end throughput.',
            'Agreement across thread counts does not establish agreement with the installed older vid.stab.')
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $runDir 'report.json') -Encoding UTF8
    Write-Host "Report: $runDir\report.json"
}
