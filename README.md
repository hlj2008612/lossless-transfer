# lossless-transfer · 无损传输照片 / 视频

一个**可运行、零第三方依赖、跨平台**的最小项目，用于在两台机器之间传输照片和视频，并保证**传输前后文件字节完全一致**。

> 「无损」在这里指**字节级无损**：不解码、不重编码、不重新压缩、不缩放、不改容器、不碰 EXIF/元数据。
> 程序把照片和视频当作不透明字节流（`rb` / `wb`），并在传输完成后用 **SHA-256** 双向比对来**证明**一致性，而不是假设一致。

项目提供两种用法，共用同一套哈希 / 清单 / 断点续传逻辑：

- **CLI**：`lossless_transfer.py` —— 命令行 TCP 直传，适合本机 / 局域网、脚本批处理。
- **网页版**：`web_transfer.py` + `web/` —— 浏览器里拖拽上传、点击下载；配合内网穿透（如 SakuraFrp）可**在不同网络 / 跨公网**使用，另一端只要一个浏览器。支持**原生 HTTPS**（`--tls-cert/--tls-key`），这也是内地节点跨网访问的必需配置（详见下文）。

---

## 为什么自建（GitHub 调研结论）

调研时间：2026-11-04，数据来自 GitHub REST API `GET /repos/{owner}/{repo}`（Star 数为当时快照）。

| 项目 | 链接 | Stars | 许可证 | 定位 | 优点 | 缺点 | 是否直接复用 |
| --- | --- | ---: | --- | --- | --- | --- | --- |
| syncthing/syncthing | <https://github.com/syncthing/syncthing> | 90,064 | MPL-2.0 | 持续双向文件同步（P2P） | 成熟、断点续传、块级校验、跨平台、自动发现 | 是「同步器」不是「一次性证明字节一致的传输器」；Go 大工程，配置与发现机制复杂，无端到端哈希证明输出 | **否**（概念参考：分块 + 块校验） |
| immich-app/immich | <https://github.com/immich-app/immich> | 118,204 | AGPL-3.0 | 自托管照片/视频管理（Google Photos 替代） | 原图上传、移动端备份、人脸/检索、生态完整 | 需要 Docker + Postgres + Redis + 机器学习服务；会生成缩略图/转码视频（**有损派生**，虽然原图保留）；AGPL 有传染性 | **否**（它是产品，不是可嵌入的传输库） |
| rclone/rclone | <https://github.com/rclone/rclone> | 60,792 | MIT | "rsync for cloud storage" | 支持 70+ 后端、`--checksum`/增量/断点、生产级 | 面向云存储与挂载；CLI 参数庞大；不是「两台机器直连」的最小实现；要自行组合命令做校验 | **否**（思想参考：checksum + 分块） |
| schollz/croc | <https://github.com/schollz/croc> | 40,860 | MIT | 一次性 P2P 直传（口令 + PAKE 加密中继） | 极强的易用性、端到端加密、可穿透 NAT、断点续传 | 依赖公共中继/信标服务器；无「元数据传输 + 时间戳恢复」；不输出可归档的 SHA-256 清单 | **否**（交互体验参考） |
| photoprism/photoprism | <https://github.com/photoprism/photoprism> | 40,404 | Other (NOASSERTION，非标准/商业双授权) | AI 自托管相册 | 索引强、原图保留、界面好 | 会做索引与转码派生；重部署；许可证不是标准 OSI 许可，复用有法律风险 | **否** |

补充：GitHub 仓库搜索 `lossless photo video transfer in:name,description` 返回 `total_count: 0`，即**没有精确定位的同类小项目**；现有方案都是「同步/相册/网盘/云 CLI」这些更大的品类。

**结论：自建。** 理由：
1. 现有项目都没有把「**字节级一致的证明**」作为一等公民输出（可归档 manifest + 发送端对接收端哈希做最终判定）。
2. 相册类会生成缩略图/转码产物，与「不重编码不重压缩」的硬约束相冲突；同步类语义是「最终一致」而非「一次性可验证」。
3. 大项目依赖重（Go/Docker/数据库），无法做到「零外部依赖、单文件可跑、跨平台」。
4. 借鉴其成熟思想即可：syncthing/rclone 的**分块 + 块校验**、croc 的**直连单文件**、immich 的**原图优先**。

> 生产环境建议：若需要长期多设备同步请直接用 syncthing；若需要全功能相册请用 immich；本项目定位是**可审计、可复现、可教学的一次性无损直传**。

---

## 技术栈选型

**Python 3.8+ 标准库，单文件 `lossless_transfer.py`，零 pip 依赖。**

| 选择 | 理由 |
| --- | --- |
| Python stdlib | Windows / macOS / Linux 都自带或易安装；`hashlib`（SHA-256）、`socket`（TCP）、`json`、`os.utime(ns=)` 全覆盖，天然零依赖 |
| TCP socket 直连 | 不依赖任何中继/云服务/账号；局域网或本机即可验证，最小可运行 |
| **不引入任何图像/视频库** | 这是刻意设计：一旦调用 Pillow/ffmpeg 就存在重编码/重写元数据风险，字节级无损必须由「只做 `read`→`write`」保证 |
| SHA-256 | 每块校验（抗传输损坏）+ 全文件校验（抗截断/重叠/拼接错误），双向独立计算 |
| JSON 行 + 裸二进制混合帧 | 头信息可读可调试，载荷零拷贝零转义 |
| 不用 `makefile()` | 自己实现带预读缓冲的 `SocketReader`，避免读 JSON 行时吞掉紧随其后的二进制块 |

