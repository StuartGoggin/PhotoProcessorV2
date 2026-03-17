param(
    [switch]$Detach,
    [switch]$Foreground,
    [switch]$CleanTarget,
    [switch]$SkipFfmpegInstall,
    [switch]$ForceFfmpegInstall
)

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
$devPort = 1430

function Get-PreferredFfmpegAsset {
    param(
        [Parameter(Mandatory = $true)]
        $Release
    )

    $preferredNames = @(
        "ffmpeg-n8.0-latest-win64-gpl-8.0.zip",
        "ffmpeg-n7.1-latest-win64-gpl-7.1.zip",
        "ffmpeg-master-latest-win64-gpl.zip"
    )

    foreach ($name in $preferredNames) {
        $asset = $Release.assets | Where-Object { $_.name -eq $name } | Select-Object -First 1
        if ($asset) {
            return $asset
        }
    }

    return $Release.assets |
        Where-Object { $_.name -match '^ffmpeg-.*win64-gpl.*\.zip$' -and $_.name -notmatch 'shared' } |
        Select-Object -First 1
}

function Test-FfmpegInstall {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FfmpegExe
    )

    if (-not (Test-Path $FfmpegExe)) {
        return $false
    }

    try {
        $versionOutput = & $FfmpegExe -hide_banner -version 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0 -or -not $versionOutput) {
            return $false
        }

        $filtersOutput = & $FfmpegExe -hide_banner -filters 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            return $false
        }

        return $filtersOutput -match 'vidstabdetect' -and $filtersOutput -match 'vidstabtransform'
    }
    catch {
        return $false
    }
}

function Stop-ProcessesOnTcpPort {
    param(
        [Parameter(Mandatory = $true)]
        [int]$Port
    )

    $patterns = @(
        ":$Port ",
        ":$Port`r",
        ":$Port`n"
    )

    $lines = netstat -ano -p tcp 2>$null
    if (-not $lines) {
        return @()
    }

    $pids = [System.Collections.Generic.HashSet[int]]::new()
    foreach ($line in $lines) {
        if (-not ($patterns | Where-Object { $line.Contains($_) })) {
            continue
        }

        $trimmed = $line.Trim()
        if (-not ($trimmed -match '^(TCP)\s+\S+:([0-9]+)\s+\S+\s+(\S+)\s+(\d+)$')) {
            continue
        }

        $localPort = [int]$Matches[2]
        $state = $Matches[3]
        $pid = [int]$Matches[4]

        if ($localPort -ne $Port) {
            continue
        }

        if ($pid -eq $PID) {
            continue
        }

        if ($state -in @('LISTENING', 'ESTABLISHED', 'TIME_WAIT', 'CLOSE_WAIT')) {
            $null = $pids.Add($pid)
        }
    }

    foreach ($pid in $pids) {
        try {
            Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
        }
        catch {
        }
    }

    return @($pids)
}

function Install-RepoLocalFfmpeg {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,

        [switch]$Force
    )

    $ffmpegRoot = Join-Path $RepoRoot "tools\ffmpeg"
    $binDir = Join-Path $ffmpegRoot "bin"
    $ffmpegExe = Join-Path $binDir "ffmpeg.exe"
    $downloadDir = Join-Path $ffmpegRoot "downloads"
    $extractDir = Join-Path $ffmpegRoot "extract"

    if (-not $Force -and (Test-FfmpegInstall -FfmpegExe $ffmpegExe)) {
        Write-Host "Using repo-local FFmpeg: $ffmpegExe" -ForegroundColor DarkCyan
        return $ffmpegExe
    }

    Write-Host "Installing repo-local FFmpeg into $ffmpegRoot" -ForegroundColor Cyan

    try {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest"
    }
    catch {
        throw "Failed to query FFmpeg release metadata: $($_.Exception.Message)"
    }

    $asset = Get-PreferredFfmpegAsset -Release $release
    if (-not $asset) {
        throw "Could not find a suitable Windows GPL FFmpeg zip asset in the latest release."
    }

    New-Item -ItemType Directory -Force $downloadDir | Out-Null
    New-Item -ItemType Directory -Force $extractDir | Out-Null

    $zipPath = Join-Path $downloadDir $asset.name
    Write-Host "Downloading $($asset.name)..." -ForegroundColor DarkCyan

    try {
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath
    }
    catch {
        throw "Failed to download FFmpeg archive: $($_.Exception.Message)"
    }

    if (Test-Path $binDir) {
        Remove-Item $binDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path $extractDir) {
        Remove-Item $extractDir -Recurse -Force -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Force $extractDir | Out-Null
    }

    Write-Host "Extracting FFmpeg..." -ForegroundColor DarkCyan
    try {
        Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
    }
    catch {
        throw "Failed to extract FFmpeg archive: $($_.Exception.Message)"
    }

    $extractedExe = Get-ChildItem -Path $extractDir -Filter ffmpeg.exe -Recurse -File | Select-Object -First 1
    if (-not $extractedExe) {
        throw "Downloaded archive did not contain ffmpeg.exe"
    }

    New-Item -ItemType Directory -Force $binDir | Out-Null

    $extractedBinDir = Split-Path -Parent $extractedExe.FullName
    Copy-Item -Path (Join-Path $extractedBinDir "*") -Destination $binDir -Recurse -Force

    if (-not (Test-FfmpegInstall -FfmpegExe $ffmpegExe)) {
        throw "Installed FFmpeg did not validate. The build must expose vidstabdetect and vidstabtransform."
    }

    Remove-Item $extractDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "FFmpeg installed: $ffmpegExe" -ForegroundColor Green
    return $ffmpegExe
}

