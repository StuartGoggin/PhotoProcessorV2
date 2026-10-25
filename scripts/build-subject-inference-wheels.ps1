#Requires -Version 7.0
param([Parameter(Mandatory)][string]$BuildPython)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$subjectRepo = Split-Path -Parent $PSScriptRoot
$subjectWheelRoot = Join-Path $subjectRepo '.build-cache/subject-finishing-evaluation-cpu/wheelhouse'
New-Item -ItemType Directory -Path $subjectWheelRoot -Force | Out-Null
# Only these two reviewed pure-Python upstream source distributions are built.
# All other runtime dependencies must arrive as Windows/pure-Python wheels.
$subjectSources = @(
    @{ name = 'iopath'; version = '0.1.10'; file = 'iopath-0.1.10.tar.gz'; hash = '3311c16a4d9137223e20f141655759933e1eda24f8bff166af834af3c645ef01' },
    @{ name = 'antlr4-python3-runtime'; version = '4.9.3'; file = 'antlr4-python3-runtime-4.9.3.tar.gz'; hash = 'f224469b4168294902bb1efa80a8bf7855f24c99aef99cbefc1bcd3cce77881b' }
)
foreach ($subjectSource in $subjectSources) {
    $subjectMetadata = Invoke-RestMethod -Uri "https://pypi.org/pypi/$($subjectSource.name)/$($subjectSource.version)/json" -TimeoutSec 60
    $subjectArtifact = @($subjectMetadata.urls | Where-Object { $_.filename -eq $subjectSource.file })
    if ($subjectArtifact.Count -ne 1 -or $subjectArtifact[0].digests.sha256 -ne $subjectSource.hash) {
        throw 'Reviewed source hash does not match publisher metadata.'
    }
    $subjectUri = "$($subjectArtifact[0].url)#sha256=$($subjectSource.hash)"
    & $BuildPython -m pip wheel --no-deps --no-cache-dir --disable-pip-version-check --wheel-dir $subjectWheelRoot $subjectUri
    if ($LASTEXITCODE -ne 0) { throw 'Controlled pure-Python inference wheel build failed.' }
}
Get-ChildItem -LiteralPath $subjectWheelRoot -Filter '*.whl' -File | Get-FileHash -Algorithm SHA256
