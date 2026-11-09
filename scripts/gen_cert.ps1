<#
.SYNOPSIS
  Generate a self-signed TLS certificate for web_transfer.py, with NO extra
  dependencies (uses the .NET crypto built into PowerShell 7+).

.DESCRIPTION
  Mainland-China SakuraFrp nodes block plain HTTP over a TCP tunnel (they
  return a 501 compliance page) but pass TLS bytes through untouched. Serving
  HTTPS from web_transfer.py itself (--tls-cert / --tls-key) makes the tunnel
  carry only opaque TLS bytes, so the node lets it through. This script
  produces the cert.pem / key.pem those two flags need.

  The certificate is self-signed, so a browser shows ONE warning the first
  time ("Your connection is not private" -> Advanced -> Continue). Put your
  public tunnel hostname in -DnsNames so that this is the only warning (no
  hostname-mismatch warning on top of it).

  No OpenSSL, no Python packages, no internet access, no admin rights.

.EXAMPLE
  pwsh -File .\scripts\gen_cert.ps1 -OutDir .\tls -DnsNames localhost,127.0.0.1,frp-ski.com
  py -3 web_transfer.py --dir .\received --tls-cert .\tls\cert.pem --tls-key .\tls\key.pem

.NOTES
  Alternative with no certificate at all: enable the SakuraFrp launcher's
  "Auto HTTPS" (自动 HTTPS) for the tunnel and keep web_transfer.py in plain
  HTTP mode. frpc then terminates TLS for you. See README.md.
#>
[CmdletBinding()]
param(
    [string]   $OutDir     = '.',
    [string[]] $DnsNames   = @('localhost', '127.0.0.1'),
    [string]   $CommonName = 'lossless-transfer',
    [ValidateRange(1, 3650)]
    [int]      $Days       = 365,
    [switch]   $Force
)
$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSVersion.Major -lt 7) {
    throw 'PowerShell 7+ (pwsh) is required. On Windows PowerShell 5.1, use the launcher "Auto HTTPS" option or openssl instead.'
}

$certPath = Join-Path $OutDir 'cert.pem'
$keyPath  = Join-Path $OutDir 'key.pem'
if (-not $Force) {
    foreach ($p in @($certPath, $keyPath)) {
        if (Test-Path -LiteralPath $p) {
            throw "Refusing to overwrite existing file: $p (pass -Force to overwrite)"
        }
    }
}
if (-not (Test-Path -LiteralPath $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

$rsa = [System.Security.Cryptography.RSA]::Create(2048)
try {
    $req = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
        "CN=$CommonName", $rsa,
        [System.Security.Cryptography.HashAlgorithmName]::SHA256,
        [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)

    # Not a CA, usable for TLS server auth.
    $req.CertificateExtensions.Add(
        [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $false))
    $ku = [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor
          [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment
    $req.CertificateExtensions.Add(
        [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($ku, $false))

    # IP literals need AddIpAddress, hostnames need AddDnsName.
    # `pwsh -File ... -DnsNames a,b,c` arrives as ONE element with commas
    # (the -File parser does not bind [string[]] by comma), so split here too.
    $san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
    foreach ($raw in $DnsNames) {
        foreach ($d in ($raw -split ',')) {
            $d = $d.Trim()
            if (-not $d) { continue }
            $ip = $null
            if ([System.Net.IPAddress]::TryParse($d, [ref]$ip)) {
                $san.AddIpAddress($ip)
            } else {
                $san.AddDnsName($d)
            }
        }
    }
    $req.CertificateExtensions.Add($san.Build())

    $notBefore = [DateTimeOffset]::UtcNow.AddDays(-1)   # tolerate clock skew
    $notAfter  = [DateTimeOffset]::UtcNow.AddDays($Days)
    $cert = $req.CreateSelfSigned($notBefore, $notAfter)

    $certPem = $cert.ExportCertificatePem()
    $keyPem  = $rsa.ExportPkcs8PrivateKeyPem()   # "BEGIN PRIVATE KEY", OpenSSL/Python ssl accept it
} finally {
    $rsa.Dispose()
}

$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($certPath, $certPem + "`n", $utf8)
[System.IO.File]::WriteAllText($keyPath,  $keyPem  + "`n", $utf8)

Write-Host "Wrote $certPath"
Write-Host "Wrote $keyPath"
Write-Host "SAN      : $($DnsNames -join ', ')"
Write-Host "Valid for: $Days days"
Write-Host ''
Write-Host 'Next:'
Write-Host "  py -3 web_transfer.py --dir .\received --tls-cert `"$certPath`" --tls-key `"$keyPath`""
Write-Host ''
Write-Host 'NOTE: cert.pem/key.pem contain a private key. Keep them out of git'
Write-Host '      (already covered by .gitignore: *.pem, tls/, demo_tls/).'
