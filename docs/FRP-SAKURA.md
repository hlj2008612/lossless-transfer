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

1. **令牌是必须的**：公网 URL 一旦存在就会被扫描。没有 `X-LT-Token` 时任何人对 `/api/delete` 都能删文件。当前令牌在 `/etc/lossless-web.env`（0600 root），**不要提交进 git、不要贴群里**。轮换：
   ```bash
   sudo sh -c 'umask 077; printf "LT_TOKEN=%s\n" "$(python3 -c "import secrets;print(secrets.token_urlsafe(18))")" > /etc/lossless-web.env'
   sudo systemctl restart lossless-web
   ```
2. **只监听 127.0.0.1**：`0.0.0.0` 等于把同样的删改能力交给整个局域网。
3. **必须开自动 HTTPS**（HTTP 隧道）或**本机原生 HTTPS**（TCP 隧道）：明文过公网时，令牌和文件内容都可被读取。
4. **访问密钥（`config.json` 里的 `token`）等于账号权限**：能建/删隧道。它已被 launcher 写成 0600，别复制到别处。
5. 免费节点**限速且共享**，不要用它传几十 GB；长期用建议付费节点或自建。
6. 隧道被删/节点迁移时入口会失效——`Restart=always` 只能重连，不能复活已删的隧道，所以面板里别手滑删隧道。
7. 若只想临时分享：传完就 `sudo systemctl stop lossless-frp`，公网入口立即消失，本机服务不受影响。

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
