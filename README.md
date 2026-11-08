# lossless-transfer · 无损传输照片 / 视频

一个**可运行、零第三方依赖、跨平台**的最小项目，用于在两台机器之间传输照片和视频，并保证**传输前后文件字节完全一致**。

> 「无损」在这里指**字节级无损**：不解码、不重编码、不重新压缩、不缩放、不改容器、不碰 EXIF/元数据。
> 程序把照片和视频当作不透明字节流（`rb` / `wb`），并在传输完成后用 **SHA-256** 双向比对来**证明**一致性，而不是假设一致。

项目提供两种用法，共用同一套哈希 / 清单 / 断点续传逻辑：

- **CLI**：`lossless_transfer.py` —— 命令行 TCP 直传，适合本机 / 局域网、脚本批处理。
- **网页版**：`web_transfer.py` + `web/` —— 浏览器里拖拽上传、点击下载；配合内网穿透（如 SakuraFrp）可**在不同网络 / 跨公网**使用，另一端只要一个浏览器。

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
| **自写纯 JS SHA-256** (`web/sha256.js`) | SakuraFrp/frp 的普通 TCP 隧道是明文 HTTP，属于**非安全上下文**，`window.crypto.subtle` 会被浏览器禁用；因此自带增量式 SHA-256，且避免把整个视频读进内存 |
| 令牌鉴权 `X-LT-Token` | 隧道把端口暴露到公网，必须有一道口令（`hmac.compare_digest` 常量时间比对）；比 CLI 的「无认证」更进一步 |
| 大分块（默认 4 MiB） | 隧道上往返延迟更高，加大块减少请求数 |

**未实现（明确的边界，非缺陷）**：CLI 传输层**无加密、无身份认证**（明文 TCP，仅建议可信局域网 / 本机，公网请套 SSH 隧道、WireGuard 或 TLS 反向代理）。网页版增加了**令牌鉴权**，但仍是**明文 HTTP**——令牌和文件字节都未加密，请务必使用足够随机的口令，并理解隧道服务商理论上能看到流量。协议不含 NAT 穿透（由 frp 等外部工具解决）、不含多文件批量（可逐个选 / 脚本循环）、不含目录递归。

---

## 项目结构

```
无损传输/
├── lossless_transfer.py            # CLI 核心：协议 + 哈希 + 断点续传（单文件，无依赖）
├── web_transfer.py                 # 网页版服务端：零依赖 HTTP 服务 + 令牌鉴权 + 分块/断点续传 + 双向校验
├── web/                            # 网页版前端（纯静态，零依赖）
│   ├── index.html                  # 页面结构：连接 / 上传 / 资料库 / 运行日志
│   ├── app.css                     # 深色主题样式
│   ├── app.js                      # 上传/下载/校验流程，调用 LTSha256
│   └── sha256.js                   # 纯 JS 增量 SHA-256（兼容非 HTTPS 隧道）
├── README.md                       # 本文档
├── LICENSE                         # MIT
├── .gitignore
├── tests/
│   ├── test_lossless_transfer.py   # 11 个 unittest：CLI 真实 TCP 端到端
│   ├── test_web_transfer.py        # 10 个 unittest：网页 HTTP API 端到端
│   ├── test_sha256_js.js           # 纯 JS SHA-256 对拍 Node crypto（51 cases）
│   └── test_web_e2e_node.js        # 浏览器真实代码路径 e2e（135 checks）
└── scripts/
    └── verify_transfer.py          # 独立校验脚本：真实 CLI 双进程，出 38/38 报告
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

CLI 适合命令行；如果想**在网页里拖拽上传、点击下载**，或两台机器**不在同一个局域网**（家里 ↔ 公司、手机 ↔ 家里电脑），用网页版。它仍然是**零第三方依赖**：服务端 `web_transfer.py`（Python 标准库 `http.server`），前端是 `web/` 下三个纯静态文件 + 一个纯 JS 实现的 SHA-256。

### 本机 / 局域网快速体验

**接收端（跑服务端，先启动）**
```bash
python3 web_transfer.py --host 0.0.0.0 --port 8765 --dir ./received --token 你自己的口令
```
Windows 用 `py -3 web_transfer.py ...`。不传 `--token` 会**随机生成一个**并打印在启动日志里。启动后终端会打印类似：

```
Library : D:\...\无损传输\received
Chunk   : 4194304 bytes
Local   : http://127.0.0.1:8765
ACCESS TOKEN: xxxxxxxxxxxxxxxxxxxxxx
WARNING: plain HTTP; token and file bytes are NOT encrypted
```

**发送端（任何有浏览器的设备）**：打开 `http://<接收端IP>:8765` → 在「连接」卡片填入上面的 `ACCESS TOKEN` → 点「连接」。之后：

