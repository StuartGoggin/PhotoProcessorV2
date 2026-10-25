#Requires -Version 7.0
param([string]$FixtureDirectory='test-output/subject-picture-gui-v1')
$ErrorActionPreference='Stop'
$guiRepo=Split-Path -Parent $PSScriptRoot
$guiTarget=[IO.Path]::GetFullPath((Join-Path $guiRepo $FixtureDirectory))
$guiAllowed=[IO.Path]::GetFullPath((Join-Path $guiRepo 'test-output'))+[IO.Path]::DirectorySeparatorChar
if (-not $guiTarget.StartsWith($guiAllowed,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $guiTarget)) {throw 'New isolated GUI fixture directory required.'}
$guiVsWhere=Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$guiInstallation=& $guiVsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
$guiDevCmd=Join-Path $guiInstallation.Trim() 'Common7/Tools/VsDevCmd.bat'
$guiEnvironment=& cmd.exe /d /s /c "call `"$guiDevCmd`" -no_logo -arch=x64 -host_arch=x64 >nul && set"
if ($LASTEXITCODE -ne 0) {throw 'Cannot initialize existing MSVC.'}
foreach ($guiLine in $guiEnvironment) {if ($guiLine -match '^([^=]+)=(.*)$') {[Environment]::SetEnvironmentVariable($Matches[1],$Matches[2],'Process')}}
New-Item -ItemType Directory -Path $guiTarget | Out-Null
$guiExe=Join-Path $guiTarget 'OwnedGuiFixture.exe'
& cl.exe /nologo /std:c++17 /O2 /EHsc /W4 /WX /MT /DUNICODE /D_UNICODE /DNOMINMAX (Join-Path $guiRepo 'src-tauri/native/subject_picture_handoff/gui_fixture.cpp') "/Fo$guiTarget/" "/Fe$guiExe" /link d3d11.lib dxgi.lib d3dcompiler.lib bcrypt.lib user32.lib gdi32.lib shell32.lib ole32.lib uuid.lib /DYNAMICBASE /NXCOMPAT /DEPENDENTLOADFLAG:0x800
if ($LASTEXITCODE -ne 0) {throw 'Owned hidden GUI fixture compilation failed.'}
& $guiExe
if ($LASTEXITCODE -ne 0) {throw 'Owned hidden GUI terminal transition failed.'}
