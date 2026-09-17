param(
    [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
    [string[]]$NpmArguments
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$nodeCandidates = @()

$nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
if ($nodeCommand) {
    $nodeCandidates += $nodeCommand.Source
}

if ($env:ProgramFiles) {
    $nodeCandidates += Join-Path $env:ProgramFiles "nodejs\node.exe"
}

$nodeExe = $nodeCandidates |
    Where-Object { $_ -and (Test-Path -LiteralPath $_) } |
    Select-Object -First 1
if (-not $nodeExe) {
    throw "Node.js was not found. Install a supported Node.js LTS release, then rerun this command."
}

$npmCliCandidates = @(
    (Join-Path (Split-Path -Parent $nodeExe) "node_modules\npm\bin\npm-cli.js")
)
if ($env:ProgramFiles) {
    $npmCliCandidates += Join-Path $env:ProgramFiles "nodejs\node_modules\npm\bin\npm-cli.js"
}

$npmCli = $npmCliCandidates |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1
if (-not $npmCli) {
    throw "npm's CLI was not found beside Node.js. Repair or reinstall Node.js, then rerun this command."
}

& $nodeExe $npmCli "--prefix" $repoRoot @NpmArguments
return