- **上传**：把照片 / 视频拖进虚线框（或点「选择文件」，可多选）。浏览器先用纯 JS 逐块算 SHA-256 → 分块上传 → 服务端逐块复算校验 → 整文件复算 → 页面显示「✓ 已验证 · 字节完全一致」。
- **下载**：在「资料库」点「下载并校验」，浏览器逐块 GET、逐块用 JS 校验、再整文件校验，一致才保存到本地。
- **断点续传**：上传到一半中断（关页面 / 断网），重新选同一个文件，`POST /api/upload/init` 会返回 `next_index`，浏览器只补未验的块。
- **列表 / 删除**：资料库列出服务端 `received/` 里的文件，可删除。

### 跨网络 / 不同局域网：用 SakuraFrp（或任意 frp）TCP 隧道

网页版本质是一个 HTTP 服务，只要让「另一端」能访问到这个端口即可。两台机器不在同一网络时，用内网穿透把接收端的 `127.0.0.1:8765` 映射成一个公网地址。以 **SakuraFrp 启动器**（截图版本 `3.2.0.2 / 3.1.9 / 0.51.0-sakura-15.1`）为例：

1. 接收端保持 `web_transfer.py` 运行（本机监听 `127.0.0.1:8765` 即可，隧道会连过来）。
2. 启动器 → **隧道 → 创建隧道**：
   - **选择节点**：在「普通节点(内地)」里挑一个**离双方都近、可用于 TCP 的节点**。注意节点卡片上的「🚫 UDP」标记——本项目**只用 TCP**，所以带「禁止 UDP」标记的节点照样可用；避开只做「公开游戏 / UDP」用途的节点即可。带「建站」标记的节点通常更合适。
   - **隧道类型**：选 **TCP 隧道**（不是 UDP、不是 HTTP/HTTPS 类型）。
   - **本地地址** `127.0.0.1`，**本地端口** `8765`；**远程端口**按面板分配（或自选可用端口）。
3. 创建后启动该隧道，面板会给出类似 `frp-xxx.example.com:12345` 或 `节点IP:远程端口` 的**公网地址**。
4. 另一端（任何网络）浏览器打开 `http://<公网地址>`（上面分配的域名 + 远程端口），填入 `ACCESS TOKEN` 即可上传 / 下载，体验和局域网内完全一样。

> 也可用 `ssh -R`、其它 frp 服务商、Cloudflare Tunnel、WireGuard / Tailscale 等任意「把本地 TCP 端口暴露出去」的方案，步骤同理：隧道只在传输层转发 TCP 字节，不解析、不改写文件内容。

> 想验证一条真实隧道是否真的无损，可用浏览器代码路径的 e2e 测试指向它：
> ```bash
> LT_E2E_URL=http://<公网地址> LT_E2E_TOKEN=<口令> node tests/test_web_e2e_node.js
> ```
> 它会用前端同款 `web/sha256.js` 造清单并跑完整上传 / 下载 / 篡改检测。

### 画质会有影响吗？——不会，一点都不会

这是本项目最核心的保证，网页版与 CLI 完全一致：