网页版沿用同样的零依赖原则，只换成 HTTP：

| 选择 | 理由 |
| --- | --- |
| `http.server.ThreadingHTTPServer` | 标准库自带，纯 Python，无需 Flask/FastAPI/nginx |
| 纯静态前端（`web/` 三个文件） | 无需构建工具；浏览器原生 `fetch` / `Blob.slice().arrayBuffer()` 即可分块读原始字节 |
| **自写纯 JS SHA-256** (`web/sha256.js`) | 普通 TCP 隧道 / 局域网常是明文 HTTP，属于**非安全上下文**，`window.crypto.subtle` 会被浏览器禁用；因此自带增量式 SHA-256，且避免把整个视频读进内存。开启 HTTPS 后浏览器原生 `crypto.subtle` 也可用，但本项目仍统一用自带实现，行为一致 |
| 令牌鉴权 `X-LT-Token` | 隧道把端口暴露到公网，必须有一道口令（`hmac.compare_digest` 常量时间比对）；比 CLI 的「无认证」更进一步。`/api/preview` 额外接受只读的 `media_token`（查询参数 `t=`），因为 `<video>`/`<img>` 发不了自定义请求头；它不能调用任何其他接口 |
| 预览 = 三级显示链路 | ① 相机内嵌的 10–30 KB 缩略图（瞬时占位）；② 服务端按屏幕实际像素**按需渲染**的展示副本（`/api/image`，见下条）；③ 装不上 Pillow 时退回读原文件头部/整段流式读取。**下载走的永远是原始字节**，渲染产物只存在于 `.lossless-web/previews/`，调用删除接口也不会碰到原图 |
| `/api/thumb` 取「相机自带」缩略图 | 相机 JPEG 的 EXIF 里本来就有一段 10–30 KB 的缩略图。服务端只从文件头部把**这段已有的字节**切出来返回（内存中转，不落盘、不解码、不重编码），因此一屏 10 MB 的原图在隧道上只花几十 KB 就能出图；没有内嵌缩略图就返回 `415`，前端再退回读原文件头部 |
| `/api/image` 按需渲染（Pillow，可选） | 内嵌缩略图只有 160×120，在 350–700 px 的卡片上放大 2–4 倍必然发糊（实测同宽锐度差 5–9 倍）。于是首次请求时用 Pillow 解码 → `Image.draft()` 让 JPEG 解码器直接按 1/2–1/8 出图（32 MP 只需解 1/64 像素）→ 缩到目标边长 → 存成 q82 JPEG 落盘缓存，之后都是纯磁盘读。缺 Pillow 时该接口返回 `501`，前端自动回到旧链路，零依赖承诺只是降级、不会失效 |
| HTTP/1.1 keep-alive | 隧道上每次请求都要重新 TCP + TLS 握手，代价远大于响应本身。开启连接复用后「首页 + 4 个静态文件 + 每个缩略图」共享一条连接；`Content-Length` 精确、流式短读/异常一律主动断连，避免 1.1 的分帧错位 |
| 静态资源 `ETag` + `no-cache` | 重新加载时静态文件走 `304`（无 body），既有更新立刻生效，又不重复传 60 KB；缩略图与预览带 `max-age`，同一版本只下一次 |
| **原生 HTTPS**（可选 `--tls-cert/--tls-key`） | 标准库 `ssl.SSLContext` 直接把监听 socket 包成 TLS；内地 SakuraFrp 节点按合规要求拦截明文 HTTP（返回 501），但放行 TLS 字节流，因此跨公网必须让链路是 HTTPS。配套 `scripts/gen_cert.ps1` 零依赖生成自签证书 |
| 大分块（默认 4 MiB） | 隧道上往返延迟更高，加大块减少请求数 |

**未实现（明确的边界，非缺陷）**：CLI 传输层**无加密、无身份认证**（明文 TCP，仅建议可信局域网 / 本机，公网请套 SSH 隧道、WireGuard 或 TLS 反向代理）。网页版增加了**令牌鉴权**；不开 `--tls-cert` 时仍是**明文 HTTP**（仅建议本机 / 可信局域网），开 HTTPS 后令牌与文件字节在链路上加密（自签证书仅提供加密与主机校验，不提供公信力，首次访问浏览器会提示一次）。协议不含 NAT 穿透（由 frp 等外部工具解决）、不含目录递归（网页版可多选后逐个下载并逐项校验）。

---

## 项目结构

```
无损传输/
├── lossless_transfer.py            # CLI 核心：协议 + 哈希 + 断点续传（单文件，无依赖）
├── web_transfer.py                 # 网页版服务端：零依赖 HTTP 服务 + 令牌鉴权 + 分块/断点续传 + 双向校验
├── web/                            # 网页版前端（纯静态，零依赖）
│   ├── index.html                  # 首页：连接 / 资料库概览（入口）/ 上传 / 运行日志
│   ├── gallery.html                # 照片墙页：瀑布流卡片、选择批量下载、灯箱播放
│   ├── app.css                     # 共享样式：设计变量、卡片、按钮、灯箱
│   ├── gallery.css                 # 照片墙样式：玻璃卡片、分列、悬停/入场动效、响应式
│   ├── app.js                      # 上传/下载/校验流程 + 瀑布流分列，调用 LTSha256
│   └── sha256.js                   # 纯 JS 增量 SHA-256（兼容非 HTTPS 隧道）
├── README.md                       # 本文档
├── LICENSE                         # MIT
├── .gitignore
├── tests/
│   ├── test_lossless_transfer.py   # 11 个 unittest：CLI 真实 TCP 端到端
│   ├── test_web_transfer.py        # 15 个 unittest：网页 HTTP/HTTPS/开放模式 API 端到端
│   ├── test_sha256_js.js           # 纯 JS SHA-256 对拍 Node crypto（51 cases）
│   ├── test_web_e2e_node.js        # 浏览器真实代码路径 e2e（支持 HTTPS 隧道）
│   └── fixtures/                   # 公开的一次性测试用自签证书（非真实凭据）
│       ├── test_cert.pem
│       └── test_key.pem
├── deploy/
│   └── lossless-web.service        # systemd 常驻单元（Linux）
└── scripts/
    ├── verify_transfer.py          # 独立校验脚本：真实 CLI 双进程，出 38/38 报告
    ├── gen_cert.sh                 # 零依赖自签证书生成器（Linux / macOS，只需 openssl）
    ├── gen_cert.ps1                # 同上，Windows（PowerShell 7+ / .NET）
    ├── start_web.sh                # 一键启动（Linux / macOS）：缺证书自动生成 + 原生 HTTPS
    └── start_web.ps1               # 同上，Windows
```

