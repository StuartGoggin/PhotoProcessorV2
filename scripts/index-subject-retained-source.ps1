#Requires -Version 7.0
# Offline distribution evidence only. Never executes or modifies the input pack.
param(
    [string]$PackRoot = (Join-Path $PSScriptRoot '../.build-cache/subject-finishing-manual-cpu-v1'),
    [string]$DefinitionPath = (Join-Path $PSScriptRoot 'subject-finishing/runtime/source-manual-cpu.json'),
    [string]$OutputDirectory = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Get-Digest([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Assert-Regular([string]$Path) {
    $item = Get-Item -LiteralPath $Path
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point in source evidence.' }
    return $item
}
function Assert-Ancestry([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        $null = Assert-Regular $cursor
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
}
function Read-BoundedEntry($Entry, [IO.Stream]$Destination = $null, [long]$Limit = 256MB) {
    if ($Entry.Length -lt 0 -or $Entry.Length -gt $Limit) { throw 'Source entry length exceeds read bound.' }
    $stream = $Entry.Open()
    $hash = [Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256)
    try {
        $buffer = [byte[]]::new(65536)
        $actualBytes = 0L
        while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $actualBytes += $read
            if ($actualBytes -gt $Limit -or $actualBytes -gt $Entry.Length) { throw 'Source entry actual bytes exceed declared read bound.' }
            $hash.AppendData($buffer, 0, $read)
            if ($Destination) { $Destination.Write($buffer, 0, $read) }
        }
        if ($actualBytes -ne $Entry.Length) { throw 'Source entry actual length mismatch.' }
        return [Convert]::ToHexString($hash.GetHashAndReset()).ToLowerInvariant()
    }
    finally { $stream.Dispose(); $hash.Dispose() }
}
function Assert-Member([string]$Name) {
    if ($Name -match '[\\:\x00-\x1f]' -or $Name.StartsWith('/') -or $Name.Length -gt 512) { throw 'Unsafe source archive member.' }
    foreach ($part in $Name.TrimEnd('/').Split('/')) {
        if ($part -in @('', '.', '..') -or $part -match '[. ]$' -or $part -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)') {
            throw 'Unsafe source archive member.'
        }
    }
}
$pack = (Resolve-Path -LiteralPath $PackRoot).Path
$definitionFile = (Resolve-Path -LiteralPath $DefinitionPath).Path
Assert-Ancestry ([IO.Path]::GetFullPath($PackRoot))
Assert-Ancestry ([IO.Path]::GetFullPath($DefinitionPath))
Assert-Ancestry $pack
Assert-Ancestry $definitionFile
if ((Get-Item -LiteralPath $definitionFile).Length -gt 8192) { throw 'Source definition exceeds bound.' }
$definition = Get-Content -LiteralPath $definitionFile -Raw | ConvertFrom-Json
$fields = @('schema','profile','sourceRevision','archiveFile','archiveSha256','archiveUrl','sourceAliases','modelFile','modelSha256','modelBytes','modelRevision','modelUrl','licenseEvidenceUrl')
if ((($definition.PSObject.Properties.Name | Sort-Object) -join ',') -cne (($fields | Sort-Object) -join ',') -or $definition.schema -ne 1) { throw 'Unexpected source definition.' }
foreach ($field in @('archiveSha256','modelSha256')) { if ($definition.$field -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid input hash.' } }
foreach ($field in @('sourceRevision','modelRevision')) { if ($definition.$field -cnotmatch '^[a-f0-9]{40}$') { throw 'Invalid publisher revision.' } }
foreach ($field in @('archiveFile','modelFile')) { if ($definition.$field -cnotmatch '^[A-Za-z0-9_.-]+$') { throw 'Invalid artifact filename.' } }
if ($definition.modelBytes -lt 1 -or $definition.modelBytes -gt 256MB) { throw 'Model size exceeds bound.' }
if (@($definition.sourceAliases.PSObject.Properties).Count -gt 16) { throw 'Source alias count exceeds bound.' }
foreach ($alias in $definition.sourceAliases.PSObject.Properties) {
    Assert-Member $alias.Name
    Assert-Member $alias.Value
    if (-not $alias.Name.StartsWith('sam2/') -or -not $alias.Name.EndsWith('.yaml')) { throw 'Invalid source alias.' }
}
$archivePath = Join-Path $pack $definition.archiveFile
$modelDirectory = Join-Path $pack 'models'
$vendorDirectory = Join-Path $pack 'vendor'
$null = Assert-Regular $modelDirectory
$null = Assert-Regular $vendorDirectory
$modelPath = Join-Path $modelDirectory $definition.modelFile
$archiveFile = Assert-Regular $archivePath
$modelFile = Assert-Regular $modelPath
if ($archiveFile.Length -gt 256MB -or (Get-Digest $archivePath) -cne $definition.archiveSha256) { throw 'Source archive identity mismatch.' }
if ($modelFile.Length -ne $definition.modelBytes -or (Get-Digest $modelPath) -cne $definition.modelSha256) { throw 'Model identity mismatch.' }
$archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    if ($archive.Entries.Count -gt 10000) { throw 'Source archive entry count exceeds bound.' }
    $prefix = 'sam2-' + $definition.sourceRevision + '/'
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $selected = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
    $inventory = [Collections.Generic.List[object]]::new()
    $expandedBytes = 0L
    foreach ($entry in $archive.Entries) {
        Assert-Member $entry.FullName
        if (-not $entry.FullName.StartsWith($prefix, [StringComparison]::Ordinal) -or -not $seen.Add($entry.FullName.TrimEnd('/'))) { throw 'Unexpected or duplicate source archive member.' }
        $expandedBytes += $entry.Length
        if ($entry.Length -gt 256MB -or $expandedBytes -gt 512MB) { throw 'Source archive expanded size exceeds bound.' }
        $path = $entry.FullName.Substring($prefix.Length)
        if (-not $path -or $entry.FullName.EndsWith('/')) { continue }
        $symlink = ($entry.ExternalAttributes -shr 16 -band 0xF000) -eq 0xA000
        $runtimeFile = ($path.StartsWith('sam2/', [StringComparison]::Ordinal) -and ($path.EndsWith('.py') -or $path.EndsWith('.yaml'))) -or $path -in @('LICENSE','LICENSE_cctorch')
        $record = [ordered]@{path=$path;bytes=$entry.Length;archiveEntryKind=if($symlink){'symlink'}else{'regular'};role=if($runtimeFile){'retained-runtime-source'}elseif($path -eq 'README.md'){'publisher-grant-evidence'}else{'not-in-runtime-subset'}}
        if ($symlink) {
            $declared = @($definition.sourceAliases.PSObject.Properties | Where-Object Name -CEQ $path)
            if ($declared.Count -ne 1 -or $entry.Length -gt 512) { throw 'Unapproved source alias.' }
            $aliasBytes = [IO.MemoryStream]::new()
            try {
                $null = Read-BoundedEntry $entry $aliasBytes 512
                $targetText = [Text.UTF8Encoding]::new($false, $true).GetString($aliasBytes.ToArray())
            } finally { $aliasBytes.Dispose() }
            if ($targetText -cne $declared[0].Value) { throw 'Source alias target mismatch.' }
            $record.linkTarget = $targetText
            $record.retainedRepresentation = 'link-text-as-regular-file-not-followed'
        }
        if ($runtimeFile -or $path -eq 'README.md') {
            $record.sha256 = Read-BoundedEntry $entry
            $selected.Add($path, [pscustomobject]$record)
        }
        $inventory.Add([pscustomobject]$record)
    }
    foreach ($required in @('LICENSE','LICENSE_cctorch','README.md')) { if (-not $selected.ContainsKey($required)) { throw 'Missing publisher notice or evidence.' } }
    foreach ($alias in $definition.sourceAliases.PSObject.Properties) {
        $target = 'sam2/'+$alias.Value
        if (-not $selected.ContainsKey($alias.Name) -or $selected[$alias.Name].archiveEntryKind -cne 'symlink' -or -not $selected.ContainsKey($target) -or $selected[$target].archiveEntryKind -cne 'regular') { throw 'Source alias target is missing or not a regular source.' }
    }
    $retained = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($item in Get-ChildItem -LiteralPath $vendorDirectory -Recurse -Force) {
        $null = Assert-Regular $item.FullName
        if ($item.PSIsContainer) { continue }
        $path = [IO.Path]::GetRelativePath($vendorDirectory,$item.FullName).Replace('\','/')
        if (-not $selected.ContainsKey($path) -or $selected[$path].role -cne 'retained-runtime-source') { throw ('Unexpected retained source: '+$path) }
        if ($item.Length -ne $selected[$path].bytes -or (Get-Digest $item.FullName) -cne $selected[$path].sha256) { throw ('Retained source mismatch: '+$path) }
        $null = $retained.Add($path)
    }
    foreach ($record in $selected.Values) { if ($record.role -ceq 'retained-runtime-source' -and -not $retained.Contains($record.path)) { throw ('Missing retained source: '+$record.path) } }
    $receipt = [ordered]@{
        schema=1; profile=$definition.profile; definitionSha256=(Get-Digest $definitionFile)
        qualificationCandidate=$true; redistributionApproved=$false; installerQualified=$false; subjectQualityAccepted=$false
        archiveSha256=$definition.archiveSha256; archiveBytes=$archiveFile.Length; sourceRevision=$definition.sourceRevision
        model=[ordered]@{file=$definition.modelFile;bytes=$modelFile.Length;sha256=$definition.modelSha256;revision=$definition.modelRevision;publisherUrl=$definition.modelUrl}
        retainedSourceFiles=$retained.Count; retainedSourceMatches=$true; sourceSubsetStaged=$false
        upstreamInventory=@($inventory | Sort-Object path); sourceArchiveForInternalProvenanceOnly=$true
        limitation='This receipt proves consistency with the supplied hash definition, not publisher grants, runtime safety, GPU quality or installer closure. Non-runtime archive assets are not staged.'
    }
    if ($OutputDirectory) {
        $repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
        $output = [IO.Path]::GetFullPath($OutputDirectory)
        $allowed = @('.build-cache','test-output') | Where-Object { $output.StartsWith((Join-Path $repo $_)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) }
        if (-not $allowed -or $output.StartsWith($pack+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or $output -eq $pack) { throw 'Output must be a separate owned staging directory.' }
        if (Test-Path -LiteralPath $output) { throw 'Source evidence output already exists; it will not be overwritten.' }
        $parent = Split-Path -Parent $output
        Assert-Ancestry $parent
        $null = New-Item -ItemType Directory -Path $output
        foreach ($record in $selected.Values | Sort-Object path) {
            $target = Join-Path (Join-Path $output 'source') $record.path
            $null = New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force
            # Always create an ordinary file; never create/follow archive links.
            $targetStream = [IO.File]::Open($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
            try {
                $stagedDigest = Read-BoundedEntry ($archive.GetEntry($prefix+$record.path)) $targetStream
                $targetStream.Flush($true)
            } finally { $targetStream.Dispose() }
            if ($stagedDigest -cne $record.sha256) { throw 'Staged stream identity mismatch; incomplete evidence preserved.' }
            if ((Get-Digest $target) -cne $record.sha256) { throw 'Staged source read-back mismatch; incomplete evidence preserved.' }
        }
        $receipt.sourceSubsetStaged = $true
        $serialized = $receipt | ConvertTo-Json -Depth 8
        $reportStream = [IO.File]::Open((Join-Path $output 'source-index.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try { $bytes=[Text.Encoding]::UTF8.GetBytes($serialized);$reportStream.Write($bytes);$reportStream.Flush($true) } finally { $reportStream.Dispose() }
        $readBack = Get-Content -LiteralPath (Join-Path $output 'source-index.json') -Raw | ConvertFrom-Json
        if ($readBack.redistributionApproved -ne $false -or $readBack.retainedSourceFiles -ne $retained.Count) { throw 'Source index read-back mismatch.' }
    }
    $receipt | ConvertTo-Json -Depth 8 -Compress
} finally { $archive.Dispose() }
