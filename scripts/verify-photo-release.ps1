param(
    [string]$Version = '2.0.30',
    [string]$PreviousVersion = '2.0.29'
)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$bundle = Join-Path $repo 'src-tauri\target\release\bundle'
$binary = Join-Path $repo 'src-tauri\target\release\photogogo-v2.exe'
$msi = Join-Path $bundle "msi\PhotoGoGoV2_${Version}_x64_en-US.msi"
$nsis = Join-Path $bundle "nsis\PhotoGoGoV2_${Version}_x64-setup.exe"
$previous = Join-Path $bundle "msi\PhotoGoGoV2_${PreviousVersion}_x64_en-US.msi"
$source = Join-Path $repo 'test-output\media-delivery\PhotoGoGo-FFmpeg-rowtest1-source.tar.gz'
$reportRoot = Join-Path $repo "test-output\release-${Version}-inspection"
if (Test-Path -LiteralPath $reportRoot) { throw "Inspection folder already exists; preserve it and choose a fresh run: $reportRoot" }
New-Item -ItemType Directory -Path $reportRoot | Out-Null
$sevenZip = 'C:\Program Files\7-Zip\7z.exe'
if (-not (Test-Path -LiteralPath $sevenZip)) { throw '7-Zip is required for non-installing package inspection.' }
$installer = New-Object -ComObject WindowsInstaller.Installer
function Read-MsiProperty([string]$path,[string]$property) {
    $database = $installer.OpenDatabase($path,0)
    $view = $database.OpenView("SELECT ``Value`` FROM ``Property`` WHERE ``Property`` = '$property'")
    $view.Execute(); $record = $view.Fetch()
    if (-not $record) { throw "Missing MSI property $property" }
    $value = $record.StringData(1); $view.Close()
    [Runtime.InteropServices.Marshal]::FinalReleaseComObject($record) | Out-Null
    [Runtime.InteropServices.Marshal]::FinalReleaseComObject($view) | Out-Null
    [Runtime.InteropServices.Marshal]::FinalReleaseComObject($database) | Out-Null
    return $value
}
$productVersion = Read-MsiProperty $msi 'ProductVersion'
$upgradeCode = Read-MsiProperty $msi 'UpgradeCode'
if ($productVersion -ne $Version) { throw 'MSI version mismatch' }
if ($upgradeCode -ne (Read-MsiProperty $previous 'UpgradeCode')) { throw 'MSI upgrade identity changed' }
$binaryHash = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash
$manifest = Get-Content -Raw -LiteralPath (Join-Path $repo 'src-tauri\tools\ffmpeg\build-manifest.json') | ConvertFrom-Json
$expected = @($binaryHash) + @($manifest.files | ForEach-Object sha256)
$packages = @()
foreach ($package in @(@{ kind='msi'; path=$msi },@{ kind='nsis'; path=$nsis })) {
    $extracted = [IO.Path]::GetFullPath((Join-Path $reportRoot $package.kind))
    if (-not $extracted.StartsWith($reportRoot + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe extraction path' }
    New-Item -ItemType Directory -Path $extracted | Out-Null
    try {
        & $sevenZip x '-y' "-o$extracted" $package.path | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Cannot inspect $($package.kind)" }
        $hashes = @(Get-ChildItem -LiteralPath $extracted -Recurse -File | ForEach-Object { (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash })
        foreach ($hash in $expected) { if ($hashes -notcontains $hash) { throw "Missing expected payload hash in $($package.kind): $hash" } }
        $file = Get-Item -LiteralPath $package.path
        $packages += @{ path=$file.FullName; bytes=$file.Length; sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash; payloadsVerified=$expected.Count; signature=(Get-AuthenticodeSignature -LiteralPath $file.FullName).Status.ToString() }
    } finally {
        # Only this new run's exact, validated extraction directory is disposable.
        if ($extracted -notin @((Join-Path $reportRoot 'msi'),(Join-Path $reportRoot 'nsis'))) { throw 'Unsafe extraction cleanup target' }
        Remove-Item -LiteralPath $extracted -Recurse -Force
    }
}
& (Join-Path $PSScriptRoot 'verify-media-bundle.ps1') -BundleDirectory (Join-Path $repo 'src-tauri\tools\ffmpeg') -SourceArchive $source
if ($LASTEXITCODE -ne 0) { throw 'Managed media verification failed' }
$report = @{ complete=$true; version=$Version; inspectedWithoutInstalling=$true; productVersion=$productVersion; upgradeCode=$upgradeCode; previousVersion=$PreviousVersion; binarySha256=$binaryHash; packages=$packages; sourceArchive=@{ path=$source; bytes=(Get-Item -LiteralPath $source).Length; sha256=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash } }
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $reportRoot 'report.json') -Encoding utf8
$report | ConvertTo-Json -Depth 8
