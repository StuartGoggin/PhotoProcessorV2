# GUI-parent regression: intentionally flashes ONE control console per run.
# The production helper calls must not create a console. No real media is used.
$ErrorActionPreference = 'Stop'
$taskRepo = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $taskRepo
$taskVswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$taskVs = & $taskVswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $taskVs) { throw 'Visual Studio C++ Build Tools is required.' }
$taskDevCmd = Join-Path $taskVs.Trim() 'Common7\Tools\VsDevCmd.bat'
$taskEnvironment = & cmd.exe /d /s /c "call `"$taskDevCmd`" -no_logo -arch=x64 -host_arch=x64 >nul && set"
if ($LASTEXITCODE -ne 0) { throw 'Build environment failed.' }
foreach ($taskLine in $taskEnvironment) {
    if ($taskLine -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') }
}
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
$taskRunDir = Join-Path $taskRepo ('test-output\background-processes\' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskRunDir -Force | Out-Null
& rustc --edition 2021 tests/fixtures/windows_console_probe.rs -o (Join-Path $taskRunDir 'ffmpeg.exe')
if ($LASTEXITCODE -ne 0) { throw 'Console probe compile failed.' }
Copy-Item -LiteralPath (Join-Path $taskRunDir 'ffmpeg.exe') -Destination (Join-Path $taskRunDir 'ffprobe.exe')

# Use Cargo's actual artifact path, not an arbitrary old executable from target.
$taskBuildOutput = & cargo test --locked --release --lib --manifest-path src-tauri/Cargo.toml --no-run --message-format=json
if ($LASTEXITCODE -ne 0) { throw 'Native regression build failed.' }
$taskArtifacts = @($taskBuildOutput | ForEach-Object {
    $taskMessage = $_ | ConvertFrom-Json
    if ($taskMessage.reason -eq 'compiler-artifact' -and $taskMessage.target.name -eq 'photogogo_v2_lib' -and $taskMessage.profile.test -and $taskMessage.executable) {
        $taskMessage.executable
    }
})
if ($taskArtifacts.Count -ne 1) { throw 'Expected exactly one native test executable from Cargo.' }
$taskGuiTest = Join-Path $taskRunDir 'gui-test.exe'
Copy-Item -LiteralPath $taskArtifacts[0] -Destination $taskGuiTest
# Modify only our test copy to match release main.rs windows_subsystem="windows".
& editbin.exe /NOLOGO /SUBSYSTEM:WINDOWS $taskGuiTest
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare GUI-subsystem regression parent.' }

$taskStart = New-Object System.Diagnostics.ProcessStartInfo
$taskStart.FileName = $taskGuiTest
$taskStart.Arguments = '--exact commands::files::windows_process_tests::background_media_helpers_do_not_open_windows --ignored --nocapture --test-threads=1'
$taskStart.UseShellExecute = $false
# Do not use CreateNoWindow: inherited hidden-console state masks the defect.
# This executable is already a GUI process, so the parent has no console.
$taskStart.RedirectStandardOutput = $true
$taskStart.RedirectStandardError = $true
$taskStart.EnvironmentVariables['PHOTOGOGO_CONSOLE_TEST_DIR'] = $taskRunDir
$taskProcess = [System.Diagnostics.Process]::Start($taskStart)
$taskOut = $taskProcess.StandardOutput.ReadToEndAsync()
$taskErr = $taskProcess.StandardError.ReadToEndAsync()
if (-not $taskProcess.WaitForExit(15000)) { $taskProcess.Kill(); throw "Regression timed out. Artifacts: $taskRunDir" }
Write-Output $taskOut.Result
Write-Output $taskErr.Result
Write-Output "Regression artifacts: $taskRunDir"
if ($taskProcess.ExitCode -ne 0) { throw "Background-process regression failed ($($taskProcess.ExitCode))." }
if ($taskOut.Result -notmatch 'test result: ok\. 1 passed; 0 failed;') {
    throw 'Expected one executed regression test; an empty test selection is not a pass.'
}
