#Requires -Version 7.0
param([string]$WorkerPath = '')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $WorkerPath) { $WorkerPath = Join-Path $repoRoot 'src-tauri/tools/gpu-tripod/photogogo-gpu-tripod.exe' }
if (-not (Test-Path -LiteralPath $WorkerPath -PathType Leaf)) {
    throw 'GPU Tripod worker has not been built. Existing stabilization is unaffected.'
}
function Invoke-BoundedWorker([string]$Argument, [int]$TimeoutMilliseconds) {
    $start = [Diagnostics.ProcessStartInfo]::new($WorkerPath)
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $start.ArgumentList.Add($Argument)
    $process = [Diagnostics.Process]::new();$process.StartInfo=$start
    if (-not $process.Start()) { throw 'GPU test worker did not start.' }
    $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
    try {
        if (-not $process.WaitForExit($TimeoutMilliseconds)) { $process.Kill($true);$process.WaitForExit();throw "GPU test $Argument exceeded its bounded deadline." }
        $out=$stdout.GetAwaiter().GetResult();$err=$stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw "GPU test $Argument failed: $err" }
        if ($err) { Write-Host $err.Trim() }
        return $out | ConvertFrom-Json
    } finally { if (-not $process.HasExited) { $process.Kill($true) };$process.Dispose() }
}
$probe = Invoke-BoundedWorker '--probe' 15000
if ($probe.engine -ne 'gpu-tripod-d3d11-v1' -or $probe.hardware -ne $true -or -not $probe.adapter) {
    throw 'Probe did not establish the requested hardware engine.'
}
$result = Invoke-BoundedWorker '--self-test' 30000
foreach ($required in @('identityPixels', 'knownTranslation', 'flatBackground', 'foregroundNegativeControl', 'fixedCropBorders', 'chromaAlignment', 'coloredCropOracle', 'segmentIsolation', 'shortWindowTail')) {
    if ($result.$required -ne $true) { throw "GPU Tripod failed: $required" }
}
Write-Host "PASS: hardware $($probe.adapter); pixel, translation, confidence, border and short-window tests."
