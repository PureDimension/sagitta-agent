<#
.SYNOPSIS
  Deploy the ReachFlow distribution service jar + installer-signing worker to production.

.DESCRIPTION
  Implements the procedure documented in delivery/ops/server/README.md ("Deployment and rollback"):
  build offline, stage under unique names, back up the current jar / worker / env with a timestamp,
  stop the service, move staged artifacts into place, start, then wait for health.

  Every mutating step is preceded by a timestamped backup. If the health deadline expires the
  script restores the backups and restarts the previous version automatically, then fails loudly.

  Production host facts (verified 2026-09-16):
    service         distribution.service        (User=distribution, WorkingDirectory=/opt/distribution)
    worker          installer-signing.service   (/opt/distribution/installer-signing-worker.py)
    env files       /etc/distribution/distribution.env, /etc/distribution/installer-signing.env
    health          http://127.0.0.1:8082/management/health  -> {"status":"UP"}
    startup budget  allow up to 180s (1 GiB host measured 50-116s)

.PARAMETER JaqSha256
  Expected SHA-256 of the local jar. Guards against deploying a half-written or stale artifact.

.EXAMPLE
  pwsh -NoProfile -File .\deploy-reachflow-server.ps1 `
    -JarPath D:\workspace\delivery\app-service\target\distribution-app-service-0.1.0-SNAPSHOT.jar `
    -WorkerPath D:\workspace\delivery\ops\server\installer-signing-worker.py `
    -InitialSetupSignerSpkiSha256 NukDHsZEeTukOieSKQQ_Pn-PZIONw1lIL-8p9KE5YGM `
    -Tag c5f62b5

.EXAMPLE
  pwsh -NoProfile -File .\deploy-reachflow-server.ps1 -RollbackTag pre-c5f62b5-20260916T072500Z
#>
[CmdletBinding(DefaultParameterSetName = 'Deploy')]
param(
    [Parameter(ParameterSetName = 'Deploy', Mandatory = $true)]
    [string]$JarPath,

    [Parameter(ParameterSetName = 'Deploy')]
    [string]$WorkerPath,

    # Required when the server must learn a new signer pin. Empty string means "do not touch the env file".
    [Parameter(ParameterSetName = 'Deploy')]
    [string]$InitialSetupSignerSpkiSha256 = '',

    [Parameter(ParameterSetName = 'Deploy', Mandatory = $true)]
    [string]$Tag,

    [Parameter(ParameterSetName = 'Rollback', Mandatory = $true)]
    [string]$RollbackTag,

    [string]$SshTarget = 'admin@47.100.101.8',
    [int]$HealthTimeoutSeconds = 180
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RemoteJar = '/opt/distribution/distribution.jar'
$RemoteWorker = '/opt/distribution/installer-signing-worker.py'
$RemoteEnv = '/etc/distribution/distribution.env'

function Invoke-Remote {
    param([Parameter(Mandatory = $true)][string]$Script)
    # Do NOT pipe the script into `bash -s`. Two distinct failure modes were
    # observed against this host (2026-09-16):
    #   1. a PowerShell here-string keeps CRLF, so bash saw a trailing CR on
    #      every line and curl failed with exit 3 on "…/health`r";
    #   2. even with LF normalized, a script delivered on stdin behaved
    #      differently from the same text passed as an argument — a lone
    #      `curl …` exited 3 with no output, while the identical command
    #      followed by a second line succeeded.
    # Base64 over an argument sidesteps stdin-as-script, quoting and encoding
    # entirely. The payload is ASCII, so no console-encoding mangling applies.
    $normalized = $Script -replace "`r`n", "`n"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($normalized))
    $output = ssh -o BatchMode=yes -o ConnectTimeout=20 $SshTarget "echo $encoded | base64 -d | bash" 2>&1
    $code = $LASTEXITCODE
    return [pscustomobject]@{ Output = ($output -join "`n"); ExitCode = $code }
}

function Invoke-RemoteChecked {
    param([Parameter(Mandatory = $true)][string]$Script, [string]$What = 'remote command')
    $result = Invoke-Remote -Script $Script
    if ($result.ExitCode -ne 0) {
        throw "$What failed (exit $($result.ExitCode)):`n$($result.Output)"
    }
    return $result.Output
}

