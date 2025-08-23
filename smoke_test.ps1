$ErrorActionPreference = 'Stop'

# Ensure required environment variables are present (do not print secrets)
$missing = @()
if (-not $env:SPEED_WALLET_SECRET_KEY) { $missing += 'SPEED_WALLET_SECRET_KEY' }
if (-not $env:SPEED_WALLET_WEBHOOK_SECRET) { $missing += 'SPEED_WALLET_WEBHOOK_SECRET' }
if ($missing.Count -gt 0) {
  Write-Output ("ENV_MISSING=" + ($missing -join ','))
  exit 2
}

# Start backend server
$backendDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$proc = Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $backendDir -PassThru -WindowStyle Hidden

try {
  # Wait for health endpoint
  $healthOk = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $resp = Invoke-RestMethod -UseBasicParsing -TimeoutSec 2 -Uri 'http://localhost:4000/health'
      if ($resp.status -eq 'ok') { $healthOk = $true; break }
    } catch { }
  }
  if (-not $healthOk) { Write-Output 'HEALTH=FAIL' } else { Write-Output 'HEALTH=OK' }

  function Post-Json($uri, $obj) {
    $json = $obj | ConvertTo-Json -Compress
    return Invoke-RestMethod -UseBasicParsing -Method Post -Uri $uri -ContentType 'application/json' -Body $json -TimeoutSec 20
  }

  # Test 1: Resolve totodile@speed.app (500 sats)
  try {
    $resp1 = Post-Json 'http://localhost:4000/api/resolve-ln' @{ input='totodile@speed.app'; amountSats=500 }
    $inv1 = $resp1.invoice
    if ($inv1) {
      $prefix = if ($inv1.Length -gt 24) { $inv1.Substring(0,24) + '...' } else { $inv1 }
      Write-Output ("RESOLVE_TOTODILE=OK " + $prefix)
    } else {
      Write-Output 'RESOLVE_TOTODILE=NO_INVOICE'
    }
  } catch {
    Write-Output ("RESOLVE_TOTODILE=ERR " + $_.Exception.Message)
  }

  # Test 2: Resolve developer@tryspeed.com (500 sats)
  try {
    $resp2 = Post-Json 'http://localhost:4000/api/resolve-ln' @{ input='developer@tryspeed.com'; amountSats=500 }
    $inv2 = $resp2.invoice
    if ($inv2) {
      $prefix2 = if ($inv2.Length -gt 24) { $inv2.Substring(0,24) + '...' } else { $inv2 }
      Write-Output ("RESOLVE_DEVELOPER=OK " + $prefix2)
    } else {
      Write-Output 'RESOLVE_DEVELOPER=NO_INVOICE'
    }
  } catch {
    Write-Output ("RESOLVE_DEVELOPER=ERR " + $_.Exception.Message)
  }
}
finally {
  try {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
  } catch { }
}

