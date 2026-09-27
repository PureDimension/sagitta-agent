<#
  Installs the Sagitta profile dependencies from GitHub and wires preset discovery.

  Every @sagitta/* dependency is declared as a git-hosted spec
  (github:<Repo>#path:plugins/<name>), so the installed code is exactly the
  repository commit that GitHub serves — never a local working copy. To move the
  profile onto a newer commit: push it, then run
  `pnpm install` after `pnpm update @sagitta/manager @sagitta/auto-advance
  @sagitta/async-work @sagitta/memory @sagitta/codex-dispatch`.

  This script owns exactly two bootstrap facts:
  - dsh.profile.bundles: the three host-plane plugins. memory and codex-dispatch
    are preset-plane rows; listing them as bundles would mount them twice.
  - cordis.patch.yml: the agent-presets entry, so DSH discovers the sagitta
    preset that ships inside @sagitta/manager/presets.

  Everything else — the manager's own settings, auto-advance tuning, credentials
  — is user-owned (Settings GUI / .credentials.yaml) and is never rewritten here.
#>
[CmdletBinding()]
param(
    [string]$ProfilePath = '',
    [string]$ProfileName = 'web',
    [string]$Repo = 'PureDimension/sagitta-agent',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'git-proxy.ps1')

$plugins = [ordered]@{
    '@sagitta/manager'        = 'manager'
    '@sagitta/memory'         = 'memory'
    '@sagitta/auto-advance'   = 'auto-advance'
    '@sagitta/async-work'     = 'async-work'
    '@sagitta/codex-dispatch' = 'codex-dispatch'
}
$bundles = @('@sagitta/manager', '@sagitta/auto-advance', '@sagitta/async-work')

function Backup-File {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
    $stamp = [DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff')
    Copy-Item -LiteralPath $Path -Destination "$Path.bak.$stamp"
    Write-Host "[install-profile-deps] backup: $Path.bak.$stamp"
}

function Set-AgentPresetsEntry {
    param([string[]]$Lines, [string]$ProfileName)
    $block = @(
        '- id: agent-presets'
        '  config:'
        '    default: sagitta'
        '    includeUserRoot: false'
        '    roots:'
        "      - path: !!js dshHomePath('profiles', '$ProfileName', 'node_modules', '@sagitta', 'manager', 'presets')"
        '        trust: user'
    )
    $preamble = [System.Collections.Generic.List[string]]::new()
    $entries = [System.Collections.Generic.List[object]]::new()
    $index = 0
    while ($index -lt $Lines.Count -and $Lines[$index] -notmatch '^-\s+id:') {
        $preamble.Add($Lines[$index])
        $index++
    }
    while ($index -lt $Lines.Count) {
        $start = $index
        $index++
        while ($index -lt $Lines.Count -and $Lines[$index] -notmatch '^-\s+id:') { $index++ }
        $entryLines = @($Lines[$start..($index - 1)])
        # Blank and comment lines trailing an entry belong to the file, not to the
        # entry: holding them separately lets this function replace one entry's
        # configuration without deleting a reader's annotations.
        $trailing = [System.Collections.Generic.List[string]]::new()
        while ($entryLines.Count -gt 1) {
            $last = $entryLines[$entryLines.Count - 1]
            if ($last.Trim() -eq '' -or $last.TrimStart().StartsWith('#')) {
                $trailing.Insert(0, $last)
                $entryLines = @($entryLines[0..($entryLines.Count - 2)])
                continue
            }
            break
        }
        $id = ($entryLines[0] -replace '^-\s+id:\s*', '').Trim().Trim("'").Trim('"')
        $entries.Add([pscustomobject]@{ Id = $id; Lines = $entryLines; Trailing = @($trailing) })
    }
    $output = [System.Collections.Generic.List[string]]::new()
    foreach ($line in $preamble) { $output.Add($line) }
    $written = $false
    foreach ($entry in $entries) {
        if ($entry.Id -eq 'agent-presets') {
            if ($written) { continue }
            foreach ($line in $block) { $output.Add($line) }
            $written = $true
        } else {
            foreach ($line in $entry.Lines) { $output.Add($line) }
        }
        foreach ($line in $entry.Trailing) { $output.Add($line) }
    }
    if (-not $written) {
        if ($output.Count -gt 0 -and $output[$output.Count - 1].Trim() -ne '') { $output.Add('') }
        foreach ($line in $block) { $output.Add($line) }
    }
    return $output
}

if ([string]::IsNullOrWhiteSpace($ProfilePath)) {
    $dshHome = if (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
        $env:DSH_HOME
    } else {
        Join-Path (if ($env:USERPROFILE) { $env:USERPROFILE } else { [Environment]::GetFolderPath('UserProfile') }) '.dsh'
    }
    $ProfilePath = Join-Path $dshHome "profiles\$ProfileName"
}
$ProfilePath = [IO.Path]::GetFullPath($ProfilePath)
$packageJsonPath = Join-Path $ProfilePath 'package.json'
$patchPath = Join-Path $ProfilePath 'cordis.patch.yml'

Write-Host "[install-profile-deps] profile: $ProfilePath"
Write-Host "[install-profile-deps] source: github:$Repo#path:plugins/<name>"

if (-not (Test-Path -LiteralPath $ProfilePath -PathType Container)) {
    if ($DryRun) {
        Write-Host "[install-profile-deps] dry-run: would create $ProfilePath"
    } else {
        New-Item -ItemType Directory -Force -Path $ProfilePath | Out-Null
    }
}

$packageData = if (Test-Path -LiteralPath $packageJsonPath -PathType Leaf) {
    Get-Content -LiteralPath $packageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
} else {
    [ordered]@{
        name         = 'dsh-profile-web'
        private      = $true
        type         = 'module'
        dependencies = [ordered]@{}
        dsh          = [ordered]@{ profile = [ordered]@{ bundles = @() } }
    }
}
if ($packageData -isnot [System.Collections.IDictionary]) { throw "Profile package.json must contain a JSON object: $packageJsonPath" }
if (-not $packageData.Contains('dependencies')) { $packageData['dependencies'] = [ordered]@{} }
if (-not $packageData.Contains('dsh')) { $packageData['dsh'] = [ordered]@{} }
if ($packageData['dsh'] -isnot [System.Collections.IDictionary]) { throw "Profile package.json 'dsh' must be an object: $packageJsonPath" }
if (-not $packageData['dsh'].Contains('profile')) { $packageData['dsh']['profile'] = [ordered]@{} }
if ($packageData['dsh']['profile'] -isnot [System.Collections.IDictionary]) { throw "Profile package.json 'dsh.profile' must be an object: $packageJsonPath" }

foreach ($name in $plugins.Keys) {
    $packageData['dependencies'][$name] = "github:$Repo#path:plugins/$($plugins[$name])"
}
$existingBundles = @($packageData['dsh']['profile']['bundles'])
$preservedBundles = @($existingBundles | Where-Object { $_ -notin @($plugins.Keys) })
$packageData['dsh']['profile']['bundles'] = @($preservedBundles + $bundles)

$before = if (Test-Path -LiteralPath $packageJsonPath -PathType Leaf) {
    Get-Content -LiteralPath $packageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable | ConvertTo-Json -Depth 100 -Compress
} else { '' }
$after = $packageData | ConvertTo-Json -Depth 100 -Compress
if ($before -ne $after) {
    if ($DryRun) {
        Write-Host "[install-profile-deps] dry-run: would rewrite $packageJsonPath with github: dependencies and host bundles."
    } else {
        Backup-File -Path $packageJsonPath
        ($packageData | ConvertTo-Json -Depth 100) + "`n" | Set-Content -LiteralPath $packageJsonPath -Encoding UTF8
        Write-Host "[install-profile-deps] updated $packageJsonPath"
    }
} else {
    Write-Host "[install-profile-deps] unchanged $packageJsonPath"
}

$patchText = if (Test-Path -LiteralPath $patchPath -PathType Leaf) { Get-Content -LiteralPath $patchPath -Raw -Encoding UTF8 } else { '' }
$eol = if ($patchText.Contains("`r`n")) { "`r`n" } else { "`n" }
$patchLines = if ([string]::IsNullOrEmpty($patchText)) { @() } else {
    # Drop the final empty element a trailing newline produces, so re-running this
    # script does not grow the file by one blank line per run.
    $split = @($patchText -split "`r?`n")
    if ($split.Count -gt 0 -and $split[$split.Count - 1] -eq '') { $split = @($split[0..($split.Count - 2)]) }
    $split
}
$updatedLines = Set-AgentPresetsEntry -Lines $patchLines -ProfileName $ProfileName
$updatedPatch = ($updatedLines -join $eol) + $eol
if ($updatedPatch -ne $patchText) {
    if ($DryRun) {
        Write-Host "[install-profile-deps] dry-run: would write the agent-presets entry in $patchPath."
    } else {
        Backup-File -Path $patchPath
        [IO.File]::WriteAllText($patchPath, $updatedPatch, [Text.UTF8Encoding]::new($false))
        Write-Host "[install-profile-deps] updated $patchPath"
    }
} else {
    Write-Host "[install-profile-deps] unchanged $patchPath"
}

if ($DryRun) {
    Write-Host "[install-profile-deps] dry-run: would run pnpm install --config.auto-install-peers=false."
    return [pscustomobject]@{ Status = 'planned'; Profile = $ProfilePath }
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { throw 'pnpm is required because the profile is a pnpm project.' }

Use-SagittaGitProxy -Proxy (Get-SagittaGitProxy)
Push-Location -LiteralPath $ProfilePath
try {
    # No --lockfile=false: the lockfile records the exact resolved commit, and it
    # is part of what makes an install reproducible.
    & pnpm install --config.auto-install-peers=false
    if ($LASTEXITCODE -ne 0) { throw "Profile package installation failed with exit code $LASTEXITCODE." }
} finally {
    Pop-Location
}

foreach ($name in $plugins.Keys) {
    $installedManifest = Join-Path $ProfilePath (Join-Path 'node_modules' (Join-Path $name 'package.json'))
    if (-not (Test-Path -LiteralPath $installedManifest -PathType Leaf)) {
        throw "Package manager completed but the dependency is not resolvable: $name"
    }
}
$presetPath = Join-Path $ProfilePath 'node_modules\@sagitta\manager\presets\sagitta'
foreach ($fileName in @('agent.cordis.yml', 'preset.yml')) {
    if (-not (Test-Path -LiteralPath (Join-Path $presetPath $fileName) -PathType Leaf)) {
        throw "Packaged preset is incomplete: $presetPath\$fileName"
    }
}
Write-Host '[install-profile-deps] dependencies installed from GitHub; preset discovery wired.'
return [pscustomobject]@{ Status = 'installed'; Profile = $ProfilePath; Repo = $Repo }
