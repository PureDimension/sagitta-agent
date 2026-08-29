[CmdletBinding()]
param(
    [string]$DshHome = '',
    [string]$RepoPath = '',
    [string]$PresetId = 'sagitta',
    [switch]$ForceSyncPreset,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Get-BackupTimestamp {
    return [DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff')
}

function Get-UniqueBackupPath {
    param([string]$Path, [string]$Timestamp)
    $candidate = "$Path.bak.$Timestamp"
    $index = 1
    while (Test-Path -LiteralPath $candidate) {
        $candidate = "$Path.bak.$Timestamp.$index"
        $index++
    }
    return $candidate
}

function Get-TextSha256 {
    param([AllowNull()][string]$Value)
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}

function Expand-PresetTemplate {
    param(
        [AllowNull()][string]$Content,
        [System.Collections.IDictionary]$Variables,
        [string]$SourceName
    )

    $warnings = [System.Collections.Generic.List[string]]::new()
    $expanded = [regex]::Replace($Content, '<([^<>]+)>', {
        param($Match)
        $name = $Match.Groups[1].Value
        if ($Variables.Contains($name) -and $null -ne $Variables[$name]) {
            return [string]$Variables[$name]
        }

        $warning = "${SourceName}: 未定义 preset 模板变量 <$name>，保留原样。"
        if (-not $warnings.Contains($warning)) {
            $warnings.Add($warning)
            Write-Warning $warning
        }
        return $Match.Value
    })

    return [pscustomobject]@{
        Content  = $expanded
        Warnings = @($warnings)
    }
}

function Write-PresetContent {
    param(
        [string]$Path,
        [AllowNull()][string]$Content
    )
    [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function Read-Marker {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try {
        $value = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
        if ($value -isnot [System.Collections.IDictionary]) { return $null }
        if ($value['managedBy'] -ne 'sagitta-agent' -or $value['presetId'] -ne $PresetId) { return $null }
        return $value
    } catch {
        return $null
    }
}

function Test-MarkerSource {
    param($Marker, [System.Collections.IDictionary]$SourceHashes)
    if (-not $Marker.ContainsKey('sourceHash') -or $null -eq $Marker['sourceHash']) { return $false }
    foreach ($fileName in $sourceFiles) {
        if ($Marker['sourceHash'][$fileName] -ne $SourceHashes[$fileName]) { return $false }
    }
    return $true
}

function Test-MarkerTarget {
    param($Marker, [string]$TargetPath, [string[]]$FileNames)
    if (-not $Marker.ContainsKey('targetHash') -or $null -eq $Marker['targetHash']) { return $false }
    foreach ($fileName in $FileNames) {
        $targetFile = Join-Path $TargetPath $fileName
        if (-not (Test-Path -LiteralPath $targetFile -PathType Leaf)) { return $false }
        $actualHash = (Get-FileHash -LiteralPath $targetFile -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($Marker['targetHash'][$fileName] -ne $actualHash) { return $false }
    }
    return $true
}

function Write-Marker {
    param([string]$Path, [string]$TargetRoot, [System.Collections.IDictionary]$SourceHashes)
    $targetHashes = [ordered]@{}
    foreach ($fileName in $sourceFiles) {
        $targetHashes[$fileName] = (Get-FileHash -LiteralPath (Join-Path $TargetRoot $fileName) -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $marker = [ordered]@{
        managedBy  = 'sagitta-agent'
        presetId   = $PresetId
        sourceHash = $SourceHashes
        targetHash = $targetHashes
        updatedAt  = [DateTime]::UtcNow.ToString('o')
    }
    $temporaryPath = "$Path.tmp.$PID"
    $marker | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
    Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
}

if ([string]::IsNullOrWhiteSpace($DshHome)) {
    $DshHome = if (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
        $env:DSH_HOME
    } else {
        Join-Path (if ($env:USERPROFILE) { $env:USERPROFILE } else { [Environment]::GetFolderPath('UserProfile') }) '.dsh'
    }
}
if ([string]::IsNullOrWhiteSpace($RepoPath)) {
    $RepoPath = if (-not [string]::IsNullOrWhiteSpace($env:SAGITTA_AGENT_DIR)) {
        $env:SAGITTA_AGENT_DIR
    } else {
        Join-Path $PSScriptRoot '..'
    }
}

$DshHome = [IO.Path]::GetFullPath($DshHome)
$RepoPath = [IO.Path]::GetFullPath($RepoPath)
$sourcePath = Join-Path $RepoPath "presets\$PresetId"
$targetPath = Join-Path $DshHome ".agent-presets\$PresetId"
$sourceFiles = @('agent.cordis.yml', 'preset.yml')
$userProfile = if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
    [IO.Path]::GetFullPath($env:USERPROFILE)
} else {
    [IO.Path]::GetFullPath([Environment]::GetFolderPath('UserProfile'))
}
$templateVariables = [ordered]@{
    # Keep these names in lockstep with plugins/updater/lib/preset.js.
    SAGITTA_PROJECT_ROOT = $RepoPath
    SAGITTA_AGENT_DIR    = $RepoPath
    USERPROFILE          = $userProfile
    DSH_HOME             = $DshHome
}

foreach ($fileName in $sourceFiles) {
    $path = Join-Path $sourcePath $fileName
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Missing source preset file: $path"
    }
}

$expandedSourceContents = [ordered]@{}
$sourceWarnings = [System.Collections.Generic.List[string]]::new()
$sourceHashes = [ordered]@{}
foreach ($fileName in $sourceFiles) {
    $sourceFile = Join-Path $sourcePath $fileName
    $expanded = Expand-PresetTemplate -Content (Get-Content -LiteralPath $sourceFile -Raw -Encoding UTF8) -Variables $templateVariables -SourceName $fileName
    $expandedSourceContents[$fileName] = $expanded.Content
    foreach ($warning in $expanded.Warnings) {
        if (-not $sourceWarnings.Contains($warning)) { $sourceWarnings.Add($warning) }
    }
    $sourceHashes[$fileName] = Get-TextSha256 -Value $expanded.Content
}

Write-Host "[sync-preset] source: $sourcePath"
Write-Host "[sync-preset] target: $targetPath"

if (-not (Test-Path -LiteralPath $targetPath -PathType Container)) {
    if ($DryRun) {
        Write-Host '[sync-preset] dry-run: would create the user preset and ownership marker.'
        return [pscustomobject]@{ Status = 'would-create'; Target = $targetPath; TemplateWarnings = @($sourceWarnings) }
    }
    New-Item -ItemType Directory -Force -Path $targetPath | Out-Null
    foreach ($fileName in $sourceFiles) {
        Write-PresetContent -Path (Join-Path $targetPath $fileName) -Content $expandedSourceContents[$fileName]
    }
    Write-Marker -Path (Join-Path $targetPath '.sagitta-managed.json') -TargetRoot $targetPath -SourceHashes $sourceHashes
    Write-Host '[sync-preset] created user preset (owned by sagitta-agent).'
    return [pscustomobject]@{ Status = 'created'; Target = $targetPath; TemplateWarnings = @($sourceWarnings) }
}

$markerPath = Join-Path $targetPath '.sagitta-managed.json'
$marker = Read-Marker -Path $markerPath
$ownedAndClean = $null -ne $marker -and (Test-MarkerTarget -Marker $marker -TargetPath $targetPath -FileNames $sourceFiles)
$sameSource = $ownedAndClean -and (Test-MarkerSource -Marker $marker -SourceHashes $sourceHashes)

if ($sameSource) {
    Write-Host '[sync-preset] unchanged: owned preset already matches repository source.'
    return [pscustomobject]@{ Status = 'unchanged'; Target = $targetPath; TemplateWarnings = @($sourceWarnings) }
}

if (-not $ownedAndClean -and -not $ForceSyncPreset) {
    $candidatePath = Join-Path (Split-Path -Parent $targetPath) ".${PresetId}-update-candidate.$($sourceHashes['agent.cordis.yml'].Substring(0, 12))"
    if ($DryRun) {
        Write-Host "[sync-preset] dry-run: existing user preset is not owned/clean; would leave it untouched and stage a candidate at $candidatePath"
    } elseif (-not (Test-Path -LiteralPath $candidatePath -PathType Container)) {
        New-Item -ItemType Directory -Force -Path $candidatePath | Out-Null
        foreach ($fileName in $sourceFiles) {
            Write-PresetContent -Path (Join-Path $candidatePath $fileName) -Content $expandedSourceContents[$fileName]
        }
        Write-Marker -Path (Join-Path $candidatePath '.sagitta-managed.json') -TargetRoot $candidatePath -SourceHashes $sourceHashes
        Write-Host "[sync-preset] preserved user preset; candidate staged at $candidatePath"
    } else {
        Write-Host "[sync-preset] preserved user preset; candidate already exists at $candidatePath"
    }
    return [pscustomobject]@{ Status = 'preserved-user-preset'; Target = $targetPath; Candidate = $candidatePath; TemplateWarnings = @($sourceWarnings) }
}

if ($DryRun) {
    Write-Host "[sync-preset] dry-run: would back up and update owned preset at $targetPath"
    return [pscustomobject]@{ Status = 'would-update'; Target = $targetPath; TemplateWarnings = @($sourceWarnings) }
}

$timestamp = Get-BackupTimestamp
foreach ($fileName in $sourceFiles) {
    $targetFile = Join-Path $targetPath $fileName
    if (Test-Path -LiteralPath $targetFile -PathType Leaf) {
        Copy-Item -LiteralPath $targetFile -Destination (Get-UniqueBackupPath -Path $targetFile -Timestamp $timestamp)
    }
}
if (Test-Path -LiteralPath $markerPath -PathType Leaf) {
    Copy-Item -LiteralPath $markerPath -Destination (Get-UniqueBackupPath -Path $markerPath -Timestamp $timestamp)
}
foreach ($fileName in $sourceFiles) {
    Write-PresetContent -Path (Join-Path $targetPath $fileName) -Content $expandedSourceContents[$fileName]
}
Write-Marker -Path $markerPath -TargetRoot $targetPath -SourceHashes $sourceHashes
Write-Host '[sync-preset] updated owned preset; backups were created before replacement.'
return [pscustomobject]@{ Status = 'updated'; Target = $targetPath; TemplateWarnings = @($sourceWarnings) }
