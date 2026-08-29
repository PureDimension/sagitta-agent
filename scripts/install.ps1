[CmdletBinding()]
param(
    [string]$DshHome = '',
    [string]$RepoPath = '',
    [switch]$ForceSyncPreset,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repoUrl = if (-not [string]::IsNullOrWhiteSpace($env:SAGITTA_AGENT_REPO_URL)) {
    $env:SAGITTA_AGENT_REPO_URL
} else {
    'https://github.com/PureDimension/sagitta-agent.git'
}

function Ensure-SagittaRepository {
    param([string]$Path, [string]$Url, [switch]$DryRun)
    $presetSource = Join-Path $Path 'presets\sagitta'
    if (Test-Path -LiteralPath $Path -PathType Container) {
        if (Test-Path -LiteralPath $presetSource -PathType Container) {
            $gitDir = Join-Path $Path '.git'
            if (Test-Path -LiteralPath $gitDir -PathType Container) {
                $status = (& git -C $Path status --porcelain 2>$null | Out-String).Trim()
                if ($status) { Write-Warning '[install] Sagitta repository is dirty; no pull/overwrite will be attempted.' }
                else { Write-Host '[install] Sagitta repository is clean; update responsibility remains with updater ff-only logic.' }
            } else {
                Write-Host '[install] using existing Sagitta source directory (no Git metadata).'
            }
            return
        }
        if (-not $DryRun) { throw "Repository path exists but is not a Sagitta source checkout: $Path" }
        Write-Host '[install] dry-run: existing repository path has no preset source; clone would be required only if it is empty.'
        return
    }
    if ($DryRun) {
        Write-Host "[install] dry-run: would shallow-clone $Url into $Path"
        return
    }
    $parent = Split-Path -Parent $Path
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    & git clone --depth 1 $Url $Path
    if ($LASTEXITCODE -ne 0) { throw "Sagitta repository clone failed with exit code $LASTEXITCODE." }
    if (-not (Test-Path -LiteralPath $presetSource -PathType Container)) { throw "Cloned repository is missing presets/sagitta: $Path" }
}

if ([string]::IsNullOrWhiteSpace($DshHome)) {
    $DshHome = if (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) { $env:DSH_HOME } else {
        Join-Path (if ($env:USERPROFILE) { $env:USERPROFILE } else { [Environment]::GetFolderPath('UserProfile') }) '.dsh'
    }
}
if ([string]::IsNullOrWhiteSpace($RepoPath)) {
    $RepoPath = if (-not [string]::IsNullOrWhiteSpace($env:SAGITTA_AGENT_DIR)) { $env:SAGITTA_AGENT_DIR } else {
        Join-Path $DshHome 'sagitta-agent'
    }
}
$DshHome = [IO.Path]::GetFullPath($DshHome)
$RepoPath = [IO.Path]::GetFullPath($RepoPath)

Write-Host '[install] Sagitta agent installer'
Write-Host "[install] DSH home: $DshHome"
Write-Host "[install] repository: $RepoPath"
if ($DryRun) { Write-Host '[install] dry-run enabled: no files, package installs, DSH process, or Worker deployment will be started.' }

$dshCommand = Get-Command dsh -ErrorAction SilentlyContinue
$dshPath = if ($dshCommand) { $dshCommand.Path } else { $null }
if ($dshPath) {
    Write-Host "[install] DSH found on PATH: $dshPath"
} else {
    Write-Host '[install] DSH was not found on PATH; invoking install-dsh.ps1.'
    $dshResult = & (Join-Path $PSScriptRoot 'install-dsh.ps1') -DryRun:$DryRun
    $dshPath = @($dshResult | Where-Object { $_.PSObject.Properties.Name -contains 'DshPath' } | Select-Object -Last 1).DshPath
    if ([string]::IsNullOrWhiteSpace($dshPath)) { throw 'install-dsh.ps1 did not return a DSH binary path.' }
}

Ensure-SagittaRepository -Path $RepoPath -Url $repoUrl -DryRun:$DryRun

& (Join-Path $PSScriptRoot 'install-profile-deps.ps1') -ProfilePath (Join-Path $DshHome 'profiles\web') -RepoPath $RepoPath -DryRun:$DryRun
& (Join-Path $PSScriptRoot 'sync-preset.ps1') -DshHome $DshHome -RepoPath $RepoPath -ForceSyncPreset:$ForceSyncPreset -DryRun:$DryRun

$setDefaultArgs = @((Join-Path $PSScriptRoot 'set-default-preset.mjs'), '--dsh-home', $DshHome)
if ($DryRun) { $setDefaultArgs += '--dry-run' }
& node @setDefaultArgs
if ($LASTEXITCODE -ne 0) { throw "set-default-preset.mjs failed with exit code $LASTEXITCODE." }

if ($DryRun) {
    & (Join-Path $PSScriptRoot 'verify-install.ps1') -DshPath $dshPath -DshHome $DshHome -DryRun
    Write-Host '[install] dry-run complete.'
    return [pscustomobject]@{ Status = 'planned'; Dsh = $dshPath; Repository = $RepoPath }
}

& (Join-Path $PSScriptRoot 'verify-install.ps1') -DshPath $dshPath -DshHome $DshHome
Write-Host '[install] installation completed and verification passed.'
return [pscustomobject]@{ Status = 'installed'; Dsh = $dshPath; Repository = $RepoPath }

function Ensure-SagittaRepository {
    param([string]$Path, [string]$Url, [switch]$DryRun)
    $presetSource = Join-Path $Path 'presets\sagitta'
    if (Test-Path -LiteralPath $Path -PathType Container) {
        if (Test-Path -LiteralPath $presetSource -PathType Container) {
            $gitDir = Join-Path $Path '.git'
            if (Test-Path -LiteralPath $gitDir -PathType Container) {
                $status = (& git -C $Path status --porcelain 2>$null | Out-String).Trim()
                if ($status) { Write-Warning '[install] Sagitta repository is dirty; no pull/overwrite will be attempted.' }
                else { Write-Host '[install] Sagitta repository is clean; update responsibility remains with updater ff-only logic.' }
            } else {
                Write-Host '[install] using existing Sagitta source directory (no Git metadata).'
            }
            return
        }
        if (-not $DryRun) { throw "Repository path exists but is not a Sagitta source checkout: $Path" }
        Write-Host '[install] dry-run: existing repository path has no preset source; clone would be required only if it is empty.'
        return
    }
    if ($DryRun) {
        Write-Host "[install] dry-run: would shallow-clone $Url into $Path"
        return
    }
    $parent = Split-Path -Parent $Path
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    & git clone --depth 1 $Url $Path
    if (-not (Test-Path -LiteralPath $presetSource -PathType Container)) { throw "Cloned repository is missing presets/sagitta: $Path" }
}
