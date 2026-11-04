# lossless-transfer · 无损传输照片 / 视频

一个**可运行、零第三方依赖、跨平台**的最小项目，用于在两台机器之间传输照片和视频，并保证**传输前后文件字节完全一致**。

> 「无损」在这里指**字节级无损**：不解码、不重编码、不重新压缩、不缩放、不改容器、不碰 EXIF/元数据。
> 程序把照片和视频当作不透明字节流（`rb` / `wb`），并在传输完成后用 **SHA-256** 双向比对来**证明**一致性，而不是假设一致。

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

**未实现（明确的边界，非缺陷）**：传输层**无加密、无身份认证**。这是明文 TCP，仅建议在可信局域网 / 本机使用；公网请套 SSH 隧道、WireGuard 或 TLS 反向代理。协议不含 NAT 穿透、不含多文件批量、不含目录递归（一次连接传一个文件，可脚本循环）。

---

## 项目结构

```
无损传输/
├── lossless_transfer.py            # 核心实现：CLI + 协议 + 哈希 + 断点续传（单文件，无依赖）
├── README.md                       # 本文档
├── LICENSE                         # MIT
├── .gitignore
├── tests/
│   └── test_lossless_transfer.py   # 11 个 unittest：真实 TCP 端到端、哈希、元数据、断点续传、篡改检测
└── scripts/
    └── verify_transfer.py          # 独立校验脚本：双进程走真实 CLI，生成照片/视频样本并出报告
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

---

## 快速开始

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

**跑单元测试**
```bash
python3 -m unittest discover -s tests -v
```

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
- **分块与断点续传**：`--chunk-size` 控制块大小（默认 1 MiB）；每验完一块就原子写 `.lossless-state.json`，中断后重跑只补未验块；状态绑定文件 `name+size+sha256+chunk_size+完整块清单`，换文件自动从头开始。META 内含完整逐块清单，超大文件配合极小 `--chunk-size` 会让清单本身变大（单条 JSON 行上限 64 MiB），日常照片/视频用默认或 256 KiB 即可。
- **平台限制（诚实说明）**：`os.utime(ns=...)` 恢复精度受目标文件系统限制，Windows NTFS 为 100 ns tick，会把 `...6789` 落成 `...6700`。因此 `--strict-metadata` 比较的是**源与目的各自实际存储的值**，而不是理想字面值；测试同样按此断言。字节内容不受任何影响。

---

## 退出码

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

- ⚠️ **明文 TCP，无认证**：任何能连上该端口的人都可以推送文件（接收端用 `os.path.basename` 阻断路径穿越，但不验证对端身份）。仅在可信网络使用，或套 SSH：`ssh -L 8765:127.0.0.1:8765 user@receiver`。
- 可选增强（超出最小项目范围）：TLS / PSK 认证、发送端带 token 的 HELLO、目录批量与 manifest 批量校验、并行块、NAT 穿透、接收端允许列表。

## 许可证

MIT — 见 [LICENSE](LICENSE)。
