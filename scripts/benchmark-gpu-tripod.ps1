#Requires -Version 7.0
param(
    [string]$Source = '',
    [int]$Frames = 50,
    [int]$ProcessTimeoutSeconds = 45
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = Split-Path -Parent $PSScriptRoot
if ($Frames -lt 1 -or $Frames -gt 100 -or $ProcessTimeoutSeconds -lt 5 -or $ProcessTimeoutSeconds -gt 60) { throw 'Benchmark exceeds the approved bounded fixture/time limits.' }
if (Get-Process -Name ffmpeg,photogogo-v2,photogogo-gpu-tripod -ErrorAction SilentlyContinue) { throw 'A render/app/media process is active; bounded benchmark refused.' }
$ffmpeg = Join-Path $repoRoot 'src-tauri/tools/ffmpeg/bin/ffmpeg.exe'
$ffprobe = Join-Path $repoRoot 'src-tauri/tools/ffmpeg/bin/ffprobe.exe'
$worker = Join-Path $repoRoot 'src-tauri/tools/gpu-tripod/photogogo-gpu-tripod.exe'
$folder = Join-Path $repoRoot ('test-output/gpu-tripod-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))
New-Item -ItemType Directory -Path $folder | Out-Null
$results = [Collections.Generic.List[object]]::new()
$synthetic = -not $Source
function Run-Bounded([string]$Name,[string]$Binary,[string[]]$Arguments) {
    $start = [Diagnostics.ProcessStartInfo]::new($Binary)
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $start.WorkingDirectory = $folder
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $start
    $clock = [Diagnostics.Stopwatch]::StartNew()
    if (-not $process.Start()) { throw "$Name did not start" }
    $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
    try {
        if (-not $process.WaitForExit($ProcessTimeoutSeconds * 1000)) { $process.Kill($true); $process.WaitForExit(); throw "$Name exceeded its bounded deadline" }
        $clock.Stop()
        $out = $stdout.GetAwaiter().GetResult(); $err = $stderr.GetAwaiter().GetResult()
        [IO.File]::WriteAllText((Join-Path $folder "$Name.stdout.txt"), $out)
        [IO.File]::WriteAllText((Join-Path $folder "$Name.stderr.txt"), $err)
        if ($process.ExitCode -ne 0) { throw "$Name failed: $err" }
        $results.Add([pscustomobject]@{ stage=$Name; seconds=$clock.Elapsed.TotalSeconds; cpuSeconds=$process.TotalProcessorTime.TotalSeconds; peakWorkingSet=$process.PeakWorkingSet64 })
        return $out
    } finally { if (-not $process.HasExited) { $process.Kill($true) }; $process.Dispose() }
}
if (-not $Source) {
    $Source = Join-Path $folder 'source.mp4'
    Run-Bounded 'fixture' $ffmpeg @('-v','error','-n','-f','lavfi','-i','testsrc2=size=3840x2160:rate=50','-frames:v',"$Frames",'-c:v','libx264','-preset','ultrafast','-threads','4','-pix_fmt','yuv420p',$Source) | Out-Null
} else { $Source = (Resolve-Path -LiteralPath $Source).Path }
$sourceInfo = (Run-Bounded 'source-info' $ffprobe @('-v','error','-show_streams','-of','json',$Source)) | ConvertFrom-Json
$sourceVideo = $sourceInfo.streams | Where-Object codec_type -eq video | Select-Object -First 1
if (-not $sourceVideo -or $sourceVideo.pix_fmt -notin 'yuv420p','yuvj420p','nv12' -or $sourceVideo.width -gt 4096 -or $sourceVideo.height -gt 4096) { throw 'This bounded GPU benchmark requires SDR 8-bit 4:2:0 footage up to 4096 pixels per axis; no silent precision reduction.' }
foreach ($field in @('color_transfer','color_primaries','color_space','field_order')) {
    $property = $sourceVideo.PSObject.Properties[$field]
    $allowed = if ($field -eq 'field_order') { @('','unknown','progressive') } else { @('','unknown','bt709') }
    if ($property -and $property.Value -notin $allowed) { throw "Unsupported source $field=$($property.Value); no implicit HDR/Log/interlace conversion." }
}
$hasSourceAudio = @($sourceInfo.streams | Where-Object codec_type -eq audio).Count -gt 0
$audioArgument = if ($hasSourceAudio) { 'yes' } else { 'no' }
$seconds = ([double]$Frames / 50).ToString('R',[Globalization.CultureInfo]::InvariantCulture)
$sourceHash = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash
$output = Join-Path $folder 'gpu.mp4'
Run-Bounded 'probe' $worker @('--probe') | Out-Null
Run-Bounded 'gpu-render' $worker @('--render','--ffmpeg',$ffmpeg,'--source',$Source,'--output',$output,
    '--width','3840','--height','2160','--fps','50','--threads','2','--encoder','libx264','--bitrate','32',
    '--seconds',$seconds,'--offset','0','--crop','0.04','--preset','balanced','--audio',$audioArgument) | Out-Null
$info = (Run-Bounded 'verify' $ffprobe @('-v','error','-count_frames','-show_streams','-show_format','-of','json',$output)) | ConvertFrom-Json
$video = $info.streams | Where-Object codec_type -eq video | Select-Object -First 1
$audio = $info.streams | Where-Object codec_type -eq audio | Select-Object -First 1
$range = if ($video.PSObject.Properties['color_range']) { $video.color_range } else { 'unspecified' }
if ([int]$video.nb_read_frames -ne $Frames -or $video.width -ne 3840 -or $video.height -ne 2160 -or $video.pix_fmt -ne 'yuv420p' -or $video.codec_name -ne 'h264' -or $range -eq 'pc' -or -not $audio) { throw 'Output frames/format/audio contract failed.' }
$receiptLine = Get-Content (Join-Path $folder 'gpu-render.stderr.txt') | Where-Object { $_.StartsWith('GPU_TRIPOD_RECEIPT ') } | Select-Object -Last 1
if (-not $receiptLine) { throw 'Native stage receipt is missing.' }
$receipt = $receiptLine.Substring('GPU_TRIPOD_RECEIPT '.Length) | ConvertFrom-Json
if ($receipt.maxBufferedFrames -gt 17 -or $receipt.frames -ne $Frames) { throw 'Memory/window/frame contract failed.' }
if ((Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash -ne $sourceHash) { throw 'Source checksum changed during the read-only benchmark.' }
$report = [pscustomobject]@{ synthetic=$synthetic; source=$Source; sourceSha256=$sourceHash; output=$output; sourceOriginalUntouched=$true; sourceAudioPreserved=$hasSourceAudio; processMetricsExcludeChildProcesses=$true; stages=$results; gpu=$receipt; frameCount=[int]$video.nb_read_frames }
[IO.File]::WriteAllText((Join-Path $folder 'report.json'),($report | ConvertTo-Json -Depth 10))
$report | ConvertTo-Json -Depth 10