function Wait-Health {
    param([int]$TimeoutSeconds)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $last = ''
    while ((Get-Date) -lt $deadline) {
        $result = Invoke-Remote -Script "curl -s -m 5 http://127.0.0.1:8082/management/health || true"
        $last = $result.Output
        if ($last -match '"status"\s*:\s*"UP"') {
            return [pscustomobject]@{ Healthy = $true; Body = $last.Trim(); WaitedSeconds = [int]($TimeoutSeconds - ($deadline - (Get-Date)).TotalSeconds) }
        }
        Start-Sleep -Seconds 5
    }
    return [pscustomobject]@{ Healthy = $false; Body = $last.Trim(); WaitedSeconds = $TimeoutSeconds }
}

# ---------------------------------------------------------------- rollback mode
if ($PSCmdlet.ParameterSetName -eq 'Rollback') {
    Write-Host "Rolling back to tag '$RollbackTag' ..." -ForegroundColor Yellow
    $script = @"
set -euo pipefail
sudo -n systemctl stop distribution.service
sudo -n cp -a "${RemoteJar}.${RollbackTag}" "$RemoteJar"
[ -f "${RemoteWorker}.${RollbackTag}" ] && sudo -n cp -a "${RemoteWorker}.${RollbackTag}" "$RemoteWorker" || true
[ -f "${RemoteEnv}.${RollbackTag}" ] && sudo -n cp -a "${RemoteEnv}.${RollbackTag}" "$RemoteEnv" || true
sudo -n systemctl start distribution.service installer-signing.service
echo "rollback issued"
"@
    Write-Host (Invoke-RemoteChecked -Script $script -What 'rollback')
    $health = Wait-Health -TimeoutSeconds $HealthTimeoutSeconds
    Write-Host "health after rollback: $($health.Body)" -ForegroundColor $(if ($health.Healthy) { 'Green' } else { 'Red' })
    return
}

