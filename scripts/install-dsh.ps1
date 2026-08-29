[CmdletBinding()]
param(
    [string]$DshRoot = '',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$dshRepositoryUrl = 'https://github.com/deepseek-ai/deepseek-harness.git'

function Assert-Command {
    param([string]$Name, [string]$Purpose)
    if (-not (Get-Command -Name $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' is missing; it is needed for $Purpose."
    }
}

function Assert-NodeVersion {
    Assert-Command -Name 'node' -Purpose 'checking the minimum Node.js version'
    $versionText = (& node --version 2>$null | Out-String).Trim()
    $match = [regex]::Match($versionText, '^v?(\d+)\.(\d+)(?:\.(\d+))?')
    if (-not $match.Success) { throw 'Unable to parse the installed Node.js version.' }
    $patchVersion = if ($match.Groups[3].Success) { [int]$match.Groups[3].Value } else { 0 }
    $version = [Version]::new([int]$match.Groups[1].Value, [int]$match.Groups[2].Value, $patchVersion)
    if ($version -lt [Version]'20.10.0') {
        throw "Node.js >= 20.10 is required; the installed version is $version."
    }
    Write-Host "[install-dsh] Node.js version check passed ($version)."
}

function Get-LockKind {
    $pnpmLock = Test-Path -LiteralPath (Join-Path $DshRoot 'pnpm-lock.yaml') -PathType Leaf
    $npmLock = Test-Path -LiteralPath (Join-Path $DshRoot 'package-lock.json') -PathType Leaf
    if ($pnpmLock -and $npmLock) { throw "DSH checkout contains both pnpm-lock.yaml and package-lock.json; refusing to guess the package manager." }
    if ($pnpmLock) { return 'pnpm' }
    if ($npmLock) { return 'npm' }
    return $null
}

function Invoke-External {
    param([string]$Command, [string[]]$Arguments, [string]$WorkingDirectory)
    Push-Location -LiteralPath $WorkingDirectory
    try {
        & $Command @Arguments
        if ($LASTEXITCODE -ne 0) { throw "Command failed with exit code ${LASTEXITCODE}: $Command" }
    } finally {
        Pop-Location
    }
}

$existingDsh = Get-Command dsh -ErrorAction SilentlyContinue
if ($existingDsh) {
    throw "dsh is already available on PATH at $($existingDsh.Path); use install-profile-deps.ps1 instead of install-dsh.ps1."
}

Assert-NodeVersion
Assert-Command -Name 'git' -Purpose 'shallow-cloning DeepSeek Harness'

if ([string]::IsNullOrWhiteSpace($DshRoot)) {
    $DshRoot = if (-not [string]::IsNullOrWhiteSpace($env:SAGITTA_DSH_ROOT)) {
        $env:SAGITTA_DSH_ROOT
    } elseif (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        Join-Path $env:LOCALAPPDATA 'DeepSeek-Harness'
    } else {
        Join-Path (Join-Path (if ($env:USERPROFILE) { $env:USERPROFILE } else { [Environment]::GetFolderPath('UserProfile') }) 'AppData\Local') 'DeepSeek-Harness'
    }
}
$DshRoot = [IO.Path]::GetFullPath($DshRoot)

Write-Host "[install-dsh] target root: $DshRoot"
if (-not (Test-Path -LiteralPath $DshRoot -PathType Container)) {
    if ($DryRun) {
        Write-Host "[install-dsh] dry-run: would shallow-clone $dshRepositoryUrl"
    } else {
        $parent = Split-Path -Parent $DshRoot
        if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        Invoke-External -Command 'git' -Arguments @('clone', '--depth', '1', $dshRepositoryUrl, $DshRoot) -WorkingDirectory (Get-Location).Path
    }
} elseif (-not (Test-Path -LiteralPath (Join-Path $DshRoot '.git') -PathType Container)) {
    $children = @(Get-ChildItem -Force -LiteralPath $DshRoot)
    if ($children.Count -gt 0) {
        throw "DSH root exists but is not a Git checkout and is not empty: $DshRoot"
    }
    if ($DryRun) {
        Write-Host "[install-dsh] dry-run: would shallow-clone $dshRepositoryUrl into the empty directory"
    } else {
        Remove-Item -LiteralPath $DshRoot -Force
        Invoke-External -Command 'git' -Arguments @('clone', '--depth', '1', $dshRepositoryUrl, $DshRoot) -WorkingDirectory (Split-Path -Parent $DshRoot)
    }
}

$lockKind = Get-LockKind
if ($null -eq $lockKind) {
    if ($DryRun) {
        Write-Host '[install-dsh] dry-run: lockfile will be inspected after clone; expected pnpm-lock.yaml or package-lock.json.'
        return [pscustomobject]@{ DshPath = Join-Path $DshRoot 'node_modules\.bin\dsh.ps1'; DshRoot = $DshRoot; Planned = $true }
    }
    throw "DSH checkout has no supported lockfile (pnpm-lock.yaml or package-lock.json): $DshRoot"
}

if ($lockKind -eq 'pnpm') {
    Assert-Command -Name 'pnpm' -Purpose 'installing the DSH pnpm lockfile'
    $packageManager = 'pnpm'
    $packageArguments = @('install', '--frozen-lockfile')
} else {
    Assert-Command -Name 'npm' -Purpose 'installing the DSH npm lockfile'
    $packageManager = 'npm'
    $packageArguments = @('ci')
}

Write-Host "[install-dsh] package manager: $packageManager"
if ($DryRun) {
    Write-Host "[install-dsh] dry-run: would run $packageManager $($packageArguments -join ' ')"
    return [pscustomobject]@{ DshPath = Join-Path $DshRoot 'node_modules\.bin\dsh.ps1'; DshRoot = $DshRoot; Planned = $true }
}

Invoke-External -Command $packageManager -Arguments $packageArguments -WorkingDirectory $DshRoot
$dshPath = Join-Path $DshRoot 'node_modules\.bin\dsh.ps1'
if (-not (Test-Path -LiteralPath $dshPath -PathType Leaf)) {
    $scriptNames = @()
    $packageJsonPath = Join-Path $DshRoot 'package.json'
    if (Test-Path -LiteralPath $packageJsonPath -PathType Leaf) {
        try {
            $packageJson = Get-Content -LiteralPath $packageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($packageJson.scripts) { $scriptNames = @($packageJson.scripts.PSObject.Properties.Name) }
        } catch { }
    }
    $scriptHint = if ($scriptNames.Count -gt 0) { " Available package scripts: $($scriptNames -join ', ')." } else { '' }
    throw "DSH install completed but the expected binary was not found: $dshPath.$scriptHint The upstream checkout may require a release/build layout change; no unverified build command was run."
}

Write-Host "[install-dsh] installed binary: $dshPath"
return [pscustomobject]@{ DshPath = $dshPath; DshRoot = $DshRoot; Planned = $false }
