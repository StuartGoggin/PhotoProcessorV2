#Requires -Version 7.0
param([Parameter(Mandatory)][string]$BuildPython,[switch]$Acquire)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$subjectRepo=Split-Path -Parent $PSScriptRoot
$subjectInputs=Join-Path $subjectRepo '.build-cache/subject-finishing-evaluation-cpu'
$subjectRoot=Join-Path $subjectRepo '.build-cache/subject-finishing-manual-cpu-v1'
$subjectRuntime=Join-Path $subjectRoot 'runtime'
$subjectWheels=Join-Path $subjectRoot 'wheelhouse'
if (Test-Path -LiteralPath $subjectRuntime) { throw 'Manual runtime already exists; it will not be overwritten.' }
if (-not (Test-Path -LiteralPath $BuildPython -PathType Leaf)) { throw 'Exact trusted build Python is required.' }
if ((Get-PSDrive -Name ([IO.Path]::GetPathRoot($subjectRepo).Substring(0,1))).Free -lt 7GB) {
    throw 'The fresh profile needs 7 GiB remaining, including preserved build/output reserve.'
}
$subjectBuilder=& $BuildPython -I -c 'import json,sys,pip; print(json.dumps({"python":sys.version.split()[0],"pip":pip.__version__}))'
if ($LASTEXITCODE -ne 0) { throw 'Could not identify the build interpreter.' }
$subjectBuilderInfo=$subjectBuilder | ConvertFrom-Json
if ($subjectBuilderInfo.python -ne '3.12.14' -or $subjectBuilderInfo.pip -ne '26.2.1') {
    throw 'This qualification recipe requires reviewed build Python 3.12.14 and pip 26.2.1; no tool upgrade is performed.'
}
$subjectSpec=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'subject-finishing/runtime/wheels-manual-cpu.json') -Raw | ConvertFrom-Json
$subjectLock=Join-Path $PSScriptRoot 'subject-finishing/runtime/requirements-manual-cpu.lock'
$subjectLines=@(Get-Content -LiteralPath $subjectLock | Where-Object { $_ -and -not $_.StartsWith('#') })
if ($subjectSpec.schema -ne 1 -or $subjectSpec.profile -ne 'manual-video-cpu-v1' -or $subjectSpec.wheels.Count -ne 21 -or $subjectLines.Count -ne 21) {
    throw 'Expected the fixed 21-package manual video profile.'
}
foreach ($subjectWheel in $subjectSpec.wheels) {
    if ($subjectWheel.file -notmatch '^[A-Za-z0-9_.+-]+\.whl$' -or $subjectWheel.sha256 -notmatch '^[a-f0-9]{64}$' -or
        "$($subjectWheel.name)==$($subjectWheel.version) --hash=sha256:$($subjectWheel.sha256)" -notin $subjectLines) {
        throw 'Wheel provenance and offline requirement lock differ.'
    }
}
New-Item -ItemType Directory -Path $subjectRoot,$subjectWheels -Force | Out-Null
foreach ($subjectWheel in $subjectSpec.wheels) {
    $subjectTarget=Join-Path $subjectWheels $subjectWheel.file
    if (-not (Test-Path -LiteralPath $subjectTarget)) {
        $subjectPending=$subjectTarget+'.download'
        if (Test-Path -LiteralPath $subjectPending) { throw 'An interrupted wheel download was preserved; inspect it before retrying acquisition.' }
        if ($subjectWheel.PSObject.Properties.Name -contains 'localArtifact') {
            Copy-Item -LiteralPath (Join-Path (Join-Path $subjectRepo '.build-cache') $subjectWheel.localArtifact) -Destination $subjectPending
        } else {
            if (-not $Acquire) { throw "Missing exact wheel $($subjectWheel.file); use -Acquire for its allowlisted publisher URL." }
            $subjectUri=[uri]$subjectWheel.url
            if ($subjectUri.Scheme -ne 'https' -or $subjectUri.Host -notin @('files.pythonhosted.org','download.pytorch.org')) { throw 'Unexpected wheel publisher.' }
            Write-Output "Acquiring fixed wheel $($subjectWheel.file)"
            Invoke-WebRequest -Uri $subjectUri -OutFile $subjectPending -TimeoutSec 120
        }
        if ((Get-FileHash -LiteralPath $subjectPending -Algorithm SHA256).Hash.ToLowerInvariant() -ne $subjectWheel.sha256) {
            throw 'Wheel hash mismatch; payload was retained and will not be executed.'
        }
        Move-Item -LiteralPath $subjectPending -Destination $subjectTarget
    }
    if ((Get-FileHash -LiteralPath $subjectTarget -Algorithm SHA256).Hash.ToLowerInvariant() -ne $subjectWheel.sha256) { throw 'Cached wheel changed; no replacement is allowed.' }
}
function Get-SubjectVerifiedInput([string]$Relative,[string]$Expected) {
    $subjectPath=Join-Path $subjectInputs $Relative
    if ((Get-FileHash -LiteralPath $subjectPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Expected) { throw "Input hash mismatch: $Relative" }
    return $subjectPath
}
$subjectPythonZip=Get-SubjectVerifiedInput 'python-3.13.16-embed-amd64.zip' '97dae5274cc54867065e8d5a3226e48c35017ed332a0fdb0e27d5b5821961297'
$subjectSamZip=Get-SubjectVerifiedInput 'sam2-2b90b9f5ceec907a1c18123530e92e794ad901a4.zip' 'fe93082a71a885a427894b1eab76341768781b6b58a298a0717e03862097d137'
$subjectSamModel=Get-SubjectVerifiedInput 'models/sam2.1_hiera_tiny.pt' '7402e0d864fa82708a20fbd15bc84245c2f26dff0eb43a4b5b93452deb34be69'
$subjectPending=Join-Path $subjectRoot ('pending-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $subjectPending | Out-Null
Expand-Archive -LiteralPath $subjectPythonZip -DestinationPath $subjectPending
$subjectPackages=Join-Path $subjectPending 'Lib/site-packages'
$subjectReport=Join-Path $subjectPending 'resolved-manual-packages.json'
& $BuildPython -I -m pip install --target $subjectPackages --python-version 3.13 --implementation cp --abi cp313 --platform win_amd64 --only-binary=:all: --no-index --find-links $subjectWheels --require-hashes --no-compile --no-cache-dir --disable-pip-version-check --no-warn-script-location --report $subjectReport -r $subjectLock
if ($LASTEXITCODE -ne 0) { throw "Offline locked provisioning failed. Candidate preserved at $subjectPending" }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'subject-finishing/runtime/python313-manual._pth') -Destination (Join-Path $subjectPending 'python313._pth')
$subjectResolved=Get-Content -LiteralPath $subjectReport -Raw | ConvertFrom-Json
if ($subjectResolved.install.Count -ne 21) { throw 'Offline resolver did not produce the exact reviewed closure.' }
foreach ($subjectPackage in $subjectResolved.install) {
    $subjectMatch=@($subjectSpec.wheels | Where-Object { $_.name -eq $subjectPackage.metadata.name -and $_.version -eq $subjectPackage.metadata.version })
    if ($subjectMatch.Count -ne 1 -or $subjectPackage.download_info.archive_info.hashes.sha256 -ne $subjectMatch[0].sha256) { throw 'Resolved package identity differs from the lock.' }
}
$subjectVendor=Join-Path $subjectRoot 'vendor'
$subjectModels=Join-Path $subjectRoot 'models'
New-Item -ItemType Directory -Path $subjectVendor,$subjectModels -Force | Out-Null
Copy-Item -LiteralPath $subjectSamZip -Destination (Join-Path $subjectRoot (Split-Path -Leaf $subjectSamZip))
Copy-Item -LiteralPath $subjectSamModel -Destination (Join-Path $subjectModels 'sam2.1_hiera_tiny.pt')
$subjectArchive=[IO.Compression.ZipFile]::OpenRead($subjectSamZip)
try {
    foreach ($subjectEntry in $subjectArchive.Entries) {
        $subjectPrefix='sam2-2b90b9f5ceec907a1c18123530e92e794ad901a4/'
        if (-not $subjectEntry.FullName.StartsWith($subjectPrefix,[StringComparison]::Ordinal)) { throw 'Unexpected verified source root.' }
        $subjectRelative=$subjectEntry.FullName.Substring($subjectPrefix.Length)
        if (-not (($subjectRelative.StartsWith('sam2/',[StringComparison]::Ordinal) -and ($subjectRelative.EndsWith('.py') -or $subjectRelative.EndsWith('.yaml'))) -or $subjectRelative -in @('LICENSE','LICENSE_cctorch'))) { continue }
        $subjectTarget=[IO.Path]::GetFullPath((Join-Path $subjectVendor $subjectRelative))
        if (-not $subjectTarget.StartsWith([IO.Path]::GetFullPath($subjectVendor)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Source path escaped the candidate vendor tree.' }
        New-Item -ItemType Directory -Path (Split-Path -Parent $subjectTarget) -Force | Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($subjectEntry,$subjectTarget,$false)
    }
} finally { $subjectArchive.Dispose() }
$subjectPython=Join-Path $subjectPending 'python.exe'
& $subjectPython -I -S -B -c 'import sys,json,torch,numpy,PIL,hydra,iopath,importlib.metadata as m; assert "site" not in sys.modules and "_distutils_hack" not in sys.modules; assert sys.version_info[:3]==(3,13,16); assert torch.__version__=="2.14.1+cpu"; assert torch.version.cuda is None; assert m.version("hydra-core")=="1.3.7"; assert m.version("iopath")=="0.1.10"; assert len(list(m.distributions()))==21; print(json.dumps({"profile":"manual-video-cpu-v1","packages":21,"cuda":False,"startupHooks":False,"qualificationCandidate":True}))'
if ($LASTEXITCODE -ne 0) { throw "Minimal native runtime import failed; candidate preserved at $subjectPending" }
Move-Item -LiteralPath $subjectPending -Destination $subjectRuntime
Write-Output "Fresh 21-package qualification candidate: $subjectRoot"
Write-Output 'Not release ready: complete pre-launch file seal, notices/source closure, real video acceptance and installer validation remain required.'
