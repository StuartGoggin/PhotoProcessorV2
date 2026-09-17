<#
.SYNOPSIS
Compares the legacy two-pass Video Studio stabilizer with the fast single-pass path.
.DESCRIPTION
Creates two small synthetic clips with audio, benchmarks software and available
hardware encoders, verifies every output, and saves JSON receipts and contact sheets
under test-output/studio-benchmark. It never opens or modifies user source footage.
Per-process timeout and a 100 MiB output guard bound each run. Hardware is probed by
encoding frames; an advertised encoder alone does not count as usable.
.EXAMPLE
.\scripts\benchmark-video-studio.ps1 -FFmpegPath 'C:\tools\ffmpeg\bin\ffmpeg.exe'
.EXAMPLE
.\scripts\benchmark-video-studio.ps1 -FFmpegPath 'C:\tools\ffmpeg\bin\ffmpeg.exe' -Width 1920 -DurationSeconds 4
#>
[CmdletBinding()]
param(
    [string]$FFmpegPath = 'ffmpeg',
    [ValidateSet(1280, 1920)][int]$Width = 1280,
    [ValidateRange(2, 12)][int]$DurationSeconds = 8,
    [ValidateRange(1, 300)][int]$CommandTimeoutSeconds = 180,
    [switch]$SkipHardware
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = Split-Path -Parent $PSScriptRoot
$runDir = Join-Path $repoRoot ('test-output\studio-benchmark\' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
$null = New-Item -ItemType Directory -Path $runDir -Force
$ffmpeg = (Get-Command $FFmpegPath -ErrorAction Stop).Source
$ffprobe = Join-Path (Split-Path -Parent $ffmpeg) 'ffprobe.exe'
if (-not (Test-Path -LiteralPath $ffprobe)) { throw "ffprobe must be beside FFmpeg: $ffprobe" }
$height = [int]($Width * 9 / 16)
$fps = 30
$expectedFrames = $fps * $DurationSeconds
$script:logIndex = 0
$measurements = [System.Collections.Generic.List[object]]::new()
$hardware = [System.Collections.Generic.List[object]]::new()
$sources = [System.Collections.Generic.List[object]]::new()

function ConvertTo-NativeArgument([string]$Value) {
    if ($Value -notmatch '[\s"]' -and $Value.Length -gt 0) { return $Value }
    return '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}

function Invoke-MeasuredProcess {
    param([string]$Label, [string[]]$Arguments, [string]$Executable = $ffmpeg,
        [int]$Threads = 2, [switch]$AllowFailure)
    $script:logIndex++
    $stem = '{0:00}-{1}' -f $script:logIndex, $Label
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = [Diagnostics.ProcessStartInfo]::new()
    $process.StartInfo.FileName = $Executable
    $process.StartInfo.Arguments = ($Arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' '
    $process.StartInfo.WorkingDirectory = $runDir
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardError = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.EnvironmentVariables['OMP_NUM_THREADS'] = [string]$Threads
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $null = $process.Start()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    while (-not $process.WaitForExit(250)) {
        if ($watch.Elapsed.TotalSeconds -gt $CommandTimeoutSeconds) {
            $process.Kill()
            $process.WaitForExit()
            throw "$Label exceeded $CommandTimeoutSeconds seconds; stopped PID $($process.Id)."
        }
    }
    $watch.Stop()
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $cpuSeconds = $process.TotalProcessorTime.TotalSeconds
    $exitCode = $process.ExitCode
    $process.Dispose()
    $stderr | Set-Content -LiteralPath (Join-Path $runDir "$stem.log") -Encoding UTF8
    $result = [pscustomobject]@{
        label = $Label; exitCode = $exitCode; wallSeconds = [Math]::Round($watch.Elapsed.TotalSeconds, 3)
        cpuSeconds = [Math]::Round($cpuSeconds, 3); ompThreads = $Threads
        arguments = $Arguments; stdout = $stdout; log = "$stem.log"
    }
    if ($exitCode -ne 0 -and -not $AllowFailure) { throw "$Label failed ($exitCode). See $runDir\$stem.log`n$stderr" }
    return $result
}

function Read-Video([string]$Name) {
    $probe = Invoke-MeasuredProcess -Label "probe-$Name" -Executable $ffprobe -Arguments @(
        '-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', $Name)
    $data = $probe.stdout | ConvertFrom-Json
    $video = @($data.streams | Where-Object codec_type -eq 'video')[0]
    $audio = @($data.streams | Where-Object codec_type -eq 'audio')
    $seconds = [double]::Parse([string]$data.format.duration, [Globalization.CultureInfo]::InvariantCulture)
    $valid = $video.width -eq $Width -and $video.height -eq $height -and
        [int]$video.nb_read_frames -eq $expectedFrames -and $audio.Count -eq 1 -and
        [Math]::Abs($seconds - $DurationSeconds) -lt 0.1
    $summary = [pscustomobject]@{
        valid = $valid; width = $video.width; height = $video.height; frames = [int]$video.nb_read_frames
        durationSeconds = $seconds; audioStreams = $audio.Count
        videoCodec = $video.codec_name; audioCodec = if ($audio.Count) { $audio[0].codec_name } else { $null }
    }
    if (-not $valid) { throw "Output verification failed for $Name`: $($summary | ConvertTo-Json -Compress)" }
    return $summary
}

$common = @('-hide_banner', '-nostdin', '-y', '-loglevel', 'warning')
$rate = if ($Width -eq 1920) { '10M' } else { '4M' }
$encodeCommon = @('-b:v', $rate, '-maxrate', $rate, '-bufsize', '64M', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-video_track_timescale', '90000')
$version = Invoke-MeasuredProcess -Label 'version' -Arguments @('-version')
function Write-BenchmarkReport([bool]$Completed) {
    [pscustomobject]@{
        createdUtc = [DateTime]::UtcNow.ToString('o'); completed = $Completed; directory = $runDir; ffmpeg = $ffmpeg
        ffmpegVersion = ($version.stdout -split "`r?`n")[0]; width = $Width; height = $height
        durationSeconds = $DurationSeconds; fps = $fps; logicalProcessors = [Environment]::ProcessorCount
        hardwareProbes = @($hardware.ToArray()); sources = @($sources.ToArray()); measurements = @($measurements.ToArray())
        limitations = @(
            'One sequential run per variant; no statistical confidence interval or cold-cache control.',
            'Synthetic translation and pan only; not evidence for rotation, rolling shutter, low light, occlusion, or real footage.',
            'All variants use a two-thread CPU budget to isolate stabilizer and encoder effects; production parallel scheduling is measured separately.',
            'Hardware bitrate/preset quality differs from x264; speed is not a claim of equal visual quality.',
            'Contact sheets show individual frames only; temporal stability and tracking-pan preservation require watching the MP4 files.',
            'Includes video filtering plus AAC audio encoding. Excludes application startup, cache, titles, assembly, and production queue overhead.'
        )
    } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $runDir 'report.json') -Encoding UTF8
}
$cases = [System.Collections.Generic.List[object]]::new()
$cases.Add([pscustomobject]@{ name = 'baseline-software'; encoder = 'libx264'; preset = 'veryfast'; threads = 2; twoPass = $true })
$cases.Add([pscustomobject]@{ name = 'fast-software'; encoder = 'libx264'; preset = 'veryfast'; threads = 2; twoPass = $false })
if (-not $SkipHardware) {
    foreach ($candidate in @(
        [pscustomobject]@{ encoder = 'h264_nvenc'; preset = 'p4'; name = 'fast-nvenc' },
        [pscustomobject]@{ encoder = 'h264_qsv'; preset = 'veryfast'; name = 'fast-qsv' }
    )) {
        $probe = Invoke-MeasuredProcess -Label "encoder-$($candidate.encoder)" -AllowFailure -Threads 4 -Arguments ($common + @(
            '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=30', '-t', '0.3',
            '-c:v', $candidate.encoder, '-preset', $candidate.preset, '-pix_fmt', 'yuv420p', '-f', 'null', '-'))
        $hardware.Add([pscustomobject]@{ encoder = $candidate.encoder; available = $probe.exitCode -eq 0; log = $probe.log })
        if ($probe.exitCode -eq 0) {
            $cases.Add([pscustomobject]@{ name = $candidate.name; encoder = $candidate.encoder; preset = $candidate.preset; threads = 2; twoPass = $false })
        }
    }
}

# Static, asymmetric landmarks and grid make the global camera motion reproducible.
# Only the crop window moves; no real footage or user source files are involved.
$canvasWidth = $Width + 256
$canvasHeight = $height + 128
$landmarks = [System.Collections.Generic.List[string]]::new()
$landmarks.Add("color=c=0x182536:s=${canvasWidth}x${canvasHeight}:r=$fps")
$landmarks.Add('drawgrid=w=80:h=80:t=2:c=white@0.6')
$random = [Random]::new(4765)
for ($i = 0; $i -lt 70; $i++) {
    $x = $random.Next(10, $canvasWidth - 90)
    $y = $random.Next(10, $canvasHeight - 90)
    $boxWidth = $random.Next(12, 70)
    $boxHeight = $random.Next(12, 70)
    $color = '{0:X6}' -f $random.Next(0x555555, 0xffffff)
    $landmarks.Add("drawbox=x=${x}:y=${y}:w=${boxWidth}:h=${boxHeight}:c=0x${color}:t=fill")
}

foreach ($scene in @('jitter', 'pan')) {
    $pan = if ($scene -eq 'pan') { "+100*n/$expectedFrames" } else { '' }
    $sceneFilter = ($landmarks -join ',') + ",crop=${Width}:${height}:'64+9*sin(n*1.19)+3*sin(n*0.73)$pan':'64+7*sin(n*1.37)+2*cos(n*0.57)',setsar=1"
    $sourceName = "$scene-source.mp4"
    Write-Host "Generating $scene ($Width x $height, $DurationSeconds seconds)."
    $null = Invoke-MeasuredProcess -Label "generate-$scene" -Arguments ($common + @(
        '-f', 'lavfi', '-i', $sceneFilter, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', [string]$DurationSeconds, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
        '-threads', '2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', $sourceName))
    $originalHash = (Get-FileHash -LiteralPath (Join-Path $runDir $sourceName) -Algorithm SHA256).Hash
    $sourceInfo = Read-Video $sourceName
    $sources.Add([pscustomobject]@{ scene = $scene; file = $sourceName; sha256 = $originalHash; verification = $sourceInfo })
    foreach ($case in $cases) {
        Write-Host "Benchmarking $scene / $($case.name)."
        $passes = [System.Collections.Generic.List[object]]::new()
        if ($case.twoPass) {
            $transform = "$scene-motion.trf"
            $passes.Add((Invoke-MeasuredProcess -Label "$scene-detect" -Threads 2 -Arguments ($common + @(
                '-threads', '2', '-i', $sourceName, '-vf',
                "vidstabdetect=stepsize=8:shakiness=3:accuracy=10:mincontrast=0.25:result=$transform",
                '-an', '-f', 'null', '-'))))
            $filter = "vidstabtransform=input=${transform}:smoothing=18:zoom=4:optzoom=2:zoomspeed=0.25:relative=1:crop=black:interpol=bicubic"
        } else {
            # Four percent per edge; proportional to the input dimensions, even-sized.
            $filter = 'deshake=rx=16:ry=16:edge=mirror:blocksize=8:contrast=125:search=less,crop=trunc(iw*0.92/2)*2:trunc(ih*0.92/2)*2'
        }
        $filter += ",unsharp=5:5:0.6:3:3:0.0,scale=${Width}:${height}:flags=bicubic,setsar=1,fps=$fps"
        $outputName = "$scene-$($case.name).mp4"
        $passes.Add((Invoke-MeasuredProcess -Label "$scene-$($case.name)" -Threads $case.threads -Arguments ($common + @(
            '-threads', [string]$case.threads, '-i', $sourceName, '-map', '0:v:0', '-map', '0:a:0', '-vf', $filter,
            '-c:v', $case.encoder, '-preset', $case.preset, '-threads', [string]$case.threads) + $encodeCommon + @($outputName))))
        $verification = Read-Video $outputName
        $wall = [double](($passes | Measure-Object wallSeconds -Sum).Sum)
        $cpu = [double](($passes | Measure-Object cpuSeconds -Sum).Sum)
        $measurements.Add([pscustomobject]@{
            scene = $scene; variant = $case.name; file = $outputName; encoder = $case.encoder
            threads = $case.threads; wallSeconds = [Math]::Round($wall, 3); cpuSeconds = [Math]::Round($cpu, 3)
            realtimeMultiplier = [Math]::Round($DurationSeconds / $wall, 3)
            meanCpuCores = [Math]::Round($cpu / $wall, 3); filter = $filter; verification = $verification
            passes = @($passes.ToArray())
        })
        Write-BenchmarkReport $false
        $totalBytes = (Get-ChildItem -LiteralPath $runDir -File | Measure-Object Length -Sum).Sum
        if ($totalBytes -gt 100MB) { throw "Benchmark output exceeded 100 MiB; stopped: $runDir" }
    }
    if ((Get-FileHash -LiteralPath (Join-Path $runDir $sourceName) -Algorithm SHA256).Hash -ne $originalHash) {
        throw "Source SHA-256 changed: $sourceName"
    }

    # Four sampled moments per row. This reveals crop/edge differences, but does not
    # establish temporal smoothness; the MP4 files must also be watched side by side.
    $sheetNames = @($sourceName) + @($cases | ForEach-Object { "$scene-$($_.name).mp4" })
    $sheetLabels = @('source') + @($cases | ForEach-Object name)
    $sheetArgs = @($common)
    $graph = [System.Collections.Generic.List[string]]::new()
    $fontFile = (Join-Path $env:WINDIR 'Fonts\arial.ttf').Replace('\', '/').Replace(':', '\:')
    for ($i = 0; $i -lt $sheetNames.Count; $i++) {
        $sheetArgs += @('-i', $sheetNames[$i])
        $interval = $DurationSeconds / 4
        $intervalText = $interval.ToString([Globalization.CultureInfo]::InvariantCulture)
        $graph.Add("[${i}:v]fps=1/${intervalText},scale=320:180,drawtext=fontfile='${fontFile}':text='$($sheetLabels[$i])':fontcolor=white:fontsize=17:box=1:boxcolor=black@0.75:x=6:y=6,tile=4x1:nb_frames=4[row$i]")
    }
    $rows = (0..($sheetNames.Count - 1) | ForEach-Object { "[row$_]" }) -join ''
    $graph.Add("${rows}vstack=inputs=$($sheetNames.Count)[sheet]")
    $sheetArgs += @('-filter_complex', ($graph -join ';'), '-map', '[sheet]', '-frames:v', '1', '-update', '1', "$scene-contact-sheet.png")
    $null = Invoke-MeasuredProcess -Label "$scene-contact-sheet" -Arguments $sheetArgs
}

Write-BenchmarkReport $true
$measurements | Select-Object scene, variant, wallSeconds, cpuSeconds, realtimeMultiplier, meanCpuCores | Format-Table -AutoSize
Write-Host "Report: $runDir\report.json"
