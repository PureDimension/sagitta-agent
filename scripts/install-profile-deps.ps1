<#
  tasksPath contract (before Ripple decision ⑤):
  - An explicit -TasksPath wins.
  - Otherwise, a non-empty tasksPath already present in the profile patch is
    preserved semantically, so reinstalling the profile is idempotent.
  - A new profile uses the temporary D:\workspace\sagitta-experience\TASKS.md
    fact-source path. This is intentionally not derived from RepoPath and is
    expected to migrate to the task API after decision ⑤.

  statePath is runtime state, not repository content. New installs keep it in
  the profile directory so updater git pulls cannot collide with it; this
  follows the existing auto-advance contract that an explicit statePath wins.
#>
[CmdletBinding()]
param(
    [string]$ProfilePath = '',
    [string]$RepoPath = '',
    [string]$TasksPath = '',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Ensure-Map {
    param([System.Collections.IDictionary]$Parent, [string]$Key)
    if (-not $Parent.Contains($Key) -or $null -eq $Parent[$Key]) { $Parent[$Key] = [ordered]@{} }
    if ($Parent[$Key] -isnot [System.Collections.IDictionary]) { throw "Profile package.json field '$Key' must be an object." }
    return $Parent[$Key]
}

function Quote-Yaml {
    param([string]$Value)
    return "'$(($Value -replace "'", "''"))'"
}

function Backup-File {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $timestamp = [DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff')
    $backupPath = "$Path.bak.$timestamp"
    $index = 1
    while (Test-Path -LiteralPath $backupPath) {
        $backupPath = "$Path.bak.$timestamp.$index"
        $index++
    }
    Copy-Item -LiteralPath $Path -Destination $backupPath
    Write-Host "[install-profile-deps] backup: $backupPath"
    return $backupPath
}

function Get-PatchId {
    param([string]$Line)
    $match = [regex]::Match($Line, '^-\s+id:\s*(?:''([^'']+)''|"([^"]+)"|([^\s#]+))\s*(?:#.*)?$')
    if (-not $match.Success) { return $null }
    foreach ($index in 1..3) { if ($match.Groups[$index].Success) { return $match.Groups[$index].Value } }
    return $null
}

function Get-PatchConfigValue {
    param(
        [AllowNull()][string]$Text,
        [string]$PatchId,
        [string]$Key
    )
    if ([string]::IsNullOrEmpty($Text)) { return $null }

    $lines = @($Text -split "`r?`n")
    $keyPattern = [regex]::Escape($Key)
    for ($index = 0; $index -lt $lines.Count; $index++) {
        if ((Get-PatchId $lines[$index]) -ne $PatchId) { continue }
        $end = $index + 1
        while ($end -lt $lines.Count -and $null -eq (Get-PatchId $lines[$end])) { $end++ }
        for ($entryIndex = $index + 1; $entryIndex -lt $end; $entryIndex++) {
            $line = $lines[$entryIndex]
            $singleQuoted = [regex]::Match($line, "^\s*$keyPattern\s*:\s*'((?:''|[^'])*)'(?:\s+#.*)?$")
            if ($singleQuoted.Success) { return $singleQuoted.Groups[1].Value -replace "''", "'" }

            $doubleQuoted = [regex]::Match($line, ('^\s*' + $keyPattern + '\s*:\s*"((?:\\.|[^"])*)"(?:\s+#.*)?$'))
            if ($doubleQuoted.Success) { return $doubleQuoted.Groups[1].Value }

            $plain = [regex]::Match($line, "^\s*$keyPattern\s*:\s*(?<value>[^#]*?)\s*(?:#.*)?$")
            if ($plain.Success) {
                $value = $plain.Groups['value'].Value.Trim()
                if ($value -and $value -notin @('null', '~')) { return $value }
                return $null
            }
        }
        return $null
    }
    return $null
}

function Get-PatchBlockConfig {
    param(
        [AllowNull()][string]$Text,
        [string]$PatchId
    )
    # 返回指定 id 块的 config 字段（仅单行 key: value，保留原行文本）：id → 行
    $result = [ordered]@{}
    if ([string]::IsNullOrEmpty($Text)) { return $result }
    $lines = @($Text -split "`r?`n")
    for ($index = 0; $index -lt $lines.Count; $index++) {
        if ((Get-PatchId $lines[$index]) -ne $PatchId) { continue }
        $end = $index + 1
        while ($end -lt $lines.Count -and $null -eq (Get-PatchId $lines[$end])) { $end++ }
        for ($entryIndex = $index + 1; $entryIndex -lt $end; $entryIndex++) {
            $line = $lines[$entryIndex]
            $match = [regex]::Match($line, '^\s{2,}([A-Za-z0-9_-]+)\s*:\s*')
            if ($match.Success -and $match.Groups[1].Value -notin @('config')) {
                $result[$match.Groups[1].Value] = $line
            }
        }
        break
    }
    return $result
}

function Merge-BlockLines {
    param(
        [string[]]$NewLines,
        [AllowNull()][string[]]$ExistingLines
    )
    # 新块优先；现有块中未在新块提及的 config 字段追加保留（防抹掉手工配置）
    $newKeys = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($line in $NewLines) {
        $match = [regex]::Match($line, '^\s{2,}([A-Za-z0-9_-]+)\s*:\s*')
        if ($match.Success -and $match.Groups[1].Value -notin @('config')) {
            $null = $newKeys.Add($match.Groups[1].Value)
        }
    }
    $merged = [System.Collections.Generic.List[string]]::new()
    foreach ($line in $NewLines) { $merged.Add($line) }
    if ($null -ne $ExistingLines) {
        foreach ($line in $ExistingLines) {
            $match = [regex]::Match($line, '^\s{2,}([A-Za-z0-9_-]+)\s*:\s*')
            if ($match.Success -and $match.Groups[1].Value -notin @('config') -and -not $newKeys.Contains($match.Groups[1].Value)) {
                $merged.Add($line)
            }
        }
    }
    return $merged.ToArray()
}

function Upsert-PatchEntries {
    param([string]$Text, [System.Collections.IDictionary]$Entries)
    $eol = if ($Text.Contains("`r`n")) { "`r`n" } else { "`n" }
    $lines = @($Text -split "`r?`n")
    if ($lines.Count -gt 0 -and $lines[-1] -eq '') {
        $lines = if ($lines.Count -eq 1) { @() } else { @($lines[0..($lines.Count - 2)]) }
    }
    $output = New-Object System.Collections.Generic.List[string]
    $seen = @{}
    $index = 0
    while ($index -lt $lines.Count) {
        $id = Get-PatchId $lines[$index]
        if ($null -eq $id -or -not $Entries.Contains($id)) {
            $null = $output.Add($lines[$index])
            $index++
            continue
        }
        $end = $index + 1
        while ($end -lt $lines.Count -and $null -eq (Get-PatchId $lines[$end])) { $end++ }
        if (-not $seen.ContainsKey($id)) {
            $existingBlock = @($lines[$index..($end - 1)])
            foreach ($entryLine in (Merge-BlockLines -NewLines @($Entries[$id]) -ExistingLines $existingBlock)) {
                $null = $output.Add($entryLine)
            }
            $seen[$id] = $true
            if ($end -lt $lines.Count) { $null = $output.Add('') }
        }
        $index = $end
    }
    foreach ($entry in $Entries.GetEnumerator()) {
        if (-not $seen.ContainsKey($entry.Key)) {
            if ($output.Count -gt 0 -and $output[$output.Count - 1].Trim() -ne '') { $null = $output.Add('') }
            foreach ($entryLine in $entry.Value) { $null = $output.Add($entryLine) }
        }
    }
    if ($output.Count -eq 0) { $null = $output.Add('# Sagitta profile patch; generated id-targeted entries.') }
    return ($output -join $eol) + $eol
}

function Select-PackageManager {
    param([string]$ProfilePath)
    $pnpmLock = Test-Path -LiteralPath (Join-Path $ProfilePath 'pnpm-lock.yaml') -PathType Leaf
    $npmLock = Test-Path -LiteralPath (Join-Path $ProfilePath 'package-lock.json') -PathType Leaf
    if ($pnpmLock -and $npmLock) { throw "Profile contains both pnpm-lock.yaml and package-lock.json; refusing to guess." }
    if ($pnpmLock) {
        if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { throw 'pnpm is required because the profile has pnpm-lock.yaml.' }
        return [pscustomobject]@{ Command = 'pnpm'; Arguments = @('install', '--lockfile=false') }
    }
    if ($npmLock) {
        if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm is required because the profile has package-lock.json.' }
        return [pscustomobject]@{ Command = 'npm'; Arguments = @('install', '--no-audit', '--no-fund') }
    }
    if (Get-Command pnpm -ErrorAction SilentlyContinue) { return [pscustomobject]@{ Command = 'pnpm'; Arguments = @('install', '--lockfile=false') } }
    if (Get-Command npm -ErrorAction SilentlyContinue) { return [pscustomobject]@{ Command = 'npm'; Arguments = @('install', '--no-audit', '--no-fund') } }
    throw 'Neither pnpm nor npm is available for profile dependency installation.'
}

function Invoke-PackageInstall {
    param($PackageManager, [string]$WorkingDirectory)
    Push-Location -LiteralPath $WorkingDirectory
    try {
        $arguments = [string[]]@($PackageManager.Arguments)
        & $PackageManager.Command @arguments
        if ($LASTEXITCODE -ne 0) { throw "Profile package installation failed with exit code ${LASTEXITCODE}." }
    } finally {
        Pop-Location
    }
}

if ([string]::IsNullOrWhiteSpace($RepoPath)) {
    $RepoPath = if (-not [string]::IsNullOrWhiteSpace($env:SAGITTA_AGENT_DIR)) { $env:SAGITTA_AGENT_DIR } else { Join-Path $PSScriptRoot '..' }
}
if ([string]::IsNullOrWhiteSpace($ProfilePath)) {
    $dshHome = if (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
        $env:DSH_HOME
    } else {
        Join-Path (if ($env:USERPROFILE) { $env:USERPROFILE } else { [Environment]::GetFolderPath('UserProfile') }) '.dsh'
    }
    $ProfilePath = Join-Path $dshHome 'profiles\web'
}

$RepoPath = [IO.Path]::GetFullPath($RepoPath)
$ProfilePath = [IO.Path]::GetFullPath($ProfilePath)
$packageJsonPath = Join-Path $ProfilePath 'package.json'
$patchPath = Join-Path $ProfilePath 'cordis.patch.yml'

$plugins = [ordered]@{
    '@sagitta/manager'       = 'plugins\manager'
    '@sagitta/memory'        = 'plugins\memory'
    '@sagitta/auto-advance'  = 'plugins\auto-advance'
    '@sagitta/updater'       = 'plugins\updater'
    '@sagitta/codex-dispatch' = 'plugins\codex-dispatch'
}
$bundleNames = @(
    '@sagitta/manager'
    '@sagitta/memory'
    '@sagitta/auto-advance'
    '@sagitta/updater'
    '@sagitta/codex-dispatch'
)

Write-Host "[install-profile-deps] profile: $ProfilePath"
Write-Host "[install-profile-deps] repository: $RepoPath"
Write-Host '[install-profile-deps] bundles: @sagitta/manager, @sagitta/memory, @sagitta/auto-advance, @sagitta/updater, @sagitta/codex-dispatch'

if (-not $DryRun) {
    foreach ($relativePluginPath in $plugins.Values) {
        $pluginPath = Join-Path $RepoPath $relativePluginPath
        if (-not (Test-Path -LiteralPath (Join-Path $pluginPath 'package.json') -PathType Leaf)) {
            throw "Missing plugin package.json: $pluginPath"
        }
    }
} else {
    Write-Host '[install-profile-deps] dry-run: source package checks and package-manager execution are skipped.'
}

if (-not (Test-Path -LiteralPath $ProfilePath -PathType Container)) {
    if ($DryRun) {
        Write-Host "[install-profile-deps] dry-run: would create $ProfilePath"
    } else {
        New-Item -ItemType Directory -Force -Path $ProfilePath | Out-Null
    }
}

$packageData = if (Test-Path -LiteralPath $packageJsonPath -PathType Leaf) {
    try {
        Get-Content -LiteralPath $packageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    } catch {
        throw "Invalid profile package.json: $packageJsonPath"
    }
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

$dependencies = Ensure-Map -Parent $packageData -Key 'dependencies'
foreach ($entry in $plugins.GetEnumerator()) {
    $pluginPath = Join-Path $RepoPath $entry.Value
    $relativePath = [IO.Path]::GetRelativePath($ProfilePath, $pluginPath).Replace('\', '/')
    if ([IO.Path]::IsPathRooted($relativePath)) {
        # A relative path cannot cross Windows drive volumes; use an absolute
        # file spec in that case instead of producing the invalid ./D:/... form.
        $dependencies[$entry.Key] = "file:$($pluginPath.Replace('\', '/'))"
    } else {
        if (-not $relativePath.StartsWith('.')) { $relativePath = "./$relativePath" }
        $dependencies[$entry.Key] = "file:$relativePath"
    }
}

$dsh = Ensure-Map -Parent $packageData -Key 'dsh'
$profile = Ensure-Map -Parent $dsh -Key 'profile'
$existingBundles = if ($profile.Contains('bundles') -and $null -ne $profile['bundles']) { @($profile['bundles']) } else { @() }
$preservedBundles = @($existingBundles | Where-Object { $_ -notin $bundleNames })
$profile['bundles'] = @($preservedBundles + $bundleNames)

$packageBefore = if (Test-Path -LiteralPath $packageJsonPath -PathType Leaf) {
    Get-Content -LiteralPath $packageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable | ConvertTo-Json -Depth 100 -Compress
} else { '' }
$packageAfter = $packageData | ConvertTo-Json -Depth 100 -Compress
if ($packageBefore -ne $packageAfter) {
    if ($DryRun) {
        Write-Host "[install-profile-deps] dry-run: would update $packageJsonPath (backup required before write)."
    } else {
        $null = Backup-File -Path $packageJsonPath
        ($packageData | ConvertTo-Json -Depth 100) + "`n" | Set-Content -LiteralPath $packageJsonPath -Encoding UTF8
        Write-Host "[install-profile-deps] updated $packageJsonPath"
    }
} else {
    Write-Host "[install-profile-deps] unchanged $packageJsonPath"
}

$existingPatch = if (Test-Path -LiteralPath $patchPath -PathType Leaf) { Get-Content -LiteralPath $patchPath -Raw -Encoding UTF8 } else { '' }
$existingTasksPath = Get-PatchConfigValue -Text $existingPatch -PatchId 'sagitta-auto-advance' -Key 'tasksPath'
$effectiveTasksPath = if (-not [string]::IsNullOrWhiteSpace($TasksPath)) {
    $TasksPath
} elseif (-not [string]::IsNullOrWhiteSpace($existingTasksPath)) {
    $existingTasksPath
} else {
    # Temporary fact-source contract until Ripple decision ⑤ moves the panel
    # from TASKS.md fallback to the manager-backed task API.
    'D:\workspace\sagitta-experience\TASKS.md'
}

$repoPathYaml = Quote-Yaml $RepoPath
$profilePathYaml = Quote-Yaml (Join-Path $ProfilePath '')
# statePath：现值优先（幂等，不改变已有运行语义）；新装才放 profile 内（防 updater pull 冲突）。
$existingStatePath = Get-PatchConfigValue -Text $existingPatch -PatchId 'sagitta-auto-advance' -Key 'statePath'
$statePath = if (-not [string]::IsNullOrWhiteSpace($existingStatePath)) { $existingStatePath } else { Join-Path $ProfilePath '.sagitta-auto-advance.json' }
$statePathYaml = Quote-Yaml $statePath
$tasksPathYaml = Quote-Yaml $effectiveTasksPath
$dshHomeFromProfile = Split-Path -Parent (Split-Path -Parent $ProfilePath)
$presetTargetYaml = Quote-Yaml (Join-Path $dshHomeFromProfile '.agent-presets\sagitta')

# memory.proxy：现值优先（幂等）；缺失时默认本机 clash 混合端口 7897——
# 本机 Node 直连 workers.dev 被墙，必须走代理，空串会解析成 direct 导致 20s 超时（08-30 实证）。
$existingMemoryProxy = Get-PatchConfigValue -Text $existingPatch -PatchId 'memory' -Key 'proxy'
$memoryProxy = if (-not [string]::IsNullOrWhiteSpace($existingMemoryProxy)) { $existingMemoryProxy } else { 'http://127.0.0.1:7897' }
$memoryProxyYaml = Quote-Yaml $memoryProxy
# sagitta-manager.workerApiUrl：现值优先，缺失给空（由用户在 Settings 里配置）。
$existingWorkerApiUrl = Get-PatchConfigValue -Text $existingPatch -PatchId 'sagitta-manager' -Key 'workerApiUrl'
$workerApiUrl = if (-not [string]::IsNullOrWhiteSpace($existingWorkerApiUrl)) { $existingWorkerApiUrl } else { '' }
$workerApiUrlYaml = Quote-Yaml $workerApiUrl

$patchEntries = [ordered]@{
    'agent-presets' = @(
        '- id: agent-presets'
        '  config:'
        '    default: sagitta'
    )
    'sagitta-manager' = @(
        '- id: sagitta-manager'
        '  config:'
        "    workerApiUrl: $workerApiUrlYaml"
    )
    'memory' = @(
        '- id: memory'
        '  config:'
        "    proxy: $memoryProxyYaml   # clash 混合端口；'direct' 或空串 = 直连"
        '    timeoutMs: 20000'
    )
    'sagitta-auto-advance' = @(
        '- id: sagitta-auto-advance'
        '  config:'
        '    idleTimeoutMs: 300000'
        "    statePath: $statePathYaml"
        "    tasksPath: $tasksPathYaml"
        '    taskFallback: true'
    )
    'sagitta-updater' = @(
        '- id: sagitta-updater'
        '  config:'
        "    repoPath: $repoPathYaml"
        "    path: $repoPathYaml"
        '    branch: main'
        "    presetId: 'sagitta'"
        "    presetTarget: $presetTargetYaml"
        "    profileName: 'web'"
        "    profileDir: $profilePathYaml"
        "    restartPolicy: 'prompt'"
        '    workerDeploy: true'
    )
    'sagitta-codex' = @(
        '- id: sagitta-codex'
        '  config:'
        "    defaultModel: 'gpt-5.6-luna'"
    )
}

$updatedPatch = Upsert-PatchEntries -Text $existingPatch -Entries $patchEntries
if ($updatedPatch -ne $existingPatch) {
    if ($DryRun) {
        Write-Host "[install-profile-deps] dry-run: would update $patchPath with id-targeted entries (backup required before write)."
    } else {
        $null = Backup-File -Path $patchPath
        $updatedPatch | Set-Content -LiteralPath $patchPath -Encoding UTF8 -NoNewline
        Write-Host "[install-profile-deps] updated $patchPath"
    }
} else {
    Write-Host "[install-profile-deps] unchanged $patchPath"
}

$packageManager = Select-PackageManager -ProfilePath $ProfilePath
if ($DryRun) {
    Write-Host "[install-profile-deps] dry-run: would run $($packageManager.Command) $($packageManager.Arguments -join ' ')"
    return [pscustomobject]@{ Status = 'planned'; Profile = $ProfilePath; PackageManager = $packageManager.Command }
}

Invoke-PackageInstall -PackageManager $packageManager -WorkingDirectory $ProfilePath
foreach ($packageName in $plugins.Keys) {
    $installedPath = Join-Path $ProfilePath (Join-Path 'node_modules' $packageName)
    if (-not (Test-Path -LiteralPath $installedPath)) {
        throw "Package manager completed but the local plugin is not resolvable: $packageName"
    }
}
Write-Host '[install-profile-deps] local plugin dependencies are resolvable.'
return [pscustomobject]@{ Status = 'installed'; Profile = $ProfilePath; PackageManager = $packageManager.Command }
