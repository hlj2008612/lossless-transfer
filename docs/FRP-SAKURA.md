# 通过 SakuraFrp 把服务暴露到公网（Linux）

本文对应当前部署：VM 上 `lossless-web.service` 监听 `127.0.0.1:8765`，由 frpc 把它接到樱花节点。

## 0. 先理解模型：谁提供「服务端」

| 角色 | 谁提供 | 说明 |
| --- | --- | --- |
| frps（服务端） | **樱花提供** | 你不需要公网服务器，也不需要自己跑 frps；节点由面板分配 |
| frpc（客户端） | 你的 VM | 主动**外连**节点，因此 VM 不需要任何入站端口 |
| 隧道 | 面板里创建 | 决定「节点 + 协议 + 本地端口 + 公网入口」四件事 |

所以「服务端配置」= 在面板建隧道；「客户端配置」= VM 上跑 frpc 指向该隧道 ID。

> 只有在你**有公网 VPS**、想自己掌管节点时，才需要自建 frps，见第 8 节。

## 1. 前置条件

1. **SakuraFrp 账号**（国内节点需实名），已登录过 launcher；本机 `/etc/natfrp/config.json` 里有 `token`（访问密钥）。
2. **一个节点**：面板「节点」列表里选延迟最低的；免费节点通常 1–5 Mbps，传大照片会慢。
3. **一条隧道**：面板「隧道」→ 新建（字段见下表）。
4. **本机服务在跑**：`systemctl status lossless-web` 为 active，且**已设置访问令牌**（`/etc/lossless-web.env`）。
5. **域名**（可选）：
   - HTTP 隧道：樱花自动分配 `*.natfrp.cloud` 之类子域名，够用；
   - 想用自己域名：在面板绑定域名，并在 DNS 里给该域名加 **CNAME** 指向分配的子域名。

## 2. 面板建隧道（关键参数）

| 字段 | 建议值 | 为什么 |
| --- | --- | --- |
| 隧道类型 | **HTTP** | 节点可直接终止 TLS（自动 HTTPS），省掉自签证书告警 |
| 本地 IP | `127.0.0.1` | frpc 与 web 在同一台 VM 上，不必暴露到 LAN |
| 本地端口 | `8765` | 与 `lossless-web.service` 的 `--port` 一致 |
| 节点 | 延迟最低的国内节点 | 决定带宽与稳定性 |
| 自动 HTTPS | **开启** | 否则公网是明文 HTTP，令牌与文件字节均可被中间人读取 |
| 绑定域名 | 可选 | 自定义域名需加 CNAME |
| 访问密码 / Basic Auth | 可选 | 与本站 `X-LT-Token` 是两层，互不冲突 |

> 若面板只给你 **TCP** 隧道：也可以，但要改成「本机自己说 HTTPS」——
> `sudo systemctl edit lossless-web` 里把 `--behind-tls` 去掉（`start_web.sh` 会自动生成 `tls/cert.pem`），
> 浏览器首次访问会提示自签证书。两种方式二选一，**不要同时**启用（会二次加密并报证书错误）。

## 3. VM 上启动客户端

```bash
cd ~/lossless-transfer
sudo ./deploy/enable-frp.sh 你的隧道ID
```

脚本做四件事：写 `/etc/lossless-frp.env`（0600）→ 安装 `/usr/local/bin/lossless-frp` →
安装并 `enable --now lossless-frp.service` → 打印最近日志（ID 错会立刻看到 `404 隧道不存在`）。

手动等价命令（排错时用）：

```bash
sudo journalctl -u lossless-frp -f          # 看隧道是否 online
sudo systemctl restart lossless-frp
sudo systemctl status lossless-web lossless-frp --no-pager
```

## 4. 需要开放的端口

**VM 侧：一个入站端口都不用开。** frpc 是主动外连；`ufw` 允许出站即可（默认策略）。
之前为局域网测试加的 `ufw allow 8765/tcp` 现在可以删掉：

```bash
sudo ufw delete allow 8765/tcp
```

**自建 frps 时才需要**（见第 8 节）：`7000`（frps 控制端口）+ `80`/`443`（vhost，或你自定的 HTTP 端口）+ 面板端口（可选，建议只对管理 IP 开放）。

## 5. 安全注意事项

> **本部署当前是开放模式（`--open`，无令牌）**：拿到 URL 的任何人都能上传、下载，甚至删除文件。
> 这是明确的取舍，不是遗漏。若哪天需要收口，见本节末尾。

1. **唯一的门是那条隧道**：服务只监听 `127.0.0.1`，`ufw` 也没有放行 8765，所以外部只能通过隧道进来。不要把 `--host 0.0.0.0` 加回来——那会把同样的删改能力交给整个局域网。
2. **URL 会被人扫到**：公网入口迟早出现在扫描日志里。想降低影响，三选一：
   - 面板给隧道设「访问密码」（HTTP 隧道支持，浏览器先弹一次 Basic Auth）；
   - 用完就 `sudo systemctl stop lossless-frp`，入口立即消失，本机服务不受影响；
   - 换回令牌模式（见第 4 条）。
3. **TLS 由节点终止**：节点用自己的自签证书（`CN=SakuraFrp Automatic TLS`，SAN 仅 `dx.frp-ski.com`），所以公网段是加密的，但**证书不代表身份**——浏览器那一次告警是正常的，别在公共网络上凭地址判断真伪。
4. **随时可以恢复令牌**（改一行 unit 即可，不动代码）：
   ```bash
   sudo sed -i 's|--open|--token 你的口令|' /etc/systemd/system/lossless-web.service
   sudo systemctl daemon-reload && sudo systemctl restart lossless-web
   ```
   不想让口令出现在 unit 里，就把 `--open` 换成 `EnvironmentFile=-/etc/lossless-web.env`，
   并在该文件（0600）写 `LT_TOKEN=你的口令`。
