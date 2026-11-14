#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# enable-frp.sh - point this machine's public entry at the tunnel you created
# in the SakuraFrp panel.
#
#   sudo ./deploy/enable-frp.sh 12345678
#
# What it does (idempotent, safe to re-run with a new tunnel id):
#   1. writes /etc/lossless-frp.env   (TUNNEL_ID, mode 0600)
#   2. installs /usr/local/bin/lossless-frp  (the frpc wrapper)
#   3. installs + enables lossless-frp.service
#   4. prints the last log lines so a bad id / deleted tunnel shows up at once
#
# It does NOT create the tunnel for you - that needs your panel login. See
# docs/FRP-SAKURA.md for the exact fields to fill in.
# ---------------------------------------------------------------------------
set -euo pipefail

TUNNEL_ID=${1:-}
if [ -z "$TUNNEL_ID" ]; then
  cat >&2 <<'EOF'
用法: sudo ./deploy/enable-frp.sh <隧道ID>

隧道 ID 从 SakuraFrp 面板的「隧道列表」里复制（一串数字，例如 29133562）。
新建隧道时请按 docs/FRP-SAKURA.md 的表格填：类型 HTTP、本地 IP 127.0.0.1、
本地端口 8765、节点选离你最近的、开启「自动 HTTPS」。
EOF
  exit 2
fi
case "$TUNNEL_ID" in
  *[!0-9]*) echo "隧道ID 应为纯数字，收到: $TUNNEL_ID" >&2; exit 2 ;;
esac

HERE=$(cd "$(dirname "$0")" && pwd)

# 1. tunnel id
umask 077
printf 'TUNNEL_ID=%s\n' "$TUNNEL_ID" > /etc/lossless-frp.env
chmod 600 /etc/lossless-frp.env
echo "==> /etc/lossless-frp.env  TUNNEL_ID=$TUNNEL_ID"

# 2. wrapper
install -m 755 "$HERE/frpc-sakura.sh" /usr/local/bin/lossless-frp
echo "==> /usr/local/bin/lossless-frp"

# 3. unit
install -m 644 "$HERE/lossless-frp.service" /etc/systemd/system/lossless-frp.service
systemctl daemon-reload
systemctl enable --now lossless-frp >/dev/null
sleep 3
echo "==> service: $(systemctl is-active lossless-frp) / $(systemctl is-enabled lossless-frp)"

# 4. the first lines of output decide whether the id is right
echo "==> 最近日志:"
journalctl -u lossless-frp -n 12 --no-pager | sed 's/^/    /'
