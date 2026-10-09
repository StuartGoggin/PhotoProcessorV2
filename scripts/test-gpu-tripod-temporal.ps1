#Requires -Version 7.0
# Complete-video oracle: a static, textured scene with a known periodic XY shake.
# Comparing temporal luma differences exercises accepted motion and smoothing;
# this is deliberately not a substitute for real horse-footage acceptance.
param([int]$ProcessTimeoutSeconds = 45,[ValidateSet('720p','2160p')][string]$Resolution = '720p')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($ProcessTimeoutSeconds -lt 5 -or $ProcessTimeoutSeconds -gt 60) { throw 'Temporal test deadline must be 5..60 seconds per stage.' }
if (Get-Process -Name ffmpeg,photogogo-v2,photogogo-gpu-tripod -ErrorAction SilentlyContinue) { throw 'Active media work found; temporal test refused.' }
$repoRoot = Split-Path -Parent $PSScriptRoot
$ffmpeg = Join-Path $repoRoot 'src-tauri/tools/ffmpeg/bin/ffmpeg.exe'
$ffprobe = Join-Path $repoRoot 'src-tauri/tools/ffmpeg/bin/ffprobe.exe'
$worker = Join-Path $repoRoot 'src-tauri/tools/gpu-tripod/photogogo-gpu-tripod.exe'
$width = if ($Resolution -eq '2160p') { 3840 } else { 1280 }
$height = if ($Resolution -eq '2160p') { 2160 } else { 720 }
$bitrate = if ($Resolution -eq '2160p') { 32 } else { 16 }
$folder = Join-Path $repoRoot ('test-output/gpu-temporal-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))
New-Item -ItemType Directory -Path $folder | Out-Null
function Run-Bounded([string]$Name,[string]$Binary,[string[]]$Arguments) {
    $start = [Diagnostics.ProcessStartInfo]::new($Binary)
    $start.UseShellExecute=$false; $start.CreateNoWindow=$true
    $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new(); $process.StartInfo=$start
    if (-not $process.Start()) { throw "$Name did not start." }
    $stdout=$process.StandardOutput.ReadToEndAsync(); $stderr=$process.StandardError.ReadToEndAsync()
    try {
        if (-not $process.WaitForExit($ProcessTimeoutSeconds*1000)) { $process.Kill($true); $process.WaitForExit(); throw "$Name exceeded its bounded deadline." }
        $out=$stdout.GetAwaiter().GetResult(); $err=$stderr.GetAwaiter().GetResult()
        [IO.File]::WriteAllText((Join-Path $folder "$Name.stdout.txt"),$out)
        [IO.File]::WriteAllText((Join-Path $folder "$Name.stderr.txt"),$err)
        if ($process.ExitCode -ne 0) { throw "$Name failed: $err" }
        return $out
    } finally { if (-not $process.HasExited) { $process.Kill($true) }; $process.Dispose() }
}
$source = Join-Path $folder 'known-shake.mp4'
$reference = Join-Path $folder 'crop-only.mp4'
$output = Join-Path $folder 'stabilized.mp4'
$scene = "nullsrc=size=$($width+64)x$($height+64):rate=50,geq=lum='clip(128+40*sin(X*0.121)+40*cos(Y*0.149)+30*sin(X*0.273+Y*0.231),16,235)':cb='128+30*sin(X*0.067+Y*0.041)':cr='128+30*cos(X*0.053-Y*0.079)',loop=loop=99:size=1:start=0,crop=${width}:${height}:x='32+4*sin(n*PI/4)':y='32+4*cos(n*PI/4)':exact=1,drawbox=x=$($width/2-50):y=$($height/2-50):w=100:h=100:color=black:t=fill,drawbox=x=$($width/2-50):y=$($height/2-50):w=100:h=100:color=white:t=fill:enable='mod(n,2)'"
Run-Bounded 'fixture' $ffmpeg @('-v','error','-nostdin','-n','-f','lavfi','-i',$scene,
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-frames:v','100','-t','2',
    '-c:v','libx264','-crf','12','-preset','ultrafast','-threads','2','-pix_fmt','yuv420p','-c:a','aac',$source) | Out-Null
$sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
Run-Bounded 'reference' $ffmpeg @('-v','error','-nostdin','-n','-i',$source,
    '-vf',"crop=iw*0.92:ih*0.92,scale=${width}:${height}:flags=bicubic",'-frames:v','100','-t','2',
    '-c:v','libx264','-b:v',"${bitrate}M",'-preset','veryfast','-threads','2','-pix_fmt','yuv420p','-c:a','aac',$reference) | Out-Null
Run-Bounded 'render' $worker @('--render','--ffmpeg',$ffmpeg,'--source',$source,'--output',$output,
    '--width',"$width",'--height',"$height",'--fps','50','--threads','2','--encoder','libx264','--bitrate',"$bitrate",
    '--seconds','2','--offset','0','--crop','0.04','--preset','strong','--audio','yes') | Out-Null
$line = Get-Content (Join-Path $folder 'render.stderr.txt') | Where-Object { $_.StartsWith('GPU_TRIPOD_RECEIPT ') } | Select-Object -Last 1
if (-not $line) { throw 'Motion render did not produce a success receipt.' }
$receipt = $line.Substring('GPU_TRIPOD_RECEIPT '.Length) | ConvertFrom-Json
if ($receipt.frames -ne 100 -or $receipt.acceptedPairs -lt 75 -or $receipt.rotation -ne 0 -or $receipt.maxBufferedFrames -gt 17) { throw 'Known-shake fixture did not exercise sufficient accepted motion, zero roll and bounded memory.' }
if ($receipt.maxAcceptedMotionPixels -gt 5) { throw 'Accepted motion exceeds the known fixture displacement; coarse aliasing may be trusted.' }
function Temporal-Delta([string]$Name,[string]$Path) {
    $text = Run-Bounded $Name $ffmpeg @('-v','error','-nostdin','-i',$Path,'-vf','signalstats,metadata=print:key=lavfi.signalstats.YDIF:file=-','-an','-f','null','NUL')
    $values = @([regex]::Matches($text,'lavfi\.signalstats\.YDIF=([0-9.]+)') | ForEach-Object {
        [double]::Parse($_.Groups[1].Value,[Globalization.CultureInfo]::InvariantCulture)
    })
    if ($values.Count -ne 100) { throw "$Name did not measure all frames." }
    # Exclude the lookahead boundary from this steady-state oracle. Worker
    # self-tests separately prove linear-pan endpoint handling and short clips.
    return ($values[10..89] | Measure-Object -Average).Average
}
$referenceDelta = Temporal-Delta 'reference-motion' $reference
$outputDelta = Temporal-Delta 'stabilized-motion' $output
if ($referenceDelta -lt 1 -or $outputDelta -gt $referenceDelta*0.6) { throw "Steady-state XY shake was not reduced by at least 40%: crop-only=$referenceDelta, stabilized=$outputDelta" }
# The central square alternates black/white every frame, inside the excluded
# tracking area. This rejects frozen/repeated frames as a false low-YDIF pass.
$markerText = Run-Bounded 'timeline-marker' $ffmpeg @('-v','error','-nostdin','-i',$output,'-vf',"crop=32:32:$($width/2-16):$($height/2-16),signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-",'-an','-f','null','NUL')
$marker = @([regex]::Matches($markerText,'lavfi\.signalstats\.YAVG=([0-9.]+)') | ForEach-Object {
    [double]::Parse($_.Groups[1].Value,[Globalization.CultureInfo]::InvariantCulture)
})
if ($marker.Count -ne 100) { throw 'Timeline marker did not cover every output frame.' }
for ($index=0;$index -lt 100;$index++) {
    $expected = if ($index%2) { 235 } else { 16 }
    if ([Math]::Abs($marker[$index]-$expected) -gt 4) { throw "Output frame $index has a frozen/repeated or reordered timeline marker." }
}
$info = (Run-Bounded 'verify' $ffprobe @('-v','error','-count_frames','-show_streams','-of','json',$output)) | ConvertFrom-Json
$video = $info.streams | Where-Object codec_type -eq video | Select-Object -First 1
$audio = $info.streams | Where-Object codec_type -eq audio | Select-Object -First 1
if ([int]$video.nb_read_frames -ne 100 -or $video.width -ne $width -or $video.height -ne $height -or $video.pix_fmt -ne 'yuv420p' -or -not $audio -or [Math]::Abs([double]$video.duration-2) -gt 0.04 -or [Math]::Abs([double]$audio.duration-2) -gt 0.06) { throw 'Temporal fixture failed output frame/format/audio duration checks.' }
if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne $sourceHash) { throw 'Synthetic source was modified.' }
$report = [pscustomobject]@{
    synthetic=$true; resolution=$Resolution; sourceSha256=$sourceHash; workerSha256=(Get-FileHash -LiteralPath $worker -Algorithm SHA256).Hash
    source=$source; cropOnlyReference=$reference; stabilized=$output
    referenceLumaFrameDelta=$referenceDelta; stabilizedLumaFrameDelta=$outputDelta
    steadyStateShakeReductionPercent=100*(1-$outputDelta/$referenceDelta)
    frameCount=100; alternatingTimelineMarker=$true; sourceOriginalUntouched=$true; gpu=$receipt
    limitations='Periodic textured global XY fixture only; not real footage, scene cuts, semantic foreground rejection or RTX performance acceptance.'
}
[IO.File]::WriteAllText((Join-Path $folder 'report.json'),($report | ConvertTo-Json -Depth 6))
$report | ConvertTo-Json -Depth 6
