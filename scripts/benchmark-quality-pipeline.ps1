<#
.SYNOPSIS
Bounded, synthetic stage measurements for the recorded 4K50 Quality pipeline.
.DESCRIPTION
Does not open user footage or modify application settings. Refuses to start while
FFmpeg or PhotoGoGo is running locally. Null-output measurements isolate CPU
stages; they are NOT a render-PC or end-to-end NVENC throughput claim.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$FFmpegPath,
    [ValidateRange(50, 200)][int]$Frames = 100,
    [ValidateRange(1, 3)][int]$Repeats = 2,
    [ValidateRange(1, 12)][int]$Threads = 6,
    [ValidateSet('stages', 'pixel-format', 'filter-threads', 'guarded-threads')][string]$Experiment = 'stages',
    [ValidateRange(0, 3)][int]$SourceBFrames = 0,
    [ValidateRange(30, 180)][int]$ProcessTimeoutSeconds = 120,
    [ValidateRange(60, 900)][int]$TotalTimeoutSeconds = 600
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (@(Get-Process -Name ffmpeg,photogogo-v2 -ErrorAction SilentlyContinue).Count) {
    throw 'Local FFmpeg or PhotoGoGo is running; leave that work untouched and run this test later.'
}
$binary = (Get-Item -LiteralPath $FFmpegPath -ErrorAction Stop).FullName
$repoRoot = Split-Path -Parent $PSScriptRoot
$runDir = Join-Path $repoRoot ('test-output\quality-pipeline-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))
$null = New-Item -ItemType Directory -Path $runDir
$measurements = [System.Collections.Generic.List[object]]::new()
$totalWatch = [Diagnostics.Stopwatch]::StartNew()
$script:index = 0
$version = ''
$sourceHash = ''

function Quote-Argument([string]$Value) {
    if ($Value -notmatch '[\s"]' -and $Value.Length -gt 0) { return $Value }
    return '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}
function Save-Report([bool]$Complete, [string]$Failure = '') {
    [pscustomobject]@{
        complete = $Complete; failure = $Failure; ffmpeg = $binary; version = $version
        directory = $runDir; width = 3840; height = 2160; fps = 50; frames = $Frames
        requestedThreads = $Threads; sourceSha256 = $sourceHash
        experiment = $Experiment; sourceBFrames = $SourceBFrames
        measurements = @($measurements.ToArray())
        limitations = @(
            'Synthetic full-range H.264 footage, not private render-PC footage.',
            'Null output isolates decoding/filtering; does not measure NVENC, audio, disk publication or the production queue.',
            'Local hardware and FFmpeg version may differ from the render PC.',
            'Removing stages is diagnostic only; no reduced-quality variant is a proposed fix.'
        )
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $runDir 'report.json') -Encoding UTF8
}
function Invoke-Case([string]$Label, [string[]]$NativeArgs) {
    if ($totalWatch.Elapsed.TotalSeconds -ge $TotalTimeoutSeconds) { throw 'Total benchmark time limit reached.' }
    $script:index++
    $log = '{0:00}-{1}.log' -f $script:index, $Label
    $process = [Diagnostics.Process]::new()
    $process.StartInfo.FileName = $binary
    $process.StartInfo.Arguments = ($NativeArgs | ForEach-Object { Quote-Argument $_ }) -join ' '
    $process.StartInfo.WorkingDirectory = $runDir
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    $process.StartInfo.EnvironmentVariables['OMP_NUM_THREADS'] = [string]$Threads
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $started = $false
    $peakWorkingSet = 0L
    try {
        $null = $process.Start()
        $started = $true
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        while (-not $process.WaitForExit(200)) {
            $process.Refresh()
            $peakWorkingSet = [math]::Max($peakWorkingSet, $process.WorkingSet64)
            if ($watch.Elapsed.TotalSeconds -ge $ProcessTimeoutSeconds -or $totalWatch.Elapsed.TotalSeconds -ge $TotalTimeoutSeconds) {
                $process.Kill()
                $process.WaitForExit()
                throw "Stopped only owned benchmark PID $($process.Id): $Label exceeded the time limit."
            }
        }
        $watch.Stop()
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
        $stderr | Set-Content -LiteralPath (Join-Path $runDir $log) -Encoding UTF8
        if ($process.ExitCode -ne 0) { throw "$Label failed ($($process.ExitCode)); see $runDir\$log`n$stderr" }
        $verifiedFrames = $null
        if ($Label -ne 'version') {
            $counters = [regex]::Matches($stdout, '(?m)^frame=(\d+)\r?$')
            if (-not $counters.Count -or $stdout -notmatch '(?m)^progress=end\r?$') {
                throw "$Label did not report completed frame progress."
            }
            $verifiedFrames = [int]$counters[$counters.Count - 1].Groups[1].Value
            if ($verifiedFrames -ne $Frames) { throw "$Label processed $verifiedFrames frames, expected $Frames." }
        }
        $bytes = (Get-ChildItem -LiteralPath $runDir -File | Measure-Object -Property Length -Sum).Sum
        if ($bytes -gt 100MB) { throw 'Benchmark output exceeded 100 MiB.' }
        $item = [pscustomobject]@{
            label = $Label; wallSeconds = [math]::Round($watch.Elapsed.TotalSeconds, 4)
            cpuSeconds = [math]::Round($process.TotalProcessorTime.TotalSeconds, 4)
            sampledPeakWorkingSetMiB = if ($peakWorkingSet -gt 0) { [math]::Round($peakWorkingSet / 1MB, 1) } else { $null }
            verifiedFrames = $verifiedFrames
            arguments = $NativeArgs; log = $log; stdout = $stdout
        }
        Write-Host "$Label : $($item.wallSeconds)s wall; $($item.cpuSeconds)s CPU; $($item.sampledPeakWorkingSetMiB) MiB sampled peak"
        return $item
    } finally {
        if ($started -and -not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
        $process.Dispose()
    }
}

try {
    $common = @('-hide_banner', '-nostdin', '-n', '-loglevel', 'warning', '-progress', 'pipe:1', '-nostats')
    if ($Experiment -eq 'pixel-format') { $common[4] = 'verbose' }
    $version = ((Invoke-Case 'version' @('-version')).stdout -split "`r?`n")[0]
    $fixture = 'testsrc2=size=3968x2288:rate=50,crop=3840:2160:x=64+9*sin(n*1.19)+3*sin(n*0.73):y=64+7*sin(n*1.37)+2*cos(n*0.57),scale=in_range=tv:out_range=pc,format=yuvj420p'
    $null = Invoke-Case 'fixture' ($common + @('-filter_threads','1','-f','lavfi','-i',$fixture,'-frames:v',[string]$Frames,'-c:v','libx264','-preset','ultrafast','-crf','18','-bf',[string]$SourceBFrames,'-threads','2','-pix_fmt','yuvj420p','-color_range','pc','source.mp4'))
    $sourceHash = (Get-FileHash -LiteralPath (Join-Path $runDir 'source.mp4') -Algorithm SHA256).Hash
    $inputArgs = $common + @('-threads',[string]$Threads,'-filter_threads','1','-filter_complex_threads','1','-i','source.mp4','-frames:v',[string]$Frames)
    $detect = Invoke-Case 'analyse-shake' ($inputArgs + @('-vf','vidstabdetect=stepsize=8:shakiness=3:accuracy=10:mincontrast=0.25:result=motion.trf','-an','-f','null','-'))
    $measurements.Add($detect)
    $transform = 'vidstabtransform=input=motion.trf:smoothing=18:zoom=4:optzoom=2:zoomspeed=0.25:relative=1:crop=black:interpol=bicubic'
    $unsharp = 'unsharp=5:5:0.6:3:3:0.0'
    $output = 'scale=3840:2160:force_original_aspect_ratio=decrease:out_range=tv,format=yuv420p,setparams=range=limited,pad=3840:2160:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=50'
    $cases = @(
        [pscustomobject]@{name='decode';filter='null'},
        [pscustomobject]@{name='output-format';filter=$output},
        [pscustomobject]@{name='sharpen-format';filter="$unsharp,$output"},
        [pscustomobject]@{name='stabilize-format';filter="$transform,$output"},
        [pscustomobject]@{name='production-quality';filter="$transform,$unsharp,$output"}
    )
    if ($Experiment -eq 'pixel-format') {
        $cases = @(
            [pscustomobject]@{name='production-quality';filter="$transform,$unsharp,$output"},
            [pscustomobject]@{name='planar-full-quality';filter="scale=in_range=pc:out_range=pc,format=yuv420p,setparams=range=full,$transform,$unsharp,$output"},
            [pscustomobject]@{name='planar-limited-quality';filter="scale=in_range=pc:out_range=tv,format=yuv420p,setparams=range=limited,$transform,$unsharp,$output"}
        )
    }
    if ($Experiment -eq 'filter-threads') {
        $cases = @(
            [pscustomobject]@{name='serial-quality';filter="$transform,$unsharp,$output";filterThreads=1},
            [pscustomobject]@{name='parallel-quality';filter="$transform,$unsharp,$output";filterThreads=$Threads}
        )
    }
    if ($Experiment -eq 'guarded-threads') {
        $cases = @(
            [pscustomobject]@{name='serial-quality';filter="$transform,$unsharp,$output";filterThreads=1},
            [pscustomobject]@{name='guarded-quality';filter="${transform}:threads=1,$unsharp,$output";filterThreads=$Threads}
        )
    }
    for ($repeat = 1; $repeat -le $Repeats; $repeat++) {
        $ordered = @($cases)
        if ($repeat % 2 -eq 0) { [array]::Reverse($ordered) }
        foreach ($case in $ordered) {
            $caseInput = @($inputArgs)
            $outputArgs = @('-an','-f','null','-')
            if ($Experiment -in @('filter-threads', 'guarded-threads')) {
                $caseInput[[array]::IndexOf($caseInput, '-filter_threads') + 1] = [string]$case.filterThreads
                $caseInput[[array]::IndexOf($caseInput, '-filter_complex_threads') + 1] = [string]$case.filterThreads
                $outputArgs = @('-an','-c:v','rawvideo','-threads','1','-f','framemd5',"$($case.name)-$repeat.framemd5")
            }
            $item = Invoke-Case "$($case.name)-$repeat" ($caseInput + @('-vf',$case.filter) + $outputArgs)
            $measurements.Add($item)
            Save-Report $false
        }
    }
    if ($Experiment -in @('filter-threads', 'guarded-threads')) {
        $hashes = @(Get-ChildItem -LiteralPath $runDir -Filter '*.framemd5' | Get-FileHash -Algorithm SHA256 | Select-Object -ExpandProperty Hash -Unique)
        if ($hashes.Count -ne 1) { throw 'Filter-thread experiment changed frame checksums; do not ship this variant.' }
        Write-Host 'All serial/parallel frame checksum files are byte-identical.'
    }
    if ((Get-FileHash -LiteralPath (Join-Path $runDir 'source.mp4') -Algorithm SHA256).Hash -ne $sourceHash) { throw 'Synthetic source changed unexpectedly.' }
    Save-Report $true
    Write-Host "Report: $runDir\report.json"
} catch {
    Save-Report $false $_.Exception.Message
    throw
}
