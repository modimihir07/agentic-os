[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RootDir = $PSScriptRoot
$BackupDir = Join-Path $RootDir 'backups'
$Timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$BackupFile = Join-Path $BackupDir "agentic-os-$Timestamp.zip"
$IncludeDirs = @('brain', 'skills', 'agents', 'data', 'registry', 'standards', 'prompts')

New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null

$StagingDir = Join-Path ([System.IO.Path]::GetTempPath()) "agentic-os-backup-$Timestamp-$PID"
New-Item -ItemType Directory -Path $StagingDir -Force | Out-Null

try {
    foreach ($Dir in $IncludeDirs) {
        $Source = Join-Path $RootDir $Dir
        if (Test-Path -LiteralPath $Source) {
            Copy-Item -LiteralPath $Source -Destination $StagingDir -Recurse -Force
        }
    }

    $SettingsFile = Join-Path $StagingDir 'data\settings.json'
    if (Test-Path -LiteralPath $SettingsFile) {
        Remove-Item -LiteralPath $SettingsFile -Force
    }

    Write-Host "Creating backup: $BackupFile"
    Compress-Archive -Path (Join-Path $StagingDir '*') -DestinationPath $BackupFile -Force

    $BackupSize = (Get-Item -LiteralPath $BackupFile).Length
    Write-Host ("Backup created: {0:N2} MB" -f ($BackupSize / 1MB))
    Write-Host "Path: $BackupFile"
}
finally {
    if (Test-Path -LiteralPath $StagingDir) {
        Remove-Item -LiteralPath $StagingDir -Recurse -Force
    }
}
