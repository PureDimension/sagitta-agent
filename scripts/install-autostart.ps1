<#
  Optional Windows logon autostart for sagitta-agent.
  Default policy (decision ④ recommendation): updater runs only when DSH starts.
  This script is OFF by default — run it explicitly if Ripple wants DSH to also
  start at Windows logon. Safe to run: backup + DryRun + idempotent.

  What it does:
  - Creates %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\sagitta-dsh.cmd
    that launches `dsh --profile web` (the same binary install.ps1 uses).
  - Restore: delete the .cmd or run Remove-Entry switch.

  Usage:
    pwsh -NoProfile -File .\scripts\install-autostart.ps1            # install entry
    pwsh -NoProfile -File .\scripts\install-autostart.ps1 -DryRun    # preview only
    pwsh -NoProfile -File .\scripts\install-autostart.ps1 -RemoveEntry  # remove entry
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$RemoveEntry
)

$ErrorActionPreference = 'Stop'

$startupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$entryPath  = Join-Path $startupDir 'sagitta-dsh.cmd'
$dshBin     = 'D:\Deepseek-Harness\node_modules\.bin\dsh.ps1'   # resolved by install.ps1; edit if DSH_HOME differs
$entryBody  = "@echo off`r`nstart ""dsh --profile web"" powershell -NoProfile -ExecutionPolicy Bypass -File `"$dshBin`" --profile web`r`n"

function Write-Entry {
    if ($DryRun) {
        Write-Host "[install-autostart] dry-run: would create $entryPath"
        return
    }
    $timestamp = [DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff')
    $backupPath = "$entryPath.bak.$timestamp"
    if (Test-Path -LiteralPath $entryPath -PathType Leaf) {
        Copy-Item -LiteralPath $entryPath -Destination $backupPath
        Write-Host "[install-autostart] backup: $backupPath"
    }
    [IO.File]::WriteAllText($entryPath, $entryBody, [Text.UTF8Encoding]::new($false))
    Write-Host "[install-autostart] entry created: $entryPath"
}

function Remove-Entry {
    if ($DryRun) {
        Write-Host "[install-autostart] dry-run: would remove $entryPath (backup kept)"
        return
    }
    if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) {
        Write-Host '[install-autostart] no entry to remove; already clean.'
        return
    }
    $timestamp = [DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff')
    Copy-Item -LiteralPath $entryPath -Destination "$entryPath.bak.$timestamp"
    Remove-Item -LiteralPath $entryPath -Force
    Write-Host "[install-autostart] entry removed; backup: $entryPath.bak.$timestamp"
}

if ($RemoveEntry) {
    Remove-Entry
} else {
    Write-Entry
}

Write-Host "[install-autostart] note: default policy is DSH-only autostart; logon autostart is opt-in (decision ④)."