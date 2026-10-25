#Requires -Version 7.0
param([Parameter(Mandatory)][string]$Zip,[Parameter(Mandatory)][string]$Destination)
$ErrorActionPreference='Stop'
if (Test-Path -LiteralPath $Destination) {throw 'Relocation fixture must use a new destination.'}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$handoffArchive=[IO.Compression.ZipFile]::OpenRead($Zip)
try {
    if ($handoffArchive.Entries.Count -gt 32) {throw 'Unexpected control package extent.'}
    foreach ($entry in $handoffArchive.Entries) {
        if ($entry.Length -gt 8MB -or $entry.FullName.Contains('..') -or $entry.FullName.Contains(':') -or
            $entry.FullName.Contains('\') -or $entry.FullName.StartsWith('/')) {throw 'Unsafe control package entry.'}
    }
} finally {$handoffArchive.Dispose()}
[IO.Compression.ZipFile]::ExtractToDirectory($Zip,$Destination)
