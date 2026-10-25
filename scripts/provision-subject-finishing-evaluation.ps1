#Requires -Version 7.0
param([Parameter(Mandatory)][string]$BuildPython)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$subjectRepo = Split-Path -Parent $PSScriptRoot
$subjectRoot = Join-Path $subjectRepo '.build-cache/subject-finishing-evaluation-cpu'
$subjectRuntime = Join-Path $subjectRoot 'runtime'
if (Test-Path -LiteralPath $subjectRuntime) {
    throw 'Evaluation runtime already exists. Inspect it or choose a fresh reviewed build; this script never overwrites a runtime.'
}
if (-not (Test-Path -LiteralPath $BuildPython -PathType Leaf)) { throw 'A trusted build Python executable is required.' }
$subjectDrive = Get-PSDrive -Name ([System.IO.Path]::GetPathRoot($subjectRepo).Substring(0, 1))
if ($subjectDrive.Free -lt 6GB) { throw 'At least 6 GiB free is required for this bounded CPU evaluation, preserving build/output reserve.' }
New-Item -ItemType Directory -Path $subjectRoot -Force | Out-Null
$subjectZip = Join-Path $subjectRoot 'python-3.13.16-embed-amd64.zip'
$subjectPythonHash = '97dae5274cc54867065e8d5a3226e48c35017ed332a0fdb0e27d5b5821961297'
if (-not (Test-Path -LiteralPath $subjectZip)) {
    Write-Output 'Acquiring the pinned private Python interpreter (11.4 MB); no system installation.'
    Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/3.13.16/python-3.13.16-embed-amd64.zip' -OutFile $subjectZip -TimeoutSec 120
}
if ((Get-FileHash -LiteralPath $subjectZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $subjectPythonHash) {
    throw 'Python publisher hash mismatch. Nothing will be executed or extracted.'
}
$subjectPending = Join-Path $subjectRoot ('pending-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $subjectPending | Out-Null
Expand-Archive -LiteralPath $subjectZip -DestinationPath $subjectPending
$subjectPackages = Join-Path $subjectPending 'Lib/site-packages'
$subjectRequirements = Join-Path $PSScriptRoot 'subject-finishing/runtime/requirements-cpu-evaluation.txt'
$subjectReport = Join-Path $subjectPending 'resolved-evaluation-packages.json'
$subjectWheelhouse = Join-Path $subjectRoot 'wheelhouse'
Write-Output 'Resolving the narrow CPU evaluation dependencies into a private directory; no CUDA payload, user site or global packages.'
& $BuildPython -m pip install --target $subjectPackages --python-version 3.13 --implementation cp --abi cp313 --platform win_amd64 --only-binary=:all: --find-links $subjectWheelhouse --no-compile --no-cache-dir --disable-pip-version-check --no-warn-script-location --report $subjectReport -r $subjectRequirements
if ($LASTEXITCODE -ne 0) { throw "CPU evaluation provisioning failed. Partial data retained for inspection at $subjectPending" }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'subject-finishing/runtime/python313._pth') -Destination (Join-Path $subjectPending 'python313._pth')
$subjectPython = Join-Path $subjectPending 'python.exe'
& $subjectPython -I -c 'import json, sys, torch, torchvision, numpy, PIL, hydra, iopath, transformers, importlib.metadata as m; assert hydra.__version__ == "1.3.7"; assert m.version("iopath") == "0.1.10"; print(json.dumps({"python":sys.version.split()[0],"torch":torch.__version__,"torchvision":torchvision.__version__,"transformers":transformers.__version__,"hydra":hydra.__version__,"cuda":torch.version.cuda,"evaluationOnly":True}))'
if ($LASTEXITCODE -ne 0) { throw "Native Windows CPU import failed. Partial runtime retained at $subjectPending" }
Move-Item -LiteralPath $subjectPending -Destination $subjectRuntime
Write-Output "Private CPU evaluation runtime ready: $subjectRuntime"
Write-Output 'This is not a release runtime: transitive hash lock, advisories, DLL/licence closure and real model tests remain required.'
