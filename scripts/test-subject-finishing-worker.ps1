#Requires -Version 7.0
param([string]$WorkerPath = (Join-Path $PSScriptRoot '../src-tauri/tools/subject-finishing/photogogo-subject-finishing.exe'))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not (Test-Path -LiteralPath $WorkerPath -PathType Leaf)) { throw 'Subject finishing worker has not been built.' }
$subjectProbe = (& $WorkerPath --probe | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0 -or $subjectProbe.schema -ne 1) { throw 'Invalid subject finishing hardware probe.' }
if (-not $subjectProbe.available) { throw 'Hardware D3D11 acceptance requires a capable adapter, not a software fallback.' }
$subjectTest = (& $WorkerPath --self-test | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0 -or $subjectTest.schema -ne 1 -or -not $subjectTest.cpuGpuExact -or $subjectTest.frames -lt 3) {
    throw 'Subject finishing CPU/GPU parity failed.'
}
[pscustomobject]@{ probe = $subjectProbe; validation = $subjectTest } | ConvertTo-Json -Depth 4