- **不解码、不重编码、不缩放、不重新压缩、不改容器、不改 EXIF / 元数据**：照片和视频从头到尾被当作**不透明字节流**（上传 `File.slice()` / `Uint8Array`，下载 `Blob`），代码里没有任何 `Pillow` / `ffmpeg` / `<canvas>` / 图像视频库调用。
- **隧道只转发 TCP 字节**：SakuraFrp / frp 在传输层复制字节流，不解析、不改写 HTTP 载荷里的文件内容，因此对画质**零影响**。
- **三层 SHA-256 证明一致**：
  1. 浏览器端（上传前）逐块 + 整文件各算一次；
  2. 服务端收到每块**独立复算**，不符直接 `422 wire corruption`，坏字节不落盘；
  3. 组装完成后服务端整文件复算，页面再把 `done.sha256` 与浏览器清单比对，一致才显示「已验证」。下载时同理逐块 + 整文件校验。

  任何一位不同都会报错，绝不会悄悄给你一个「看起来能打开但已被改动」的文件。
- **元数据**：`mtime_ns`（网页端以 **BigInt 字符串**发送以保纳秒精度）、`mode` 等随清单上传，服务端用 `os.utime(ns=...)` / `os.chmod()` 尽力恢复；同样受 Windows NTFS 100 ns 精度限制（见下文「平台限制」），但**字节内容不受影响**。

> 简单说：`收到的字节 == 发出的字节`，所以分辨率、码率、色彩、EXIF、拍摄时间、容器格式全部原样保留。「画质变差」通常来自相册 / 网盘生成的**缩略图与转码**，而本项目刻意不做这件事。

### HTTP API（供二次开发）

所有 `/api/*` 请求必须带 `X-LT-Token` 头；静态页面（`/`、`/index.html`、`/app.js`、`/app.css`、`/sha256.js`）无需令牌。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/info` | 服务信息、`chunk_size`、`token_required` |
| GET | `/api/list` | 列出资料库文件（name / size / mtime_ns） |
| POST | `/api/upload/init` | 提交清单；返回 `status=upload` + `next_index`（或 `complete` 幂等跳过） |
| POST | `/api/upload/chunk?name=&index=` | 上传一块原始字节，服务端逐块校验 SHA-256 |
| POST | `/api/upload/complete` | 整文件复算 → 原子发布 → 恢复元数据 |
| GET | `/api/download/manifest?name=` | 取该文件的逐块清单 |
| GET | `/api/download/chunk?name=&index=` | 取一块，附 `X-Chunk-Index` / `X-Chunk-Sha256` 头 |
| POST | `/api/delete` | 删除文件及其暂存状态 |

### 网页版测试

```bash
python3 -m unittest discover -s tests -v      # 21 个测试（11 CLI + 10 网页 API）
node tests/test_sha256_js.js                   # 纯 JS SHA-256 对拍 Node crypto：51 cases
node tests/test_web_e2e_node.js                # 浏览器真实代码路径 e2e：135 checks
```

`test_web_e2e_node.js` 用**实际的 `web/sha256.js`** 造清单、用 `fetch` + `Uint8Array` 发块（与 `app.js` 一致），起一个真实 `web_transfer.py`，证明「服务端独立 SHA-256 == 浏览器 JS SHA-256（byte-exact, lossless）」、下载重组字节一致、篡改块被拒；全程纯 HTTP、不依赖 `crypto.subtle`。不设环境变量时它会自己拉起服务端；设 `LT_E2E_URL` / `LT_E2E_TOKEN` 则可指向一个已运行的真实隧道。

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
- ⚠️ **网页版：令牌鉴权，但仍是明文 HTTP**：所有 `/api/*` 校验 `X-LT-Token`（`hmac.compare_digest` 常量时间比对），静态页公开、文件名做 `basename` 白名单校验（拒绝空名 / NUL / 斜杠 / 路径穿越 / 内部保留后缀）。但**令牌与文件字节都未加密**：请务必用足够随机的口令（不传 `--token` 即自动生成），不要复用弱口令，并理解隧道服务商 / 同一网络内的监听者理论上能看到流量。需要真正的机密性请再加 HTTPS 反向代理或 WireGuard / Tailscale。
- 可选增强（超出最小项目范围）：TLS / PSK 认证、目录批量与 manifest 批量校验、并行块、接收端允许列表、端到端加密（在客户端先加密再传，但那样就不是「原样字节」了）。

## 许可证

MIT — 见 [LICENSE](LICENSE)。
