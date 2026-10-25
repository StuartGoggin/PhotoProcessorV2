#Requires -Version 7.0
param([string]$CandidateDirectory='test-output/subject-picture-handoff-v5',[string]$StagingJunctionFixture='',[switch]$StagingOnly)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$pictureRepo=Split-Path -Parent $PSScriptRoot
$pictureCandidate=[IO.Path]::GetFullPath((Join-Path $pictureRepo $CandidateDirectory))
$pictureAllowed=[IO.Path]::GetFullPath((Join-Path $pictureRepo 'test-output'))+[IO.Path]::DirectorySeparatorChar
if (-not $pictureCandidate.StartsWith($pictureAllowed,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $pictureCandidate)) {
    throw 'Choose a new candidate directory within the isolated test-output; retained artifacts are never overwritten.'
}
function Assert-PictureOrdinary([string]$Path) {
    $picturePart=[IO.Path]::GetFullPath($Path)
    while ($picturePart) {
        if (Test-Path -LiteralPath $picturePart) {
            $pictureItem=Get-Item -LiteralPath $picturePart -Force
            if ($pictureItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {throw 'Reparse paths are not admitted.'}
        }
        $pictureNext=Split-Path -Parent $picturePart
        if ($pictureNext -eq $picturePart) {break}
        $picturePart=$pictureNext
    }
}
Assert-PictureOrdinary $pictureCandidate
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class PictureBuildLease {
    [StructLayout(LayoutKind.Sequential)] private struct Info {
        public uint attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME created,accessed,written;
        public uint volume,sizeHigh,sizeLow,links,indexHigh,indexLow;
    }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    private static extern SafeFileHandle CreateFileW(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle file,out Info info);
    public static SafeFileHandle Open(string path,bool directory) {
        var handle=CreateFileW(path,0x80000000,1,IntPtr.Zero,3,directory?0x02200000u:0x00200000u,IntPtr.Zero);
        Info info;
        if(handle.IsInvalid || !GetFileInformationByHandle(handle,out info) || (info.attributes&0x400)!=0 ||
            ((info.attributes&0x10)!=0)!=directory) {
            handle.Dispose();throw new InvalidOperationException("Ordinary staging/input lease refused; possible redirection or concurrent writer.");
        }
        return handle;
    }
}
'@
$pictureDirectoryLeases=[Collections.Generic.Dictionary[string,Microsoft.Win32.SafeHandles.SafeFileHandle]]::new([StringComparer]::OrdinalIgnoreCase)
function Protect-PictureDirectory([string]$Path,[bool]$Create=$false) {
    $pictureAbsolute=[IO.Path]::GetFullPath($Path)
    $pictureRoot=[IO.Path]::GetPathRoot($pictureAbsolute)
    $pictureParts=@($pictureRoot)
    $pictureCurrent=$pictureRoot
    foreach ($pictureSegment in $pictureAbsolute.Substring($pictureRoot.Length).Split([IO.Path]::DirectorySeparatorChar,[StringSplitOptions]::RemoveEmptyEntries)) {
        $pictureCurrent=Join-Path $pictureCurrent $pictureSegment
        $pictureParts+=$pictureCurrent
    }
    foreach ($pictureDirectory in $pictureParts) {
        if ($pictureDirectoryLeases.ContainsKey($pictureDirectory)) {continue}
        if (-not [IO.Directory]::Exists($pictureDirectory)) {
            if (-not $Create) {throw 'An ordinary existing source directory is required.'}
            # The immediate parent has already been leased. This creates one
            # segment, then pins it before any subsequent descendant is used.
            [IO.Directory]::CreateDirectory($pictureDirectory) | Out-Null
        }
        $pictureDirectoryLeases.Add($pictureDirectory,[PictureBuildLease]::Open($pictureDirectory,$true))
    }
}
$pictureSources=@('src-tauri/native/subject_picture_handoff/main.cpp','src-tauri/native/subject_picture_handoff/payload.h',
    'src-tauri/native/subject_picture_handoff/supervisor.h','src-tauri/native/subject_picture_handoff/issued_request.h',
    'src-tauri/native/subject_picture_handoff/report_bundle.h','src-tauri/native/subject_picture_handoff/session.h',
    'src-tauri/native/subject_picture_handoff/gui.h','src-tauri/native/subject_finishing/core.h',
    'src-tauri/native/subject_finishing/gpu.h','src-tauri/native/subject_finishing/shaders.h',
    'src-tauri/native/subject_finishing/mask_cache.h','src-tauri/native/subject_finishing/process_owner.h',
    'src-tauri/native/subject_finishing/media_contract.h','src-tauri/native/subject_finishing/media_pipeline.h',
    'scripts/build-subject-picture-handoff.ps1')
$pictureLeases=[Collections.Generic.List[IO.FileStream]]::new()
try {
    $picturePins=@($pictureSources | ForEach-Object {
        $pictureSource=Join-Path $pictureRepo $_
        Assert-PictureOrdinary $pictureSource
        Protect-PictureDirectory (Split-Path -Parent $pictureSource)
        $pictureLease=[IO.FileStream]::new([PictureBuildLease]::Open($pictureSource,$false),[IO.FileAccess]::Read)
        $pictureLeases.Add($pictureLease)
        $pictureHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($pictureLease)).ToLowerInvariant()
        $pictureLease.Position=0
        [pscustomobject]@{path=$_;sha256=$pictureHash}
    })
    $pictureHeader=Get-Content -LiteralPath (Join-Path $pictureRepo $pictureSources[1]) -Raw
    $picturePayload=@([regex]::Matches($pictureHeader,'\{L"([a-zA-Z0-9_./-]+)",(\d+),"([a-f0-9]{64})"\},') | ForEach-Object {
        [pscustomobject]@{path=$_.Groups[1].Value;bytes=[long]$_.Groups[2].Value;sha256=$_.Groups[3].Value}
    })
    if ($picturePayload.Count -ne 35) {throw 'The complete fixed 35-file media/source/sample payload is required.'}
    Protect-PictureDirectory (Split-Path -Parent $pictureCandidate)
    $pictureClaim=[IO.File]::Open($pictureCandidate+'.build-claim',[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    $pictureClaim.Dispose()
    Protect-PictureDirectory $pictureCandidate $true
    if ($StagingJunctionFixture) {
        $pictureFixture=[IO.Path]::GetFullPath($StagingJunctionFixture)
        if (-not $StagingOnly -or -not $pictureFixture.StartsWith($pictureAllowed,[StringComparison]::OrdinalIgnoreCase) -or
            -not [IO.Directory]::Exists($pictureFixture) -or @(Get-ChildItem -LiteralPath $pictureFixture -Force).Count) {
            throw 'Junction injection is confined to an empty, isolated staging-only fixture.'
        }
        Protect-PictureDirectory $pictureFixture
        New-Item -ItemType Junction -Path (Join-Path $pictureCandidate 'media') -Target $pictureFixture | Out-Null
    }
    Protect-PictureDirectory (Join-Path $pictureCandidate 'bin') $true
    Protect-PictureDirectory (Join-Path $pictureCandidate 'objects') $true
    $pictureSamples=Join-Path $pictureRepo 'test-output/subject-footage-evaluation-1791597148390'
    $pictureMedia='C:\creations\PhotoGoGoV2\src-tauri\tools\ffmpeg'
    foreach ($picturePin in $picturePayload) {
        if ($picturePin.path.StartsWith('media/')) {$pictureSource=Join-Path $pictureMedia $picturePin.path.Substring(6)}
        elseif ($picturePin.path.StartsWith('source/')) {
            $pictureSource='C:\creations\PhotoGoGoV2\test-output\media-delivery\PhotoGoGo-FFmpeg-rowtest1-source.tar.gz'
        } elseif ($picturePin.path -match '^samples/(black-horse|white-horse)/(base\.mp4|masks\.pgmask|manifest\.json)$') {
            $pictureSampleName=$Matches[1]
            $pictureSampleFile=if ($Matches[2] -eq 'base.mp4') {'bounded-normalized-excerpt.mp4'} else {'masks.partial/'+$Matches[2]}
            $pictureSource=Join-Path (Join-Path $pictureSamples $pictureSampleName) $pictureSampleFile
        } else {throw 'Unexpected fixed payload path.'}
        Assert-PictureOrdinary $pictureSource
        Protect-PictureDirectory (Split-Path -Parent $pictureSource)
        $pictureInput=[IO.FileStream]::new([PictureBuildLease]::Open($pictureSource,$false),[IO.FileAccess]::Read)
        try {
            if ($pictureInput.Length -ne $picturePin.bytes -or
                [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($pictureInput)).ToLowerInvariant() -ne $picturePin.sha256) {
                throw 'Retained payload does not match the fixed inventory; no substitution or download is allowed.'
            }
            $pictureInput.Position=0
            $pictureTarget=Join-Path $pictureCandidate $picturePin.path
            Protect-PictureDirectory (Split-Path -Parent $pictureTarget) $true
            $pictureOutput=[IO.File]::Open($pictureTarget,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read)
            try {
                $pictureInput.CopyTo($pictureOutput)
                $pictureOutput.Flush($true)
                $pictureOutput.Position=0
                if ($pictureOutput.Length -ne $picturePin.bytes -or
                    [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($pictureOutput)).ToLowerInvariant() -ne $picturePin.sha256) {
                    throw 'Copied payload read-back failed.'
                }
            } finally {$pictureOutput.Dispose()}
        } finally {$pictureInput.Dispose()}
    }
    if ($StagingOnly) {Write-Output 'Fixed payload staging passed; no native build, receipt or delivery qualification.';return}
    $pictureVsWhere=Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    $pictureInstallation=& $pictureVsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($LASTEXITCODE -ne 0 -or -not $pictureInstallation) {throw 'Existing MSVC/SDK required on the build PC only; nothing is installed.'}
    $pictureDevCmd=Join-Path $pictureInstallation.Trim() 'Common7/Tools/VsDevCmd.bat'
    $pictureEnvironment=& cmd.exe /d /s /c "call `"$pictureDevCmd`" -no_logo -arch=x64 -host_arch=x64 >nul && set"
    if ($LASTEXITCODE -ne 0) {throw 'Cannot initialize existing MSVC.'}
    foreach ($pictureLine in $pictureEnvironment) {
        if ($pictureLine -match '^([^=]+)=(.*)$') {[Environment]::SetEnvironmentVariable($Matches[1],$Matches[2],'Process')}
    }
    $pictureExecutable=Join-Path $pictureCandidate 'bin/PhotoGoGo-Cached-Picture-Test.exe'
    $pictureObjects=Join-Path $pictureCandidate 'objects'
    & cl.exe /nologo /std:c++17 /O2 /EHsc /W4 /WX /MT /DUNICODE /D_UNICODE /DNOMINMAX (Join-Path $pictureRepo $pictureSources[0]) "/Fo$pictureObjects/" "/Fe$pictureExecutable" /link d3d11.lib dxgi.lib d3dcompiler.lib bcrypt.lib user32.lib gdi32.lib shell32.lib ole32.lib uuid.lib /DYNAMICBASE /NXCOMPAT /DEPENDENTLOADFLAG:0x800
    if ($LASTEXITCODE -ne 0) {throw 'Native cached-picture compilation failed; this retained candidate is not validated.'}
    for ($pictureIndex=0;$pictureIndex -lt $pictureLeases.Count;$pictureIndex++) {
        $pictureLeases[$pictureIndex].Position=0
        if ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($pictureLeases[$pictureIndex])).ToLowerInvariant() -ne $picturePins[$pictureIndex].sha256) {
            throw 'Source changed during build; no bound receipt was published.'
        }
    }
    $pictureReceipt=[ordered]@{schema=1;kind='native-cached-picture-handoff-build';sources=$picturePins;payload=$picturePayload;
        executable=@{path='bin/PhotoGoGo-Cached-Picture-Test.exe';sha256=(Get-FileHash -LiteralPath $pictureExecutable -Algorithm SHA256).Hash.ToLowerInvariant()};
        testFaultsEnabled=$false;compileOptions=@('/std:c++17','/O2','/EHsc','/W4','/WX','/MT','/DNOMINMAX','/DYNAMICBASE','/NXCOMPAT','/DEPENDENTLOADFLAG:0x800');
        cudaInferenceReady=$false;subjectQualityAccepted=$false;productionExportQualified=$false;deliveryQualified=$false}
    $pictureReceiptBytes=[Text.Encoding]::UTF8.GetBytes(($pictureReceipt | ConvertTo-Json -Depth 6))
    $pictureReceiptStream=[IO.File]::Open((Join-Path $pictureCandidate 'build-receipt.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read)
    try {
        $pictureReceiptStream.Write($pictureReceiptBytes);$pictureReceiptStream.Flush($true);$pictureReceiptStream.Position=0
        if ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($pictureReceiptStream)) -ne
            [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($pictureReceiptBytes))) {throw 'Build receipt read-back failed.'}
    } finally {$pictureReceiptStream.Dispose()}
    Write-Output "Built fixed cached-picture candidate: $pictureExecutable (not a qualified delivery or release)."
} finally {
    foreach ($pictureLease in $pictureLeases) {$pictureLease.Dispose()}
    foreach ($pictureDirectoryLease in $pictureDirectoryLeases.Values) {$pictureDirectoryLease.Dispose()}
}
