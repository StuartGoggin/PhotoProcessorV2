#Requires -Version 7.0
param(
 [string]$CandidateDirectory='test-output/subject-picture-handoff-v8',
 [string]$ComparisonDirectory='test-output/subject-picture-comparison-lChCd8/new session',
 [string]$OutputDirectory='test-output/subject-picture-package-v1'
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$kitRepo=Split-Path -Parent $PSScriptRoot
$kitAllowed=[IO.Path]::GetFullPath((Join-Path $kitRepo 'test-output'))+[IO.Path]::DirectorySeparatorChar
function Resolve-KitDirectory([string]$Value) {
 $absolute=[IO.Path]::GetFullPath((Join-Path $kitRepo $Value))
 if (-not $absolute.StartsWith($kitAllowed,[StringComparison]::OrdinalIgnoreCase)) {throw 'Isolated test-output candidate required.'}
 return $absolute
}
$kitCandidate=Resolve-KitDirectory $CandidateDirectory
$kitComparison=Resolve-KitDirectory $ComparisonDirectory
$kitOutput=Resolve-KitDirectory $OutputDirectory
if (Test-Path -LiteralPath $kitOutput) {throw 'New package directory required; never overwrite retained evidence.'}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class PicturePackageLease {
 [StructLayout(LayoutKind.Sequential)] private struct Info {
  public uint attributes;public System.Runtime.InteropServices.ComTypes.FILETIME created,accessed,written;
  public uint volume,sizeHigh,sizeLow,links,indexHigh,indexLow;
 }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern SafeFileHandle CreateFileW(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll")] private static extern bool GetFileInformationByHandle(SafeFileHandle file,out Info info);
 public static SafeFileHandle Open(string path,bool directory) {
  var handle=CreateFileW(path,0x80000000,1,IntPtr.Zero,3,directory?0x02200000u:0x00200000u,IntPtr.Zero);Info info;
  if(handle.IsInvalid||!GetFileInformationByHandle(handle,out info)||(info.attributes&0x400)!=0||((info.attributes&0x10)!=0)!=directory) {
   handle.Dispose();throw new InvalidOperationException("Ordinary package lease refused.");
  }return handle;
 }
}
'@
$kitDirectories=[Collections.Generic.Dictionary[string,Microsoft.Win32.SafeHandles.SafeFileHandle]]::new([StringComparer]::OrdinalIgnoreCase)
$kitInputs=[Collections.Generic.List[IO.FileStream]]::new()
function Protect-KitDirectory([string]$Path,[bool]$Create=$false) {
 $absolute=[IO.Path]::GetFullPath($Path);$volume=[IO.Path]::GetPathRoot($absolute);$parts=@($volume);$current=$volume
 foreach ($segment in $absolute.Substring($volume.Length).Split([IO.Path]::DirectorySeparatorChar,[StringSplitOptions]::RemoveEmptyEntries)) {$current=Join-Path $current $segment;$parts+=$current}
 foreach ($part in $parts) {
  if ($kitDirectories.ContainsKey($part)) {continue}
  if (-not [IO.Directory]::Exists($part)) {if (-not $Create) {throw 'Existing ordinary parent required.'};[IO.Directory]::CreateDirectory($part) | Out-Null}
  $kitDirectories.Add($part,[PicturePackageLease]::Open($part,$true))
 }
}
function Read-KitInput([string]$Path) {
 Protect-KitDirectory (Split-Path -Parent $Path)
 $stream=[IO.FileStream]::new([PicturePackageLease]::Open($Path,$false),[IO.FileAccess]::Read)
 if ($stream.Length -le 0 -or $stream.Length -gt 64MB) {$stream.Dispose();throw 'Bounded nonempty package input required.'}
 $kitInputs.Add($stream);$hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant();$stream.Position=0
 return [pscustomobject]@{stream=$stream;bytes=$stream.Length;sha256=$hash}
}
$kitFiles=[Collections.Generic.List[object]]::new()
try {
 Protect-KitDirectory $kitCandidate;Protect-KitDirectory (Split-Path -Parent $kitOutput)
 $kitReceiptPath=Join-Path $kitCandidate 'build-receipt.json';$kitReceiptPin=Read-KitInput $kitReceiptPath
 $kitBuild=Get-Content -LiteralPath $kitReceiptPath -Raw | ConvertFrom-Json
 if ($kitBuild.schema -ne 1 -or $kitBuild.kind -ne 'native-cached-picture-handoff-build' -or $kitBuild.testFaultsEnabled -ne $false -or
     $kitBuild.productionExportQualified -ne $false -or $kitBuild.subjectQualityAccepted -ne $false -or $kitBuild.cudaInferenceReady -ne $false -or
     $kitBuild.executable.path -cne 'bin/PhotoGoGo-Cached-Picture-Test.exe' -or $kitBuild.sources.Count -ne 15 -or $kitBuild.payload.Count -ne 35) {throw 'Exact normal cached-picture build required.'}
 $kitSourcePins=@($kitBuild.sources | ForEach-Object {
  if ($_.path -cnotmatch '^(src-tauri/native/(subject_picture_handoff|subject_finishing)/[a-z_]+\.(cpp|h)|scripts/build-subject-picture-handoff\.ps1)$') {throw 'Unexpected source path.'}
  $pin=Read-KitInput (Join-Path $kitRepo $_.path);if ($pin.sha256 -cne $_.sha256) {throw 'Stale source closure.'}
  [pscustomobject]@{path=$_.path;pin=$pin}
 })
 $kitBinary=Join-Path $kitCandidate $kitBuild.executable.path;$kitBinaryPin=Read-KitInput $kitBinary
 if ($kitBinaryPin.sha256 -cne $kitBuild.executable.sha256) {throw 'Executable identity mismatch.'}
 $kitPayloadPins=@($kitBuild.payload | ForEach-Object {
  if ($_.path -cnotmatch '^(media/|source/PhotoGoGo-FFmpeg-rowtest1-source\.tar\.gz$|samples/(black-horse|white-horse)/(base\.mp4|masks\.pgmask|manifest\.json)$)' -or $_.path.Contains('..') -or $_.path.Contains('\')) {throw 'Unexpected payload path.'}
  $pin=Read-KitInput (Join-Path $kitCandidate $_.path);if ($pin.sha256 -cne $_.sha256 -or $pin.bytes -ne $_.bytes) {throw 'Payload identity mismatch.'}
  [pscustomobject]@{path=$_.path;pin=$pin}
 })
 # Run public non-quality seams against this exact current build.
 $kitTests=@(
  @{script='test-subject-picture-refusal.mjs';args=@($kitBinary)},
  @{script='test-subject-picture-admission.mjs';args=@($kitBinary)},
  @{script='test-subject-picture-timeout.mjs';args=@($kitBinary)},
  @{script='test-subject-picture-report-reader.mjs';args=@($kitReceiptPath,(Join-Path $kitComparison 'case-1'))},
  @{script='test-subject-picture-attribution.mjs';args=@($kitBinary,(Join-Path $kitComparison 'case-1/picture-report.json'))},
  @{script='test-subject-picture-return-zip.mjs';args=@($kitComparison,$kitReceiptPath)}
 )
 $kitEvidence=@();Push-Location $kitRepo
 try {foreach ($test in $kitTests) {
  $result=@(& node.exe (Join-Path $PSScriptRoot $test.script) @($test.args))
  if ($LASTEXITCODE -ne 0 -or $result.Count -ne 1) {throw 'Public validation failed; no package created.'}
  $value=$result[0] | ConvertFrom-Json
  if ($value.event -ne 'passed' -or $value.productionExportQualified -ne $false) {throw 'Unexpected validation result.'}
  $kitEvidence+=@{seam=$value.seam;passed=$true;scriptSha256=(Read-KitInput (Join-Path $PSScriptRoot $test.script)).sha256}
 }}finally{Pop-Location}
 $kitVsWhere=Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
 $kitVs=(& $kitVsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath).Trim()
 $kitCompiler=(Get-Content -LiteralPath (Join-Path $kitVs 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt')).Trim()
 $kitDumpBin=Join-Path $kitVs ('VC/Tools/MSVC/'+$kitCompiler+'/bin/Hostx64/x64/dumpbin.exe')
 $kitPe=(& $kitDumpBin /loadconfig /imports $kitBinary) -join "`n"
 if ($LASTEXITCODE -ne 0 -or $kitPe -notmatch '(?m)^\s+0800 Dependent Load Flag\s*$') {throw 'Actual PE loader policy unverified.'}
 $kitImports=@([regex]::Matches($kitPe,'(?im)^\s+([a-z0-9_.-]+\.dll)\s*$') | ForEach-Object {$_.Groups[1].Value.ToLowerInvariant()} | Sort-Object -Unique)
 $kitExpected=@('bcrypt.dll','d3d11.dll','dxgi.dll','d3dcompiler_47.dll','gdi32.dll','ole32.dll','shell32.dll','user32.dll','kernel32.dll') | Sort-Object
 if (($kitImports -join ',') -cne ($kitExpected -join ',')) {throw 'Unexpected direct runtime prerequisite.'}
 # Exclusive root creation occurs with its ordinary parent already leased.
 # Never adopt a directory created by another writer during qualification.
 New-Item -ItemType Directory -Path $kitOutput -ErrorAction Stop | Out-Null
 Protect-KitDirectory $kitOutput;$kitStage=Join-Path $kitOutput 'payload';Protect-KitDirectory $kitStage $true
 function Add-KitFile([string]$Path,$Pin) {
  if ($Path.Contains('..') -or $Path.Contains('\') -or $Path.StartsWith('/')) {throw 'Unsafe package entry.'}
  $target=Join-Path $kitStage $Path;Protect-KitDirectory (Split-Path -Parent $target) $true
  $out=[IO.File]::Open($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read)
  try {
   $Pin.stream.Position=0;$Pin.stream.CopyTo($out);$out.Flush($true);$out.Position=0
   if ($out.Length -ne $Pin.bytes -or [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($out)).ToLowerInvariant() -cne $Pin.sha256) {throw 'Package copy readback failed.'}
  }finally{$out.Dispose()}
  $kitFiles.Add(@{path=$Path;bytes=$Pin.bytes;sha256=$Pin.sha256})
 }
 Add-KitFile $kitBuild.executable.path $kitBinaryPin;Add-KitFile 'build-receipt.json' $kitReceiptPin
 foreach ($entry in $kitPayloadPins) {Add-KitFile $entry.path $entry.pin}
 foreach ($entry in $kitSourcePins) {Add-KitFile ('source/photogogo-owned/'+$entry.path) $entry.pin}
 Add-KitFile 'README.txt' (Read-KitInput (Join-Path $kitRepo 'docs/subject-picture-handoff-README.txt'))
 Add-KitFile 'NOTICE.txt' (Read-KitInput (Join-Path $kitRepo 'docs/subject-picture-handoff-NOTICE.txt'))
 function Write-KitJson([string]$Path,$Value) {
  $bytes=[Text.Encoding]::UTF8.GetBytes(($Value | ConvertTo-Json -Depth 10));$target=Join-Path $kitStage $Path;Protect-KitDirectory (Split-Path -Parent $target) $true
  $out=[IO.File]::Open($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read)
  try {$out.Write($bytes);$out.Flush($true);$out.Position=0;if ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($out)) -cne [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes))) {throw 'JSON readback failed.'}}finally{$out.Dispose()}
  if ($Path -ne 'package-receipt.json') {$pin=Read-KitInput $target;$kitFiles.Add(@{path=$Path;bytes=$pin.bytes;sha256=$pin.sha256})}
 }
 Write-KitJson 'evidence/validation.json' @{schema=1;kind='cached-picture-control-package';tests=$kitEvidence;actualDirectImports=$kitImports;dependentLoadFlag='0800';sourceCount=15;
  mediaPayloadCount=35;interactivePickerExercised=$false;nvidiaMediaTested=$false;cudaInferenceReady=$false;subjectQualityAccepted=$false;productionExportQualified=$false}
 Write-KitJson 'package-receipt.json' @{schema=1;kind='photogogo-cached-picture-control-package';unsigned=$true;testFaultsEnabled=$false;files=@($kitFiles);
  inferenceRuntimeBundled=$false;cudaInferenceReady=$false;subjectQualityAccepted=$false;productionExportQualified=$false}
 Add-Type -AssemblyName System.IO.Compression.FileSystem
 $kitZip=Join-Path $kitOutput 'PhotoGoGo-Cached-Picture-Test.zip'
 $kitZipStream=[IO.File]::Open($kitZip,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read)
 try {
  $archive=[IO.Compression.ZipArchive]::new($kitZipStream,[IO.Compression.ZipArchiveMode]::Create,$true)
  try {foreach ($entry in @($kitFiles)+@(@{path='package-receipt.json'})) {
   [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,(Join-Path $kitStage $entry.path),$entry.path,[IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }}finally{$archive.Dispose()}
  $kitZipStream.Flush($true)
 }finally{$kitZipStream.Dispose()}
 foreach ($pin in @($kitBinaryPin,$kitReceiptPin)+@($kitSourcePins.pin)+@($kitPayloadPins.pin)) {
  $pin.stream.Position=0;if ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($pin.stream)).ToLowerInvariant() -cne $pin.sha256) {throw 'Pinned input changed during packaging.'}
 }
 Write-Output (@{event='cachedPicturePackageCreated';zip=$kitZip;files=$kitFiles.Count+1;sha256=(Get-FileHash -LiteralPath $kitZip -Algorithm SHA256).Hash.ToLowerInvariant();productionExportQualified=$false} | ConvertTo-Json -Compress)
}finally{foreach ($input in $kitInputs) {$input.Dispose()};foreach ($directory in $kitDirectories.Values) {$directory.Dispose()}}