5. **访问密钥（`/etc/natfrp/config.json` 的 `token`）等于账号权限**：能建、能删隧道，别外传；它已是 0600。
6. 免费节点**限速且共享**（实测约 1.8 MB/s）；长期大流量请用付费节点或自建 frps。
7. 「开放模式 + 自动 HTTPS」这个组合下，删除操作**没有二次确认之外的任何保护**——页面上的删除按钮点下去就真的删了，且不进回收站（服务端是 `os.remove`）。

## 6. 验证公网连通性（按顺序）

```bash
# ① 隧道是否在线（面板"隧道状态"应为绿色，或看日志里 start proxy success）
sudo journalctl -u lossless-frp -n 30 --no-pager | grep -iE "start|success|error"

# ② 从公网地址验证服务（把 URL 换成面板给你 的域名）
curl -s -o /dev/null -w "%{http_code}\n" https://你的域名/api/info
#   期望 401（没带令牌）——说明隧道通了、鉴权也生效

curl -s -H "X-LT-Token: 你的令牌" https://你的域名/api/info
#   期望 200 + {"service":"lossless-transfer-web","version":"1.4.0",...}

# ③ 证书是否正确（HTTP 隧道 + 自动 HTTPS 时不应有自签告警）
curl -sSI https://你的域名/ | head -5

# ④ 真实带宽（用一张 10 MB 照片替换文件名）
curl -H "X-LT-Token: 你的令牌" -o /tmp/t.jpg -w "%{speed_download} B/s\n" \
     "https://你的域名/api/image?name=4T3A3729.JPG&w=1600"

# ⑤ 最终验收：手机切 4G（不要连 WiFi）打开 https://你的域名/gallery
```

**故障对照**：

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `404 隧道不存在` | 隧道 ID 错/已删/不属于该账号 | 面板复制正确的 ID |
| 502 / 页面打不开但隧道在线 | 本地服务没起来或端口不对 | `systemctl status lossless-web`；确认 8765 |
| 501 | 明文 HTTP 被内地节点拦截 | 开自动 HTTPS，或改 TCP 隧道 + 本机 HTTPS |
| 一直 401 | 没带令牌或令牌没生效 | `curl -H "X-LT-Token: ..."`；核对 `/etc/lossless-web.env` |
| 证书告警 | HTTP 隧道却让本机也开了 TLS | 去掉 `--behind-tls` 与本机证书，二选一 |
| `https` 入口 502，响应头 `Server: natfrp-autohttps`，正文是 `read tcp 127.0.0.1:x->127.0.0.1:8765: read: connection reset by peer` | **节点已代理 TLS**（把 TLS 终止在节点，再以明文回源），本机却又开了 HTTPS，回源握手失败 | 本机改回明文：`ExecStart` 带 `--behind-tls`，并删掉 `tls/` 证书 |
| `http` 入口 501（页面标题 `501 Not Implemented`） | 明文 HTTP 直接被节点拦截（合规） | 改用 `https://` 入口；若节点没有自动 HTTPS，就自建证书或换节点 |

> 判断依据很简单：**谁终止 TLS，另一端就只能是明文**。
> - 节点终止（`natfrp-autohttps` / 面板"自动 HTTPS"）→ 本机 `--behind-tls`
> - 本机终止（TCP 隧道 + `tls/cert.pem`）→ 面板不要开自动 HTTPS，入口用 `https://域名:端口` 并接受一次自签证书

## 7. 客户端参数速查

`/etc/lossless-frp.env`：

```
TUNNEL_ID=29133562
```

`/usr/local/bin/lossless-frp` 的核心就一行：

```bash
exec /home/natfrp/frpc -f "$KEY:$TUNNEL_ID" --log_level info
```

- `KEY` 取自 `/etc/natfrp/config.json` 的 `token`（可用 `NATFRP_TOKEN` 覆盖）
- 为什么不是 `frpc.toml`：樱花的「节点/协议/远端端口」由面板下发给 frpc，`-f key:id` 就是拉这份配置

## 8. 附录：自建 frps（只有当你拥有公网 VPS）

frps 端 `frps.toml`：

```toml
bindPort = 7000                 # 客户端连这里
vhostHTTPPort = 8080            # 反代用（若用 nginx/caddy 对外，改 127.0.0.1:8080）
vhostHTTPSPort = 8443
auth.method = "token"
auth.token = "换成长随机串"      # 必须改，公网默认可被扫
transport.tls.force = true       # 只接受 TLS 连接
webServer.addr = "127.0.0.1"     # 面板不要对公网
webServer.port = 7500
webServer.user = "admin"
webServer.password = "换成强口令"
```

frpc 端 `frpc.toml`：

```toml
serverAddr = "你的VPS公网IP或域名"
serverPort = 7000
auth.method = "token"
auth.token = "与 frps 一致"
transport.tls.enable = true

[[proxies]]
name = "lossless-web"
type = "tcp"
localIP = "127.0.0.1"
localPort = 8765
remotePort = 9000               # 公网访问 http(s)://VPS:9000
```

端口：VPS 安全组放行 `7000`、`9000`（以及你给反代用的 80/443）；VM 侧仍然零入站。
证书：最省事是 Caddy/nginx 在 VPS 上终止 TLS，frps 只做四层转发。
