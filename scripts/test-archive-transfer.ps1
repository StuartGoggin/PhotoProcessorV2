param(
    [string]$TestBinary,
    [switch]$AllNative
)
$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$output = Join-Path $projectRoot 'test-output/archive-transfer-native'
New-Item -ItemType Directory -Path $output -Force | Out-Null
Push-Location $projectRoot
try {
    $buildMode = 'provided native test harness'
    if (-not $TestBinary) {
        $buildMode = 'cargo rustc test profile; debug symbols disabled'
        # Full native application test harness, with bounded build concurrency.
        # Disable dependency debug symbols too, so fresh builds fit small disks.
        $buildArgs = @('rustc', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', '--profile', 'test',
            '--no-default-features', '-j', '2', '--message-format=json',
            '--config', 'profile.test.debug=0', '--config', 'profile.test.incremental=false',
            '--', '-C', 'debuginfo=0')
        if ($IsWindows) { $buildArgs += @('-C', 'link-arg=/DEBUG:NONE') }
        $buildLines = @(& cargo @buildArgs 2>&1 | ForEach-Object { $_.ToString() } | Tee-Object -FilePath (Join-Path $output 'build.jsonl'))
        if ($LASTEXITCODE -ne 0) { throw 'Native archive test harness compilation failed. See build.jsonl.' }
        $artifacts = @($buildLines | ForEach-Object {
            try { $message = $_ | ConvertFrom-Json; if ($message.reason -eq 'compiler-artifact' -and $message.target.name -eq 'photogogo_v2_lib' -and $message.executable) { $message.executable } } catch { }
        })
        if (-not $artifacts.Count) { throw 'Cargo did not identify the native test executable.' }
        $TestBinary = $artifacts[-1]
    }
    $binary = (Resolve-Path -LiteralPath $TestBinary).Path
    if (-not $binary.StartsWith($projectRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Use the test harness built in this workspace.'
    }
    $groups = @('commands::archive_plan', 'commands::transfer::archive_transfer_tests')
    if ($AllNative) { $groups += 'all-native' }
    $checks = @()
    foreach ($group in $groups) {
        $testArgs = @('--test-threads=2')
        if ($group -ne 'all-native') { $testArgs = @($group) + $testArgs }
        $file = Join-Path $output (($group.Replace('::', '-')) + '.log')
        $lines = @(& $binary @testArgs 2>&1 | ForEach-Object { $_.ToString() } | Tee-Object -FilePath $file)
        $exitCode = $LASTEXITCODE
        $result = [regex]::Match(($lines -join "`n"), 'test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;')
        $checks += @{ group=$group; exitCode=$exitCode; passed=if($result.Success){[int]$result.Groups[2].Value}else{0}; failed=if($result.Success){[int]$result.Groups[3].Value}else{1}; ignored=if($result.Success){[int]$result.Groups[4].Value}else{0} }
        if ($exitCode -ne 0 -or -not $result.Success) { break }
    }
    $report = @{ complete=($checks.Count -eq $groups.Count -and @($checks | Where-Object { $_.exitCode -ne 0 -or $_.failed -ne 0 }).Count -eq 0);
        checkedAt=(Get-Date).ToUniversalTime().ToString('o'); buildMode=$buildMode; binary=$binary;
        binarySha256=(Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash;
        scope='Actual native planner, shared catalogue and verified file publication against generated temporary fixtures. No user media or Google account operations.';
        checks=$checks }
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $output 'report.json') -Encoding utf8
    if (-not $report.complete) { throw 'Native archive regressions failed. See report.json and group logs.' }
    Write-Host 'Native archive regressions passed.'
} finally { Pop-Location }
