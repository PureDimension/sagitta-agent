[CmdletBinding()]
param(
    [string]$DshPath = '',
    [string]$DshHome = '',
    [string]$ProfileName = 'web',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($DshHome)) {
    $DshHome = if (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) { $env:DSH_HOME } else {
        Join-Path (if ($env:USERPROFILE) { $env:USERPROFILE } else { [Environment]::GetFolderPath('UserProfile') }) '.dsh'
    }
}
$DshHome = [IO.Path]::GetFullPath($DshHome)
$profilePath = Join-Path $DshHome "profiles\$ProfileName"

if ([string]::IsNullOrWhiteSpace($DshPath)) {
    $command = Get-Command dsh -ErrorAction SilentlyContinue
    if ($command) { $DshPath = $command.Path }
}
if ([string]::IsNullOrWhiteSpace($DshPath)) { throw 'dsh was not found on PATH; install DSH before verification.' }

Write-Host "[verify-install] dsh: $DshPath"
Write-Host "[verify-install] profile: $profilePath"
if (-not (Test-Path -LiteralPath $profilePath -PathType Container)) {
    if ($DryRun) {
        Write-Host "[verify-install] dry-run: profile directory would be created by install-profile-deps.ps1."
    } else {
        throw "Profile directory is missing: $profilePath"
    }
}

if ($DryRun) {
    Write-Host '[verify-install] dry-run: would run dsh --profile web --dump-config and inspect plugin/preset/path markers.'
    return [pscustomobject]@{ Status = 'planned'; Profile = $profilePath }
}

$dump = (& $DshPath --profile $ProfileName --dump-config 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) { throw 'dsh --profile web --dump-config failed; installation verification stopped.' }

$checks = [ordered]@{
    'sagitta-manager'    = ($dump -match '(?m)sagitta-manager|@sagitta/manager')
    'memory'              = ($dump -match '(?m)(^|[^\w])memory([^\w]|$)|@sagitta/memory')
    'sagitta-auto-advance'= ($dump -match '(?m)sagitta-auto-advance|@sagitta/auto-advance')
    'sagitta-updater'     = ($dump -match '(?m)sagitta-updater|@sagitta/updater')
    'preset default'      = ($dump -match '(?i)default\s*[:=]\s*["'']?sagitta\b|agent-presets[^\r\n]*sagitta')
    'profile path'        = ($dump -match [regex]::Escape($profilePath) -or $dump -match '(?i)profiles[\\/]+' + [regex]::Escape($ProfileName))
}
$missing = @($checks.GetEnumerator() | Where-Object { -not $_.Value } | ForEach-Object Key)
foreach ($check in $checks.GetEnumerator()) {
    Write-Host "[verify-install] $($check.Key): $([bool]$check.Value)"
}
if ($missing.Count -gt 0) { throw "Installation verification failed for: $($missing -join ', ')" }
Write-Host '[verify-install] all required plugin, preset, and profile checks passed.'
return [pscustomobject]@{ Status = 'verified'; Profile = $profilePath }