关键实现位置（行号随版本可能微调，可用 `--help` 与 `grep` 定位）：

| 能力 | 函数 / 位置 |
| --- | --- |
| 全文件 + 逐块 SHA-256 清单 | `build_manifest()`（含 `sha256_file()`） |
| 元数据（mtime_ns/atime_ns/mode/uid/gid/ctime） | `file_metadata()` |
| 带预读缓冲的帧读取（JSON 行 ↔ 裸字节） | `class SocketReader` / `recv_json_line()` / `recv_exact()` |
| 断点续传状态（文件身份绑定 + 前缀长度校验） | `save_resume_state()` / `load_resume_state()` |
| 元数据恢复 | `restore_metadata()` |
| 发送端（发 HELLO+META→读 RESUME→推块→比对 DONE） | `run_sender()` |
| 接收端（收 META→回 RESUME→验块→原子发布→回 DONE） | `run_receiver()` |
| 离线双文件比对 / 生成清单 | `run_verify()` / `run_manifest()` |
| 网页版 HTTP 服务 / 路由 / 令牌鉴权 | `web_transfer.py` `class Handler` / `Config` |
| 原生 HTTPS（内地节点跨网必需） | `web_transfer.py` `build_tls_context()` / `main()` 的 `--tls-cert/--tls-key` |
| 自签证书生成（零依赖） / 一键启动 | `scripts/gen_cert.sh` + `start_web.sh`（Linux/macOS）／`gen_cert.ps1` + `start_web.ps1`（Windows） |
| 网页端分块 + 校验 + 上传 / 下载 | `web/app.js` `buildManifest()` / `uploadFile()` / `downloadFile()` |
| 浏览器端纯 JS 增量 SHA-256 | `web/sha256.js` `class Sha256` / `sha256Hex()` |

---

## 快速开始（CLI）

需要 Python 3.8+（Windows 用 `py -3`，其他平台用 `python3`）。

**终端 A（接收端，先启动）**
```bash
python3 lossless_transfer.py receive --host 0.0.0.0 --port 8765 -o ./received
```

**终端 B（发送端）**
```bash
python3 lossless_transfer.py send DSC_0123.NEF --host 192.168.1.20 --port 8765
python3 lossless_transfer.py send MVI_4567.MP4 --host 192.168.1.20 --port 8765 --chunk-size 262144
```

发送端输出出现 `VERIFIED: receiver SHA-256 matches source (byte-exact).` 即表示**接收端文件的 SHA-256 与源文件相同**，字节级无损成立。

**离线校验（不经网络，任何两个文件都能比）**
```bash
python3 lossless_transfer.py verify ./DSC_0123.NEF ./received/DSC_0123.NEF --strict-metadata
python3 lossless_transfer.py manifest ./DSC_0123.NEF --out ./DSC_0123.NEF.lossless-manifest.json
```

`verify` 输出 `PASS: SHA-256 identical -> bytes are identical (lossless)`；`--strict-metadata` 额外要求 `mtime_ns` 一致（mode 位跨 Windows/POSIX 只告警不判失败）。

**一条命令跑完整校验脚本**
```bash
python3 scripts/verify_transfer.py
```
它会生成 JPEG / PNG / MP4 三种二进制样本，启动真实接收端与发送端两个进程，走一遍完整 TCP 传输，然后做字节比对、SHA-256 比对、mtime 比对、篡改检测、断点续传模拟，最后打印汇总报告（`38/38 checks passed`）并以退出码表示成败。

Windows 上直接用 `py -3 scripts/verify_transfer.py`（脚本用 `sys.executable` 启动子进程，无需额外配置）；也可用 `--python py -3` 覆盖解释器、`--keep` 保留临时目录检查产物。

---

## 网页版：浏览器上传 / 下载（可在不同网络、跨公网使用）

CLI 适合命令行；如果想**在网页里拖拽上传、点击下载**，或两台机器**不在同一个局域网**（家里 ↔ 公司、手机 ↔ 家里电脑），用网页版。它仍然是**零第三方依赖**：服务端 `web_transfer.py`（Python 标准库 `http.server`），前端是 `web/` 下四个纯静态文件（含一个纯 JS 实现的 SHA-256）。

### 两个页面：首页与照片墙

| 页面 | 地址 | 放什么 |
|---|---|---|
| 首页 | `/` | 连接状态、资料库**概览**（数量 + 「打开照片墙」入口）、上传区、运行日志 |
| 照片墙 | `/gallery` | 瀑布流照片墙：按真实宽高比排列、点开灯箱预览、勾选批量下载、单卡下载/删除 |

