#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# start_web.sh - the POSIX twin of start_web.ps1
#
# One command to run the lossless-transfer WEB server. If tls/cert.pem and
# tls/key.pem are missing (or --regenerate-cert is given) it generates a
# self-signed certificate first, then starts the server in the FOREGROUND so
# the ACCESS TOKEN and the request log stay visible and Ctrl+C works.
#
# Two TLS modes, and the difference matters:
#   (default)      the server speaks HTTPS itself  -> point a *TCP* tunnel at it
#                  (SakuraFrp TCP tunnel, "Auto HTTPS" DISABLED)
#   --behind-tls   something in front terminates TLS (SakuraFrp HTTP tunnel with
#                  Auto HTTPS, Caddy, nginx)         -> the server stays plain
#                  HTTP; serving TLS here would produce a certificate error
#                  from inside the tunnel.
#
# Usage:
#   ./scripts/start_web.sh                       # HTTPS + random token
#   ./scripts/start_web.sh --open                # no token (anyone can write!)
#   ./scripts/start_web.sh --token 'secret' --regenerate-cert
#   ./scripts/start_web.sh --behind-tls --port 8765 --dir shared
#   PYTHON_EXE=/usr/bin/python3.12 ./scripts/start_web.sh
# ---------------------------------------------------------------------------
set -euo pipefail

PORT=8765
HOST='127.0.0.1'
DIR='shared'
TOKEN=''
OPEN=0
BEHIND_TLS=0
REGEN=0
DNS_NAMES='localhost,127.0.0.1,frp-ski.com,dx.frp-ski.com,yd.frp-ski.com'
CHUNK=4194304
DAYS=365

usage() {
  cat <<'EOF'
start_web.sh - launch the lossless-transfer web server

  --port N            listen port                       (default: 8765)
  --host ADDR         bind address                      (default: 127.0.0.1)
                      127.0.0.1 = this machine / a local tunnel only
                      0.0.0.0   = reachable from the LAN (open the firewall)
  --dir PATH          library folder                    (default: shared)
  --token SECRET      fixed access token                (default: random)
  --open              no token at all (anyone can upload/download/DELETE)
  --behind-tls        a proxy terminates TLS; serve plain HTTP here
  --regenerate-cert   regenerate tls/cert.pem + tls/key.pem
  --dns LIST          SAN list for a new certificate
  --chunk-size BYTES  transfer chunk size               (default: 4194304)
  --days N            certificate validity in days      (default: 365)
  -h, --help          this text

Environment:
  PYTHON_EXE          interpreter to use (default: python3)
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port|--host|--dir|--token|--dns|--chunk-size|--days)
      [ $# -ge 2 ] || { echo "start_web.sh: $1 needs a value" >&2; exit 2; }
      case "$1" in
        --port)       PORT="$2" ;;
        --host)       HOST="$2" ;;
        --dir)        DIR="$2" ;;
        --token)      TOKEN="$2" ;;
        --dns)        DNS_NAMES="$2" ;;
        --chunk-size) CHUNK="$2" ;;
        --days)       DAYS="$2" ;;
      esac
      shift 2 ;;
    --open)            OPEN=1; shift ;;
    --behind-tls)      BEHIND_TLS=1; shift ;;
    --regenerate-cert) REGEN=1; shift ;;
    -h|--help)         usage; exit 0 ;;
    *) echo "start_web.sh: unknown option '$1'" >&2; usage >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TLS_DIR="$ROOT/tls"
CERT="$TLS_DIR/cert.pem"
KEY="$TLS_DIR/key.pem"
PYTHON="${PYTHON_EXE:-python3}"

if ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "start_web.sh: '$PYTHON' not found. Install Python 3.8+ (sudo apt install python3) or set PYTHON_EXE." >&2
  exit 1
fi

# 1. Certificate: only needed when nothing in front of us terminates TLS.
if [ "$BEHIND_TLS" -eq 1 ]; then
  echo '==> --behind-tls: serving plain HTTP; the proxy/tunnel provides HTTPS'
elif [ "$REGEN" -eq 1 ] || [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
  echo '==> Generating self-signed TLS certificate ...'
  "$ROOT/scripts/gen_cert.sh" --out-dir "$TLS_DIR" --dns "$DNS_NAMES" --days "$DAYS" --force
  if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
    echo 'start_web.sh: certificate generation did not produce cert.pem / key.pem' >&2
    exit 1
  fi
else
  echo "==> Using existing certificate: $CERT"
fi

# 2. Build the web_transfer.py argument list.
ARGS=("$ROOT/web_transfer.py"
      --host "$HOST"
      --port "$PORT"
      --dir "$ROOT/$DIR"
      --chunk-size "$CHUNK")
if [ "$BEHIND_TLS" -eq 0 ]; then
  ARGS+=(--tls-cert "$CERT" --tls-key "$KEY")
fi
if [ -n "$TOKEN" ]; then
  ARGS+=(--token "$TOKEN")
fi
if [ "$OPEN" -eq 1 ]; then
  ARGS+=(--no-auth)
fi

echo
if [ "$BEHIND_TLS" -eq 1 ]; then
  echo '==> Starting lossless-transfer WEB (plain HTTP behind a TLS proxy) ...'
else
  echo '==> Starting lossless-transfer WEB (native HTTPS) ...'
fi
printf '    %s %s\n' "$PYTHON" "${ARGS[*]}"
echo
if [ "$BEHIND_TLS" -eq 1 ]; then
  echo "    Point the HTTP tunnel / reverse proxy at $HOST:$PORT"
  echo '    (SakuraFrp: tunnel type HTTP, "Auto HTTPS" ENABLED).'
  echo '    Browser: https://<your domain> - certificate comes from the proxy, no warnings.'
else
  echo "    SakuraFrp TCP tunnel: local $HOST:$PORT , Auto HTTPS = DISABLED"
  echo '    Browser (other network): https://<public host> (accept the self-signed cert once)'
fi
if [ "$OPEN" -eq 1 ]; then
  echo '    OPEN MODE: no token - anyone who opens the URL can upload/download/DELETE.'
else
  echo '    Enter the ACCESS TOKEN printed below into the web page.'
fi
echo
echo '    Press Ctrl+C to stop.'
echo

# 3. Foreground exec: the server keeps the terminal, so the token and the
#    request log stay visible and Ctrl+C reaches it directly (no wrapper shell).
cd "$ROOT"
exec "$PYTHON" "${ARGS[@]}"
