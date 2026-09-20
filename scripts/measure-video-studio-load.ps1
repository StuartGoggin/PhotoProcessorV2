<#
.SYNOPSIS
Records a short, read-only CPU/RAM/NVIDIA load sample during an existing render.
.DESCRIPTION
Does not start FFmpeg, change settings, inspect media, or collect process commands.
Writes only scalar counters to a new timestamped folder in test-output. Missing
counters are N/A, not zero. NVIDIA queries run hidden with a two-second timeout.
.EXAMPLE
.\scripts\measure-video-studio-load.ps1 -RunLabel adaptive-B1 -DurationSeconds 60
#>
[CmdletBinding()]
param(
    [ValidateRange(1, 300)][int]$DurationSeconds = 60,
    [ValidateRange(1, 10)][int]$IntervalSeconds = 2,
    [ValidatePattern('^[A-Za-z0-9_-]{1,40}$')][string]$RunLabel = 'sample',
    [switch]$SkipGpu
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'This sampler requires Windows.' }
# Kernel counters avoid WMI permissions/services and have no external query wait.
$nativeAvailable = $true
try {
    if (-not ('PhotoGoGo.Diagnostics.LoadCounters' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace PhotoGoGo.Diagnostics {
    public static class LoadCounters {
        [StructLayout(LayoutKind.Sequential)]
        private struct MemoryStatus {
            public uint Length, Load;
            public ulong TotalPhysical, AvailablePhysical, TotalPageFile, AvailablePageFile;
            public ulong TotalVirtual, AvailableVirtual, AvailableExtendedVirtual;
        }
        [DllImport("kernel32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetSystemTimes(out ulong idle, out ulong kernel, out ulong user);
        [DllImport("kernel32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GlobalMemoryStatusEx(ref MemoryStatus status);
        public static ulong[] ReadCpu() {
            ulong idle, kernel, user;
            return GetSystemTimes(out idle, out kernel, out user) ? new[] { idle, kernel, user } : null;
        }
        public static ulong[] ReadMemory() {
            var status = new MemoryStatus();
            status.Length = (uint)Marshal.SizeOf(typeof(MemoryStatus));
            return GlobalMemoryStatusEx(ref status) ? new[] { status.AvailablePhysical, status.TotalPhysical } : null;
        }
    }
}
'@
    }
} catch { $nativeAvailable = $false }
$repoRoot = Split-Path -Parent $PSScriptRoot
$runName = 'video-studio-load-{0}-{1}-{2}' -f [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'), $RunLabel, [Guid]::NewGuid().ToString('N').Substring(0, 8)
$runDir = Join-Path $repoRoot (Join-Path 'test-output' $runName)
$null = New-Item -ItemType Directory -Path $runDir
$samples = [Collections.Generic.List[object]]::new()
$nvidiaCommand = Get-Command nvidia-smi.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$nvidiaPath = if ($nvidiaCommand) { $nvidiaCommand.Source } else { $null }
if (-not $nvidiaPath -and -not $SkipGpu) {
    foreach ($candidate in @(
        (Join-Path $env:WINDIR 'System32\nvidia-smi.exe'),
        (Join-Path $env:ProgramFiles 'NVIDIA Corporation\NVSMI\nvidia-smi.exe')
    )) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $nvidiaPath = $candidate; break }
    }
}

function ConvertTo-Counter([string]$Value) {
    # Preserve unsupported values as N/A; never infer zero load from a failed probe.
    if ($Value -match '^\s*(\d+(?:\.\d+)?)\s*(?:%|MiB)?\s*$') {
        return [double]::Parse($Matches[1], [Globalization.CultureInfo]::InvariantCulture)
    }
    return 'N/A'
}

function ConvertFrom-NvidiaCounters([string]$RawXml) {
    if ($RawXml.Length -gt 1MB) { throw 'Oversize GPU response.' }
    $settings = [Xml.XmlReaderSettings]::new()
    $settings.DtdProcessing = [Xml.DtdProcessing]::Ignore
    $settings.XmlResolver = $null
    $reader = [Xml.XmlReader]::Create([IO.StringReader]::new($RawXml), $settings)
    try {
        $document = [Xml.XmlDocument]::new()
        $document.XmlResolver = $null
        $document.Load($reader)
    } finally { $reader.Dispose() }
    $rows = [Collections.Generic.List[object]]::new()
    $index = 0
    foreach ($gpu in @($document.SelectNodes('/nvidia_smi_log/gpu')) | Select-Object -First 16) {
        $row = [ordered]@{ gpuIndex = $index }
        foreach ($field in @(
            @('gpuKernelPercent', 'utilization/gpu_util'),
            @('gpuEncoderPercent', 'utilization/encoder_util'),
            @('gpuDecoderPercent', 'utilization/decoder_util'),
            @('gpuMemoryUsedMiB', 'fb_memory_usage/used'),
            @('gpuMemoryTotalMiB', 'fb_memory_usage/total')
        )) {
            $node = $gpu.SelectSingleNode($field[1])
            $row[$field[0]] = if ($node) { ConvertTo-Counter $node.InnerText } else { 'N/A' }
        }
        $rows.Add([pscustomobject]$row)
        $index++
    }
    return $rows.ToArray()
}

function Read-GpuCounters {
    param([string]$Executable, [int]$TimeoutMilliseconds)
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = [Diagnostics.ProcessStartInfo]::new()
    $process.StartInfo.FileName = $Executable
    # Fixed arguments only; no shell and no user-controlled argument interpolation.
    $process.StartInfo.Arguments = '-q -x'
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    try {
        if (-not $process.Start()) { return @{ status = 'start-failed'; rows = @() } }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutMilliseconds)) {
            # Kill only the measurement child we started, never any rendering process.
            $process.Kill()
            $null = $process.WaitForExit(500)
            return @{ status = 'timeout'; rows = @() }
        }
        if ($process.ExitCode -ne 0) { return @{ status = 'query-failed'; rows = @() } }
        if (-not $stdoutTask.Wait(200) -or -not $stderrTask.Wait(200)) {
            return @{ status = 'read-timeout'; rows = @() }
        }
        $rows = @(ConvertFrom-NvidiaCounters $stdoutTask.Result)
        # Never persist the raw XML: it can contain unrelated process/device details.
        return @{ status = if ($rows.Count) { 'ok' } else { 'no-devices' }; rows = $rows }
    } catch {
        return @{ status = 'unavailable'; rows = @() }
    } finally { $process.Dispose() }
}

$startedUtc = [DateTime]::UtcNow
$previousCpu = $null # The first CPU interval is unknown, not a near-zero startup sample.
$watch = [Diagnostics.Stopwatch]::StartNew()
$sampleNumber = 0
$completed = $false
try {
    while ($watch.Elapsed.TotalSeconds -lt $DurationSeconds) {
        $sampleStart = $watch.Elapsed.TotalSeconds
        $sampleNumber++
        $timestamp = [DateTime]::UtcNow.ToString('o')
        $cpu = 'N/A'; $freeRam = 'N/A'; $totalRam = 'N/A'
        if ($nativeAvailable) {
            try {
                $currentCpu = [PhotoGoGo.Diagnostics.LoadCounters]::ReadCpu()
                if ($null -ne $currentCpu -and $null -ne $previousCpu) {
                    # Windows kernel time includes idle time; subtract idle once.
                    $total = ([double]$currentCpu[1] - $previousCpu[1]) + ([double]$currentCpu[2] - $previousCpu[2])
                    $idle = [double]$currentCpu[0] - $previousCpu[0]
                    if ($total -gt 0 -and $idle -ge 0 -and $idle -le $total) {
                        $cpu = [Math]::Round(100 * (1 - $idle / $total), 2)
                    }
                }
                $previousCpu = $currentCpu
                $memory = [PhotoGoGo.Diagnostics.LoadCounters]::ReadMemory()
                if ($null -ne $memory) {
                    $freeRam = [Math]::Round([double]$memory[0] / 1GB, 3)
                    $totalRam = [Math]::Round([double]$memory[1] / 1GB, 3)
                }
            } catch { }
        }
        $gpuResult = @{ status = if ($SkipGpu) { 'skipped' } else { 'not-found' }; rows = @() }
        if ($nvidiaPath -and -not $SkipGpu -and $watch.Elapsed.TotalSeconds -lt $DurationSeconds) {
            $remainingMs = [Math]::Max(1, [Math]::Min(2000, [int](1000 * ($DurationSeconds - $watch.Elapsed.TotalSeconds))))
            $gpuResult = Read-GpuCounters -Executable $nvidiaPath -TimeoutMilliseconds $remainingMs
        }
        $gpuRows = @($gpuResult.rows)
        if (-not $gpuRows.Count) {
            $gpuRows = @([pscustomobject]@{ gpuIndex = 'N/A'; gpuKernelPercent = 'N/A'; gpuEncoderPercent = 'N/A'; gpuDecoderPercent = 'N/A'; gpuMemoryUsedMiB = 'N/A'; gpuMemoryTotalMiB = 'N/A' })
        }
        foreach ($gpu in $gpuRows) {
            $samples.Add([pscustomobject][ordered]@{
                timestampUtc = $timestamp; sample = $sampleNumber; elapsedSeconds = [Math]::Round($sampleStart, 3)
                cpuPercent = $cpu; freeRamGiB = $freeRam; totalRamGiB = $totalRam
                gpuStatus = $gpuResult.status; gpuIndex = $gpu.gpuIndex
                gpuKernelPercent = $gpu.gpuKernelPercent; gpuEncoderPercent = $gpu.gpuEncoderPercent
                gpuDecoderPercent = $gpu.gpuDecoderPercent; gpuMemoryUsedMiB = $gpu.gpuMemoryUsedMiB
                gpuMemoryTotalMiB = $gpu.gpuMemoryTotalMiB
            })
        }
        $remaining = $DurationSeconds - $watch.Elapsed.TotalSeconds
        $sleep = [Math]::Min($remaining, [Math]::Max(0, $IntervalSeconds - ($watch.Elapsed.TotalSeconds - $sampleStart)))
        if ($sleep -gt 0) { Start-Sleep -Milliseconds ([int][Math]::Ceiling($sleep * 1000)) }
    }
    $completed = $true
} finally {
    $watch.Stop()
    $samples.ToArray() | Export-Csv -LiteralPath (Join-Path $runDir 'samples.csv') -NoTypeInformation -Encoding UTF8
    [pscustomobject]@{
        runLabel = $RunLabel; startedUtc = $startedUtc.ToString('o'); completed = $completed
        durationRequestedSeconds = $DurationSeconds; elapsedSeconds = [Math]::Round($watch.Elapsed.TotalSeconds, 3)
        intervalSeconds = $IntervalSeconds; sampleCount = $sampleNumber; rowCount = $samples.Count
        windowsCountersAvailable = $nativeAvailable
        gpuQueryAvailable = [bool]($nvidiaPath -and -not $SkipGpu)
        gpuStatuses = @($samples | Select-Object -ExpandProperty gpuStatus -Unique)
        limitations = @(
            'System-wide counters include other applications; not per-render attribution.',
            'GPU kernel, encoder and decoder are separate engines; do not add their percentages.',
            'N/A means unknown or unsupported, not idle. No throughput or visual-quality claim is inferred.',
            'Sampling is bounded to at most 300 seconds, plus bounded GPU-query cleanup and writing the receipt.',
            'Windows CPU counters cover the calling processor group; systems over 64 logical processors need a different sampler.',
            'Multi-GPU rows repeat system CPU/RAM per sample; do not count them as independent CPU samples.',
            'No media paths, process command lines, raw NVIDIA XML, host/user identifiers or GPU serial numbers are saved.'
        )
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $runDir 'summary.json') -Encoding UTF8
    Write-Host "Load sample saved: $runDir"
}
