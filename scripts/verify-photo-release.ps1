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
$reportRoot = Join-Path $repo ("test-output\release-${Version}-inspection-" + [datetime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))
if (Test-Path -LiteralPath $reportRoot) { throw "Inspection folder already exists; preserve it and choose a fresh run: $reportRoot" }
New-Item -ItemType Directory -Path $reportRoot | Out-Null
$sevenZip = 'C:\Program Files\7-Zip\7z.exe'
if (-not (Test-Path -LiteralPath $sevenZip)) { throw '7-Zip is required for non-installing package inspection.' }
$installer = New-Object -ComObject WindowsInstaller.Installer
function Read-MsiProperty([string]$path,[string]$property) {
    $database = $installer.OpenDatabase($path,0)
    $view = $database.OpenView("SELECT ``Value`` FROM ``Property`` WHERE ``Property`` = '$property'")
    $null = $view.Execute(); $record = $view.Fetch()
    if (-not $record) { throw "Missing MSI property $property" }
    $value = $record.StringData(1); $null = $view.Close()
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
$binaryLength = (Get-Item -LiteralPath $binary).Length
function Get-NormalizedApplicationHash([string]$path,[string]$expectedType) {
    $bytes = [IO.File]::ReadAllBytes($path)
    $prefix = '__TAURI_BUNDLE_TYPE_VAR_'
    $ascii = [Text.Encoding]::ASCII.GetString($bytes)
    $offset = $ascii.IndexOf($prefix,[StringComparison]::Ordinal)
    if ($offset -lt 0 -or $ascii.IndexOf($prefix,$offset + $prefix.Length,[StringComparison]::Ordinal) -ge 0) {
        throw "Expected exactly one Tauri bundle marker in $path"
    }
    $typeOffset = $offset + $prefix.Length
    $actualType = $ascii.Substring($typeOffset,3)
    if ($actualType -cne $expectedType) { throw "Unexpected Tauri bundle marker '$actualType' in $path" }
    # tauri-utils patches only these three bytes when creating MSI/NSIS packages.
    # Every other byte must match the standalone application; do not waive other differences.
    [Array]::Copy([Text.Encoding]::ASCII.GetBytes('UNK'),0,$bytes,$typeOffset,3)
    $normalizedHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes))
    return @{ sha256=$normalizedHash; bundleType=$actualType; markerOffset=$typeOffset }
}
$standalone = Get-NormalizedApplicationHash $binary 'UNK'
if ($standalone.sha256 -ne $binaryHash) { throw 'Standalone application normalization changed unexpected bytes' }
$manifest = Get-Content -Raw -LiteralPath (Join-Path $repo 'src-tauri\tools\ffmpeg\build-manifest.json') | ConvertFrom-Json
$manifestHash = (Get-FileHash -LiteralPath (Join-Path $repo 'src-tauri\tools\ffmpeg\build-manifest.json') -Algorithm SHA256).Hash
$expected = @($manifestHash) + @($manifest.files | ForEach-Object sha256)
$packages = @()
foreach ($package in @(@{ kind='msi'; path=$msi },@{ kind='nsis'; path=$nsis })) {
    $extracted = [IO.Path]::GetFullPath((Join-Path $reportRoot $package.kind))
    if (-not $extracted.StartsWith($reportRoot + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe extraction path' }
    New-Item -ItemType Directory -Path $extracted | Out-Null
    try {
        & $sevenZip x '-y' "-o$extracted" $package.path | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Cannot inspect $($package.kind)" }
        $payloadFiles = @(Get-ChildItem -LiteralPath $extracted -Recurse -File)
        $applications = @($payloadFiles | Where-Object Length -eq $binaryLength)
        if ($applications.Count -ne 1) { throw "Expected exactly one application payload in $($package.kind)" }
        $expectedType = if ($package.kind -eq 'msi') { 'MSI' } else { 'NSS' }
        $application = Get-NormalizedApplicationHash $applications[0].FullName $expectedType
        if ($application.sha256 -ne $binaryHash) { throw "Application differs beyond its Tauri bundle marker in $($package.kind)" }
        $hashes = @($payloadFiles | ForEach-Object { (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash })
        foreach ($hash in $expected) { if ($hashes -notcontains $hash) { throw "Missing expected payload hash in $($package.kind): $hash" } }
        $file = Get-Item -LiteralPath $package.path
        $packages += @{ path=$file.FullName; bytes=$file.Length; sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash; payloadsVerified=($expected.Count + 1); application=@{ sha256=(Get-FileHash -LiteralPath $applications[0].FullName -Algorithm SHA256).Hash; normalizedSha256=$application.sha256; bundleType=$application.bundleType; markerOffset=$application.markerOffset }; signature=(Get-AuthenticodeSignature -LiteralPath $file.FullName).Status.ToString() }
    } finally {
        # Only this new run's exact, validated extraction directory is disposable.
        if ($extracted -notin @((Join-Path $reportRoot 'msi'),(Join-Path $reportRoot 'nsis'))) { throw 'Unsafe extraction cleanup target' }
        Remove-Item -LiteralPath $extracted -Recurse -Force
    }
}
& (Join-Path $PSScriptRoot 'verify-media-bundle.ps1') -BundleDirectory (Join-Path $repo 'src-tauri\tools\ffmpeg') -SourceArchive $source
if ($LASTEXITCODE -ne 0) { throw 'Managed media verification failed' }
$report = @{ complete=$true; reportFolder=$reportRoot; version=$Version; inspectedWithoutInstalling=$true; productVersion=$productVersion; upgradeCode=$upgradeCode; previousVersion=$PreviousVersion; binarySha256=$binaryHash; packages=$packages; sourceArchive=@{ path=$source; bytes=(Get-Item -LiteralPath $source).Length; sha256=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash } }
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $reportRoot 'report.json') -Encoding utf8
$report | ConvertTo-Json -Depth 8
