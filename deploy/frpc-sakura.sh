#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# frpc-sakura.sh - run ONE SakuraFrp tunnel with the frpc binary that the
# SakuraFrp launcher already downloaded. Installed as /usr/local/bin/lossless-frp
# by enable-frp.sh, and started by lossless-frp.service.
#
# SakuraFrp's model: the *server* (frps) is theirs - you never run one. The
# client authenticates with your account access key and is told which tunnel to
# serve by tunnel ID, which is why the invocation is `-f <key>:<id>` instead of
# a frpc.toml: the mapping (node, protocol, remote port) lives in their panel.
#
# Config:
#   /etc/lossless-frp.env    TUNNEL_ID=...        (written by enable-frp.sh)
#   /etc/natfrp/config.json  {"token": "..."}     (written by the launcher login)
# ---------------------------------------------------------------------------
set -euo pipefail

ENV_FILE=${LOSSLESS_FRP_ENV:-/etc/lossless-frp.env}
NATFRP_CONF=${NATFRP_CONFIG:-/etc/natfrp/config.json}
FRPC_BIN=${FRPC_BIN:-/home/natfrp/frpc}

[ -r "$ENV_FILE" ] || { echo "frpc-sakura: 缺少 $ENV_FILE（先运行 enable-frp.sh <隧道ID>）" >&2; exit 1; }
# shellcheck disable=SC1090
. "$ENV_FILE"
[ -n "${TUNNEL_ID:-}" ] || { echo "frpc-sakura: $ENV_FILE 里没有 TUNNEL_ID" >&2; exit 1; }

[ -x "$FRPC_BIN" ] || {
  echo "frpc-sakura: 找不到可执行的 frpc（$FRPC_BIN）。" >&2
  echo "  先装 SakuraFrp launcher（它会把 frpc 放在这里），或设置 FRPC_BIN。" >&2
  exit 1
}

if [ -n "${NATFRP_TOKEN:-}" ]; then
  KEY=$NATFRP_TOKEN
else
  [ -r "$NATFRP_CONF" ] || { echo "frpc-sakura: 缺少 $NATFRP_CONF（先在 launcher 里登录账号）" >&2; exit 1; }
  KEY=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["token"])' "$NATFRP_CONF")
fi

# The launcher's frpc keeps node TLS certificates in its working directory;
# running from there means the embedded/CA files resolve exactly as they do
# for the launcher itself.
cd "$(dirname "$FRPC_BIN")"
exec "$FRPC_BIN" -f "$KEY:$TUNNEL_ID" --log_level "${FRPC_LOG_LEVEL:-info}"
