#Requires -Version 7.0
param([Parameter(Mandatory)][string]$SyntheticSource)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = Split-Path -Parent $PSScriptRoot
$testRoot = (Resolve-Path -LiteralPath (Join-Path $repoRoot 'test-output')).Path.TrimEnd('\') + '\'
$source = (Resolve-Path -LiteralPath $SyntheticSource).Path
if (-not $source.StartsWith($testRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'This cancellation fixture must be generated inside this repository test-output folder.' }
if (Get-Process -Name ffmpeg,photogogo-v2,photogogo-gpu-tripod -ErrorAction SilentlyContinue) { throw 'Active media work found; cancellation test refused.' }
$folder = Join-Path $testRoot ('gpu-cancel-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))
New-Item -ItemType Directory -Path $folder | Out-Null
$worker = Join-Path $repoRoot 'src-tauri/tools/gpu-tripod/photogogo-gpu-tripod.exe'
$ffmpeg = Join-Path $repoRoot 'src-tauri/tools/ffmpeg/bin/ffmpeg.exe'
$start = [Diagnostics.ProcessStartInfo]::new($worker)
$start.UseShellExecute = $false; $start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
foreach ($arg in @('--render','--ffmpeg',$ffmpeg,'--source',$source,'--output',(Join-Path $folder 'cancelled.partial.mp4'),
    '--width','3840','--height','2160','--fps','50','--threads','2','--encoder','libx264','--bitrate','32',
    '--seconds','1','--offset','0','--crop','0.04','--preset','strong','--audio','no')) { $start.ArgumentList.Add($arg) }
$process = [Diagnostics.Process]::new();$process.StartInfo=$start
if (-not $process.Start()) { throw 'Owned worker did not start.' }
$stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
try {
    $deadline=[DateTime]::UtcNow.AddSeconds(5);$children=@()
    while ([DateTime]::UtcNow -lt $deadline -and -not $process.HasExited -and $children.Count -lt 2) {
        $children=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($process.Id)" | Where-Object Name -eq ffmpeg.exe | Select-Object -ExpandProperty ProcessId)
    }
    if ($children.Count -ne 2 -or $process.HasExited) { throw 'Both owned FFmpeg children were not observed before completion; cancellation was not exercised.' }
    $timer=[Diagnostics.Stopwatch]::StartNew()
    $process.Kill() # Only the exact worker created by this test, not a global name.
    if (-not $process.WaitForExit(5000)) { throw 'Cancelled worker did not exit.' }
    foreach ($childId in $children) {
        try { $child=[Diagnostics.Process]::GetProcessById([int]$childId) } catch [ArgumentException] { continue }
        try { if (-not $child.WaitForExit(3000)) { throw "Owned FFmpeg child $childId survived worker cancellation." } } finally { $child.Dispose() }
    }
    $timer.Stop()
    $err=$stderr.GetAwaiter().GetResult();$out=$stdout.GetAwaiter().GetResult()
    if ($err.Contains('GPU_TRIPOD_RECEIPT ') -or $out.Contains('progress=end')) { throw 'Cancelled work emitted a success receipt.' }
    $receipt=[pscustomobject]@{ workerPid=$process.Id; ownedChildPids=$children; seconds=$timer.Elapsed.TotalSeconds; successReceipt=$false; published=$false }
    [IO.File]::WriteAllText((Join-Path $folder 'report.json'),($receipt | ConvertTo-Json))
    $receipt | ConvertTo-Json
} finally { if (-not $process.HasExited) { $process.Kill($true);$process.WaitForExit() };$process.Dispose() }