照片默认**只**出现在照片墙里，首页永远只有一行「共 N 项」和入口按钮，所以照片攒到几百张首页也不会乱。照片墙的分列是纯 JS 贪心分配（每张放进当前最矮的一列），列数按视口七档切换（2 ~ 8 列，见 `web/app.js` 的 `columnCount`）；卡片比例取文件自身的 EXIF 缩略图尺寸，竖图高、横图矮，桌面端与手机端都会自动重排。参考站是同一作者 mqz 项目的「画报」页。

### 共享文件夹模式（打开域名即用，无需令牌）

如果你想要的是「**对方打开域名就能直接上传/下载，什么都不用填**」，用开放模式把一个专用文件夹当共享盘：

```powershell
pwsh -NoProfile -File .\scripts\start_web.ps1 -Open -Dir shared
```

或直接用 `python3 web_transfer.py --no-auth --dir ./shared ...`。此时：

- 页面**自动连接**，连接卡片隐藏，打开就是上传区和资料库；
- `--dir` 指向的文件夹（默认的 `shared/`）就是网页里的共享文件夹，对方能**上传 / 下载 / 删除**；
- `/api/info` 返回 `"token_required": false`。

> ⚠️ **开放模式 = 没有门锁**：任何知道公网地址的人都能往这个文件夹写东西、下载里面的文件、甚至删除。只在你清楚风险时使用（例如临时给家人传照片、用完就停）。`--no-auth` 与 `--token` 不能同时给。

### 在 Linux / macOS 上运行（bash）

Windows 用 PowerShell 脚本，Linux / macOS 用等价的 bash 脚本，参数一一对应：

| 用途 | Windows | Linux / macOS |
| --- | --- | --- |
| 一键启动 | `pwsh -NoProfile -File .\scripts\start_web.ps1 -Open -Dir shared` | `./scripts/start_web.sh --open --dir shared` |
| 生成证书 | `pwsh -File .\scripts\gen_cert.ps1 -OutDir .\tls -DnsNames localhost,127.0.0.1` | `./scripts/gen_cert.sh --out-dir ./tls --dns localhost,127.0.0.1` |
| 解释器 | `py -3` | `python3`（可用 `PYTHON_EXE=` 覆盖） |

首次使用：

```bash
sudo apt install -y python3 openssl      # python3 基本都自带，openssl 用于自签证书
sudo apt install -y python3-pil          # 可选：装了才有清晰预览；不装会退回 160×120 缩略图
chmod +x scripts/*.sh                    # 从 zip 解压丢了可执行位时执行一次
./scripts/start_web.sh --open --dir shared
```

Linux / macOS 特有的注意点：

- **Pillow 建议用发行版包**：Ubuntu 24.04+ 的系统 Python 受 PEP 668 保护，`pip install pillow` 会被拒绝；`sudo apt install python3-pil` 直接生效。想用更新版本再建虚拟环境：`python3 -m venv .venv && . .venv/bin/activate && pip install pillow`，随后 `PYTHON_EXE=.venv/bin/python ./scripts/start_web.sh ...`。
- **换行符**：`git clone` 在 Linux 上得到 LF，正常。**不要**把 Windows 侧的 CRLF 副本直接拷过去，否则 `.sh` 会报 `bad interpreter: /usr/bin/env bash^M`；必须拷贝时用 `git archive` 打包，或 `sed -i 's/\r$//' scripts/*.sh`。
- **可执行位**：仓库中 `.sh` 已带可执行位；`git archive` / `git clone` 会保留，zip 解压可能丢失（`chmod +x` 或直接 `bash scripts/...`）。
- **文件权限**：CLI 传输会记录并恢复 `mode`。Linux→Linux 权限位可原样还原；从 Windows 发来的文件没有 POSIX 权限位，接收端会落成 `0o644` 这类安全默认值。
- **时间戳精度**：`os.utime(ns=...)` 在 ext4 / xfs / btrfs 上是纳秒级；FAT/exFAT 与部分网络盘只有 1–2 秒精度，mtime 可能有微小偏差（内容 SHA-256 不受影响）。
- **监听地址与防火墙**：脚本默认 `--host 127.0.0.1`（配合隧道）。要让同网段其它机器直连，启动时加 `--host 0.0.0.0`（Windows 侧对应 `-Bind 0.0.0.0`），并放行端口：`sudo ufw allow 8765/tcp`。绑定 `0.0.0.0` 等于把「上传/下载/删除」能力交给整个局域网，只在内网可信时使用。
- **开机自启（可选）**：`.sh` 是前台进程，需要常驻时用 systemd：

仓库里已带一份可直接用的 unit：`deploy/lossless-web.service`（`User=mq`、`WorkingDirectory=/home/mq/lossless-transfer`，按你的路径改这两处即可）。

```bash
sudo install -m 644 deploy/lossless-web.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now lossless-web
systemctl status lossless-web --no-pager
journalctl -u lossless-web -f          # ACCESS TOKEN 与访问日志
```

```ini
[Unit]
Description=lossless-transfer web (photo/video transfer, byte-exact)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=mq
Group=mq
WorkingDirectory=/home/mq/lossless-transfer
Environment=PYTHON_EXE=/usr/bin/python3
ExecStart=/home/mq/lossless-transfer/scripts/start_web.sh --behind-tls --open --dir shared --host 0.0.0.0 --port 8765
Restart=on-failure
RestartSec=3
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now lossless-web
journalctl -u lossless-web -f        # 看 ACCESS TOKEN 与访问日志
```

