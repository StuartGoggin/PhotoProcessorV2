#Requires -Version 7.0
param([string]$FixtureDirectory='test-output/subject-picture-startup-v1')
$ErrorActionPreference='Stop'
$startupRepo=Split-Path -Parent $PSScriptRoot
$startupTarget=[IO.Path]::GetFullPath((Join-Path $startupRepo $FixtureDirectory))
$startupAllowed=[IO.Path]::GetFullPath((Join-Path $startupRepo 'test-output'))+[IO.Path]::DirectorySeparatorChar
if (-not $startupTarget.StartsWith($startupAllowed,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $startupTarget)) {throw 'New isolated fixture directory required.'}
$startupVsWhere=Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$startupInstallation=& $startupVsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or -not $startupInstallation) {throw 'Existing build toolchain required.'}
$startupDevCmd=Join-Path $startupInstallation.Trim() 'Common7/Tools/VsDevCmd.bat'
$startupEnvironment=& cmd.exe /d /s /c "call `"$startupDevCmd`" -no_logo -arch=x64 -host_arch=x64 >nul && set"
if ($LASTEXITCODE -ne 0) {throw 'Cannot initialize existing MSVC.'}
foreach ($startupLine in $startupEnvironment) {
 if ($startupLine -match '^([^=]+)=(.*)$') {[Environment]::SetEnvironmentVariable($Matches[1],$Matches[2],'Process')}
}
New-Item -ItemType Directory -Path $startupTarget | Out-Null
$startupExe=Join-Path $startupTarget 'StartupFailureFixture.exe'
& cl.exe /nologo /std:c++17 /O2 /EHsc /W4 /WX /MT /DNOMINMAX (Join-Path $startupRepo 'src-tauri/native/subject_picture_handoff/startup_fixture.cpp') "/Fo$startupTarget/" "/Fe$startupExe" /link /DYNAMICBASE /NXCOMPAT
if ($LASTEXITCODE -ne 0) {throw 'Fixture compilation failed.'}
foreach ($startupBoundary in @('assignment','resume')) {
 & $startupExe $startupBoundary
 if ($LASTEXITCODE -ne 0) {throw "Owned startup cleanup failed at $startupBoundary."}
}
