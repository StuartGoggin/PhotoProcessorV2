<#
.SYNOPSIS
Small no-restart compiler probe using installed Visual Studio, not a downloaded compiler.
.DESCRIPTION
Use Codex's normal per-command approval if the sandbox denies the build tools.
This script changes no permissions or persistent environment settings. Environment
canonicalization is confined to its own child processes, including one PATH key.
#>
#Requires -Version 7.0
[CmdletBinding()]
param([ValidateRange(30, 180)][int]$TotalTimeoutSeconds = 120)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$sourceDir = Join-Path $PSScriptRoot 'existing-msvc-probe'
$buildDir = Join-Path $repoRoot 'test-output\ffmpeg-row-backport\existing-msvc-probe'
$cmake = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
if (-not (Test-Path -LiteralPath $cmake -PathType Leaf)) { throw 'Existing Visual Studio CMake is unavailable.' }
if ((Get-PSDrive C).Free -lt 1.2GB) { throw 'Need 1.2 GiB free to begin this small probe; no cleanup performed.' }
$null = New-Item -ItemType Directory -Path $buildDir -Force
$watch = [Diagnostics.Stopwatch]::StartNew()
$steps = [Collections.Generic.List[object]]::new()
$environmentEntries = @([Environment]::GetEnvironmentVariables().GetEnumerator())
$pathEntries = @($environmentEntries | Where-Object { $_.Key -ieq 'PATH' } |
    Sort-Object @{Expression={if ($_.Key -ceq 'PATH') {0} else {1}}})
$childEnvironment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($entry in $environmentEntries) { $childEnvironment[[string]$entry.Key] = [string]$entry.Value }
$pathParts = [Collections.Generic.List[string]]::new()
$seenPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($entry in $pathEntries) {
    foreach ($part in ([string]$entry.Value -split ';')) {
        if ($part -and $seenPaths.Add($part)) { $pathParts.Add($part) }
    }
}
$childEnvironment['PATH'] = $pathParts -join ';'

function Invoke-ProbeStep([string]$Label, [string]$File, [string[]]$Arguments) {
    $process = [Diagnostics.Process]::new()
    $process.StartInfo.FileName = $File
    $process.StartInfo.WorkingDirectory = $repoRoot
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    $process.StartInfo.Environment.Clear()
    foreach ($entry in $childEnvironment.GetEnumerator()) { $process.StartInfo.Environment.Add($entry.Key, $entry.Value) }
    if (@($process.StartInfo.Environment.Keys | Where-Object { $_ -ieq 'PATH' }).Count -ne 1) {
        throw 'Child environment must contain exactly one PATH key.'
    }
    foreach ($argument in $Arguments) { $process.StartInfo.ArgumentList.Add($argument) }
    $started = $false
    $stepWatch = [Diagnostics.Stopwatch]::StartNew()
    try {
        if ($watch.Elapsed.TotalSeconds -ge $TotalTimeoutSeconds) { throw 'Total probe timeout reached.' }
        $null = $process.Start(); $started = $true
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        while (-not $process.WaitForExit(200)) {
            if ($watch.Elapsed.TotalSeconds -ge $TotalTimeoutSeconds -or (Get-PSDrive C).Free -lt 1GB) {
                throw 'Stopped this probe: time limit or 1 GiB disk reserve reached.'
            }
        }
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
        ($stdout + "`n" + $stderr) | Set-Content -LiteralPath (Join-Path $buildDir "$Label.log") -Encoding UTF8
        $steps.Add([pscustomobject]@{name=$Label;exitCode=$process.ExitCode;seconds=$stepWatch.Elapsed.TotalSeconds})
        if ($process.ExitCode -ne 0) { throw "$Label failed ($($process.ExitCode)); see $buildDir\$Label.log" }
        Write-Host "$Label succeeded in $([Math]::Round($stepWatch.Elapsed.TotalSeconds, 2)) seconds."
        return $stdout
    } finally {
        if ($started -and -not $process.HasExited) { $process.Kill($true); $process.WaitForExit() }
        $process.Dispose()
    }
}

$complete = $false
$failure = ''
try {
    $null = Invoke-ProbeStep 'configure' $cmake @('-S',$sourceDir,'-B',$buildDir,'-G','Visual Studio 17 2022','-A','x64')
    $null = Invoke-ProbeStep 'build' $cmake @('--build',$buildDir,'--config','Release','--parallel','1')
    $result = Invoke-ProbeStep 'run' (Join-Path $buildDir 'Release\compiler-probe.exe') @()
    if ($result.Trim() -ne 'existing_compiler_openmp_threads=2') { throw 'Two-thread OpenMP verification failed.' }
    $complete = $true
    Write-Host 'PASS: compiled and executed two OpenMP threads with the installed MSVC toolchain.'
} catch {
    $failure = $_.Exception.Message
    throw
} finally {
    [pscustomobject]@{
        complete=$complete;failure=$failure;createdAtUtc=[DateTime]::UtcNow.ToString('o')
        elapsedSeconds=$watch.Elapsed.TotalSeconds;parentPathEntryCount=$pathEntries.Count
        childPathEntryCount=1;environmentScope='child process only'
        steps=@($steps.ToArray())
        limitation='Compiler smoke test only; not FFmpeg, pixel equivalence, NVENC or installer validation.'
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $buildDir 'report.json') -Encoding UTF8
}