# PhotoGoGoV2 Launcher
$msvcPath = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207\bin\Hostx64\x64"
$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"

$machinePath = [System.Environment]::GetEnvironmentVariable("PATH", "Machine")
$userPath = [System.Environment]::GetEnvironmentVariable("PATH", "User")
$env:PATH = "$msvcPath;$cargoBin;$machinePath;$userPath"
$env:CARGO_TARGET_DIR = "C:\build\photogogo"

if ($CleanTarget -and (Test-Path $env:CARGO_TARGET_DIR)) {
    Write-Host "Cleaning cargo target cache: $env:CARGO_TARGET_DIR" -ForegroundColor Yellow
    Remove-Item $env:CARGO_TARGET_DIR -Recurse -Force -ErrorAction SilentlyContinue
}

New-Item -ItemType Directory -Force $env:CARGO_TARGET_DIR | Out-Null

try {
    Write-Host "Preparing PhotoGoGoV2 launcher..." -ForegroundColor Cyan

    $stoppedPids = Stop-ProcessesOnTcpPort -Port $devPort
    if ($stoppedPids.Count -gt 0) {
        Write-Host "Freed port $devPort by stopping PID(s): $($stoppedPids -join ', ')" -ForegroundColor Yellow
    }

    Set-Location $PSScriptRoot
    Write-Host "Working directory: $PSScriptRoot" -ForegroundColor DarkCyan

    if (-not $SkipFfmpegInstall) {
        try {
            $env:PHOTOGOGO_FFMPEG = Install-RepoLocalFfmpeg -RepoRoot $PSScriptRoot -Force:$ForceFfmpegInstall
        }
        catch {
            Write-Host "FFmpeg bootstrap failed: $($_.Exception.Message)" -ForegroundColor Red
            throw
        }
    }

    Write-Host "Starting PhotoGoGoV2..." -ForegroundColor Cyan
    Write-Host "Note: tauri dev is a long-running watch process." -ForegroundColor DarkCyan
    if ($env:PHOTOGOGO_FFMPEG) {
        Write-Host "Using FFmpeg: $env:PHOTOGOGO_FFMPEG" -ForegroundColor DarkCyan
    }

    $launchDetached = $Detach -or -not $Foreground

    if ($launchDetached) {
        $scriptPath = Join-Path $PSScriptRoot "run.ps1"
        $childArgs = @(
            "-NoExit",
            "-ExecutionPolicy", "Bypass",
            "-File", $scriptPath,
            "-Foreground",
            "-SkipFfmpegInstall"
        )

        if ($CleanTarget) {
            $childArgs += "-CleanTarget"
        }

        Write-Host "Launching in a separate window and returning immediately." -ForegroundColor DarkCyan
        Write-Host "Use -Foreground if you want the live tauri dev watcher in this shell." -ForegroundColor DarkCyan
        $startArgs = @(
            "/c",
            "start",
            '"PhotoGoGoV2 Dev"',
            '"powershell.exe"'
        ) + ($childArgs | ForEach-Object { '"{0}"' -f $_ })
        $child = Start-Process -FilePath "cmd.exe" -ArgumentList $startArgs -WorkingDirectory $PSScriptRoot -PassThru
        Write-Host "Issued detached launch via cmd.exe PID $($child.Id)." -ForegroundColor DarkCyan
        return
    }

    Write-Host "Running tauri dev in the current shell." -ForegroundColor DarkCyan
    npm run tauri dev
}
catch {
    Write-Host "Launcher failed: $($_.Exception.Message)" -ForegroundColor Red
    $_ | Format-List * -Force | Out-String -Width 240 | Write-Host
    exit 1
}