#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# gen_cert.sh - the POSIX twin of gen_cert.ps1
#
# Generates the self-signed certificate web_transfer.py needs for native HTTPS
# (--tls-cert / --tls-key). Needs nothing but openssl, which every Ubuntu /
# Debian / RHEL base image already has - no Python packages, no admin rights.
#
# Mainland-China SakuraFrp nodes block plain HTTP over a TCP tunnel (501
# compliance page) but pass TLS bytes through untouched, so serving HTTPS from
# the server itself makes the tunnel carry only opaque TLS records.
#
# Usage:
#   ./scripts/gen_cert.sh                                  # ./cert.pem + ./key.pem
#   ./scripts/gen_cert.sh --out-dir ./tls --dns localhost,127.0.0.1,frp-ski.com
#   ./scripts/gen_cert.sh --out-dir ./tls --days 365 --force
# ---------------------------------------------------------------------------
set -euo pipefail

OUT_DIR='.'
DNS_NAMES='localhost,127.0.0.1'
COMMON_NAME='lossless-transfer'
DAYS=365
FORCE=0

usage() {
  cat <<'EOF'
gen_cert.sh - self-signed TLS certificate for web_transfer.py

  --out-dir DIR     where to write cert.pem / key.pem      (default: .)
  --dns  LIST       comma separated names and IPs          (default: localhost,127.0.0.1)
  --cn   NAME       certificate common name                (default: lossless-transfer)
  --days N          validity in days                       (default: 365)
  --force           overwrite existing cert.pem / key.pem
  -h, --help        this text
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --dns)     DNS_NAMES="$2"; shift 2 ;;
    --cn)      COMMON_NAME="$2"; shift 2 ;;
    --days)    DAYS="$2"; shift 2 ;;
    --force)   FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "gen_cert.sh: unknown option '$1'" >&2; usage >&2; exit 2 ;;
  esac
done

if ! command -v openssl >/dev/null 2>&1; then
  echo "gen_cert.sh: openssl not found. Install it with: sudo apt install openssl" >&2
  exit 1
fi

CERT="$OUT_DIR/cert.pem"
KEY="$OUT_DIR/key.pem"
if [ "$FORCE" -eq 0 ]; then
  for f in "$CERT" "$KEY"; do
    if [ -e "$f" ]; then
      echo "gen_cert.sh: refusing to overwrite $f (use --force)" >&2
      exit 1
    fi
  done
fi
mkdir -p "$OUT_DIR"

# Build the subjectAltName list. IP literals must use IP:, hostnames DNS: -
# otherwise the browser reports a hostname mismatch on top of the "self-signed"
# warning, which is exactly the noise this certificate is meant to avoid.
SAN=''
OLD_IFS="$IFS"
IFS=','
for entry in $DNS_NAMES; do
  entry="${entry// /}"                       # trim spaces
  [ -z "$entry" ] && continue
  case "$entry" in
    *[!0-9.]*) SAN="$SAN,DNS:$entry" ;;      # contains a non digit/dot -> DNS
    *)         SAN="$SAN,IP:$entry" ;;
  esac
done
IFS="$OLD_IFS"
SAN="${SAN#,}"
if [ -z "$SAN" ]; then
  echo "gen_cert.sh: --dns produced an empty SAN list" >&2
  exit 2
fi

# 2048-bit RSA, SHA-256, PKCS#8 key ("BEGIN PRIVATE KEY"), which both Python's
# ssl module and every browser accept.
openssl req -x509 -newkey rsa:2048 -sha256 -nodes \
  -keyout "$KEY" -out "$CERT" -days "$DAYS" \
  -subj "/CN=$COMMON_NAME" -addext "subjectAltName=$SAN" 2>/dev/null

chmod 600 "$KEY"      # private key: owner read/write only
chmod 644 "$CERT"

echo "Wrote $CERT"
echo "Wrote $KEY"
echo "SAN      : $SAN"
echo "Valid for: $DAYS days"
echo
echo "Next:"
echo "  python3 web_transfer.py --dir ./received --tls-cert \"$CERT\" --tls-key \"$KEY\""
echo
echo "NOTE: key.pem contains a private key. Keep it out of git"
echo "      (already covered by .gitignore: *.pem, tls/, demo_tls/)."
