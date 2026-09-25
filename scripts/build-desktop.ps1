$ErrorActionPreference = 'Stop'
$projectDir = Split-Path $PSScriptRoot -Parent
Set-Location $projectDir
& npm.cmd run desktop:build
if ($LASTEXITCODE -ne 0) { throw 'Windows executable packaging failed' }
Copy-Item -LiteralPath (Join-Path $projectDir 'src-tauri\target\release\ColdDrop.exe') -Destination (Join-Path $projectDir 'artifacts\ColdDrop-1.2.0-portable.exe')
$installer = Get-ChildItem -LiteralPath (Join-Path $projectDir 'src-tauri\target\release\bundle\nsis') -Filter '*setup.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $installer) { throw 'The NSIS installer was not produced' }
Copy-Item -LiteralPath $installer.FullName -Destination (Join-Path $projectDir 'artifacts\ColdDrop-1.2.0-setup.exe')
Write-Output 'Created Windows installer and portable executable in artifacts'
