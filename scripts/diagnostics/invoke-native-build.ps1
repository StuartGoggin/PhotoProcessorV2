#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$WorkingDirectory,
    [Parameter(Mandatory)][string]$File,
    [string[]]$Arguments = @(),
    [Parameter(Mandatory)][string]$LogName,
    [ValidateRange(10,1800)][int]$TimeoutSeconds = 300,
    [ValidateRange(512,4096)][int]$MinimumFreeMiB = 1024,
    [switch]$VisualStudio,
    [string[]]$ExtraPath = @(),
    [hashtable]$ExtraEnvironment = @{}
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$buildRoot = Join-Path $root 'test-output\ffmpeg-row-backport'
$resolvedWork = (Resolve-Path -LiteralPath $WorkingDirectory).Path
if (-not $resolvedWork.StartsWith($buildRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Build working directory must be isolated under ffmpeg-row-backport.' }
if ($LogName -notmatch '^[a-zA-Z0-9_-]+$') { throw 'Invalid log name.' }
if ((Get-PSDrive C).Free -lt (($MinimumFreeMiB + 100) * 1MB)) { throw 'Not enough space above the configured build reserve.' }
$childEnv = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator()) { $childEnv[[string]$entry.Key] = [string]$entry.Value }
function New-BuildProcess([string]$Program, [string[]]$NativeArgs) {
    $p = [Diagnostics.Process]::new()
    $p.StartInfo.FileName = $Program
    $p.StartInfo.WorkingDirectory = $resolvedWork
    $p.StartInfo.UseShellExecute = $false
    $p.StartInfo.CreateNoWindow = $true
    $p.StartInfo.RedirectStandardOutput = $true
    $p.StartInfo.RedirectStandardError = $true
    $p.StartInfo.Environment.Clear()
    foreach ($entry in $childEnv.GetEnumerator()) { $p.StartInfo.Environment.Add($entry.Key, $entry.Value) }
    foreach ($arg in $NativeArgs) { $p.StartInfo.ArgumentList.Add($arg) }
    return $p
}
if ($VisualStudio) {
    $vsCommand = 'call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64 >nul && set'
    $vs = New-BuildProcess $env:ComSpec @('/d','/s','/c',$vsCommand)
    $vs.StartInfo.ArgumentList.Clear()
    $vs.StartInfo.Arguments = '/d /s /c "' + $vsCommand + '"'
    try {
        $null = $vs.Start()
        $vsOut = $vs.StandardOutput.ReadToEndAsync()
        $vsErr = $vs.StandardError.ReadToEndAsync()
        if (-not $vs.WaitForExit(30000)) { $vs.Kill($true); throw 'VS environment timeout.' }
        if ($vs.ExitCode -ne 0) { throw ('VS environment initialization failed: ' + $vsErr.GetAwaiter().GetResult()) }
        foreach ($line in ($vsOut.GetAwaiter().GetResult() -split "`r?`n")) {
            if ($line -match '^([^=]+)=(.*)$') { $childEnv[$Matches[1]] = $Matches[2] }
        }
    } finally { $vs.Dispose() }
}
foreach ($key in $ExtraEnvironment.Keys) { $childEnv[$key] = [string]$ExtraEnvironment[$key] }
if ($ExtraPath.Count) { $childEnv['PATH'] = ($ExtraPath -join ';') + ';' + $childEnv['PATH'] }
$p = New-BuildProcess $File $Arguments
$watch = [Diagnostics.Stopwatch]::StartNew()
$started = $false
$failure = ''
try {
    $null = $p.Start(); $started = $true
    $stdout = $p.StandardOutput.ReadToEndAsync()
    $stderr = $p.StandardError.ReadToEndAsync()
    while (-not $p.WaitForExit(200)) {
        if ($watch.Elapsed.TotalSeconds -gt $TimeoutSeconds) { throw "Owned build stopped at $TimeoutSeconds second limit." }
        if ((Get-PSDrive C).Free -lt ($MinimumFreeMiB * 1MB)) { throw "Owned build stopped at $MinimumFreeMiB MiB disk reserve." }
    }
    if ($p.ExitCode -ne 0) { throw "Build exited $($p.ExitCode); inspect $LogName.log" }
} catch { $failure = $_.Exception.Message; throw }
finally {
    if ($started) {
        if (-not $p.HasExited) { $p.Kill($true); $p.WaitForExit() }
        ($stdout.GetAwaiter().GetResult() + "`n" + $stderr.GetAwaiter().GetResult()) | Set-Content -LiteralPath (Join-Path $buildRoot "$LogName.log") -Encoding UTF8
        [pscustomobject]@{name=$LogName;exitCode=$p.ExitCode;failure=$failure;elapsedSeconds=$watch.Elapsed.TotalSeconds;freeGiB=[Math]::Round((Get-PSDrive C).Free / 1GB,3)} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $buildRoot "$LogName.json") -Encoding UTF8
    }
    $p.Dispose()
}
Write-Host "$LogName passed in $([Math]::Round($watch.Elapsed.TotalSeconds,1)) seconds."
