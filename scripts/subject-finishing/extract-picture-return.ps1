#Requires -Version 7.0
param([Parameter(Mandatory)][string]$Zip,[Parameter(Mandatory)][string]$Destination)
$ErrorActionPreference='Stop'
$returnRepo=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$returnAllowed=[IO.Path]::GetFullPath((Join-Path $returnRepo 'test-output'))+[IO.Path]::DirectorySeparatorChar
$returnZip=[IO.Path]::GetFullPath($Zip);$returnDestination=[IO.Path]::GetFullPath($Destination)
foreach ($returnPath in @($returnZip,$returnDestination)) {
 if (-not $returnPath.StartsWith($returnAllowed,[StringComparison]::OrdinalIgnoreCase)) {throw 'Isolated return-report fixture required.'}
 for ($returnPart=$returnPath;$returnPart;$returnPart=Split-Path -Parent $returnPart) {
  if ((Test-Path -LiteralPath $returnPart) -and ((Get-Item -LiteralPath $returnPart -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {throw 'Ordinary fixture paths required.'}
  if ((Split-Path -Parent $returnPart) -eq $returnPart) {break}
 }
}
if (Test-Path -LiteralPath $returnDestination) {throw 'New extraction directory required.'}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$returnArchive=[IO.Compression.ZipFile]::OpenRead($returnZip)
try {
 $returnNames=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
 $returnTotal=0L
 if ($returnArchive.Entries.Count -lt 2 -or $returnArchive.Entries.Count -gt 10) {throw 'Unexpected bounded return inventory.'}
 foreach ($returnEntry in $returnArchive.Entries) {
  if ($returnEntry.FullName -cnotmatch '^(case-[1-4]/picture-report|comparison-report)(\.json|\.[a-f0-9]{64}\.committed)$' -or
      -not $returnNames.Add($returnEntry.FullName) -or $returnEntry.Length -gt 65536 -or
      ($returnEntry.FullName.EndsWith('.committed') -and $returnEntry.Length -ne 0)) {throw 'Unexpected return entry.'}
  $returnTotal+=$returnEntry.Length
 }
 if ($returnTotal -gt 65536) {throw 'Return-report byte budget exceeded.'}
 New-Item -ItemType Directory -Path $returnDestination | Out-Null
 foreach ($returnEntry in $returnArchive.Entries) {
  $returnTarget=Join-Path $returnDestination $returnEntry.FullName
  [IO.Directory]::CreateDirectory((Split-Path -Parent $returnTarget)) | Out-Null
  $returnInput=$returnEntry.Open();$returnOutput=[IO.File]::Open($returnTarget,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try {$returnInput.CopyTo($returnOutput);$returnOutput.Flush($true)}finally{$returnOutput.Dispose();$returnInput.Dispose()}
 }
}finally{$returnArchive.Dispose()}
