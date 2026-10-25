#Requires -Version 7.0
# Generated, non-media fixtures only; original runtime and archives are untouched.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression.FileSystem
$subjectScript=Join-Path $PSScriptRoot 'index-subject-retained-source.ps1'
$subjectTestsRoot=Join-Path (Join-Path $PSScriptRoot '../test-output') ('subject-source-index-'+[guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $subjectTestsRoot
$subjectPasses=0
function Write-Fixture([string]$Path,[string]$Text) {
    $null=New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force
    [IO.File]::WriteAllText($Path,$Text,[Text.UTF8Encoding]::new($false))
}
function Fixture([switch]$Unsafe,[switch]$Duplicate,[switch]$MissingNotice,[switch]$KnownAlias,[switch]$UnexpectedAlias,[switch]$UnderstatedSize) {
    $root=Join-Path $subjectTestsRoot ([guid]::NewGuid().ToString('N'))
    $null=New-Item -ItemType Directory -Path (Join-Path $root 'models'),(Join-Path $root 'vendor/sam2')
    Write-Fixture (Join-Path $root 'models/model.pt') 'Synthetic model bytes; never executed.'
    $source=[ordered]@{'sam2/model.py'='# Synthetic source';'sam2/config.yaml'='fixture: true';'LICENSE'='Synthetic licence fixture';'LICENSE_cctorch'='Synthetic secondary notice';'README.md'='Synthetic grant-evidence fixture';'sav_dataset/example/video.mp4'='Excluded synthetic media'}
    if ($KnownAlias -or $UnexpectedAlias) { $source['sam2/alias.yaml']='config.yaml' }
    $revision='1'*40
    $archivePath=Join-Path $root ('sam2-'+$revision+'.zip')
    $archive=[IO.Compression.ZipFile]::Open($archivePath,[IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($entry in $source.GetEnumerator()) {
            if ($MissingNotice -and $entry.Key -eq 'LICENSE') { continue }
            $member=$archive.CreateEntry('sam2-'+$revision+'/'+$entry.Key)
            if ($entry.Key -eq 'sam2/alias.yaml') { $member.ExternalAttributes=0xA000 -shl 16 }
            $writer=[IO.StreamWriter]::new($member.Open(),[Text.UTF8Encoding]::new($false))
            try {$writer.Write($entry.Value)}finally{$writer.Dispose()}
            if ($entry.Key.StartsWith('sam2/') -or $entry.Key.StartsWith('LICENSE')) { Write-Fixture (Join-Path (Join-Path $root 'vendor') $entry.Key) $entry.Value }
        }
        if ($Unsafe) {$stream=$archive.CreateEntry('sam2-'+$revision+'/sam2/../escape.py').Open();$stream.Dispose()}
        if ($Duplicate) {$stream=$archive.CreateEntry('sam2-'+$revision+'/SAM2/model.py').Open();$stream.Dispose()}
    } finally {$archive.Dispose()}
    if ($UnderstatedSize) {
        # Deliberately malformed synthetic archive only: preserve compressed payload
        # but understate its central-directory length. The identity is repinned below.
        $archiveBytes=[IO.File]::ReadAllBytes($archivePath)
        $patched=$false
        for ($offset=0; $offset -le $archiveBytes.Length-46; $offset++) {
            if ([BitConverter]::ToUInt32($archiveBytes,$offset) -ne 0x02014b50) { continue }
            $nameLength=[BitConverter]::ToUInt16($archiveBytes,$offset+28)
            if ($offset+46+$nameLength -gt $archiveBytes.Length) { throw 'Invalid synthetic central directory.' }
            $name=[Text.Encoding]::UTF8.GetString($archiveBytes,$offset+46,$nameLength)
            if ($name -cne ('sam2-'+$revision+'/sam2/model.py')) { continue }
            [Array]::Copy([BitConverter]::GetBytes([uint32]1),0,$archiveBytes,$offset+24,4)
            $patched=$true
            break
        }
        if (-not $patched) { throw 'Synthetic ZIP member was not patched.' }
        [IO.File]::WriteAllBytes($archivePath,$archiveBytes)
    }
    $definition=[ordered]@{schema=1;profile='synthetic-only';sourceRevision=$revision;archiveFile=[IO.Path]::GetFileName($archivePath);archiveSha256=(Get-FileHash -LiteralPath $archivePath).Hash.ToLowerInvariant();archiveUrl='https://example.invalid/source';modelFile='model.pt';modelSha256=(Get-FileHash -LiteralPath (Join-Path $root 'models/model.pt')).Hash.ToLowerInvariant();modelBytes=(Get-Item -LiteralPath (Join-Path $root 'models/model.pt')).Length;modelRevision='2'*40;modelUrl='https://example.invalid/model';licenseEvidenceUrl='https://example.invalid/notice'}
    $definition.sourceAliases=if($KnownAlias){[ordered]@{'sam2/alias.yaml'='config.yaml'}}else{[ordered]@{}}
    $definitionPath=Join-Path $root 'definition.json'
    Write-Fixture $definitionPath ($definition | ConvertTo-Json)
    return [pscustomobject]@{root=$root;definition=$definitionPath}
}
function Invoke-Index($Fixture,[string]$Output='') {
    return (& $subjectScript -PackRoot $Fixture.root -DefinitionPath $Fixture.definition -OutputDirectory $Output | ConvertFrom-Json)
}
function Check([bool]$Condition,[string]$Message) {if(-not $Condition){throw $Message}}
function Fails([scriptblock]$Action,[string]$Pattern) {
    try {$null=& $Action;throw 'Expected refusal did not occur.'}catch{if($_.Exception.Message -notmatch $Pattern){throw}}
    $script:subjectPasses++
}
$fixture=Fixture
$output=Join-Path $subjectTestsRoot 'verified-subset'
$receipt=Invoke-Index $fixture $output
Check ($receipt.retainedSourceFiles -eq 4 -and $receipt.sourceSubsetStaged) 'Wrong source subset.'
Check (-not $receipt.redistributionApproved -and -not $receipt.installerQualified -and -not $receipt.subjectQualityAccepted) 'Receipt improperly grants qualification.'
Check ((Get-ChildItem -LiteralPath (Join-Path $output 'source') -File -Recurse).Count -eq 5) 'Wrong staged member count.'
Check (-not (Test-Path -LiteralPath (Join-Path $output 'source/sav_dataset'))) 'Dataset/example media staged.'
$script:subjectPasses++
Fails {Invoke-Index $fixture $output} 'already exists'
Fails {Invoke-Index $fixture (Join-Path $fixture.root 'output')} 'separate owned'
$fixture=Fixture;Write-Fixture (Join-Path $fixture.root 'vendor/sam2/model.py') '# Changed source'
Fails {Invoke-Index $fixture} 'Retained source mismatch'
$fixture=Fixture;Write-Fixture (Join-Path $fixture.root 'vendor/sam2/extra.py') '# Unexpected source'
Fails {Invoke-Index $fixture} 'Unexpected retained source'
$fixture=Fixture;Write-Fixture (Join-Path $fixture.root 'models/model.pt') 'Changed model'
Fails {Invoke-Index $fixture} 'Model identity mismatch'
$fixture=Fixture -Unsafe
Fails {Invoke-Index $fixture} 'Unsafe source archive'
$fixture=Fixture -Duplicate
Fails {Invoke-Index $fixture} 'duplicate source archive'
$fixture=Fixture -MissingNotice
Fails {Invoke-Index $fixture} 'Missing publisher notice'
$fixture=Fixture;$definition=Get-Content -LiteralPath $fixture.definition -Raw | ConvertFrom-Json;$definition | Add-Member exportQualified $true
Write-Fixture $fixture.definition ($definition | ConvertTo-Json)
Fails {Invoke-Index $fixture} 'Unexpected source definition'
$fixture=Fixture -KnownAlias
$output=Join-Path $subjectTestsRoot 'literal-alias-subset'
$receipt=Invoke-Index $fixture $output
Check ($receipt.retainedSourceFiles -eq 5) 'Known alias not inventoried.'
Check ((Get-Content -LiteralPath (Join-Path $output 'source/sam2/alias.yaml') -Raw) -ceq 'config.yaml') 'Alias text was not retained literally.'
Check (((Get-Item -LiteralPath (Join-Path $output 'source/sam2/alias.yaml')).Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'Archive alias became a filesystem link.'
$script:subjectPasses++
$fixture=Fixture -UnexpectedAlias
Fails {Invoke-Index $fixture} 'Unapproved source alias'
$fixture=Fixture -UnderstatedSize
$output=Join-Path $subjectTestsRoot 'malformed-subset'
# Some .NET ZIP readers stop at the declared length: the retained-source hash
# must still reject that truncated stream before any output is created.
Fails {Invoke-Index $fixture $output} 'actual bytes exceed declared read bound|actual length mismatch|Retained source mismatch'
Check (-not (Test-Path -LiteralPath $output)) 'Malformed archive caused output creation.'
$fixture=Fixture
$junction=Join-Path $subjectTestsRoot 'redirected-input'
$null=New-Item -ItemType Junction -Path $junction -Target $fixture.root
$redirected=[pscustomobject]@{root=$junction;definition=(Join-Path $junction 'definition.json')}
$output=Join-Path $fixture.root 'aliased-output'
$before=(Get-FileHash -LiteralPath $fixture.definition).Hash
Fails {Invoke-Index $redirected $output} 'Reparse point in source evidence'
Check (-not (Test-Path -LiteralPath $output)) 'Redirected input caused output creation.'
Check ((Get-FileHash -LiteralPath $fixture.definition).Hash -ceq $before) 'Redirected input was modified.'
[pscustomobject]@{passed=$subjectPasses;fixtureRoot=$subjectTestsRoot;originalRuntimeTouched=$false} | ConvertTo-Json -Compress
