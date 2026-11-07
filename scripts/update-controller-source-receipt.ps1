# Deliberate maintainer action after reviewing a controller-source patch.
# Builds verify this receipt; they never regenerate it automatically.
$ErrorActionPreference='Stop'
$bundle=Join-Path (Split-Path -Parent $PSScriptRoot) 'src-tauri/resources/controller-source'
$source=(Resolve-Path -LiteralPath (Join-Path $bundle 'ajazz-sdk-photogogo')).Path
$receiptPath=Join-Path $bundle 'source-receipt.json'
$receipt=Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
$files=@(Get-ChildItem -LiteralPath $source -Recurse -File -Force | Sort-Object FullName | ForEach-Object {
    $relative=[IO.Path]::GetRelativePath($source,$_.FullName).Replace('\','/')
    if($relative -match '(^|/)(target|node_modules|\.git)(/|$)'){throw 'Generated or private files cannot enter the controller source receipt'}
    [ordered]@{path=$relative;bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
})
if($files.Count -gt 128 -or ($files | Measure-Object bytes -Sum).Sum -gt 4MB){throw 'Controller source exceeded its reviewed size bound'}
$receipt.schema=2
$receipt.modified=$true
$receipt | Add-Member -NotePropertyName modifiedSdk -NotePropertyValue ([ordered]@{
    directory='ajazz-sdk-photogogo';version='0.2.1';basedOnCrateSha256='10320f86148f1774e444c8fdb5ae2bbccdffee23abc2c3848cb291293590c54c';modifiedFiles=@('src/device.rs','src/lib.rs');notes='PHOTOGOGO-CHANGES.md';files=$files
}) -Force
[IO.File]::WriteAllText($receiptPath,($receipt | ConvertTo-Json -Depth 8)+"`n",[Text.UTF8Encoding]::new($false))
Write-Host "Controller source receipt updated: $($files.Count) reviewed source files. Review the diff before release."
