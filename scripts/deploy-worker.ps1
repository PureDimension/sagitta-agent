[CmdletBinding()]
param(
    [ValidateSet('Direct', 'Wrangler')]
    [string]$Mode = 'Direct',
    [string]$RepoPath = '',
    [string]$WorkerPath = '',
    [string]$ReferencePath = '',
    [string]$WranglerConfigPath = '',
    [string]$WorkerApiUrl = '',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Read-ReferenceConfig {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return @{} }
    try {
        $value = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
        if ($value -is [System.Collections.IDictionary]) { return $value }
    } catch {
        throw "Invalid Worker reference JSON: $Path"
    }
    throw "Worker reference JSON must contain an object: $Path"
}

function Test-RealValue {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    return $Value -notmatch '(?i)(REPLACE_WITH|YOUR_|CHANGE_ME|TODO|<[^>]+>|\{\{[^}]+\}\})'
}

function Find-Wrangler {
    $command = Get-Command wrangler -ErrorAction SilentlyContinue
    if ($command) { return $command.Path }
    foreach ($candidate in @(
        (Join-Path $RepoPath 'node_modules\.bin\wrangler.ps1'),
        (Join-Path $RepoPath 'node_modules\.bin\wrangler.cmd')
    )) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    throw 'Wrangler is not available; install it locally or on PATH before using -Mode Wrangler.'
}

if ([string]::IsNullOrWhiteSpace($RepoPath)) { $RepoPath = Join-Path $PSScriptRoot '..' }
$RepoPath = [IO.Path]::GetFullPath($RepoPath)
if ([string]::IsNullOrWhiteSpace($WorkerPath)) { $WorkerPath = Join-Path $RepoPath 'worker\worker.js' }
if ([string]::IsNullOrWhiteSpace($ReferencePath)) { $ReferencePath = Join-Path $RepoPath 'worker\reference\account.example.json' }
if ([string]::IsNullOrWhiteSpace($WranglerConfigPath)) { $WranglerConfigPath = Join-Path $RepoPath 'worker\wrangler.toml' }

$WorkerPath = [IO.Path]::GetFullPath($WorkerPath)
$ReferencePath = [IO.Path]::GetFullPath($ReferencePath)
$WranglerConfigPath = [IO.Path]::GetFullPath($WranglerConfigPath)
if (-not (Test-Path -LiteralPath $WorkerPath -PathType Leaf)) {
    if ($DryRun) { Write-Host "[deploy-worker] dry-run: Worker source is not present yet; expected $WorkerPath" }
    else { throw "Worker source file is missing: $WorkerPath" }
}

$reference = Read-ReferenceConfig -Path $ReferencePath
$accountId = if (-not [string]::IsNullOrWhiteSpace($env:CF_ACCOUNT_ID)) { $env:CF_ACCOUNT_ID } else { [string]$reference['accountId'] }
$scriptName = if (-not [string]::IsNullOrWhiteSpace($env:CF_SCRIPT_NAME)) { $env:CF_SCRIPT_NAME } else { [string]$reference['scriptName'] }
if ([string]::IsNullOrWhiteSpace($WorkerApiUrl)) {
    $WorkerApiUrl = if (-not [string]::IsNullOrWhiteSpace($env:SAGITTA_WORKER_API_URL)) { $env:SAGITTA_WORKER_API_URL } else { [string]$reference['workerApiUrl'] }
}

Write-Host "[deploy-worker] mode: $Mode"
Write-Host "[deploy-worker] worker source: $WorkerPath"

if ($Mode -eq 'Direct') {
    $tokenConfigured = -not [string]::IsNullOrWhiteSpace($env:CLOUDFLARE_API_TOKEN)
    $accountConfigured = Test-RealValue $accountId
    $scriptConfigured = Test-RealValue $scriptName
    if ($DryRun) {
        Write-Host "[deploy-worker] dry-run: direct PUT planned (token configured: $tokenConfigured; account configured: $accountConfigured; script configured: $scriptConfigured)."
        if ($accountConfigured -and $scriptConfigured) { Write-Host '[deploy-worker] dry-run: endpoint path is Cloudflare Workers Scripts API; token value is not displayed.' }
    } else {
        if (-not $tokenConfigured) { throw 'CLOUDFLARE_API_TOKEN is not set; refusing to deploy.' }
        if (-not $accountConfigured) { throw 'CF_ACCOUNT_ID is missing or still a placeholder; refusing to deploy.' }
        if (-not $scriptConfigured) { throw 'CF_SCRIPT_NAME is missing or still a placeholder; refusing to deploy.' }
        $endpoint = "https://api.cloudflare.com/client/v4/accounts/$([uri]::EscapeDataString($accountId))/workers/scripts/$([uri]::EscapeDataString($scriptName))"
        try {
            Invoke-WebRequest -Uri $endpoint -Method Put -Headers @{ Authorization = "Bearer $($env:CLOUDFLARE_API_TOKEN)" } -ContentType 'application/javascript' -InFile $WorkerPath -ErrorAction Stop | Out-Null
        } catch {
            throw 'Cloudflare direct PUT failed; see the HTTP status from the deployment environment without exposing the token.'
        }
        Write-Host '[deploy-worker] direct PUT completed.'
    }
} else {
    if (-not (Test-Path -LiteralPath $WranglerConfigPath -PathType Leaf)) {
        if ($DryRun) {
            Write-Host "[deploy-worker] dry-run: Wrangler config is not present yet; expected $WranglerConfigPath"
        } else {
            throw "Wrangler config is missing: $WranglerConfigPath (copy the example and fill placeholders locally)."
        }
    }
    if ($DryRun) {
        Write-Host "[deploy-worker] dry-run: would run wrangler deploy --config $WranglerConfigPath"
    } else {
        $wrangler = Find-Wrangler
        Push-Location -LiteralPath (Split-Path -Parent $WorkerPath)
        try {
            & $wrangler deploy --config $WranglerConfigPath
            if ($LASTEXITCODE -ne 0) { throw "Wrangler deploy failed with exit code ${LASTEXITCODE}." }
        } finally {
            Pop-Location
        }
        Write-Host '[deploy-worker] Wrangler deploy completed.'
    }
}

if (Test-RealValue $WorkerApiUrl) {
    if ($DryRun) {
        Write-Host '[deploy-worker] dry-run: would GET /mem/health after deployment.'
    } else {
        $healthUri = ([Uri]::new(($WorkerApiUrl.TrimEnd('/') + '/mem/health'))).AbsoluteUri
        try {
            $health = Invoke-WebRequest -Uri $healthUri -Method Get -ErrorAction Stop
            if ([int]$health.StatusCode -lt 200 -or [int]$health.StatusCode -ge 300) { throw 'non-success status' }
            Write-Host '[deploy-worker] health check passed.'
        } catch {
            throw 'Worker upload completed, but the /mem/health check failed; deployment is not considered verified.'
        }
    }
} else {
    Write-Host '[deploy-worker] health check skipped: SAGITTA_WORKER_API_URL is not configured.'
}

return [pscustomobject]@{ Status = if ($DryRun) { 'planned' } else { 'deployed' }; Mode = $Mode; Worker = $WorkerPath }
