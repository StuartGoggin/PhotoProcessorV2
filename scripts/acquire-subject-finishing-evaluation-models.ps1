#Requires -Version 7.0
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$subjectRepo = Split-Path -Parent $PSScriptRoot
$subjectRoot = Join-Path $subjectRepo '.build-cache/subject-finishing-evaluation-cpu'
$subjectModels = Join-Path $subjectRoot 'models'
$subjectVendor = Join-Path $subjectRoot 'vendor'
New-Item -ItemType Directory -Path $subjectModels, $subjectVendor -Force | Out-Null
if ((Get-PSDrive -Name ([IO.Path]::GetPathRoot($subjectRepo).Substring(0, 1))).Free -lt 5GB) {
    throw 'Model evaluation needs at least 5 GiB remaining for runtime, frames and build reserve.'
}
function Get-SubjectArtifact([string]$Uri, [string]$Path, [string]$Hash = '') {
    if (-not (Test-Path -LiteralPath $Path)) {
        $subjectPendingDownload = $Path + '.download'
        Invoke-WebRequest -Uri $Uri -OutFile $subjectPendingDownload -TimeoutSec 180
        if ($Hash -and (Get-FileHash -LiteralPath $subjectPendingDownload -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Hash) {
            throw 'Model publisher hash mismatch. The payload will not be loaded.'
        }
        Move-Item -LiteralPath $subjectPendingDownload -Destination $Path
    }
    if ($Hash -and (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Hash) {
        throw 'Cached evaluation artifact has changed. It will not be overwritten or executed.'
    }
}
Write-Output 'Acquiring hash-allowlisted SAM 2.1 tiny and DETR keyframe candidates. No runtime installation or inference yet.'
$subjectSamRevision = 'de431c4043854a71d8101e17995dfe596bf101a5'
$subjectSamHash = '7402e0d864fa82708a20fbd15bc84245c2f26dff0eb43a4b5b93452deb34be69'
Get-SubjectArtifact "https://huggingface.co/facebook/sam2.1-hiera-tiny/resolve/$subjectSamRevision/sam2.1_hiera_tiny.pt" (Join-Path $subjectModels 'sam2.1_hiera_tiny.pt') $subjectSamHash
$subjectDetrRevision = '70120ba84d68ca1211e007c4fb61d0cd5424be54'
$subjectDetr = Join-Path $subjectModels 'detr-no-timm'
New-Item -ItemType Directory -Path $subjectDetr -Force | Out-Null
Get-SubjectArtifact "https://huggingface.co/facebook/detr-resnet-50/resolve/$subjectDetrRevision/pytorch_model.bin" (Join-Path $subjectDetr 'pytorch_model.bin') '883e4b0a898b87cc8ce28b33e04f86413984f67f7a44e96de5d05473bb0931b4'
foreach ($subjectFile in @('config.json', 'preprocessor_config.json', 'README.md')) {
    Get-SubjectArtifact "https://huggingface.co/facebook/detr-resnet-50/resolve/$subjectDetrRevision/$subjectFile" (Join-Path $subjectDetr $subjectFile)
}
$subjectSamCommit = '2b90b9f5ceec907a1c18123530e92e794ad901a4'
$subjectSource = Join-Path $subjectRoot "sam2-$subjectSamCommit.zip"
Get-SubjectArtifact "https://codeload.github.com/facebookresearch/sam2/zip/$subjectSamCommit" $subjectSource
if ((Get-Item -LiteralPath $subjectSource).Length -gt 256MB) { throw 'Unexpected SAM source archive size.' }
$subjectZip = [IO.Compression.ZipFile]::OpenRead($subjectSource)
try {
    foreach ($subjectEntry in $subjectZip.Entries) {
        $subjectPrefix = "sam2-$subjectSamCommit/"
        if (-not $subjectEntry.FullName.StartsWith($subjectPrefix, [StringComparison]::Ordinal)) { throw 'Unexpected source archive root.' }
        $subjectRelative = $subjectEntry.FullName.Substring($subjectPrefix.Length)
        $subjectWanted = (($subjectRelative.StartsWith('sam2/', [StringComparison]::Ordinal)) -and
            ($subjectRelative.EndsWith('.py') -or $subjectRelative.EndsWith('.yaml'))) -or
            $subjectRelative -in @('LICENSE', 'LICENSE_cctorch')
        if (-not $subjectWanted) { continue }
        $subjectTarget = [IO.Path]::GetFullPath((Join-Path $subjectVendor $subjectRelative))
        if (-not $subjectTarget.StartsWith([IO.Path]::GetFullPath($subjectVendor) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Source archive path escapes the private vendor directory.'
        }
        if (Test-Path -LiteralPath $subjectTarget) { continue }
        New-Item -ItemType Directory -Path (Split-Path -Parent $subjectTarget) -Force | Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($subjectEntry, $subjectTarget, $false)
    }
} finally { $subjectZip.Dispose() }
Get-ChildItem -LiteralPath $subjectModels -File -Recurse | Get-FileHash -Algorithm SHA256
Get-FileHash -LiteralPath $subjectSource -Algorithm SHA256
Write-Output 'Evaluation artifacts acquired. Hash lock, code/weight notices, actual model inference and visual acceptance remain release gates.'
