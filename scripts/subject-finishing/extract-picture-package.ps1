#Requires -Version 7.0
param([Parameter(Mandatory)][string]$Zip,[Parameter(Mandatory)][string]$Destination)
$ErrorActionPreference='Stop'
$extractRepo=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$extractAllowed=[IO.Path]::GetFullPath((Join-Path $extractRepo 'test-output'))+[IO.Path]::DirectorySeparatorChar
$extractZip=[IO.Path]::GetFullPath($Zip);$extractTarget=[IO.Path]::GetFullPath($Destination)
foreach ($extractPath in @($extractZip,$extractTarget)) {
 if (-not $extractPath.StartsWith($extractAllowed,[StringComparison]::OrdinalIgnoreCase)) {throw 'Isolated package fixture required.'}
 for ($part=$extractPath;$part;$part=Split-Path -Parent $part) {
  if ((Test-Path -LiteralPath $part) -and ((Get-Item -LiteralPath $part -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {throw 'Ordinary fixture paths required.'}
  if ((Split-Path -Parent $part) -eq $part) {break}
 }
}
if (Test-Path -LiteralPath $extractTarget) {throw 'New extraction target required.'}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=[IO.Compression.ZipFile]::OpenRead($extractZip)
try {
 $names=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase);$total=0L
 if ($archive.Entries.Count -ne 56) {throw 'Exact portable-kit inventory required.'}
 foreach ($entry in $archive.Entries) {
  if ($entry.FullName -cnotmatch '^[a-zA-Z0-9_./-]+$' -or $entry.FullName.StartsWith('/') -or $entry.FullName.Contains('..') -or
      -not $names.Add($entry.FullName) -or $entry.Length -le 0 -or $entry.Length -gt 64MB) {throw 'Unexpected package entry.'}
  $total+=$entry.Length
 }
 if ($total -gt 160MB) {throw 'Package byte budget exceeded.'}
 New-Item -ItemType Directory -Path $extractTarget | Out-Null
 foreach ($entry in $archive.Entries) {
  $target=Join-Path $extractTarget $entry.FullName;[IO.Directory]::CreateDirectory((Split-Path -Parent $target)) | Out-Null
  $input=$entry.Open();$output=[IO.File]::Open($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try {$input.CopyTo($output);$output.Flush($true)}finally{$output.Dispose();$input.Dispose()}
 }
}finally{$archive.Dispose()}
