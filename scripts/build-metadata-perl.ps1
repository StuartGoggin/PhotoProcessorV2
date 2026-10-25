#Requires -Version 7.0
<#
Build the pinned official Perl source with installed x64 MSVC, entirely inside
test-output. This is not a system installer. It does not alter user/system PATH,
registry entries, application settings or any media. The stock MSVC release /MD
configuration is retained: upstream has no supported static-CRT switch.
BUILD_STATIC is a separate perl-static.exe target, not a static-CRT switch;
that static interpreter cannot load the dynamic XS closure used here.
#>
[CmdletBinding()]
param(
    [string]$BuildRoot = "",
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$allowedRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'test-output/metadata-perl-build'))
if (-not $BuildRoot) { $BuildRoot = $allowedRoot }
$BuildRoot = [IO.Path]::GetFullPath($BuildRoot)
if ($BuildRoot -ne $allowedRoot -and -not $BuildRoot.StartsWith($allowedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The private Perl build must remain inside test-output/metadata-perl-build.'
}
New-Item -ItemType Directory -Path $BuildRoot -Force | Out-Null
if ((Get-Item -LiteralPath $BuildRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The private build directory cannot be a link.' }
$version = '5.44.0'
$sourceUrl = "https://www.cpan.org/src/5.0/perl-$version.tar.gz"
$sourceSha256 = '3b855066b92491cb40e86affb1ca57d1a388aa43e51b91c7806a32c2f65f96c3'
$sourceAnnouncement = 'https://www.nntp.perl.org/group/perl.perl5.porters/2026/07/msg271063.html'
$archive = Join-Path $BuildRoot "perl-$version.tar.gz"
$sourceRoot = Join-Path $BuildRoot "perl-$version"
$installRoot = Join-Path $BuildRoot 'install'
$privateTemp = Join-Path $BuildRoot 'temp'
New-Item -ItemType Directory -Path $privateTemp -Force | Out-Null
if (-not (Test-Path -LiteralPath $archive)) { Invoke-WebRequest -Uri $sourceUrl -OutFile $archive }
$actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $sourceSha256) { throw 'Pinned official Perl source SHA-256 mismatch; nothing will be compiled.' }
$checksumsUrl = 'https://www.cpan.org/authors/id/L/LE/LEONT/CHECKSUMS'
$checksumsPath = Join-Path $BuildRoot 'LEONT-CHECKSUMS'
if (-not (Test-Path -LiteralPath $checksumsPath)) { Invoke-WebRequest -Uri $checksumsUrl -OutFile $checksumsPath }
$checksumEntry = [regex]::Match((Get-Content -LiteralPath $checksumsPath -Raw), "(?ms)^\s*'perl-5\.44\.0\.tar\.gz'\s*=>\s*\{(?<entry>.*?)^\s*\},")
if (-not $checksumEntry.Success -or $checksumEntry.Groups['entry'].Value -notmatch "'sha256'\s*=>\s*'$sourceSha256'" -or $checksumEntry.Groups['entry'].Value -notmatch "'size'\s*=>\s*21265451") { throw 'Official author CHECKSUMS does not confirm the pinned Perl archive; build stopped.' }
if (-not (Test-Path -LiteralPath $sourceRoot)) {
    & tar.exe -xzf $archive -C $BuildRoot
    if ($LASTEXITCODE -ne 0) { throw 'Perl source extraction failed.' }
}
foreach ($required in @('README.win32', 'win32/Makefile', 'MANIFEST', 'Artistic', 'Copying')) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $required))) { throw "Official source is incomplete: $required" }
}

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Installed MSVC Build Tools were not found; this script never installs a compiler.' }
$installation = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or -not $installation) { throw 'Installed x64 MSVC tools were not found.' }
$devCmd = Join-Path $installation.Trim() 'Common7/Tools/VsDevCmd.bat'
$devEnvironment = & cmd.exe /d /s /c "call `"$devCmd`" -no_logo -arch=x64 -host_arch=x64 >nul && set"
if ($LASTEXITCODE -ne 0) { throw 'MSVC developer environment could not be initialized.' }
foreach ($line in $devEnvironment) {
    if ($line -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') }
}
foreach ($variable in Get-ChildItem Env: | Where-Object Name -Like 'PERL*') { [Environment]::SetEnvironmentVariable($variable.Name, $null, 'Process') }
foreach ($variable in Get-ChildItem Env: | Where-Object { $_.Name -like 'LC_*' -or $_.Name -eq 'LANG' }) { [Environment]::SetEnvironmentVariable($variable.Name, $null, 'Process') }
$compiler = (Get-Command cl.exe -ErrorAction Stop).Source
$nmake = (Get-Command nmake.exe -ErrorAction Stop).Source
$dumpbin = (Get-Command dumpbin.exe -ErrorAction Stop).Source
$resourceCompiler = (Get-Command rc.exe -ErrorAction Stop).Source
# Restrict only this build process. Avoid other Perl/GCC/toolkit copies on PATH.
$env:PATH = @((Split-Path $compiler), (Split-Path $resourceCompiler), (Join-Path $env:SystemRoot 'System32'), $env:SystemRoot) -join ';'
$env:TEMP = $privateTemp
$env:TMP = $privateTemp
$compilerVersion = (& $compiler /Bv 2>&1 | Out-String).Trim()
$compilerVersion | Set-Content -LiteralPath (Join-Path $BuildRoot 'compiler-version.txt') -Encoding utf8NoBOM
$redistRoot = Join-Path $env:VCToolsRedistDir 'x64/Microsoft.VC143.CRT'
if (-not (Test-Path -LiteralPath $redistRoot)) { throw 'Installed release x64 MSVC redistributable directory was not found.' }
$makeArguments = @('-nologo', 'CCTYPE=MSVC143', "INST_TOP=$installRoot", 'USE_NO_REGISTRY=define', 'DEFAULT_INC_EXCLUDES_DOT=define', 'USE_SITECUST=undef')
function Invoke-NativeBuild([string]$Target, [string]$LogName) {
    $log = Join-Path $BuildRoot $LogName
    Write-Output "Building Perl target '$Target'; log: $log"
    Push-Location (Join-Path $sourceRoot 'win32')
    try {
        & $nmake @makeArguments $Target *> $log
        if ($LASTEXITCODE -ne 0) {
            Get-Content -LiteralPath $log -Tail 45 | Write-Output
            throw "Perl '$Target' build failed (exit $LASTEXITCODE). No runtime validation acceptance was attempted."
        }
    } finally { Pop-Location }
}
if (-not $SkipBuild) {
    Invoke-NativeBuild 'all' 'nmake-build.log'
    Invoke-NativeBuild 'installbare' 'nmake-install.log'
}
foreach ($required in @('bin/perl.exe', 'bin/perl544.dll', 'lib/Config.pm', 'lib/Win32API/File.pm')) {
    if (-not (Test-Path -LiteralPath (Join-Path $installRoot $required))) { throw "The private install is incomplete: $required" }
}

# Each staging attempt is immutable; never delete a prior candidate or receipts.
$stamp = Get-Date -Format 'yyyyMMddTHHmmssfff'
$runtimeRoot = Join-Path $BuildRoot "stages/runtime-$stamp"
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $installRoot 'bin/perl.exe') -Destination (Join-Path $runtimeRoot 'perl.exe')
Copy-Item -LiteralPath (Join-Path $installRoot 'bin/perl544.dll') -Destination (Join-Path $runtimeRoot 'perl544.dll')
Copy-Item -LiteralPath (Join-Path $installRoot 'lib') -Destination (Join-Path $runtimeRoot 'lib') -Recurse
$licenseRoot = Join-Path $runtimeRoot 'licenses'
New-Item -ItemType Directory -Path $licenseRoot -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $sourceRoot 'Artistic') -Destination (Join-Path $licenseRoot 'Perl-Artistic.txt')
Copy-Item -LiteralPath (Join-Path $sourceRoot 'Copying') -Destination (Join-Path $licenseRoot 'Perl-COPYING.txt')
Copy-Item -LiteralPath (Join-Path $sourceRoot 'README') -Destination (Join-Path $licenseRoot 'Perl-README.txt')
$redistList = Join-Path $installation.Trim() 'Licenses/1033/Redist.txt'
if (-not (Test-Path -LiteralPath $redistList)) { throw 'Installed Microsoft redistributable notice was not found.' }
Copy-Item -LiteralPath $redistList -Destination (Join-Path $licenseRoot 'Microsoft-Redist.txt')
$crtLicense = Join-Path $BuildRoot 'Visual-C-Runtime-2015-2022-License-1.docx'
$crtLicenseUrl = 'https://visualstudio.microsoft.com/wp-content/uploads/2021/09/Visual-C-Runtime-2015-2022-License-1.docx'
if (-not (Test-Path -LiteralPath $crtLicense)) { Invoke-WebRequest -Uri $crtLicenseUrl -OutFile $crtLicense }
Copy-Item -LiteralPath $crtLicense -Destination (Join-Path $licenseRoot 'Microsoft-Visual-C-Runtime-License.docx')

$dependencies = @()
$crtCopies = @()
$scanned = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$queue = [Collections.Generic.Queue[string]]::new()
Get-ChildItem -LiteralPath $runtimeRoot -Recurse -File | Where-Object Extension -In '.exe', '.dll' | ForEach-Object { $queue.Enqueue($_.FullName) }
while ($queue.Count) {
    $binary = $queue.Dequeue()
    if (-not $scanned.Add($binary)) { continue }
    $headers = & $dumpbin /nologo /headers $binary 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or $headers -notmatch '(?im)8664 machine \(x64\)') { throw "Runtime binary is not verified x64 PE: $binary" }
    $importsText = & $dumpbin /nologo /dependents $binary 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "Could not inspect runtime dependencies: $binary" }
    $imports = @([regex]::Matches($importsText, '(?im)^\s+([A-Za-z0-9_.+-]+\.dll)\s*$') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
    foreach ($dependency in $imports) {
        if ($dependency -match '(?i)libgcc|libstdc\+\+|libwinpthread|libgmp|libquadmath|^(?:vcruntime|msvcp|concrt).*d\.dll$|^ucrtbased\.dll$') { throw "Forbidden GCC/debug runtime dependency: $dependency" }
        $redistSource = Join-Path $redistRoot $dependency
        if ((Test-Path -LiteralPath $redistSource) -or $dependency -match '(?i)^(vcruntime|msvcp|concrt).*\.dll$') {
            $target = Join-Path $runtimeRoot $dependency
            if (-not (Test-Path -LiteralPath $target)) {
                $original = $redistSource
                if (-not (Test-Path -LiteralPath $original)) { throw "Release MSVC redistributable not found: $dependency" }
                Copy-Item -LiteralPath $original -Destination $target
                $queue.Enqueue($target)
                $crtCopies += [ordered]@{ name = $dependency; source = $original; bytes = (Get-Item -LiteralPath $original).Length; sha256 = (Get-FileHash -LiteralPath $original -Algorithm SHA256).Hash.ToLowerInvariant(); fileVersion = (Get-Item -LiteralPath $original).VersionInfo.FileVersion; signature = (Get-AuthenticodeSignature -LiteralPath $original).Status.ToString() }
            }
        }
    }
    $dependencies += [ordered]@{ binary = [IO.Path]::GetRelativePath($runtimeRoot, $binary).Replace('\', '/'); imports = $imports }
}

# Plain-path relocation validates that the app layout needs no installed Perl,
# compiler/GCC PATH entries, PERL* variables or registry library injection.
$relocationRoot = Join-Path $BuildRoot "relocated/plain-runtime-$stamp"
New-Item -ItemType Directory -Path (Split-Path $relocationRoot) -Force | Out-Null
Copy-Item -LiteralPath $runtimeRoot -Destination $relocationRoot -Recurse
$probe = @'
BEGIN { @INC = ('./lib'); }
use strict; use warnings;
use Config; use JSON::PP (); use Cwd (); use File::Spec (); use IO::File ();
use Encode (); use Digest::SHA (); use Compress::Raw::Zlib ();
use Unicode::Normalize (); use Time::HiRes (); use Win32 (); use Win32API::File ();
die "Unexpected Perl version\n" unless $Config{version} eq '5.44.0';
die "Runtime is not x64\n" unless $Config{ptrsize} == 8;
die "Registry lookup is enabled\n" unless $Config{ccflags} =~ /WIN32_NO_REGISTRY/;
die "Implicit current directory is enabled\n" unless $Config{default_inc_excludes_dot} eq 'define';
die "sitecustomize is enabled\n" if ($Config{usesitecustomize} // '') eq 'define';
print JSON::PP::encode_json({version=>$Config{version},archname=>$Config{archname},ptrsize=>$Config{ptrsize},ccflags=>$Config{ccflags},inc=>\@INC,loaded=>\%INC,win32ApiFileVersion=>$Win32API::File::VERSION}), "\n";
'@
$start = [Diagnostics.ProcessStartInfo]::new((Join-Path $relocationRoot 'perl.exe'))
$start.WorkingDirectory = $relocationRoot
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.Environment.Clear()
$start.Environment['SystemRoot'] = $env:SystemRoot
$start.Environment['WINDIR'] = $env:SystemRoot
$start.Environment['ComSpec'] = Join-Path $env:SystemRoot 'System32/cmd.exe'
$start.Environment['PATH'] = Join-Path $env:SystemRoot 'System32'
$start.Environment['TEMP'] = $privateTemp
$start.Environment['TMP'] = $privateTemp
foreach ($argument in @('-Ilib', '-e', $probe)) { $start.ArgumentList.Add($argument) }
$process = [Diagnostics.Process]::new(); $process.StartInfo = $start
$acceptance = [ordered]@{ scope = 'Relocated plain-path Perl/core XS closure only; root owns ExifTool and Unicode metadata acceptance.'; passed = $false; runtime = $runtimeRoot; relocated = $relocationRoot }
try {
    if (-not $process.Start()) { throw 'Relocated runtime did not start.' }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync(); $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(60000)) { $process.Kill($true); throw 'Relocated runtime probe timed out.' }
    $stdout = $stdoutTask.GetAwaiter().GetResult(); $stderr = $stderrTask.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) { throw "Relocated runtime probe failed (exit $($process.ExitCode)): $stderr" }
    $result = $stdout | ConvertFrom-Json
    if ($stderr.Trim()) { throw "Unexpected stderr from core module probe: $stderr" }
    foreach ($entry in $result.inc) {
        $resolved = [IO.Path]::GetFullPath([IO.Path]::Combine($relocationRoot, [string]$entry))
        if (-not $resolved.StartsWith($relocationRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Relocated Perl searches outside its packaged runtime: $entry" }
    }
    foreach ($module in $result.loaded.PSObject.Properties) {
        $resolved = [IO.Path]::GetFullPath([IO.Path]::Combine($relocationRoot, [string]$module.Value))
        if (-not $resolved.StartsWith($relocationRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Core module came from outside packaged lib: $($module.Name)" }
    }
    $acceptance.passed = $true
    $acceptance.modules = $result
} catch {
    $acceptance.failure = $_.Exception.Message
    $acceptance | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $BuildRoot "runtime-validation-$stamp.json") -Encoding utf8NoBOM
    throw
} finally { $process.Dispose() }
$files = @(Get-ChildItem -LiteralPath $runtimeRoot -Recurse -File | ForEach-Object { [ordered]@{ path = [IO.Path]::GetRelativePath($runtimeRoot, $_.FullName).Replace('\', '/'); bytes = $_.Length; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() } })
$receipt = [ordered]@{
    version = $version; createdAt = (Get-Date).ToUniversalTime().ToString('o'); sourceUrl = $sourceUrl; sourceArchive = $archive; sourceBytes = (Get-Item -LiteralPath $archive).Length; sourceSha256 = $actualHash; sourceHashAuthority = $sourceAnnouncement; officialChecksumsUrl = $checksumsUrl; officialChecksumsSha256 = (Get-FileHash -LiteralPath $checksumsPath -Algorithm SHA256).Hash.ToLowerInvariant();
    compiler = $compiler; compilerVersion = $compilerVersion; toolset = $env:VCToolsVersion; cctype = 'MSVC143'; crt = 'Upstream release /MD; only imported unmodified installed MSVC release redistributables, Windows 10/11 UCRT supplied by OS'; redistRoot = $redistRoot; redistDlls = $crtCopies;
    privateInstall = $installRoot; runtime = $runtimeRoot; recipe = @("nmake $($makeArguments -join ' ') all", "nmake $($makeArguments -join ' ') installbare"); sourcePatched = $false;
    security = @{ registryLookup = 'disabled'; implicitDotInInc = 'disabled'; sitecustomize = 'disabled'; probeEnvironment = 'cleared; Windows system directory only on PATH'; managedInc = "BEGIN { @INC = ('./lib'); }" };
    runtimeLicenseUrl = $crtLicenseUrl; runtimeLicenseSha256 = (Get-FileHash -LiteralPath $crtLicense -Algorithm SHA256).Hash.ToLowerInvariant(); acceptance = $acceptance; dependencies = $dependencies; files = $files;
}
$receiptPath = Join-Path $BuildRoot 'runtime-build-receipt.json'
$receipt | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $receiptPath -Encoding utf8NoBOM
$acceptance | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $BuildRoot "runtime-validation-$stamp.json") -Encoding utf8NoBOM
Write-Output "Perl runtime ready: $runtimeRoot"
Write-Output "Relocation/core XS probe passed. Receipt: $receiptPath"
