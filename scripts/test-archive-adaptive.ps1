param([ValidateRange(5,120)][int]$TimeoutSeconds=30)
$ErrorActionPreference='Stop'
$repoRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location $repoRoot
try {
    $vswhere=Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $installation=& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $installation) { throw 'C++ Build Tools is required.' }
    $devCmd=Join-Path $installation.Trim() 'Common7\Tools\VsDevCmd.bat'
    $environmentLines=& cmd.exe /d /s /c "call `"$devCmd`" -no_logo -arch=x64 -host_arch=x64 >nul && set"
    if ($LASTEXITCODE -ne 0) { throw 'Could not load build environment.' }
    foreach ($line in $environmentLines) {
        if ($line -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1],$Matches[2],'Process') }
    }
    $env:PATH="$env:USERPROFILE\.cargo\bin;$env:PATH"
    $outputDir=Join-Path $repoRoot 'test-output\archive-adaptive'
    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
    $testExecutable=Join-Path $outputDir 'archive-adaptive-tests.exe'
    & rustc --edition 2021 --test scripts/archive-adaptive-tests.rs -C debuginfo=0 -o $testExecutable
    if ($LASTEXITCODE -ne 0) { throw 'Adaptive archive test compilation failed.' }
    $startInfo=New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName=$testExecutable
    $startInfo.Arguments='--test-threads=1 --nocapture'
    $startInfo.WorkingDirectory=$repoRoot
    $startInfo.UseShellExecute=$false
    $startInfo.CreateNoWindow=$true
    $startInfo.RedirectStandardOutput=$true
    $startInfo.RedirectStandardError=$true
    $process=New-Object Diagnostics.Process
    $process.StartInfo=$startInfo
    try {
        if (-not $process.Start()) { throw 'Adaptive archive test process did not start.' }
        $stdoutTask=$process.StandardOutput.ReadToEndAsync()
        $stderrTask=$process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds*1000)) {
            $process.Kill(); $process.WaitForExit()
            throw "Adaptive archive tests exceeded the $TimeoutSeconds-second deadlock guard; only the owned test process was stopped."
        }
        $process.WaitForExit()
        $exitCode=$process.ExitCode
        $testOutput=$stdoutTask.GetAwaiter().GetResult()
        $testErrors=$stderrTask.GetAwaiter().GetResult()
        [IO.File]::WriteAllText((Join-Path $outputDir 'stdout.txt'),$testOutput)
        [IO.File]::WriteAllText((Join-Path $outputDir 'stderr.txt'),$testErrors)
        $summary=[regex]::Match($testOutput,'test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;')
        $report=@{complete=($exitCode -eq 0 -and $summary.Success -and $summary.Groups[1].Value -eq 'ok');exitCode=$exitCode;checkedAt=[datetime]::UtcNow.ToString('o');scope='Production std-only adaptive controller and worker scheduler; deterministic virtual service curves and event-handshake tests, not live network throughput or user-media operations.';passed=if($summary.Success){[int]$summary.Groups[2].Value}else{0};failed=if($summary.Success){[int]$summary.Groups[3].Value}else{1};binarySha256=(Get-FileHash -LiteralPath $testExecutable -Algorithm SHA256).Hash}
        $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $outputDir 'report.json') -Encoding utf8
        Write-Output $testOutput
        if ($testErrors) { Write-Output $testErrors }
        if (-not $report.complete) { throw 'Adaptive archive tests failed. See test-output/archive-adaptive/report.json.' }
    } finally { $process.Dispose() }
} finally { Pop-Location }