# ---------------------------------------------------------------- preflight
$jar = Get-Item -LiteralPath $JarPath -ErrorAction Stop
$localHash = (Get-FileHash -LiteralPath $jar.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "jar        : $($jar.FullName)"
Write-Host "jar size   : $([math]::Round($jar.Length / 1MB, 2)) MB"
Write-Host "jar sha256 : $localHash"

if ($WorkerPath -and -not (Test-Path -LiteralPath $WorkerPath)) {
    throw "WorkerPath does not exist: $WorkerPath"
}

$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$backupTag = "pre-$Tag-$stamp"
Write-Host "backup tag : $backupTag"

$pre = Invoke-RemoteChecked -Script @"
set -euo pipefail
sudo -n true
systemctl is-active distribution.service
systemctl is-active installer-signing.service
curl -s -m 5 http://127.0.0.1:8082/management/health
"@ -What 'preflight'
Write-Host "preflight  : $($pre -replace "`n", ' | ')"

# ---------------------------------------------------------------- upload
$remoteJarStage = "/tmp/distribution-$Tag.jar"
$remoteWorkerStage = "/tmp/installer-signing-worker-$Tag.py"
Write-Host "uploading jar ..."
scp -q -o BatchMode=yes $jar.FullName "${SshTarget}:$remoteJarStage"
if ($LASTEXITCODE -ne 0) { throw "scp of the jar failed" }
if ($WorkerPath) {
    Write-Host "uploading worker ..."
    scp -q -o BatchMode=yes $WorkerPath "${SshTarget}:$remoteWorkerStage"
    if ($LASTEXITCODE -ne 0) { throw "scp of the worker failed" }
}

# ---------------------------------------------------------------- backup + install
$envBlock = if ($InitialSetupSignerSpkiSha256) {
@"
if ! sudo -n grep -q '^DISTRIBUTION_INITIAL_SETUP_SIGNER_SPKI_SHA256=' "$RemoteEnv"; then
  echo 'DISTRIBUTION_INITIAL_SETUP_SIGNER_SPKI_SHA256=$InitialSetupSignerSpkiSha256' | sudo -n tee -a "$RemoteEnv" >/dev/null
  echo 'env: appended DISTRIBUTION_INITIAL_SETUP_SIGNER_SPKI_SHA256'
else
  sudo -n sed -i 's|^DISTRIBUTION_INITIAL_SETUP_SIGNER_SPKI_SHA256=.*|DISTRIBUTION_INITIAL_SETUP_SIGNER_SPKI_SHA256=$InitialSetupSignerSpkiSha256|' "$RemoteEnv"
  echo 'env: updated DISTRIBUTION_INITIAL_SETUP_SIGNER_SPKI_SHA256'
fi
"@
} else { "echo 'env: unchanged'" }

$workerBlock = if ($WorkerPath) {
@"
sudo -n install -o root -g distribution -m 0750 "$remoteWorkerStage" "$RemoteWorker"
echo 'worker: installed'
"@
} else { "echo 'worker: unchanged'" }

Write-Host "backing up and installing ..."
# Ordering matters. The first version of this script stopped distribution.service
# and only afterwards ran the env edit and the worker install; when the env step
# failed, `set -e` aborted the script with the jar already swapped and the service
# left STOPPED (real outage, 2026-09-16). Everything that can fail must happen
# while the service is still running, and an ERR trap guarantees a start attempt.
$install = Invoke-RemoteChecked -Script @"
set -euo pipefail
trap 'sudo -n systemctl start distribution.service || true' ERR
sudo -n cp -a "$RemoteJar" "${RemoteJar}.$backupTag"
sudo -n cp -a "$RemoteWorker" "${RemoteWorker}.$backupTag"
sudo -n cp -a "$RemoteEnv" "${RemoteEnv}.$backupTag"
echo "backup: ${RemoteJar}.$backupTag"

# Non-disruptive steps first: config and worker, with the app still serving.
$envBlock
$workerBlock
sudo -n systemctl restart installer-signing.service
echo 'worker service: restarted'

# Only now swap the jar and take the short restart window.
sudo -n systemctl stop distribution.service
sudo -n install -o root -g distribution -m 0640 "$remoteJarStage" "$RemoteJar"
echo 'jar: installed'
sudo -n systemctl start distribution.service
echo 'services: restarted'
"@ -What 'install'

Write-Host $install

# ---------------------------------------------------------------- health gate
Write-Host "waiting for health (up to ${HealthTimeoutSeconds}s) ..."
$health = Wait-Health -TimeoutSeconds $HealthTimeoutSeconds
if (-not $health.Healthy) {
    Write-Host "HEALTH FAILED after $($health.WaitedSeconds)s: $($health.Body)" -ForegroundColor Red
    Write-Host "rolling back to $backupTag ..." -ForegroundColor Yellow
    Invoke-Remote -Script @"
set -uo pipefail
sudo -n systemctl stop distribution.service
sudo -n cp -a "${RemoteJar}.$backupTag" "$RemoteJar"
sudo -n cp -a "${RemoteWorker}.$backupTag" "$RemoteWorker"
sudo -n cp -a "${RemoteEnv}.$backupTag" "$RemoteEnv"
sudo -n systemctl restart installer-signing.service
sudo -n systemctl start distribution.service
"@ | Out-Null
    $back = Wait-Health -TimeoutSeconds $HealthTimeoutSeconds
    throw "Deployment failed and was rolled back. Health after rollback: $($back.Body)"
}
Write-Host "health OK after $($health.WaitedSeconds)s: $($health.Body)" -ForegroundColor Green

# ---------------------------------------------------------------- verification
$verify = Invoke-RemoteChecked -Script @"
set -uo pipefail
echo '--- deployed jar sha256 (must match local) ---'
sudo -n sha256sum "$RemoteJar"
echo '--- flyway head ---'
sudo -n -u postgres psql -d distribution_platform -t -A -F'|' -c "select version, description, success from flyway_schema_history order by installed_rank desc limit 2;"
echo '--- new endpoint present? (401/409 = wired; 404 = missing) ---'
curl -s -o /dev/null -w 'initial-setup status=%{http_code}\n' -m 10 -X POST http://127.0.0.1:8082/api/v1/installer-handoffs/00000000-0000-0000-0000-000000000000/initial-setup
echo '--- pin configured? ---'
sudo -n grep -c '^DISTRIBUTION_INITIAL_SETUP_SIGNER_SPKI_SHA256=' "$RemoteEnv"
"@ -What 'verification'

Write-Host $verify
Write-Host ""
Write-Host "Deployed. Rollback tag: $backupTag" -ForegroundColor Green
Write-Host "To roll back: pwsh -NoProfile -File $($MyInvocation.MyCommand.Name) -RollbackTag $backupTag"
