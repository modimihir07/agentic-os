[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$BackupFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RootDir = $PSScriptRoot
$BackupDir = Join-Path $RootDir 'backups'

if ([string]::IsNullOrWhiteSpace($BackupFile)) {
    Write-Host 'Available backups:'
    $Backups = Get-ChildItem -Path $BackupDir -Filter '*.zip' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
    if ($Backups) {
        $Backups | ForEach-Object { Write-Host "  $($_.FullName)" }
    }
    else {
        Write-Host "  No backups found in $BackupDir"
    }
    Write-Host ''
    Write-Host 'Usage: .\restore.ps1 <backup-file>'
    exit 1
}

if (-not [System.IO.Path]::IsPathRooted($BackupFile)) {
    $BackupFile = Join-Path $RootDir $BackupFile
}

if (-not (Test-Path -LiteralPath $BackupFile -PathType Leaf)) {
    Write-Error "Backup file not found: $BackupFile"
    exit 1
}

Write-Host "Restoring from: $BackupFile"
Write-Host 'WARNING: This will overwrite current brain\, skills\, agents\, data\, registry\, standards\, prompts\'

$Confirm = Read-Host 'Continue? (y/N)'
if ($Confirm -notin @('y', 'Y')) {
    Write-Host 'Cancelled.'
    exit 0
}

Expand-Archive -LiteralPath $BackupFile -DestinationPath $RootDir -Force

Write-Host 'Restore complete!'
