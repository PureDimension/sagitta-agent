[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Assert-Same {
    param($Expected, $Actual, [string]$Message)
    if ($Expected -cne $Actual) {
        throw "ASSERT FAILED: $Message`nExpected: $Expected`nActual:   $Actual"
    }
}

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "ASSERT FAILED: $Message" }
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) "sagitta-preset-smoke-$([Guid]::NewGuid().ToString('N'))"
$repoPath = Join-Path $tempRoot 'repo'
$sourceDir = Join-Path $repoPath 'presets\sagitta'
$dshHome = Join-Path $tempRoot 'dsh-home'
$targetDir = Join-Path $dshHome '.agent-presets\sagitta'
$syncScript = Join-Path $PSScriptRoot 'sync-preset.ps1'

try {
    New-Item -ItemType Directory -Force -Path $sourceDir | Out-Null
    $agentSource = @'
# <SAGITTA_AGENT_DIR> and <DSH_HOME> are also part of the template contract.
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      Read <SAGITTA_PROJECT_ROOT>\TASKS.md and <USERPROFILE>\.ssh\config.
      Unknown value: <UNKNOWN_TEMPLATE>
'@
    $metadataSource = @'
name: sagitta
description: smoke
order: 1
'@
    [IO.File]::WriteAllText((Join-Path $sourceDir 'agent.cordis.yml'), $agentSource, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $sourceDir 'preset.yml'), $metadataSource, [Text.UTF8Encoding]::new($false))

    $invocationOutput = @(& $syncScript -DshHome $dshHome -RepoPath $repoPath 3>&1)
    $warningRecords = @($invocationOutput | Where-Object { $_ -is [System.Management.Automation.WarningRecord] })
    $result = @($invocationOutput | Where-Object { $_.PSObject.Properties.Name -contains 'Status' }) | Select-Object -Last 1
    Assert-Same 'created' $result.Status 'PS sync creates the temporary preset'

    $expectedRepo = [IO.Path]::GetFullPath($repoPath)
    $expectedDshHome = [IO.Path]::GetFullPath($dshHome)
    $expectedUserProfile = if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        [IO.Path]::GetFullPath($env:USERPROFILE)
    } else {
        [IO.Path]::GetFullPath([Environment]::GetFolderPath('UserProfile'))
    }
    $targetContent = Get-Content -LiteralPath (Join-Path $targetDir 'agent.cordis.yml') -Raw -Encoding UTF8
    Assert-True $targetContent.Contains((Join-Path $expectedRepo 'TASKS.md')) 'project root is expanded in PS output'
    Assert-True $targetContent.Contains((Join-Path $expectedUserProfile '.ssh\config')) 'user profile is expanded in PS output'
    Assert-True $targetContent.Contains($expectedRepo) 'SAGITTA_AGENT_DIR is expanded in PS output'
    Assert-True $targetContent.Contains($expectedDshHome) 'DSH_HOME is expanded in PS output'
    Assert-True (-not $targetContent.Contains('<SAGITTA_PROJECT_ROOT>')) 'project root placeholder is absent from PS output'
    Assert-True (-not $targetContent.Contains('<USERPROFILE>')) 'user profile placeholder is absent from PS output'
    Assert-True $targetContent.Contains('<UNKNOWN_TEMPLATE>') 'unknown placeholder is preserved in PS output'

    $warningText = ($warningRecords | ForEach-Object { $_.ToString() }) -join "`n"
    Assert-True $warningText.Contains('UNKNOWN_TEMPLATE') 'unknown placeholder is recorded as a PS warning'

    $marker = Get-Content -LiteralPath (Join-Path $targetDir '.sagitta-managed.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $agentHash = (Get-FileHash -LiteralPath (Join-Path $targetDir 'agent.cordis.yml') -Algorithm SHA256).Hash.ToLowerInvariant()
    Assert-Same $agentHash $marker.targetHash.'agent.cordis.yml' 'PS marker target hash matches expanded file'
    Assert-Same $agentHash $marker.sourceHash.'agent.cordis.yml' 'PS marker source hash matches expanded content'

    Write-Host 'PS sync-preset smoke passed.'
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
