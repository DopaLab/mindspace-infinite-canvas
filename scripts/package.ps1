[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'manifest.json') | ConvertFrom-Json
$distDirectory = Join-Path $projectRoot 'dist'
$archiveName = "Mindspace-Infinite-Canvas-v$($manifest.version).zip"
$archivePath = Join-Path $distDirectory $archiveName
$checksumPath = Join-Path $distDirectory 'SHA256SUMS.txt'

node (Join-Path $PSScriptRoot 'validate.mjs')
New-Item -ItemType Directory -Force -Path $distDirectory | Out-Null

$packageEntries = @(
    (Join-Path $projectRoot 'manifest.json'),
    (Join-Path $projectRoot 'newtab.html'),
    (Join-Path $projectRoot 'styles.css'),
    (Join-Path $projectRoot 'script.js'),
    (Join-Path $projectRoot 'icon.png'),
    (Join-Path $projectRoot 'icons')
)

Compress-Archive -Path $packageEntries -DestinationPath $archivePath -CompressionLevel Optimal -Force
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText($checksumPath, "$hash  $archiveName`n", [System.Text.UTF8Encoding]::new($false))

Write-Host "Created $archivePath"
Write-Host "SHA-256 $hash"
