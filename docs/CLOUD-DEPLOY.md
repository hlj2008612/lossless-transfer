# 把服务端放到云上（B 方案）

GitHub Pages 只能托管静态文件，跑不了 `web_transfer.py`。想让 **域名直接就是能用的上传/下载页面**，
必须让这个 Python 服务跑在一台「能常驻、能监听端口」的机器上，再由平台把 HTTPS 和域名接到它前面。

本文件记录怎么做，以及**代价和坑**（先读第 1 节再动手）。

---

## 1. 先看清代价

| 项目 | 免费方案（Render Free） | 真正可用的方案 |
| --- | --- | --- |
| 服务常驻 | ❌ 闲置 15 分钟会休眠，下次访问要冷启动 30–60 s | ✅ VPS / 付费实例 |
| 文件持久化 | ❌ **容器重启即清空**（重新部署、休眠唤醒都可能触发） | ✅ 挂持久磁盘或 VPS 本地盘 |
| 自定义域名 + 证书 | ✅ 自动签发，**有效证书，不再有自签警告** | ✅ 同左 |
| 费用 | 0 | 约 $7/月 起（Render 付费实例 + 磁盘），或一台便宜 VPS |

结论：

- **只是想在域名上「看到并试一下」这个 App** → 免费方案够用，但要接受「传完立刻取走，重启就没了」。
- **要长期当传文件的通道用** → 上持久磁盘或 VPS。否则别人刚传完，服务一重启文件就蒸发，这比没有更难解释。

另外，云端实例**必须带令牌**（`LT_TOKEN`）。不要在有公网域名的实例上开 `--no-auth`：那等于把「删除任意文件」的权限公开挂在互联网上。

---

## 2. Render 免费部署（约 5 分钟，零命令行）

仓库里已经准备好 `Dockerfile` + `render.yaml`，不用改代码。

1. 注册 / 登录 <https://render.com>，用 GitHub 账号登录并授权访问 `lossless-transfer` 仓库。
2. 控制台点 **New +** → **Blueprint** → 选择仓库 `hlj2008612/lossless-transfer` → 分支 `pages`。
   Render 会自动读到 `render.yaml`，创建名为 `lossless-transfer` 的 Web Service。
3. 点 **Apply / Deploy**，等构建完成（1–2 分钟）。首次部署后：
   - 访问地址形如 `https://lossless-transfer-xxxx.onrender.com`；
   - 在服务的 **Environment** 页可以查看自动生成的 `LT_TOKEN`，把它填进网页的「连接」卡片。
4. 验收：
   - 打开首页 → 显示「未连接」→ 填入 `LT_TOKEN` → 点「连接」→ 出现资料库；
   - 上传一张照片 → 页面显示「✓ 已验证 · 字节完全一致」。

> 免费实例第一次访问会转 30–60 秒（冷启动），这是平台行为，不是程序卡住。

---

## 3. 绑定域名（`app.mchlj.ccwu.cc`）

建议**把 App 放在子域名**上，`mchlj.ccwu.cc` 继续留给 GitHub Pages 的项目主页——
一个域名只能指向一个目标，分成两个最省事。

1. Render 服务页 → **Settings** → **Custom Domains** → **Add Custom Domain**，
   填 `app.mchlj.ccwu.cc`。
2. Render 会给出一个 CNAME 目标，形如 `lossless-transfer-xxxx.onrender.com`。
3. 去 DNSHE（你截图里那个面板）→ 该域名 → **添加解析**：

   | 记录类型 | 主机记录 | 记录值 | TTL |
   | --- | --- | --- | --- |
   | `CNAME` | `app` | `lossless-transfer-xxxx.onrender.com` | 默认 |

4. 回到 Render 点 **Verify**，通过后它会自动签发 Let's Encrypt 证书（几分钟），
   之后 `https://app.mchlj.ccwu.cc` 就是有效证书，**不用再点「继续访问不安全」**。

如果 DNSHE 不允许添加 `app` 这类二级记录，那就把 `@` 直接给 Render（放弃 Pages 主页，
GitHub Pages 仍在 `https://hlj2008612.github.io/lossless-transfer/` 可访问）。

---

## 4. 环境变量

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `PORT` | 平台要求监听的端口（Render 会注入） | `8765` |
| `LT_TOKEN` | 访问令牌，网页里要填这个 | 随机生成并打印在日志 |
| `LT_DIR` | 资料库目录（挂磁盘就指到磁盘挂载点） | `./shared` |
| `LT_HOST` | 绑定地址，容器里必须是 `0.0.0.0` | `0.0.0.0` |

本地可以完全模拟云端启动方式：

```bash
PORT=8080 LT_TOKEN=my-secret LT_DIR=/data python3 web_transfer.py
```

---

## 5. 想真正持久化

**Render 付费磁盘**：服务 → Settings → Disks → Add Disk，挂载到 `/data`（`LT_DIR` 已经是 `/data`），
然后升到付费实例类型（免费实例不支持磁盘）。

**换成自己的 VPS**（最省钱、最可控）：

```bash
git clone https://github.com/hlj2008612/lossless-transfer.git && cd lossless-transfer
git checkout pages
docker build -t lossless-transfer .
docker run -d --name lt --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -e LT_TOKEN='换成你的长随机串' \
  -v /srv/lt-data:/data \
  lossless-transfer
# 再用 Caddy / Nginx 把 https://app.mchlj.ccwu.cc 反代到 127.0.0.1:8080
```

注意：容器里**不要**再开 `--tls-cert`，TLS 由前面的平台/反代负责。

---

## 6. 和本机隧道方案的关系

云端这套和 `scripts/start_web.ps1`（本机 + frp 隧道）**互不影响**，是两条路：

- 本机 + 隧道：文件留在自己机器上，零成本，但地址带端口、证书是自签的；
- 云端 + 域名：地址干净、证书有效，但文件在别人的机房里（免费套餐还会丢）。

按用途选一个即可，不要同时对外开两份开放模式的服务。
