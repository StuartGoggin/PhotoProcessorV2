#Requires -Version 7.0
[CmdletBinding()]
param([ValidateSet('Configure','Build')][string]$Stage='Configure')
$ErrorActionPreference='Stop'
$root=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$base=Join-Path $root 'test-output\ffmpeg-row-backport'
$posixBase=$base.Replace('\','/')
$runner=Join-Path $PSScriptRoot 'invoke-native-build.ps1'
$nativePaths=@(
    'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207\bin\Hostx64\x64',
    "$base\nasm-2.16.03", "$base\make-4.4.1\WinRel", 'C:\Program Files\Git\usr\bin'
)
$buildEnvironment=@{PKG_CONFIG_PATH="$posixBase/prefix/lib/pkgconfig";SHELL='C:/Program Files/Git/usr/bin/sh.exe'}
if($Stage -eq 'Configure') {
    $configureArgs=@('--noprofile','--norc','../ffmpeg-source/configure',
        '--toolchain=msvc','--arch=x86_64','--target-os=win64','--enable-gpl',
        '--enable-libx264','--enable-libvidstab','--enable-libfreetype','--enable-libharfbuzz','--enable-libdav1d',
        '--enable-libvpl','--enable-ffnvcodec','--enable-nvenc','--enable-d3d11va','--enable-dxva2',
        '--enable-zlib','--enable-schannel','--disable-debug','--disable-doc','--disable-ffplay',
        '--disable-autodetect','--pkg-config=../pkgconf-build/Release/pkgconf.exe',
        "--pkg-config-flags=--static --personality=$($PSScriptRoot.Replace('\','/'))/pkgconf-msvc/static.personality",
        "--extra-cflags=-MD -GS -I$posixBase/prefix/include", '--extra-cxxflags=-MD -GS', "--extra-ldflags=-libpath:$posixBase/prefix/lib",
        '--extra-version=PhotoGoGo-rowtest1',"--prefix=$posixBase/ffmpeg-install")
    & $runner -WorkingDirectory "$base\ffmpeg-build" -File 'C:\Program Files\Git\bin\bash.exe' -Arguments $configureArgs -ExtraPath $nativePaths -ExtraEnvironment $buildEnvironment -LogName configure-ffmpeg -VisualStudio -TimeoutSeconds 900 -MinimumFreeMiB 768
} else {
    # Git Bash emits MSYS /c paths; native Windows Make cannot resolve them.
    # Normalize only generated source-root references, not upstream source.
    $msysSource='/' + $posixBase.Substring(0,1).ToLowerInvariant() + $posixBase.Substring(2) + '/ffmpeg-source'
    foreach($generated in @('Makefile','ffbuild/config.mak')) {
        $path=Join-Path "$base\ffmpeg-build" $generated
        $content=[IO.File]::ReadAllText($path)
        [IO.File]::WriteAllText($path,$content.Replace($msysSource,'../ffmpeg-source'),[Text.UTF8Encoding]::new($false))
    }
    & $runner -WorkingDirectory "$base\ffmpeg-build" -File "$base\make-4.4.1\WinRel\gnumake.exe" -Arguments @('-j2','SHELL=sh.exe','ffmpeg.exe','ffprobe.exe') -ExtraPath $nativePaths -ExtraEnvironment $buildEnvironment -LogName build-ffmpeg -VisualStudio -TimeoutSeconds 1800 -MinimumFreeMiB 512
}
