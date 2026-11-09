#!/usr/bin/env python3
"""web_transfer.py - browser UI + HTTP API for lossless-transfer.

A zero-third-party-dependency (Python stdlib only) HTTP server that serves a
single-page web app and a small JSON/raw-bytes API. It reuses the hashing,
manifest, resume-state and metadata helpers from lossless_transfer.py, so the
web path provides exactly the same byte-exact guarantee as the CLI:

  * the browser streams the local File slice-by-slice and computes a SHA-256
    for every chunk plus one for the whole file (no re-encode, no compression);
  * the server independently computes each chunk's SHA-256 and, at the end,
    the whole file's SHA-256 from the bytes it actually received;
  * the browser compares the server's reported hash with its own source hash.

Only when all three agree is the transfer declared VERIFIED. The image/video
bytes are never decoded, re-encoded, resized or stripped of metadata.

Designed to be reachable from another network through a SakuraFrp / frp TCP
tunnel. Because a plain TCP tunnel normally serves plain HTTP (a non-secure
context), crypto.subtle is unavailable in the browser; web/sha256.js is a
dependency-free SHA-256 that works in any context. All API calls require an
X-LT-Token header.

Mainland-China SakuraFrp nodes block plain HTTP over a TCP tunnel (they return
a 501 compliance page) but pass TLS bytes through unmodified. Passing
--tls-cert/--tls-key makes this server speak HTTPS itself, so the tunnel only
forwards an opaque TLS stream and the browser uses https:// - no 501, and the
token/file bytes are encrypted end-to-end. (Equivalently, the launcher's
"Auto HTTPS" can terminate TLS in front of a plain-HTTP local server.)
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import secrets
import ssl
import sys
import threading
import traceback
import urllib.parse
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Tuple

import lossless_transfer as lt

WEB_VERSION = "1.2.0"
DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024  # 4 MiB; fewer round-trips over a tunnel
MAX_CHUNKS = 100_000
MAX_INIT_BODY = 64 << 20
MAX_SMALL_BODY = 1 << 20
PREVIEW_CHUNK = 1 << 20             # rolling read size for streamed responses
PREVIEW_BATCH = 2 << 20             # a small mid-file Range is served in one piece
WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
STATIC_TYPES = {
    "index.html": "text/html; charset=utf-8",
    "app.js": "application/javascript; charset=utf-8",
    "app.css": "text/css; charset=utf-8",
    "sha256.js": "application/javascript; charset=utf-8",
}
INTERNAL_SUFFIXES = (lt.RECV_SUFFIX, lt.STATE_SUFFIX, lt.MANIFEST_SUFFIX)

# Browser-displayable media, by extension (case-insensitive). Anything that a
# browser cannot natively decode (CR3/NEF/ARW/HEIC/HEVC .mp4/MOV ...) is
# "other": its bytes are still downloadable byte-exactly, but not previewed.
IMAGE_TYPES = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".jpe": "image/jpeg",
    ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif",
    ".avif": "image/avif", ".bmp": "image/bmp",
}
VIDEO_TYPES = {
    ".mp4": "video/mp4", ".m4v": "video/mp4",
    ".webm": "video/webm", ".ogv": "video/ogg", ".ogg": "video/ogg",
    ".mov": "video/quicktime",
}
OTHER_TYPES = {
    ".txt": "text/plain; charset=utf-8",
    ".json": "application/json",
    ".pdf": "application/pdf",
}
# Kept exact: a browser can display these only if it happens to support HEIC
# (Safari); everyone else falls back to the download button.
OTHER_TYPES.update({".heic": "image/heic", ".heif": "image/heif"})


class HTTPError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class Config:
    def __init__(self, host: str, port: int, directory: str,
                 chunk_size: int, token: str) -> None:
        self.host = host
        self.port = port
        self.dir = os.path.abspath(directory)
        self.staging = os.path.join(self.dir, ".lossless-web")
        self.chunk_size = chunk_size
        self.token = token
        self._locks: Dict[str, threading.Lock] = {}
        self._guard = threading.Lock()

    def ensure_dirs(self) -> None:
        os.makedirs(self.dir, exist_ok=True)
        os.makedirs(self.staging, exist_ok=True)

    def lock_for(self, key: str) -> threading.Lock:
        with self._guard:
            lock = self._locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._locks[key] = lock
            return lock


def is_hex64(value: Any) -> bool:
    return (isinstance(value, str) and len(value) == 64
            and all(c in "0123456789abcdef" for c in value))


def safe_name(name: Any) -> str:
    """Reject path traversal, hidden/reserved names and internal suffixes."""
    if not isinstance(name, str) or not name:
        raise HTTPError(400, "invalid file name")
    if "\x00" in name or "/" in name or "\\" in name:
        raise HTTPError(400, "invalid file name (path separator or NUL byte)")
    if len(name) > 255:
        raise HTTPError(400, "file name too long")
    if name in (".", "..") or name.startswith("."):
        raise HTTPError(400, "invalid file name (hidden/reserved)")
    if any(name.endswith(s) for s in INTERNAL_SUFFIXES):
        raise HTTPError(400, "invalid file name (reserved internal suffix)")
    return name


def media_type(name: str) -> Tuple[str, Optional[str]]:
    """Map a file name to (kind, content_type) strictly from its extension.

    kind is "image" or "video" for formats every current browser renders
    natively; anything else is "other" (content_type None), so the preview
    endpoint can answer 415 instead of handing the browser bytes it would
    merely download.
    """
    ext = os.path.splitext(name)[1].lower()
    if ext in IMAGE_TYPES:
        return "image", IMAGE_TYPES[ext]
    if ext in VIDEO_TYPES:
        return "video", VIDEO_TYPES[ext]
    return "other", None


def validate_manifest(obj: Any, cfg: Config) -> Dict[str, Any]:
    """Validate the browser-supplied manifest before trusting any of it."""
    if not isinstance(obj, dict):
        raise HTTPError(400, "manifest must be a JSON object")
    name = safe_name(obj.get("name"))
    size = obj.get("size")
    sha = obj.get("sha256")
    chunk_size = obj.get("chunk_size")
    chunks = obj.get("chunks")
    if not isinstance(size, int) or isinstance(size, bool) or size < 0:
        raise HTTPError(400, "invalid size")
    if not is_hex64(sha):
        raise HTTPError(400, "invalid whole-file sha256")
    if not isinstance(chunk_size, int) or isinstance(chunk_size, bool) \
            or chunk_size != cfg.chunk_size:
        raise HTTPError(400, "chunk_size must equal the server's chunk_size (%d)"
                        % cfg.chunk_size)
    if not isinstance(chunks, list) or len(chunks) > MAX_CHUNKS:
        raise HTTPError(400, "invalid or too many chunks")
    total = 0
    for i, c in enumerate(chunks):
        if not isinstance(c, dict):
            raise HTTPError(400, "chunk %d is not an object" % i)
        length = c.get("length")
        if (c.get("index") != i or c.get("offset") != i * chunk_size
                or not isinstance(length, int) or isinstance(length, bool)
                or length <= 0 or length > chunk_size
                or not is_hex64(c.get("sha256"))):
            raise HTTPError(400, "invalid chunk %d descriptor" % i)
        if i < len(chunks) - 1 and length != chunk_size:
            raise HTTPError(400, "only the last chunk may be shorter")
        total += length
    if total != size:
        raise HTTPError(400, "sum(chunk length) != size")
    return {
        "name": name,
        "size": size,
        "sha256": sha,
        "chunk_size": chunk_size,
        "chunks": chunks,
        "mtime_ns": obj.get("mtime_ns"),
    }


class Handler(BaseHTTPRequestHandler):
    # HTTP/1.0: one request per connection, so every response ends with EOF.
    # Range/Accept-Ranges still work (a 206 carries an exact Content-Length);
    # the UI's preview loader reads responses with a byte bound so a shared
    # protocol_version change can never stall it.
    protocol_version = "HTTP/1.0"
    server_version = "LosslessWeb/" + WEB_VERSION

    @property
    def cfg(self) -> Config:
        return self.server.cfg  # type: ignore[attr-defined]

    # ---- low-level helpers -------------------------------------------------
    def _send_bytes(self, data: bytes, content_type: str, status: int = 200,
                    extra: Optional[Dict[str, str]] = None) -> None:
        # Bytes this response body will contain. _api_preview consults it so a
        # HEAD request answers with identical headers and no body.
        self._body_bytes = len(data)
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()
        if data and self.command != "HEAD":
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True

    def _send_json(self, obj: Any, status: int = 200) -> None:
        payload = json.dumps(obj, ensure_ascii=False,
                             separators=(",", ":")).encode("utf-8")
        self._send_bytes(payload, "application/json; charset=utf-8", status)

    def _read_body(self, max_bytes: int) -> bytes:
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            length = 0
        if length < 0 or length > max_bytes:
            self.close_connection = True
            raise HTTPError(413, "request body too large (limit %d bytes)"
                            % max_bytes)
        if length == 0:
            return b""
        data = self.rfile.read(length)
        if len(data) != length:
            raise HTTPError(400, "incomplete request body")
        return data

    def _read_json(self, max_bytes: int) -> Any:
        raw = self._read_body(max_bytes)
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise HTTPError(400, "invalid JSON body")

    def _require_auth(self, allow_media_token: bool = False) -> None:
        # An empty token means --no-auth: the shared folder is deliberately
        # open to anyone who can reach the URL (see README "open mode").
        if not self.cfg.token:
            return
        if allow_media_token:
            # <video>/<img> cannot send request headers, so the preview
            # endpoint additionally accepts the server-generated media token
            # in the query string. It is unused on every other route, so it
            # can never unlock a mutation or a verified download.
            mt = getattr(self.server, "media_token", "")
            got_t = self._parts()[1].get("t", [""])[0]
            if mt and got_t and hmac.compare_digest(got_t, mt):
                return
        got = self.headers.get("X-LT-Token", "")
        if not got or not hmac.compare_digest(got, self.cfg.token):
            raise HTTPError(401, "unauthorized: invalid or missing X-LT-Token")

    def _parts(self):
        parsed = urllib.parse.urlparse(self.path)
        return parsed.path, urllib.parse.parse_qs(parsed.query,
                                                  keep_blank_values=True)

    @staticmethod
    def _qs(q, key: str) -> str:
        vals = q.get(key)
        if not vals or not vals[0]:
            raise HTTPError(400, "missing query parameter: " + key)
        return vals[0]

    def _staging_for(self, name: str):
        key = hashlib.sha256(name.encode("utf-8")).hexdigest()
        return os.path.join(self.cfg.staging, key), key

    # ---- range / streaming helpers -----------------------------------------
    def _parse_range(self, size: int) -> Optional[Tuple[Optional[int],
                                                        Optional[int]]]:
        """Parse the single byte-range of a `Range: bytes=...` header.

        Returns (start, end) with BOTH inclusive (None, None) means "whole
        file", or None when the header is unsatisfiable (RFC 9110 416).
        Multi-range requests are deliberately not multiplexed: the first
        satisfiable range is served, which is legal (a server may ignore the
        others) and keeps `<video>` seeking trivially correct.
        """
        raw = (self.headers.get("Range") or "").strip()
        if not raw.lower().startswith("bytes="):
            return (None, None)
        for part in raw[6:].split(","):
            part = part.strip()
            if "-" not in part:
                continue
            first, last = part.split("-", 1)
            first, last = first.strip(), last.strip()
            try:
                if not first:                       # suffix: bytes=-N
                    n = int(last)
                    if n <= 0 or size <= 0:
                        continue
                    return max(0, size - n), size - 1
                start = int(first)                  # bytes=A- / bytes=A-B
                if start < 0 or start >= size:
                    continue
                end = int(last) if last else size - 1
                if end < start:
                    continue
                return start, min(end, size - 1)
            except ValueError:
                continue
        return None

    def _stream_file(self, path: str, start: int, length: int) -> None:
        """Copy exactly `length` raw bytes from `path[start:]` to the socket.

        The bytes are never decoded or transformed; the file is read in
        PREVIEW_CHUNK pieces (a last-second file replacement merely ends the
        stream early, it can never inject wrong bytes into a verified
        download, which always goes through /api/download/chunk).
        """
        pos = start
        remaining = length
        try:
            with open(path, "rb") as f:
                if start:
                    f.seek(start)
                while remaining > 0:
                    f.seek(pos)  # tolerate a concurrent overwrite
                    piece = f.read(min(PREVIEW_CHUNK, remaining))
                    if not piece:
                        break
                    self.wfile.write(piece)
                    pos += len(piece)
                    remaining -= len(piece)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    # ---- routing -----------------------------------------------------------
    def _serve_static(self, path: str) -> None:
        if path in ("/", "/index.html"):
            fname = "index.html"
        elif path in ("/app.js", "/app.css", "/sha256.js"):
            fname = path.lstrip("/")
        elif path == "/favicon.ico":
            self._send_bytes(b"", "image/x-icon", 204)
            return
        else:
            raise HTTPError(404, "not found")
        with open(os.path.join(WEB_DIR, fname), "rb") as f:
            data = f.read()
        self._send_bytes(data, STATIC_TYPES[fname])

    def _route(self, method: str) -> None:
        path, q = self._parts()
        if not path.startswith("/api/"):
            if method == "GET":
                return self._serve_static(path)
            raise HTTPError(404, "not found")
        # /api/preview is the ONLY route that also accepts the media token,
        # because a browser media element cannot attach request headers.
        self._require_auth(allow_media_token=(path == "/api/preview"))
        if path == "/api/info" and method == "GET":
            return self._api_info()
        if path == "/api/list" and method == "GET":
            return self._api_list()
        if path == "/api/upload/init" and method == "POST":
            return self._api_upload_init()
        if path == "/api/upload/chunk" and method == "POST":
            return self._api_upload_chunk(q)
        if path == "/api/upload/complete" and method == "POST":
            return self._api_upload_complete()
        if path == "/api/download/manifest" and method == "GET":
            return self._api_download_manifest(q)
        if path == "/api/download/chunk" and method == "GET":
            return self._api_download_chunk(q)
        if path == "/api/preview" and method == "GET":
            return self._api_preview(q)
        if path == "/api/delete" and method == "POST":
            return self._api_delete()
        raise HTTPError(404, "unknown endpoint")

    # ---- API: info / list --------------------------------------------------
    def _api_info(self) -> None:
        self._send_json({
            "service": "lossless-transfer-web",
            "version": WEB_VERSION,
            "protocol": lt.PROTOCOL_VERSION,
            "chunk_size": self.cfg.chunk_size,
            "token_required": bool(self.cfg.token),
            "tls": isinstance(self.server.socket, ssl.SSLSocket),
            # Header-less media elements (<video> posters/playback) append
            # this to the preview URL instead of X-LT-Token. Empty in
            # --no-auth mode, where no token is needed at all.
            "media_token": getattr(self.server, "media_token", "")
                           if self.cfg.token else "",
            "preview_ext": {"image": sorted(IMAGE_TYPES),
                            "video": sorted(VIDEO_TYPES)},
        })

    def _api_list(self) -> None:
        files = []
        for name in sorted(os.listdir(self.cfg.dir)):
            if name.startswith("."):
                continue
            path = os.path.join(self.cfg.dir, name)
            if not os.path.isfile(path):
                continue
            if any(name.endswith(s) for s in INTERNAL_SUFFIXES):
                continue
            st = os.stat(path)
            mtime_ns = getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9))
            kind, _ = media_type(name)
            files.append({"name": name, "size": st.st_size,
                          "mtime_ns": mtime_ns, "kind": kind})
        self._send_json({"files": files, "count": len(files)})

    # ---- API: upload -------------------------------------------------------
    def _api_upload_init(self) -> None:
        v = validate_manifest(self._read_json(MAX_INIT_BODY), self.cfg)
        name = v["name"]
        staging, key = self._staging_for(name)
        dest = os.path.join(self.cfg.dir, name)
        with self.cfg.lock_for(key):
            if os.path.exists(dest) and not os.path.isfile(dest):
                raise HTTPError(409, "a directory with this name exists")
            if os.path.isfile(dest):
                existing = lt.sha256_file(dest)
                if existing == v["sha256"]:
                    # Idempotent: an identical file is already stored.
                    return self._send_json({
                        "status": "complete", "sha256": existing,
                        "size": v["size"],
                        "mtime_ns": lt.file_metadata(dest)["mtime_ns"],
                        "path": dest,
                    })
                raise HTTPError(
                    409, "a different file with this name already exists "
                         "(delete it first to replace)")
            next_index = lt.load_resume_state(staging, v)
            if next_index == 0:
                lt.cleanup_transfer_artifacts(staging)
                with open(lt.part_path(staging), "wb"):
                    pass  # fresh empty .part
                lt.save_resume_state(staging, v, 0)
        self._send_json({
            "status": "upload", "next_index": next_index,
            "chunk_size": v["chunk_size"], "chunks": len(v["chunks"]),
        })

    def _api_upload_chunk(self, q) -> None:
        name = safe_name(self._qs(q, "name"))
        try:
            index = int(self._qs(q, "index"))
        except ValueError:
            raise HTTPError(400, "index must be an integer")
        staging, key = self._staging_for(name)
        with self.cfg.lock_for(key):
            state = lt.read_json(lt.resume_state_path(staging))
            if not state:
                raise HTTPError(409, "no active upload; call init first")
            chunks = state["chunks"]
            if state.get("next_index") != index:
                raise HTTPError(409, "out-of-order chunk; expected index %s"
                                % state.get("next_index"))
            if index < 0 or index >= len(chunks):
                raise HTTPError(400, "chunk index out of range")
            c = chunks[index]
            data = self._read_body(self.cfg.chunk_size + 4096)
            if len(data) != c["length"]:
                raise HTTPError(400, "chunk length mismatch (got %d, want %d)"
                                % (len(data), c["length"]))
            got = hashlib.sha256(data).hexdigest()
            if got != c["sha256"]:
                raise HTTPError(422, "chunk %d SHA-256 mismatch (wire corruption)"
                                % index)
            part = lt.part_path(staging)
            expected = sum(x["length"] for x in chunks[:index])
            if not os.path.isfile(part) or os.path.getsize(part) != expected:
                raise HTTPError(409, "partial file size mismatch; re-init required")
            with open(part, "ab") as f:
                f.write(data)  # the ONLY write of file bytes; a raw byte copy
            lt.save_resume_state(staging, state, index + 1)
        self._send_json({"ok": True, "index": index, "next_index": index + 1})

    def _api_upload_complete(self) -> None:
        body = self._read_json(MAX_SMALL_BODY)
        if not isinstance(body, dict):
            raise HTTPError(400, "body must be a JSON object")
        name = safe_name(body.get("name"))
        mtime_ns = body.get("mtime_ns")
        staging, key = self._staging_for(name)
        dest = os.path.join(self.cfg.dir, name)
        with self.cfg.lock_for(key):
            state = lt.read_json(lt.resume_state_path(staging))
            if not state:
                raise HTTPError(409, "no active upload")
            part = lt.part_path(staging)
            if not os.path.isfile(part):
                raise HTTPError(409, "partial file missing")
            sha = lt.sha256_file(part)
            size = os.path.getsize(part)
            if sha != state["sha256"] or size != state["size"]:
                raise HTTPError(
                    422, "assembled SHA-256/size mismatch; partial kept for "
                         "retry (got sha=%s size=%d, want sha=%s size=%d)"
                         % (sha, size, state["sha256"], state["size"]))
            if os.path.isfile(dest) and lt.sha256_file(dest) != sha:
                raise HTTPError(409, "a different file with this name exists")
            os.replace(part, dest)  # atomic publish of the finished file
            # Browser sends mtime_ns as a BigInt *string* to keep full
            # nanosecond precision through JSON; accept int, float or str.
            if isinstance(mtime_ns, (int, float, str)) and not isinstance(mtime_ns, bool):
                try:
                    ns = int(mtime_ns)
                    lt.restore_metadata(dest, {"atime_ns": ns, "mtime_ns": ns,
                                              "mode": 0o644})
                except (OSError, ValueError, OverflowError):
                    pass
            lt.cleanup_transfer_artifacts(staging)
            meta = lt.file_metadata(dest)
        self._send_json({
            "status": "verified", "sha256": sha, "size": size,
            "mtime_ns": meta["mtime_ns"], "path": dest,
        })

    # ---- API: download -----------------------------------------------------
    def _api_download_manifest(self, q) -> None:
        name = safe_name(self._qs(q, "name"))
        dest = os.path.join(self.cfg.dir, name)
        if not os.path.isfile(dest):
            raise HTTPError(404, "file not found")
        m = lt.build_manifest(dest, self.cfg.chunk_size)
        self._send_json({
            "name": name, "size": m["size"], "sha256": m["sha256"],
            "chunk_size": m["chunk_size"], "chunks": m["chunks"],
            "mtime_ns": m["metadata"]["mtime_ns"],
        })

    def _api_download_chunk(self, q) -> None:
        name = safe_name(self._qs(q, "name"))
        try:
            index = int(self._qs(q, "index"))
        except ValueError:
            raise HTTPError(400, "index must be an integer")
        dest = os.path.join(self.cfg.dir, name)
        if not os.path.isfile(dest):
            raise HTTPError(404, "file not found")
        size = os.path.getsize(dest)
        cs = self.cfg.chunk_size
        nchunks = (size + cs - 1) // cs
        if index < 0 or index >= nchunks:
            raise HTTPError(400, "chunk index out of range")
        offset = index * cs
        length = min(cs, size - offset)
        with open(dest, "rb") as f:
            f.seek(offset)
            data = f.read(length)
        self._send_bytes(data, "application/octet-stream", 200, {
            "X-Chunk-Index": str(index),
            "X-Chunk-Sha256": hashlib.sha256(data).hexdigest(),
        })

    # ---- API: preview ------------------------------------------------------
    def _api_preview(self, q) -> None:
        """GET /api/preview?name=... [&index=N]  -> raw bytes, Range-aware.

        Streams the stored file verbatim with the Content-Type implied by its
        extension, so the browser can render images and play/seek videos. It
        is a *display* path: the verified, SHA-256-checked path stays
        /api/download/manifest + /api/download/chunk.

        `index` is OPTIONAL: a caller-visible hint that the client wants the
        N-th previewable item of its current list. It is validated (integer)
        but never selects a file - `name` alone does - so the endpoint cannot
        be used to probe anything outside the shared folder.

        Headers: Accept-Ranges / Content-Range / ETag / Last-Modified, so
        <video> can seek with 206 responses and images can be cached briefly.
        Extensions a browser cannot decode natively (CR3/NEF/RAW ...) get 415
        so the UI offers the verified download instead.
        """
        name = safe_name(self._qs(q, "name"))
        if "index" in q:
            try:
                int(self._qs(q, "index"))
            except ValueError:
                raise HTTPError(400, "index must be an integer")
        kind, ctype = media_type(name)
        if ctype is None:
            raise HTTPError(415, "this file type cannot be previewed in a "
                                 "browser; download it to verify it "
                                 "byte-exactly")
        dest = os.path.join(self.cfg.dir, name)
        if not os.path.isfile(dest):
            raise HTTPError(404, "file not found")
        st = os.stat(dest)
        size = st.st_size
        mtime_ns = getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9))
        # (size, mtime_ns) identifies the stored version: a client may pass
        # it as `index=` so a re-uploaded name becomes a new URL and the
        # browser cache can never serve stale bytes.
        etag = '"%x-%x"' % (size, mtime_ns)
        rng = self._parse_range(size)
        if rng is None:
            self._send_bytes(
                b'{"error":"requested range not satisfiable"}',
                "application/json; charset=utf-8", 416,
                {"Content-Range": "bytes */%d" % size})
            return
        start = 0 if rng[0] is None else int(rng[0])
        end = (size - 1) if rng[1] is None else int(rng[1])
        length = end - start + 1 if size > 0 else 0
        partial = rng[0] is not None
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("ETag", etag)
        self.send_header("Last-Modified", self.date_time_string(st.st_mtime))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Disposition", "inline")
        # Short max-age: bytes are immutable for a given ETag, and it keeps
        # video seeking / repeated image opens off a slow tunnel.
        self.send_header("Cache-Control", "private, max-age=86400")
        if partial:
            self.send_header("Content-Range",
                             "bytes %d-%d/%d" % (start, end, size))
        self.end_headers()
        if length and self.command != "HEAD":
            self._stream_file(dest, start, length)

    # ---- API: delete -------------------------------------------------------
    def _api_delete(self) -> None:
        body = self._read_json(MAX_SMALL_BODY)
        if not isinstance(body, dict):
            raise HTTPError(400, "body must be a JSON object")
        name = safe_name(body.get("name"))
        staging, key = self._staging_for(name)
        dest = os.path.join(self.cfg.dir, name)
        with self.cfg.lock_for(key):
            lt.cleanup_transfer_artifacts(staging)
            if os.path.isfile(dest):
                os.remove(dest)
        self._send_json({"ok": True, "name": name})

    # ---- framework ---------------------------------------------------------
    def do_GET(self) -> None:
        self._handle("GET")

    def do_POST(self) -> None:
        self._handle("POST")

    def do_HEAD(self) -> None:
        # Routed like GET so HEAD /api/preview (and the rest of /api/*)
        # reports the same headers a GET would; bodies are suppressed.
        self._handle("GET")

    def _handle(self, method: str) -> None:
        try:
            self._route(method)
        except HTTPError as exc:
            self.close_connection = True  # avoid keep-alive body desync on error
            self._send_json({"error": exc.message}, exc.status)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception as exc:  # pragma: no cover - defensive
            traceback.print_exc()
            self.close_connection = True
            try:
                self._send_json({"error": "internal error: %s" % exc}, 500)
            except Exception:
                pass

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("[web] %s - %s\n" % (self.address_string(), fmt % args))


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="web_transfer.py",
        description="Zero-dependency browser UI for byte-exact photo/video "
                    "transfer (works over a SakuraFrp TCP tunnel).",
    )
    p.add_argument("--version", action="version", version="%(prog)s " + WEB_VERSION)
    p.add_argument("--host", default="0.0.0.0",
                   help="bind address (default 0.0.0.0)")
    p.add_argument("--port", type=int, default=8765,
                   help="TCP port (default 8765)")
    p.add_argument("--dir", default="received",
                   help="directory that stores received files (default ./received)")
    p.add_argument("--chunk-size", type=int, default=DEFAULT_CHUNK_SIZE,
                   help="chunk size in bytes (default %d)" % DEFAULT_CHUNK_SIZE)
    p.add_argument("--token", default=None,
                   help="access token; a random one is generated if omitted")
    p.add_argument("--no-auth", action="store_true",
                   help="open mode: no token at all, anyone who can reach the "
                        "URL may upload/download/delete (implies a public folder)")
    p.add_argument("--tls-cert", default=None,
                   help="PEM certificate to serve HTTPS (needed for mainland "
                        "SakuraFrp nodes that block plain HTTP); use with --tls-key")
    p.add_argument("--tls-key", default=None,
                   help="PEM private key matching --tls-cert")
    return p


def build_tls_context(cert_path: str, key_path: str) -> ssl.SSLContext:
    """Server-side TLS context; fails early with a clear message."""
    if not cert_path or not key_path:
        raise ValueError("--tls-cert and --tls-key must be given together")
    for label, p in (("certificate", cert_path), ("private key", key_path)):
        if not os.path.isfile(p):
            raise ValueError("TLS %s not found: %s" % (label, p))
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(certfile=cert_path, keyfile=key_path)
    return ctx


def main(argv: Optional[list] = None) -> int:
    args = build_parser().parse_args(argv)
    if args.chunk_size <= 0:
        print("ERROR: --chunk-size must be > 0", file=sys.stderr)
        return 2
    if bool(args.tls_cert) != bool(args.tls_key):
        print("ERROR: --tls-cert and --tls-key must be used together",
              file=sys.stderr)
        return 2
    if args.no_auth and args.token:
        print("ERROR: --no-auth and --token are mutually exclusive",
              file=sys.stderr)
        return 2
    token = "" if args.no_auth else (args.token or secrets.token_urlsafe(18))
    cfg = Config(args.host, args.port, args.dir, args.chunk_size, token)
    cfg.ensure_dirs()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    httpd.cfg = cfg  # type: ignore[attr-defined]
    # Media elements (<video>) cannot send X-LT-Token, so the preview endpoint
    # also honours `?t=<token>` - one expiring, tunnel-scoped secret, never
    # part of a verified download. See Handler._require_auth.
    httpd.media_token = secrets.token_urlsafe(9)  # type: ignore[attr-defined]
    tls = False
    if args.tls_cert:
        try:
            ctx = build_tls_context(args.tls_cert, args.tls_key)
        except (ValueError, ssl.SSLError, OSError) as exc:
            httpd.server_close()
            print("ERROR: cannot enable TLS: %s" % exc, file=sys.stderr)
            return 2
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
        tls = True
    scheme = "https" if tls else "http"
    shown_host = "127.0.0.1" if args.host in ("0.0.0.0", "", "::") else args.host
    print("=" * 70)
    print("  lossless-transfer  WEB  v%s   (Python stdlib only)" % WEB_VERSION)
    print("=" * 70)
    print("  Library dir  : %s" % cfg.dir)
    print("  Chunk size   : %d bytes (%.1f MiB)" %
          (cfg.chunk_size, cfg.chunk_size / 1048576.0))
    print("  Local URL    : %s://%s:%d" % (scheme, shown_host, args.port))
    if token:
        print("  ACCESS TOKEN : %s" % token)
        print("  -> enter this token in the web page (sent as X-LT-Token header)")
    else:
        print("  ACCESS TOKEN : (open mode - no token required)")
        print("  -> WARNING: ANYONE who can reach this URL can upload, download "
              "and DELETE")
        print("     files in the shared folder. Only use this knowingly.")
    print("  -> other networks: point a SakuraFrp/frp TCP tunnel at port %d,"
          % args.port)
    print("     then open the public %s://<tunnel-host>:<port> in a browser"
          % scheme)
    if tls:
        print("  TLS          : ENABLED (native HTTPS; tunnel forwards opaque "
              "TLS bytes)")
        print("  -> mainland SakuraFrp nodes block plain HTTP (501); with TLS "
              "they work.")
        print("  -> self-signed cert: the browser will ask you to accept it "
              "once.")
    else:
        print("  WARNING: plain HTTP; token and file bytes are NOT encrypted.")
        print("           On mainland SakuraFrp nodes this is blocked with a "
              "501 page;")
        print("           add --tls-cert/--tls-key or enable the launcher's "
              "'Auto HTTPS'.")
    print("=" * 70, flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