### 本机 / 局域网快速体验
**接收端（跑服务端，先启动）**
```bash
python3 web_transfer.py --host 0.0.0.0 --port 8765 --dir ./shared --token 你自己的口令
```
Windows 用 `py -3 web_transfer.py ...`。不传 `--token` 会**随机生成一个**并打印在启动日志里。加 `--tls-cert`/`--tls-key` 则改为原生 HTTPS（跨公网 / 内地节点必需，见下一节）。启动后终端会打印类似：

```
  lossless-transfer  WEB  v1.4.0   (Python stdlib + Pillow previews)
  Library dir  : D:\...\无损传输\shared
  Chunk size   : 4194304 bytes (4.0 MiB)
  Local URL    : http://127.0.0.1:8765     # 加了证书则是 https://
  Previews     : rendered on demand (sharp cards); cached in ...\.lossless-web\previews
  ACCESS TOKEN : xxxxxxxxxxxxxxxxxxxxxx
  WARNING: plain HTTP; token and file bytes are NOT encrypted   # 明文模式才有
======================================================================
```

> 没装 Pillow 时这一行会显示 `Python stdlib only` 并提示装 Pillow，功能照常，只是卡片用相机内嵌的 160×120 缩略图。装法：`pip install pillow`（或 `py -3 -m pip install pillow`）。

**发送端（任何有浏览器的设备）**：打开 `http://<接收端IP>:8765` → 在「连接」卡片填入上面的 `ACCESS TOKEN` → 点「连接」。之后：

- **上传**：把照片 / 视频拖进虚线框（或点「选择文件」，可多选）。浏览器先用纯 JS 逐块算 SHA-256 → 分块上传 → 服务端逐块复算校验 → 整文件复算 → 页面显示「✓ 已验证 · 字节完全一致」。
- **预览**：资料库是缩略图网格——照片直接出缩略、视频出首帧（滚到可见才加载，最多 4 个并发）。缩略图优先用**相机写在 EXIF 里的那段缩略图**（`/api/thumb`，通常 10–30 KB，一屏 10 MB 原图也只花几十 KB）；这段缩略图本身不带 EXIF，所以网格按主文件的 `Orientation` 自行旋转，竖拍照片不会躺倒。没有内嵌缩略图时退回读原文件头部，再不行才整份读取（超过 8 MiB 的图不整份拉取，卡片显示「点开查看」）。点卡片打开灯箱看大图 / 播放视频（`Esc` 关闭、`←` `→` 切换、视频可拖进度条）：大图加载期间先放大模糊显示已有缩略图，并在底部显示「载入 N%」。预览全部只读原文件字节，**不生成也不保存任何派生图**，所以预览永远不会改动原文件。
- **下载**：在「资料库」点单张卡片的「下载」，或勾选多张后点「下载选中（N）」，浏览器逐块 GET、逐块用 JS 校验、再整文件校验，一致才保存到本地。多选是逐个下载，每一项都独立做 SHA-256 校验。
- **下载并行化**：分块**3 路并发**取回（`web/app.js` 的 `DL_PARALLEL`），因为隧道上每个请求都要一次往返，串行取块等于把 RTT 乘以块数。乱序到达的块先进槽位，等前序补齐后再**按顺序喂给增量 SHA-256**——顺序不可并行，这是哈希本身的约束，不是实现妥协。任一块在 2 次重试后仍失败（或哈希不一致）会立刻中止整个传输，不会产出半成品文件。实测 9.72 MB / 3 块：串行 28.3 s → 3 路 13.5 s（2.09×，字节完全一致）。
- **大文件内存**：下载时整份文件会先拼成 Blob 再写盘，内存占用≈文件大小；超过 512 MB 会在日志里先给一条提醒（`DL_BIG_BYTES`），避免 2 GB 视频在低内存机器上莫名失败。
- **浏览器认不出的格式**：CR3、NEF 等 RAW 只显示文件图标（`/api/preview` 返回 `415`），照常可以下载校验；HEIC/HEIF 能否显示取决于浏览器。
- **断点续传**：上传到一半中断（关页面 / 断网），重新选同一个文件，`POST /api/upload/init` 会返回 `next_index`，浏览器只补未验的块。
- **列表 / 删除**：资料库列出服务端 `shared/` 里的文件，可删除（CLI 的 `receive` 子命令写的是 `received/`，两者互不干扰）。

### 跨网络 / 不同局域网：用 SakuraFrp（或任意 frp）TCP 隧道

网页版本质是一个 HTTP(S) 服务，只要让「另一端」能访问到这个端口即可。两台机器不在同一网络时，用内网穿透把接收端的 `127.0.0.1:8765` 映射成一个公网地址。以 **SakuraFrp 启动器**（截图版本 `3.2.0.2 / 3.1.9 / 0.51.0-sakura-15.1`）为例。

