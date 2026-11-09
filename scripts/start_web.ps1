<#
.SYNOPSIS
  One-command launcher for the lossless-transfer WEB server in native-HTTPS
  mode (方案 A). Zero third-party dependencies: uses the bundled PowerShell 7+
  / .NET cert generator and the Python stdlib server.

.DESCRIPTION
  Mainland-China SakuraFrp nodes block plain HTTP over a TCP tunnel (501
  compliance page) but pass TLS bytes through unchanged. This script makes
  web_transfer.py speak HTTPS itself, so the tunnel only forwards an opaque
  TLS stream and the browser uses https:// - no 501, and the token/file bytes
  are encrypted end-to-end.

  If tls/cert.pem + tls/key.pem do not exist (or -RegenerateCert is given),
  it generates a self-signed certificate first. Then it starts the server in
  the FOREGROUND, printing the ACCESS TOKEN you must enter in the web page.
  Keep this window open while transferring; Ctrl+C stops the server.

  Your SakuraFrp launcher's TCP tunnel must be configured with:
    local IP 127.0.0.1, local port <Port>, "Auto HTTPS" DISABLED.
  Then open https://<公网地址> in the other network's browser.

.EXAMPLE
  pwsh -NoProfile -File .\scripts\start_web.ps1
  .\scripts\start_web.ps1 -Token 'my-long-random-secret' -RegenerateCert
  .\scripts\start_web.ps1 -DnsNames localhost,127.0.0.1,my-tunnel.example.com

.NOTES
  Alternative with no certificate at all: enable the launcher's "Auto HTTPS"
  and keep web_transfer.py in plain HTTP mode (方案 B). See README.md.
#>
[CmdletBinding()]
param(
    [int]      $Port           = 8765,
    # The folder the page calls 资料库. 'shared' is the web library (it is what
    # the tunnel exposes and what README documents); the CLI receiver writes to
    # 'received' instead, so the two never mix by accident.
    [string]   $Dir            = 'shared',
    [string]   $Token          = '',
    # Open mode: no token. Anyone who reaches the URL can upload/download/delete.
    [switch]   $Open,
    [string[]] $DnsNames       = @('localhost', '127.0.0.1', 'frp-ski.com',
                                    'dx.frp-ski.com', 'yd.frp-ski.com'),
    [int]      $ChunkSize      = 4194304,
    [ValidateRange(1, 3650)]
    [int]      $Days           = 365,
    [switch]   $RegenerateCert
)
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tlsDir = Join-Path $root 'tls'
$certPath = Join-Path $tlsDir 'cert.pem'
$keyPath  = Join-Path $tlsDir 'key.pem'
$genScript = Join-Path $PSScriptRoot 'gen_cert.ps1'

# 1. Ensure a certificate exists (regenerate on demand).
if ($RegenerateCert -or -not (Test-Path -LiteralPath $certPath) -or
    -not (Test-Path -LiteralPath $keyPath)) {
    Write-Host '==> Generating self-signed TLS certificate ...' -ForegroundColor Cyan
    & $genScript -OutDir $tlsDir -DnsNames $DnsNames -Days $Days -Force
    if (-not (Test-Path -LiteralPath $certPath) -or
        -not (Test-Path -LiteralPath $keyPath)) {
        throw 'Certificate generation did not produce cert.pem / key.pem'
    }
} else {
    Write-Host "==> Using existing certificate: $certPath" -ForegroundColor Cyan
}

# 2. Build the web_transfer.py argument list.
$pyArgs = @('-3', (Join-Path $root 'web_transfer.py'),
            '--host', '127.0.0.1',
            '--port', [string]$Port,
            '--dir', (Join-Path $root $Dir),
            '--chunk-size', [string]$ChunkSize,
            '--tls-cert', $certPath,
            '--tls-key',  $keyPath)
if ($Token) { $pyArgs += @('--token', $Token) }
if ($Open)  { $pyArgs += @('--no-auth') }

$py = if ($env:PYTHON_EXE) { $env:PYTHON_EXE } else { 'py' }

Write-Host ''
Write-Host '==> Starting lossless-transfer WEB (native HTTPS) ...' -ForegroundColor Green
Write-Host ('    ' + ($pyArgs -join ' ')) -ForegroundColor DarkGray
Write-Host ''
Write-Host ('    SakuraFrp TCP tunnel: local 127.0.0.1:' + $Port +
            ' , Auto HTTPS = DISABLED') -ForegroundColor Yellow
Write-Host '    Browser (other network): https://<公网地址>  (accept the self-signed cert once)' -ForegroundColor Yellow
if ($Open) {
    Write-Host '    OPEN MODE: no token - anyone who opens the URL can upload/download/DELETE.' -ForegroundColor Red
} else {
    Write-Host '    Enter the ACCESS TOKEN printed below into the web page.' -ForegroundColor Yellow
}
Write-Host ''
Write-Host '    Press Ctrl+C to stop.' -ForegroundColor DarkGray
Write-Host ''

# 3. Run in the foreground so the token / logs are visible and Ctrl+C works.
Push-Location $root
try {
    & $py @pyArgs
} finally {
    Pop-Location
}
