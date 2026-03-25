param(
    [switch]$WhatIf
)

$ErrorActionPreference = "Stop"

$renames = @(
    [pscustomobject]@{ Original = 'F:\test1\2024\04\13'; Current = 'F:\test1\2024\04\13 - Sale Team Championships - April 2024)' }
    [pscustomobject]@{ Original = 'F:\test1\2024\04\14'; Current = 'F:\test1\2024\04\14 - Sale Team Championships - April 2024)' }
    [pscustomobject]@{ Original = 'F:\test1\2024\04\20'; Current = 'F:\test1\2024\04\20 - State Individuals - Ballarat - April 2024)' }
    [pscustomobject]@{ Original = 'F:\test1\2024\04\21'; Current = 'F:\test1\2024\04\21 - State Individuals - Ballarat - April 2024)' }
    [pscustomobject]@{ Original = 'F:\test1\2024\06\02'; Current = 'F:\test1\2024\06\02 - Rally)' }
    [pscustomobject]@{ Original = 'F:\test1\2024\07\07'; Current = 'F:\test1\2024\07\07 - Rally)' }
    [pscustomobject]@{ Original = 'F:\test1\2024\09\15'; Current = 'F:\test1\2024\09\15 - State Pairs - Trafalgar - September 2024)' }
    [pscustomobject]@{ Original = 'F:\test1\2024\11\02'; Current = 'F:\test1\2024\11\02 - Whittlesea show))' }
    [pscustomobject]@{ Original = 'F:\test1\2024\11\16'; Current = 'F:\test1\2024\11\16 - With the horses)' }
    [pscustomobject]@{ Original = 'F:\test1\2025\01\14'; Current = 'F:\test1\2025\01\14 - The wasps)' }
    [pscustomobject]@{ Original = 'F:\test1\2025\02\01'; Current = 'F:\test1\2025\02\01 - Ayr Hill)' }
    [pscustomobject]@{ Original = 'F:\test1\2025\03\22'; Current = 'F:\test1\2025\03\22 - Ayr Hill - State Pairs - Day 1)' }
    [pscustomobject]@{ Original = 'F:\test1\2025\03\23'; Current = 'F:\test1\2025\03\23 - Ayr Hill - State Pairs - Day 2)' }
)

$renamedCount = 0
$skippedCount = 0

foreach ($entry in $renames) {
    $originalPath = $entry.Original
    $currentPath = $entry.Current

    if (-not (Test-Path -LiteralPath $currentPath -PathType Container)) {
        Write-Warning "Current renamed folder not found, skipping: $currentPath"
        $skippedCount += 1
        continue
    }

    if (Test-Path -LiteralPath $originalPath) {
        Write-Warning "Original folder already exists, skipping to avoid overwrite: $originalPath"
        $skippedCount += 1
        continue
    }

    $parentPath = Split-Path -Parent $originalPath
    $originalName = Split-Path -Leaf $originalPath

    if (-not (Test-Path -LiteralPath $parentPath -PathType Container)) {
        Write-Warning "Parent folder missing, skipping: $parentPath"
        $skippedCount += 1
        continue
    }

    if ($WhatIf) {
        Write-Host "WhatIf: Rename '$currentPath' -> '$originalPath'" -ForegroundColor Yellow
        continue
    }

    Rename-Item -LiteralPath $currentPath -NewName $originalName
    Write-Host "Reverted '$currentPath' -> '$originalPath'" -ForegroundColor Green
    $renamedCount += 1
}

if ($WhatIf) {
    Write-Host "WhatIf complete. No folders were renamed." -ForegroundColor Cyan
} else {
    Write-Host "Undo complete. Reverted $renamedCount folder(s); skipped $skippedCount." -ForegroundColor Cyan
}