> ⚠️ **内地节点必须走 HTTPS**：SakuraFrp 的「普通节点(内地)」（含实测的 `#62 东莞双线PLUS2`）按机房合规要求**拦截明文 HTTP 的 TCP 隧道**——浏览器用 `http://` 访问会收到节点返回的 `501 Not Implemented` 页面（正文写明「请启用 HTTPS 后使用 HTTPS 访问」），无论本地服务是否正常。TLS 字节流则原样放行。据 [官方文档](https://doc.natfrp.com/faq/site-inaccessible.html)：内地节点「TCP 隧道映射 HTTP 流量 = ✗（请配置自动 HTTPS）」「TCP 隧道映射 HTTPS 流量 = ✓」。所以跨公网前先选下面 **A / B 任一方案**让链路是 HTTPS。

**方案 A：让 `web_transfer.py` 自己说 HTTPS（推荐，端到端加密）**

最省事的是**一键脚本**：它会按需生成自签证书、以原生 HTTPS 启动服务，并把 `ACCESS TOKEN` 打印在窗口里。

```powershell
pwsh -NoProfile -File .\scripts\start_web.ps1 -Token 你自己的口令
```
（也可先 `pwsh -NoProfile -File .\scripts\gen_cert.ps1 -OutDir .\tls -DnsNames localhost,127.0.0.1,你的隧道公网域名 -Force` 单独生成证书，再用 `py -3 web_transfer.py --tls-cert .\tls\cert.pem --tls-key .\tls\key.pem ...` 手动启动；两者等价。`start_web.ps1` 支持 `-Port` / `-Dir` / `-ChunkSize` / `-DnsNames` / `-RegenerateCert`。）

1. **证书**：脚本缺证书时自动调用 `gen_cert.ps1` 生成 `tls/cert.pem` 与 `tls/key.pem`（含私钥，已被 `.gitignore` 排除，切勿提交）。`-DnsNames` 里带上公网域名（如 `frp-ski.com`），这样浏览器只出现一次「证书不受信任」提示，不会再叠加域名不匹配警告。
2. 启动日志会显示 `Local URL: https://127.0.0.1:8765` 与 `TLS: ENABLED`，以及 `ACCESS TOKEN`。**保持这个窗口开着**。
3. 启动器 → **隧道 → 创建隧道**：
   - **选择节点**：在「普通节点(内地)」里挑一个**离双方都近、可用于 TCP 的节点**。带「🚫 UDP」标记的节点照样可用（本项目只用 TCP）；带「建站」标记的通常更合适。
   - **隧道类型**：选 **TCP 隧道**（不是 UDP、不是 HTTP/HTTPS 类型）。
   - **自动 HTTPS**：保持 **禁用**（TLS 已由本地服务提供，别让 frpc 再脱壳一次）。
   - **本地地址** `127.0.0.1`，**本地端口** `8765`；**远程端口**按面板分配。
4. 创建后启动该隧道，面板给出公网地址（如 `frp-ski.com:18482`）。另一端（任何网络）浏览器打开 **`https://<公网地址>`**，首次会提示「您的连接不是私密连接」→ 高级 → 继续（自签证书，仅此一次），填入 `ACCESS TOKEN` 即可上传 / 下载。

**方案 B：用启动器的「自动 HTTPS」（本地服务保持明文）**

1. 创建/编辑同一条 TCP 隧道，把 **自动 HTTPS** 从「禁用」改为 **启用 / 自动**，重启 frpc。据 [自动 HTTPS 文档](https://doc.natfrp.com/frpc/auto-https.html)，frpc 会在公网侧用 TLS 接受连接、脱壳后以**明文 HTTP** 转发给本地 `web_transfer.py`（本地仍用不带证书的命令启动）。
2. 面板的「连接方式」会变成 `https://...`，浏览器用 **`https://<公网地址>`** 访问（同样有自签证书首次提示）。
3. 注意：此方案里「公网 → frpc」加密、「frpc → 本地」是明文，但同一台机器上一般可接受；方案 A 则是全程 TLS 到应用。

> 也可用 `ssh -R`、其它 frp 服务商、Cloudflare Tunnel、WireGuard / Tailscale 等任意「把本地 TCP 端口暴露出去」的方案，步骤同理。所有隧道 / TLS 都只在传输层转发字节，不解析、不改写文件内容，因此对画质无影响。

> 想验证一条真实隧道是否真的无损，可用浏览器代码路径的 e2e 测试指向它（HTTPS + 自签证书时把证书加入信任）：
> ```bash
> LT_E2E_URL=https://<公网地址> LT_E2E_TOKEN=<口令> \
>   NODE_EXTRA_CA_CERTS=./tls/cert.pem node tests/test_web_e2e_node.js
> ```
> 它会用前端同款 `web/sha256.js` 造清单并跑完整上传 / 下载 / 篡改检测；服务端 `tls:true` 也会被断言。

### 画质会有影响吗？——不会，一点都不会

这是本项目最核心的保证，网页版与 CLI 完全一致：

- **不解码、不重编码、不缩放、不重新压缩、不改容器、不改 EXIF / 元数据**：照片和视频从头到尾被当作**不透明字节流**（上传 `File.slice()` / `Uint8Array`，下载 `Blob`），代码里没有任何 `Pillow` / `ffmpeg` / `<canvas>` / 图像视频库调用。
- **隧道只在传输层转发字节**：SakuraFrp / frp 把 TCP 字节流（启用 HTTPS 后是不透明的 TLS 记录）原样复制到接收端，不解析、不改写文件内容；TLS 只是给这条字节流加密，同样不接触明文载荷，因此对画质**零影响**。实测：明文 HTTP 经内地节点会被 501 拦截，换成 HTTPS 后同一条隧道完整跑通「上传 → 逐块校验 → 整文件校验 → 下载重组」，字节与源文件完全一致。
- **三层 SHA-256 证明一致**：
  1. 浏览器端（上传前）逐块 + 整文件各算一次；
  2. 服务端收到每块**独立复算**，不符直接 `422 wire corruption`，坏字节不落盘；
  3. 组装完成后服务端整文件复算，页面再把 `done.sha256` 与浏览器清单比对，一致才显示「已验证」。下载时同理逐块 + 整文件校验。

  任何一位不同都会报错，绝不会悄悄给你一个「看起来能打开但已被改动」的文件。
- **元数据**：`mtime_ns`（网页端以 **BigInt 字符串**发送以保纳秒精度）、`mode` 等随清单上传，服务端用 `os.utime(ns=...)` / `os.chmod()` 尽力恢复；同样受 Windows NTFS 100 ns 精度限制（见下文「平台限制」），但**字节内容不受影响**。

> 简单说：`收到的字节 == 发出的字节`，所以分辨率、码率、色彩、EXIF、拍摄时间、容器格式全部原样保留。「画质变差」通常来自相册 / 网盘生成的**缩略图与转码**，而本项目刻意不做这件事。

### HTTP API（供二次开发）

所有 `/api/*` 请求必须带 `X-LT-Token` 头；静态页面（`/`、`/gallery`、`/index.html`、`/gallery.html`、`/app.js`、`/app.css`、`/gallery.css`、`/sha256.js`）无需令牌。**唯一例外是 `/api/preview`**：它额外接受查询参数 `t=<media_token>`，因为 `<video>` / `<img>` 无法自定义请求头；这个令牌只能用于预览，拿它调其他接口一律 `401`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/info` | 服务信息、`chunk_size`、`token_required`（开放模式为 `false`）、`tls`、`media_token`（预览专用，开放模式为空）、`preview_ext`（可预览的图片 / 视频扩展名）、`thumb_ext`（可走 `/api/thumb` 取内嵌缩略图的扩展名） |
| GET | `/api/list` | 列出资料库文件（name / size / mtime_ns / kind=`image`\|`video`\|`other`） |
| GET | `/api/preview?name=&index=` | **只读预览**：返回原文件原始字节（不解码、不转码），按扩展名给 `Content-Type`，支持 `Range`（`206` + `Accept-Ranges`，视频可拖进度）；未知 / 浏览器不认的格式（CR3、NEF、RAW…）→ `415`。`index` 可选，仅作客户端缓存键 |
| GET | `/api/thumb?name=` | **内嵌缩略图**：从 JPEG 的 EXIF IFD1 里切出相机自己写入的那段缩略图（不生成、不重编码、不落盘），带 `ETag` + 7 天缓存，命中条件请求返回 `304`；响应头 `X-Thumb-Orientation` 给出主文件的 EXIF 方向（1–8），因为这段缩略图本身不带 EXIF，前端要据此旋转；文件没带缩略图 → `415`（此时前端退回 `/api/preview`，**不代表**该文件不能预览） |
| GET | `/api/image?name=&w=` | **按需渲染的展示副本**（需要 Pillow）：把原图缩到最长边 `w`（默认 720，上限 2048）的 JPEG q82，首次请求生成并缓存到 `.lossless-web/previews/`，之后纯磁盘读；`ETag` 由 `(name, size, mtime, w)` 派生，条件请求走 `304`；照片墙卡片按屏幕像素密度取 320–1080，灯箱取 1600。非图片 → `415`，**没装 Pillow → `501`**（前端自动退回 `/api/thumb` + `/api/preview`） |
| POST | `/api/upload/init` | 提交清单；返回 `status=upload` + `next_index`（或 `complete` 幂等跳过） |
| POST | `/api/upload/chunk?name=&index=` | 上传一块原始字节，服务端逐块校验 SHA-256 |
| POST | `/api/upload/complete` | 整文件复算通过后**原子发布**；磁盘余量低于 `--min-free-bytes` 时 `init` 直接返回 507 |
| POST | `/api/upload/complete` | 整文件复算 → 原子发布 → 恢复元数据 |
| GET | `/api/download/manifest?name=` | 取该文件的逐块清单 |

上传侧的两条硬性约束：

- **磁盘余量**：`/api/upload/init` 会先看目标盘剩余空间，要求「剩余 − 本次大小 ≥ 512 MiB」（阈值可调：`--min-free-bytes`，`0` 关闭）。否则返回 `507`，避免一次上传把根分区写满、连 sshd 一起拖死。
- **文件名**：拒绝 Windows 保留设备名（`CON`/`NUL`/`COM1`…）、尾随点或空格、以及控制字符——这些名字在 Linux 上能建、在 Windows 上建不出来或指向设备，跨平台传输会造成「传过去却存不上」。
| GET | `/api/download/chunk?name=&index=` | 取一块，附 `X-Chunk-Index` / `X-Chunk-Sha256` 头 |
| POST | `/api/delete` | 删除文件及其暂存状态 |

### 网页版测试

```bash
python3 -m unittest discover -s tests -v      # 33 个测试（11 CLI + 22 网页 HTTP/HTTPS/开放模式 API）
node tests/test_sha256_js.js                   # 纯 JS SHA-256 对拍 Node crypto：51 cases
node tests/test_web_e2e_node.js                # 浏览器真实代码路径 e2e：约 140 checks（随分块数/幂等跳过浮动）
```

`test_web_e2e_node.js` 用**实际的 `web/sha256.js`** 造清单、用 `fetch` + `Uint8Array` 发块（与 `app.js` 一致），起一个真实 `web_transfer.py`，证明「服务端独立 SHA-256 == 浏览器 JS SHA-256（byte-exact, lossless）」、下载重组字节一致、篡改块被拒；不依赖 `crypto.subtle`。不设环境变量时它会自己拉起服务端（明文 HTTP）；设 `LT_E2E_URL` / `LT_E2E_TOKEN` 可指向一个已运行的真实隧道，URL 为 `https://` 时还会断言服务端 `tls:true`（配合 `NODE_EXTRA_CA_CERTS` 信任自签证书）。Python 套件里的 `WebTransferTLS` 会再起一个**原生 HTTPS 服务**，用公开的测试证书跑完整分块上传 / 下载 / 字节比对。`test_web_transfer.py` 中另有 `build_tls_context()` 对缺失证书 / 不成对参数的拒绝测试。

---

## 协议与「无损」是如何被保证的

```
发送端 S                                       接收端 R
   |  HELLO  {name,size,sha256,chunk_size}\n     |
   |  META   {manifest: 全文件哈希 + 每块哈希    |
   |          + 元数据 + 每块 offset/length}\n    |
   |-------------------------------------------->|
   |         RESUME {next_index:N}\n              |  查 .lossless-state.json + .part 前缀长度
   |<--------------------------------------------|  （身份不匹配则从 0 重来，绝不混字节）
   |  CHUNK {index,offset,length,sha256}\n        |
   |  <length 字节原始二进制>                     |  逐块 SHA-256 校验 → 追加写 .part → 落盘状态
   |  ... (重复，直到所有块)                      |
   |-------------------------------------------->|
   |  (shutdown WR)                               |  全文件 SHA-256 复算 == manifest.sha256
   |<--------------------------------------------|  os.replace(.part -> 目标) + 恢复 mtime/mode
   |  DONE {sha256,size,mtime_ns,path}\n          |
   |<--------------------------------------------|
   |  S 用自己源文件的 manifest 比对 DONE          |
   |  相同 → VERIFIED / 不同 → 非零退出码          |
```

保障清单：

- **不重编码**：接收端唯一的内容写入是 `out.write(data)`，`data` 直接来自 socket；全项目无 `PIL`/`cv2`/`ffmpeg`/转码调用。
- **不重压缩**：无 `zlib`/`gzip` 用于传输载荷（测试里 zlib 只用来*构造*一个合法 PNG 样本）。
- **字节级一致**：每块校验 + 全文件校验 + 发送端对接收端回报哈希做最终判定；任何一位差异都会导致非零退出码。
- **元数据与时间戳**：`mtime_ns`、`atime_ns`、`mode`、`uid`、`gid`、`ctime_ns` 随 META 传送；`mtime_ns`/`atime_ns`/`mode` 通过 `os.utime(ns=...)` / `os.chmod()` 恢复；`ctime`/创建时间仅传不设（POSIX ctime 不可直接设置，Windows 创建时间需平台 API）。
- **同时支持照片和视频**：按字节处理，与扩展名无关；测试覆盖 JPEG、PNG、MP4(ISO-BMFF)、空文件、单字节文件、大文件多块。
- **分块与断点续传**：`--chunk-size` 控制块大小（CLI 默认 1 MiB，网页版默认 4 MiB）；每验完一块就原子写 `.lossless-state.json`，中断后重跑只补未验块；状态绑定文件 `name+size+sha256+chunk_size+完整块清单`，换文件自动从头开始。META 内含完整逐块清单，超大文件配合极小 `--chunk-size` 会让清单本身变大（单条 JSON 行上限 64 MiB），日常照片/视频用默认或 256 KiB 即可。
- **平台限制（诚实说明）**：`os.utime(ns=...)` 恢复精度受目标文件系统限制，Windows NTFS 为 100 ns tick，会把 `...6789` 落成 `...6700`。因此 `--strict-metadata` 比较的是**源与目的各自实际存储的值**，而不是理想字面值；测试同样按此断言。字节内容不受任何影响。

---

## 退出码（CLI）

| 码 | 含义 |
| --- | --- |
| 0 | 成功 / 校验通过 |
| 1 | 通用错误（网络、协议、JSON）或 `verify` 发现不一致 |
| 2 | 参数/文件错误（源文件不存在、接收超时、chunk-size ≤ 0） |
| 3 | 协议握手错误（HELLO/META/RESUME 不匹配） |
| 4 | 块序号错乱或缺少 DONE |
| 5 | 块 SHA-256 不匹配（线路损坏）或最终校验失败 |
| 6 | 组装后全文件哈希不匹配（保留 `.part` 供重试） |
| 130 | 用户 Ctrl+C 中断 |

---

## 安全提示与后续可选项

- ⚠️ **CLI：明文 TCP，无认证**：任何能连上该端口的人都可以推送文件（接收端用 `os.path.basename` 阻断路径穿越，但不验证对端身份）。仅在可信网络使用，或套 SSH：`ssh -L 8765:127.0.0.1:8765 user@receiver`。
- ⚠️ **网页版：令牌鉴权 + 可选原生 HTTPS**：所有 `/api/*` 校验 `X-LT-Token`（`hmac.compare_digest` 常量时间比对），静态页公开、文件名做 `basename` 白名单校验（拒绝空名 / NUL / 斜杠 / 路径穿越 / 内部保留后缀）。
  - **明文模式**（默认，不带证书）：令牌与文件字节都未加密，仅限本机 / 可信局域网；且经内地 SakuraFrp 节点会被 501 拦截，必须改用 HTTPS。请务必用足够随机的口令（不传 `--token` 即自动生成），不要复用弱口令。
  - **HTTPS 模式**（`--tls-cert/--tls-key` 或启动器「自动 HTTPS」）：链路上令牌与字节均被 TLS 加密，也是跨公网 / 内地节点的必需配置。自签证书仅提供加密与主机校验、不提供公信力（首次访问会提示一次）；要消除提示可换自有域名证书。文件字节仍不解码、不重编码，画质与「无损」保证不变。
- 可选增强（超出最小项目范围）：PSK 双向认证、目录批量与 manifest 批量校验、并行块、接收端允许列表、端到端加密（在客户端先加密再传，但那样就不是「原样字节」了）。

## 许可证

MIT — 见 [LICENSE](LICENSE)。
