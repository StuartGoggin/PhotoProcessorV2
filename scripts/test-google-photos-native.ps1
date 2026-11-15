#Requires -Version 7.0
param([string]$Filter='commands::google_photos::',[switch]$Release,[switch]$ShowOutput)
$ErrorActionPreference='Stop'
$repoRoot=Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot
$tokens=$null;$parseErrors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'build-release.ps1'),[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw 'Release environment helper could not be parsed.'}
$definition=$ast.Find({param($node)$node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Import-MsvcBuildEnvironment'},$true)
if(-not $definition){throw 'Release environment helper is missing.'}
. ([scriptblock]::Create($definition.Extent.Text))
Import-MsvcBuildEnvironment
$cargo=Join-Path $env:USERPROFILE '.cargo/bin/cargo.exe'
$arguments=@('test','--manifest-path',(Join-Path $repoRoot 'src-tauri/Cargo.toml'),'--locked','--lib',$Filter)
if($Release){$arguments+='--release'}
$arguments+=@('--','--test-threads=1')
if($ShowOutput){$arguments+='--nocapture'}
& $cargo @arguments
if($LASTEXITCODE -ne 0){throw "Google Photos native verification failed ($LASTEXITCODE)."}
