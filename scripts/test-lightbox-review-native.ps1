#Requires -Version 7.0
param([switch]$Release,[switch]$All,[switch]$Embedded)
$ErrorActionPreference='Stop'
$repoRoot=Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot
# Reuse the checked release environment setup; do not duplicate compiler discovery.
$tokens=$null;$parseErrors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'build-release.ps1'),[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw 'Release environment helper could not be parsed.'}
$definition=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Import-MsvcBuildEnvironment'},$true)
if(-not $definition){throw 'Release environment helper is missing.'}
. ([scriptblock]::Create($definition.Extent.Text))
Import-MsvcBuildEnvironment
$cargo=Join-Path $env:USERPROFILE '.cargo/bin/cargo.exe'
$arguments=@('test','--manifest-path',(Join-Path $repoRoot 'src-tauri/Cargo.toml'),'--locked')
if($Release){$arguments+='--release'}
if($Embedded){$arguments+=@('--features','custom-protocol','--test','embedded_guide')}
else{$arguments+='--lib';if(-not $All){$arguments+='commands::lightbox_review::tests'}}
if($All){$arguments+=@('--','--test-threads=1')}
& $cargo @arguments
if($LASTEXITCODE -ne 0){throw "Native verification failed ($LASTEXITCODE)."}
