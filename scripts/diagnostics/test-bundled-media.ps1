#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BinDirectory,
    [Parameter(Mandatory)][string]$Av1Fixture
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$bin = (Resolve-Path -LiteralPath $BinDirectory).Path
$av1 = (Resolve-Path -LiteralPath $Av1Fixture).Path
if ((Get-FileHash -LiteralPath $av1 -Algorithm SHA256).Hash -ne '2722015E399D90148DB31E3E1F28E6D0E237827C36C58504EB3E5E61A30C4755') {
    throw 'The bounded three-frame AV1 fixture does not match the approved synthetic input.'
}
$out = Join-Path $root ('test-output\bundled-media-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))
$null = New-Item -ItemType Directory -Path $out
$checks = [Collections.Generic.List[string]]::new()
function Invoke-Media([string]$Tool, [string[]]$NativeArgs, [string]$BinaryOutput='') {
    $p = [Diagnostics.Process]::new()
    $p.StartInfo.FileName = Join-Path $bin "$Tool.exe"
    $p.StartInfo.WorkingDirectory = $out
    $p.StartInfo.UseShellExecute = $false
    $p.StartInfo.CreateNoWindow = $true
    $p.StartInfo.RedirectStandardOutput = $true
    $p.StartInfo.RedirectStandardError = $true
    # Exclude the developer toolchain/external FFmpeg from PATH. This alone
    # cannot prove runtime closure: audit DLL imports separately with dumpbin.
    $childEnv = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator()) { $childEnv[[string]$entry.Key] = [string]$entry.Value }
    $childEnv['PATH'] = "$env:SystemRoot\System32;$env:SystemRoot"
    $childEnv['OMP_NUM_THREADS'] = '2'
    $p.StartInfo.Environment.Clear()
    foreach ($entry in $childEnv.GetEnumerator()) { $p.StartInfo.Environment.Add($entry.Key,$entry.Value) }
    foreach ($arg in $NativeArgs) { $p.StartInfo.ArgumentList.Add($arg) }
    $bytes = if ($BinaryOutput) { [IO.MemoryStream]::new() } else { $null }
    try {
        $null = $p.Start()
        $stdout = if ($bytes) { $p.StandardOutput.BaseStream.CopyToAsync($bytes) } else { $p.StandardOutput.ReadToEndAsync() }
        $stderr = $p.StandardError.ReadToEndAsync()
        if (-not $p.WaitForExit(30000)) { $p.Kill($true); $p.WaitForExit(); throw "$Tool timed out." }
        $stdoutText = $stdout.GetAwaiter().GetResult()
        $result = [string]$stdoutText + $stderr.GetAwaiter().GetResult()
        if ($p.ExitCode -ne 0) { throw "$Tool exited $($p.ExitCode): $result" }
        if ($bytes) { [IO.File]::WriteAllBytes((Join-Path $out $BinaryOutput),$bytes.ToArray()) }
        return $result
    } finally { $p.Dispose(); if ($bytes) { $bytes.Dispose() } }
}
function Require-Names([string]$Listing, [string[]]$Names, [string]$Kind) {
    foreach ($name in $Names) {
        if ($Listing -notmatch ('(?m)^\s*\S+\s+[^\r\n ]*\b' + [regex]::Escape($name) + '\b')) {
            throw "Missing $Kind capability: $name"
        }
        $checks.Add("$Kind/$name")
    }
}
$complete = $false
try {
    $versions = @{}
    foreach ($tool in @('ffmpeg','ffprobe')) {
        $versionOutput = Invoke-Media $tool @('-version')
        $versions[$tool] = ($versionOutput -split "`n")[0].Trim()
        if ($versions[$tool] -notmatch 'PhotoGoGo-rowtest1') { throw "Wrong bundled $tool build." }
    }
    Require-Names (Invoke-Media ffmpeg @('-hide_banner','-filters')) @('vidstabdetect','vidstabtransform','deshake','unsharp','scale','format','setparams','pad','setsar','fps','setpts','drawtext','color','anullsrc','testsrc2','sine','aresample','volume','afade','atrim','amix','apad','asetpts','atempo') 'filter'
    Require-Names (Invoke-Media ffmpeg @('-hide_banner','-encoders')) @('libx264','h264_nvenc','h264_qsv','aac','mjpeg','pcm_s16le') 'encoder'
    Require-Names (Invoke-Media ffmpeg @('-hide_banner','-decoders')) @('libdav1d','h264','hevc','aac','mp3','flac','vorbis','opus','mjpeg','png','bmp','wmav2','mpeg2video','vc1','pcm_s16le') 'decoder'
    Require-Names (Invoke-Media ffmpeg @('-hide_banner','-demuxers')) @('mov','matroska','avi','mpegts','asf','image2','wav','aac','mp3','mpeg','flac','ogg','concat') 'demuxer'
    Require-Names (Invoke-Media ffmpeg @('-hide_banner','-muxers')) @('mp4','wav','framemd5','null','image2','image2pipe','matroska') 'muxer'
    Copy-Item -LiteralPath "$env:SystemRoot\Fonts\arial.ttf" -Destination (Join-Path $out 'font.ttf')
    $null = Invoke-Media ffmpeg @('-hide_banner','-nostdin','-n','-f','lavfi','-i','testsrc2=size=96x64:rate=25','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-vf','drawtext=fontfile=font.ttf:text=PhotoGoGo:fontsize=12:fontcolor=white,format=yuv420p','-frames:v','3','-t','0.12','-c:v','libx264','-threads','2','-c:a','aac','-movflags','+faststart','smoke.mp4')
    $probe = Invoke-Media ffprobe @('-v','error','-count_frames','-show_streams','-of','json','smoke.mp4') | ConvertFrom-Json
    if (@($probe.streams | Where-Object codec_type -eq video)[0].nb_read_frames -ne '3' -or @($probe.streams | Where-Object codec_type -eq audio).Count -ne 1) { throw 'Smoke video/audio stream validation failed.' }
    $null = Invoke-Media ffmpeg @('-hide_banner','-nostdin','-i','smoke.mp4','-frames:v','1','-an','-f','image2pipe','-vcodec','mjpeg','-') -BinaryOutput 'thumbnail.jpg'
    $jpeg = [IO.File]::ReadAllBytes((Join-Path $out 'thumbnail.jpg'))
    if ($jpeg.Length -lt 4 -or $jpeg[0] -ne 255 -or $jpeg[1] -ne 216 -or $jpeg[-2] -ne 255 -or $jpeg[-1] -ne 217) { throw 'Piped thumbnail is not a complete JPEG.' }
    $thumbnail = Invoke-Media ffprobe @('-v','error','-show_streams','-of','json','thumbnail.jpg') | ConvertFrom-Json
    if ($thumbnail.streams[0].codec_name -ne 'mjpeg' -or $thumbnail.streams[0].width -ne 96 -or $thumbnail.streams[0].height -ne 64) { throw 'JPEG thumbnail decode/size check failed.' }
    $null = Invoke-Media ffmpeg @('-hide_banner','-nostdin','-n','-i','smoke.mp4','-an','-f','framemd5','smoke.framemd5')
    if (@(Get-Content (Join-Path $out 'smoke.framemd5') | Where-Object { $_ -notmatch '^#' -and $_.Trim() }).Count -ne 3) { throw 'Expected exactly three frame checksum records.' }
    $checks.Add('synthetic-caption-video-audio-thumbnail-probe')
    $null = Invoke-Media ffmpeg @('-hide_banner','-nostdin','-n','-i',$av1,'-an','-threads','2','-f','framemd5','av1.framemd5')
    if (@(Get-Content (Join-Path $out 'av1.framemd5') | Where-Object { $_ -notmatch '^#' -and $_.Trim() }).Count -ne 3) { throw 'Software AV1 decode did not return exactly three frames.' }
    $checks.Add('software-av1-three-frame-decode')
    $complete = $true
} finally {
    [pscustomobject]@{complete=$complete;binDirectory=$bin;versions=$versions;checks=@($checks.ToArray());
        binaries=@(Get-FileHash -LiteralPath (Join-Path $bin 'ffmpeg.exe'),(Join-Path $bin 'ffprobe.exe') -Algorithm SHA256 | Select-Object Path,Hash);
        limitation='Capability listing does not prove NVIDIA hardware execution. Run RTX acceptance separately.'} |
        ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $out 'report.json') -Encoding UTF8
    Write-Host "Bundled media report: $out\report.json"
}
