param([ValidateRange(5, 120)][int]$TimeoutSeconds = 30)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$installation = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $installation) { throw 'C++ Build Tools is required.' }
$devCmd = Join-Path $installation.Trim() 'Common7\Tools\VsDevCmd.bat'
$lines = & cmd.exe /d /s /c "call `"$devCmd`" -no_logo -arch=x64 -host_arch=x64 >nul && set"
if ($LASTEXITCODE -ne 0) { throw 'Could not load build environment.' }
foreach ($line in $lines) {
    if ($line -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') }
}
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"

$outputDir = Join-Path $repoRoot 'test-output\import-pipeline'
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
$testExecutable = Join-Path $outputDir 'import-pipeline-tests.exe'
& rustc --edition 2021 --test tests/import_pipeline.rs -o $testExecutable
if ($LASTEXITCODE -ne 0) { throw 'Import pipeline test compile failed.' }

# A process deadline guards panic/disconnect regressions. It is not a performance
# assertion: overlap is proven by test event handshakes, never elapsed time.
$stdout = Join-Path $outputDir 'stdout.txt'
$stderr = Join-Path $outputDir 'stderr.txt'
$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $testExecutable
$startInfo.Arguments = '--test-threads=1'
$startInfo.WorkingDirectory = $repoRoot
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$process = New-Object System.Diagnostics.Process
$process.StartInfo = $startInfo
try {
    # Own the process from launch through exit. Windows PowerShell's
    # Start-Process -PassThru can otherwise return a null cached ExitCode.
    if (-not $process.Start()) { throw 'Import pipeline test process did not start.' }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        $process.Kill()
        $process.WaitForExit()
        throw "Import pipeline tests exceeded the $TimeoutSeconds-second deadlock guard; only the spawned test process was stopped."
    }
    $process.WaitForExit()
    $exitCode = $process.ExitCode
    $testOutput = $stdoutTask.GetAwaiter().GetResult()
    $testErrors = $stderrTask.GetAwaiter().GetResult()
    # Generated test receipts, not application or media files.
    [System.IO.File]::WriteAllText($stdout, $testOutput)
    [System.IO.File]::WriteAllText($stderr, $testErrors)
    Write-Output $testOutput
    if ($testErrors) { Write-Output $testErrors }
    if ($exitCode -ne 0) { throw "Import pipeline tests failed ($exitCode)." }
} finally {
    $process.Dispose()
}
