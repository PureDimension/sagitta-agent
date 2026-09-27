<#
  Git proxy plumbing shared by the installer scripts.

  This machine already configures a proxy for npm/pnpm (`.npmrc`); git does not
  read it. That matters because pnpm resolves `github:` dependencies by running
  `git ls-remote` over HTTPS, while direct git usage here goes over SSH — so an
  install fails behind the proxy even though git itself works.

  `Use-SagittaGitProxy` applies the resolved proxy through GIT_CONFIG_* for the
  current process tree only. Nothing global is written: a documented machine
  setting is used, not modified.
#>
function Get-SagittaGitProxy {
    foreach ($command in @('pnpm', 'npm')) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { continue }
        $value = (& $command config get proxy 2>$null | Select-Object -First 1)
        if (-not [string]::IsNullOrWhiteSpace($value) -and $value.Trim() -notin @('null', 'undefined')) { return $value.Trim() }
    }
    foreach ($value in @($env:HTTPS_PROXY, $env:HTTP_PROXY)) {
        if (-not [string]::IsNullOrWhiteSpace($value)) { return $value.Trim() }
    }
    return ''
}

function Use-SagittaGitProxy {
    param([string]$Proxy)
    if ([string]::IsNullOrWhiteSpace($Proxy)) {
        Write-Host '[git-proxy] no proxy configured; git reaches github directly.'
        return
    }
    $env:GIT_CONFIG_COUNT = '1'
    $env:GIT_CONFIG_KEY_0 = 'http.proxy'
    $env:GIT_CONFIG_VALUE_0 = $Proxy
    Write-Host "[git-proxy] git proxy: $Proxy"
}
