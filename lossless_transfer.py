#!/usr/bin/env python3
"""lossless-transfer: byte-exact photo/video transfer over a real TCP socket.

Design goals
------------
* Zero third-party dependencies (Python >= 3.8 standard library only).
* Cross-platform (Windows / macOS / Linux) — TCP works everywhere.
* The receiver never decodes, re-encodes, re-compresses, resizes, or
  re-writes media. It only copies raw bytes into a file.
* SHA-256 of every chunk (per-chunk integrity) AND of the whole file,
  computed independently by both sides, is compared by the sender before
  it declares success -> byte-level equality is *proven*, not assumed.
* mtime/atime (nanosecond precision) and POSIX mode bits are transferred
  and restored. Creation time / uid / gid are carried as informational
  best-effort fields.
* Fixed-size chunks + a JSON resume state file -> an interrupted transfer
  resumes from the last verified chunk instead of starting over.
* Both photos and videos are treated as opaque byte streams; there is no
  format handling of any kind, so no quality can be lost.

Wire protocol (one connection per file; JSON lines + raw binary)
---------------------------------------------------------------
  S -> R : HELLO   {"op":"HELLO", ...}\n
  S -> R : META    {"op":"META", "manifest":{...}}\n
  R -> S : RESUME  {"op":"RESUME", "next_index":N}\n
  S -> R : for each chunk index >= N:
             CHUNK header JSON line
             raw chunk bytes (exactly header["length"] bytes)
  R -> S : DONE    {"op":"DONE", "sha256":..., "size":..., ...}\n
  S compares DONE against its own source manifest; prints VERIFIED/FAILED.

Note: META is sent BEFORE RESUME is read back. Both messages are small
enough for TCP buffers, so this ordering avoids a request/reply deadlock.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import socket
import stat
import sys
import time
from typing import Any, Dict, Optional

__version__ = "1.0.0"

CHUNK_SIZE = 1024 * 1024  # 1 MiB; override with --chunk-size
PROTOCOL_VERSION = 1
STATE_VERSION = 1
RECV_SUFFIX = ".part"
STATE_SUFFIX = ".lossless-state.json"
MANIFEST_SUFFIX = ".lossless-manifest.json"

# ---------------------------------------------------------------------------
# hashing / metadata
# ---------------------------------------------------------------------------


def sha256_file(path: str, chunk_size: int = 1024 * 1024) -> str:
    """Streaming whole-file SHA-256; never loads the file into memory."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            block = f.read(chunk_size)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def file_metadata(path: str) -> Dict[str, Any]:
    """Collect byte-level and filesystem metadata without touching content."""
    st = os.stat(path)
    mtime_ns = getattr(st, "st_mtime_ns", int(st.st_mtime * 1_000_000_000))
    atime_ns = getattr(st, "st_atime_ns", int(st.st_atime * 1_000_000_000))
    ctime_ns = getattr(st, "st_ctime_ns", int(st.st_ctime * 1_000_000_000))
    return {
        "size": st.st_size,
        "mtime_ns": mtime_ns,
        "atime_ns": atime_ns,
        "ctime_ns": ctime_ns,  # informational: POSIX ctime / Windows creation time
        "mode": stat.S_IMODE(st.st_mode),
        "uid": getattr(st, "st_uid", None),
        "gid": getattr(st, "st_gid", None),
        "platform": sys.platform,
        "python": sys.version.split()[0],
    }


def build_manifest(path: str, chunk_size: int) -> Dict[str, Any]:
    """Manifest = metadata + whole-file hash + per-chunk hashes.

    Per-chunk hashes are what make resumable verification possible: a
    receiver can prove any prefix of the file is intact after a crash.
    """
    h_all = hashlib.sha256()
    chunks = []
    with open(path, "rb") as f:
        index = 0
        while True:
            data = f.read(chunk_size)
            if not data:
                break
            h_all.update(data)
            chunks.append({
                "index": index,
                "offset": index * chunk_size,
                "length": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            })
            index += 1
    return {
        "version": STATE_VERSION,
        "protocol": PROTOCOL_VERSION,
        "name": os.path.basename(path),
        "size": os.path.getsize(path),
        "chunk_size": chunk_size,
        "sha256": h_all.hexdigest(),
        "chunks": chunks,
        "metadata": file_metadata(path),
    }


# ---------------------------------------------------------------------------
# wire helpers
# ---------------------------------------------------------------------------


def send_json_line(sock: socket.socket, obj: Dict[str, Any]) -> None:
    payload = (json.dumps(obj, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")
    sock.sendall(payload)


class SocketReader:
    """Minimal buffered socket reader.

    A raw socket has no read-ahead: recv(4096) while reading a short JSON
    line would swallow the beginning of the following binary chunk. This
    class keeps that surplus in an internal buffer so JSON lines and raw
    chunk payloads can alternate safely on the same TCP stream.
    """

    def __init__(self, sock: socket.socket) -> None:
        self.sock = sock
        self.buf = bytearray()

    def _fill(self) -> None:
        block = self.sock.recv(65536)
        if not block:
            raise ConnectionError("peer closed connection")
        self.buf += block

    def readline(self, max_bytes: int = 64 << 20) -> bytes:
        while True:
            i = self.buf.find(b"\n")
            if i >= 0:
                if i + 1 > max_bytes:
                    raise ValueError("JSON line exceeded %d bytes" % max_bytes)
                line = bytes(self.buf[:i + 1])
                del self.buf[:i + 1]
                return line
            if len(self.buf) > max_bytes:
                raise ValueError("JSON line exceeded %d bytes" % max_bytes)
            self._fill()

    def read_exact(self, n: int) -> bytes:
        while len(self.buf) < n:
            self._fill()
        out = bytes(self.buf[:n])
        del self.buf[:n]
        return out


def recv_json_line(reader: SocketReader, max_bytes: int = 64 << 20) -> Dict[str, Any]:
    """Read one newline-terminated JSON line, keeping surplus bytes buffered."""
    line = reader.readline(max_bytes)
    return json.loads(line.decode("utf-8"))


def recv_exact(reader: SocketReader, n: int) -> bytes:
    """Read exactly n raw bytes or raise; used for chunk payloads."""
    if n < 0:
        raise ValueError("negative length")
    return reader.read_exact(n)


# ---------------------------------------------------------------------------
# state / persistence
# ---------------------------------------------------------------------------


def part_path(out_path: str) -> str:
    return out_path + RECV_SUFFIX


def resume_state_path(out_path: str) -> str:
    return out_path + STATE_SUFFIX


def write_json_atomic(path: str, obj: Dict[str, Any]) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def read_json(path: str) -> Optional[Dict[str, Any]]:
    if not os.path.isfile(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_resume_state(out_path: str, manifest: Dict[str, Any], next_index: int,
                      next_offset: Optional[int] = None) -> None:
    """Persist the resume point.

    `next_offset` is the byte position the next chunk appends at. Callers that
    track it incrementally pass it in, which keeps the web upload path O(1) per
    chunk instead of re-summing every preceding chunk length.
    """
    record = {
        "version": STATE_VERSION,
        "name": manifest["name"],
        "size": manifest["size"],
        "sha256": manifest["sha256"],
        "chunk_size": manifest["chunk_size"],
        "chunks": manifest["chunks"],
        "next_index": next_index,
        "updated_at": time.time(),
    }
    if next_offset is not None:
        record["next_offset"] = next_offset
    write_json_atomic(resume_state_path(out_path), record)


def load_resume_state(out_path: str, manifest: Dict[str, Any]) -> int:
    """Return the first chunk index that still needs to be received.

    A state file is trusted ONLY when its file identity matches the current
    manifest (name + size + sha256 + chunk_size + full chunk list) and the
    existing .part file has exactly the expected prefix length. Otherwise
    the transfer restarts from zero rather than mixing bytes from two files.
    """
    state = read_json(resume_state_path(out_path))
    if not state:
        return 0
    if (state.get("version") != STATE_VERSION
            or state.get("name") != manifest["name"]
            or state.get("size") != manifest["size"]
            or state.get("sha256") != manifest["sha256"]
            or state.get("chunk_size") != manifest["chunk_size"]
            or state.get("chunks") != manifest["chunks"]):
        return 0
    n = int(state.get("next_index", 0))
    if n <= 0 or n > len(manifest["chunks"]):
        return 0
    expected = sum(c["length"] for c in manifest["chunks"][:n])
    p = part_path(out_path)
    if not os.path.isfile(p) or os.path.getsize(p) != expected:
        return 0
    return n


def cleanup_transfer_artifacts(out_path: str) -> None:
    for p in (resume_state_path(out_path), part_path(out_path)):
        try:
            os.remove(p)
        except FileNotFoundError:
            pass


def restore_metadata(out_path: str, meta: Dict[str, Any]) -> None:
    """Best-effort restore of timestamp + permission metadata after content
    is final. Never touches file bytes. Failures are non-fatal: mode bits
    and creation time differ across Windows/POSIX/filesystems."""
    try:
        os.chmod(out_path, int(meta.get("mode", 0o644)))
    except (OSError, ValueError):
        pass
    try:
        os.utime(out_path, ns=(int(meta["atime_ns"]), int(meta["mtime_ns"])))
    except (OSError, KeyError, ValueError):
        try:
            os.utime(out_path, (int(meta["atime_ns"]) / 1e9, int(meta["mtime_ns"]) / 1e9))
        except (OSError, KeyError, ValueError):
            pass
    # ctime / creation time is intentionally not set: POSIX ctime cannot be
    # set without mutating inode metadata, and Windows creation time needs
    # platform-specific APIs. It is still transmitted inside META.
    # NOTE: os.utime(ns=...) is limited by filesystem timestamp resolution
    # (e.g. Windows NTFS stores 100 ns ticks). The nanosecond value is sent
    # verbatim and restored as closely as the destination OS allows; this is
    # why `verify --strict-metadata` compares source and destination rather
    # than an idealized literal.


# ---------------------------------------------------------------------------
# sender
# ---------------------------------------------------------------------------


def run_sender(args: argparse.Namespace) -> int:
    src = os.path.abspath(args.file)
    if not os.path.isfile(src):
        print("ERROR: source file not found: %s" % src, file=sys.stderr)
        return 2
    chunk_size = args.chunk_size
    if chunk_size <= 0:
        print("ERROR: --chunk-size must be > 0", file=sys.stderr)
        return 2

    manifest = build_manifest(src, chunk_size)
    print("[sender] file       : %s" % src)
    print("[sender] size       : %d bytes" % manifest["size"])
    print("[sender] sha256     : %s" % manifest["sha256"])
    print("[sender] chunks     : %d x %d bytes" % (len(manifest["chunks"]), chunk_size))
    print("[sender] connecting: %s:%d" % (args.host, args.port))

    with socket.create_connection((args.host, args.port), timeout=args.timeout) as sock:
        sock.settimeout(args.timeout)
        reader = SocketReader(sock)
        send_json_line(sock, {
            "op": "HELLO", "protocol": PROTOCOL_VERSION,
            "name": manifest["name"], "size": manifest["size"],
            "sha256": manifest["sha256"], "chunk_size": chunk_size,
        })
        # Send META immediately (before waiting for RESUME) to avoid deadlock.
        send_json_line(sock, {"op": "META", "protocol": PROTOCOL_VERSION,
                              "manifest": manifest})
        resume = recv_json_line(reader)
        if resume.get("op") != "RESUME":
            print("ERROR: unexpected reply: %r" % resume, file=sys.stderr)
            return 3
        next_index = int(resume.get("next_index", 0))
        print("[sender] receiver resume from chunk %d" % next_index)

        with open(src, "rb") as f:
            for c in manifest["chunks"]:
                if c["index"] < next_index:
                    continue  # already verified on the receiver, do not resend
                f.seek(c["offset"])
                data = f.read(c["length"])
                if len(data) != c["length"]:
                    raise IOError("short read on source at chunk %d" % c["index"])
                send_json_line(sock, {
                    "op": "CHUNK", "index": c["index"], "offset": c["offset"],
                    "length": len(data), "sha256": c["sha256"],
                })
                sock.sendall(data)  # raw bytes, no transformation of any kind
                if args.verbose:
                    print("[sender] sent chunk %d/%d (%d bytes)" %
                          (c["index"] + 1, len(manifest["chunks"]), len(data)))
        try:
            sock.shutdown(socket.SHUT_WR)  # half-close: no more data from us
        except OSError:
            pass
        done = recv_json_line(reader)
        if done.get("op") != "DONE":
            print("ERROR: receiver did not send DONE: %r" % done, file=sys.stderr)
            return 4

    ok = (done.get("sha256") == manifest["sha256"]
          and done.get("size") == manifest["size"])
    if ok:
        print("[sender] VERIFIED: receiver SHA-256 matches source (byte-exact).")
        print("[sender] receiver file: %s" % done.get("path", "?"))
        print("[sender] mtime_ns      : %s" % done.get("mtime_ns", "?"))
        return 0
    print("ERROR: VERIFICATION FAILED", file=sys.stderr)
    print("  source   sha256=%s size=%d" % (manifest["sha256"], manifest["size"]), file=sys.stderr)
    print("  receiver sha256=%s size=%s" % (done.get("sha256"), done.get("size")), file=sys.stderr)
    return 5


# ---------------------------------------------------------------------------
# receiver
# ---------------------------------------------------------------------------


def run_receiver(args: argparse.Namespace) -> int:
    out_dir = os.path.abspath(args.output)
    os.makedirs(out_dir, exist_ok=True)
    print("[receiver] listening: %s:%d" % (args.host, args.port))
    print("[receiver] output dir: %s" % out_dir)

    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((args.host, args.port))
    srv.listen(1)
    srv.settimeout(args.timeout)
    try:
        conn, addr = srv.accept()
    except socket.timeout:
        print("ERROR: no sender connected within %d seconds" % args.timeout, file=sys.stderr)
        return 2
    finally:
        srv.close()

    with conn:
        conn.settimeout(args.timeout)
        reader = SocketReader(conn)
        print("[receiver] connected: %s:%d" % (addr[0], addr[1]))
        hello = recv_json_line(reader)
        if hello.get("op") != "HELLO" or hello.get("protocol") != PROTOCOL_VERSION:
            print("ERROR: invalid HELLO: %r" % hello, file=sys.stderr)
            return 3
        name = os.path.basename(str(hello["name"]))  # block path traversal
        if not name or name in (".", ".."):
            print("ERROR: invalid file name in HELLO", file=sys.stderr)
            return 3
        out_path = os.path.join(out_dir, name)
        p_path = part_path(out_path)
        print("[receiver] incoming : %s (%d bytes)" % (name, hello["size"]))

        meta_msg = recv_json_line(reader)
        if meta_msg.get("op") != "META":
            print("ERROR: expected META, got %r" % meta_msg, file=sys.stderr)
            return 3
        manifest = meta_msg["manifest"]
        if (manifest["name"] != hello["name"] or manifest["sha256"] != hello["sha256"]
                or manifest["size"] != hello["size"]):
            print("ERROR: HELLO/META mismatch", file=sys.stderr)
            return 3

        # Already have a complete, hash-matching file: skip everything.
        if os.path.isfile(out_path) and sha256_file(out_path) == manifest["sha256"]:
            print("[receiver] already complete: %s" % out_path)
            cleanup_transfer_artifacts(out_path)
            send_json_line(conn, {"op": "RESUME",
                                  "next_index": len(manifest["chunks"])})
            send_json_line(conn, {
                "op": "DONE", "sha256": manifest["sha256"], "size": manifest["size"],
                "mtime_ns": file_metadata(out_path)["mtime_ns"], "path": out_path,
            })
            return 0

        next_index = load_resume_state(out_path, manifest)
        if next_index:
            print("[receiver] resuming from chunk %d (%d bytes already on disk)"
                  % (next_index, os.path.getsize(p_path)))
        else:
            cleanup_transfer_artifacts(out_path)
            with open(p_path, "wb"):
                pass  # fresh empty .part
        send_json_line(conn, {"op": "RESUME", "next_index": next_index})

        mode = "ab" if next_index else "wb"
        with open(p_path, mode) as out:
            for c in manifest["chunks"]:
                if c["index"] < next_index:
                    continue
                header = recv_json_line(reader)
                if header.get("op") != "CHUNK" or header.get("index") != c["index"]:
                    print("ERROR: unexpected chunk header at %d: %r"
                          % (c["index"], header), file=sys.stderr)
                    return 4
                data = recv_exact(reader, int(header["length"]))
                got = hashlib.sha256(data).hexdigest()
                if got != c["sha256"] or got != header.get("sha256"):
                    print("ERROR: chunk %d SHA-256 mismatch (wire corruption)"
                          % c["index"], file=sys.stderr)
                    return 5
                out.write(data)  # the ONLY write to .part: a raw byte copy
                out.flush()
                save_resume_state(out_path, manifest, c["index"] + 1)
                if args.verbose:
                    print("[receiver] verified chunk %d/%d"
                          % (c["index"] + 1, len(manifest["chunks"])))

        final_hash = sha256_file(p_path)
        if final_hash != manifest["sha256"] or os.path.getsize(p_path) != manifest["size"]:
            print("ERROR: assembled file hash mismatch; partial state kept for retry",
                  file=sys.stderr)
            return 6

        os.replace(p_path, out_path)  # atomic publish of the finished file
        restore_metadata(out_path, manifest["metadata"])
        cleanup_transfer_artifacts(out_path)
        final_meta = file_metadata(out_path)
        print("[receiver] saved   : %s" % out_path)
        print("[receiver] sha256  : %s" % final_hash)
        print("[receiver] mtime_ns: %d" % final_meta["mtime_ns"])
        send_json_line(conn, {
            "op": "DONE", "sha256": final_hash, "size": manifest["size"],
            "mtime_ns": final_meta["mtime_ns"], "path": out_path,
        })
        return 0


# ---------------------------------------------------------------------------
# verify / manifest (offline utilities)
# ---------------------------------------------------------------------------


def run_verify(args: argparse.Namespace) -> int:
    a, b = os.path.abspath(args.a), os.path.abspath(args.b)
    for p in (a, b):
        if not os.path.isfile(p):
            print("ERROR: not a file: %s" % p, file=sys.stderr)
            return 2
    ha, hb = sha256_file(a), sha256_file(b)
    sa, sb = file_metadata(a), file_metadata(b)
    print("A: %s" % a)
    print("   size=%d sha256=%s mtime_ns=%d mode=%s" %
          (sa["size"], ha, sa["mtime_ns"], oct(sa["mode"])))
    print("B: %s" % b)
    print("   size=%d sha256=%s mtime_ns=%d mode=%s" %
          (sb["size"], hb, sb["mtime_ns"], oct(sb["mode"])))
    ok = True
    if ha != hb:
        print("FAIL: SHA-256 differs -> bytes are NOT identical", file=sys.stderr)
        ok = False
    else:
        print("PASS: SHA-256 identical -> bytes are identical (lossless)")
    if args.strict_metadata:
        if sa["mtime_ns"] != sb["mtime_ns"]:
            print("FAIL: mtime_ns differs", file=sys.stderr)
            ok = False
        else:
            print("PASS: mtime_ns preserved (%d)" % sa["mtime_ns"])
        if sa["mode"] != sb["mode"]:
            print("WARN: mode differs (%s vs %s); expected across Windows/POSIX"
                  % (oct(sa["mode"]), oct(sb["mode"])))
    return 0 if ok else 1


def run_manifest(args: argparse.Namespace) -> int:
    p = os.path.abspath(args.file)
    if not os.path.isfile(p):
        print("ERROR: not a file: %s" % p, file=sys.stderr)
        return 2
    if args.chunk_size <= 0:
        print("ERROR: --chunk-size must be > 0", file=sys.stderr)
        return 2
    m = build_manifest(p, args.chunk_size)
    out = args.out or (p + MANIFEST_SUFFIX)
    write_json_atomic(out, m)
    print("manifest written: %s" % out)
    print("sha256=%s size=%d chunks=%d" % (m["sha256"], m["size"], len(m["chunks"])))
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="lossless_transfer.py",
        description="Byte-exact, resumable photo/video transfer (no re-encode, zero deps).",
    )
    parser.add_argument("--version", action="version", version="%(prog)s " + __version__)
    sub = parser.add_subparsers(dest="command", required=True)

    s = sub.add_parser("send", help="send one file to a running receiver")
    s.add_argument("file", help="source photo/video file (any bytes)")
    s.add_argument("--host", default="127.0.0.1", help="receiver host (default 127.0.0.1)")
    s.add_argument("--port", type=int, default=8765, help="receiver TCP port (default 8765)")
    s.add_argument("--chunk-size", type=int, default=CHUNK_SIZE,
                   help="chunk size in bytes (default %d)" % CHUNK_SIZE)
    s.add_argument("--timeout", type=float, default=300.0, help="socket timeout seconds")
    s.add_argument("-v", "--verbose", action="store_true")
    s.set_defaults(func=run_sender)

    r = sub.add_parser("receive", help="listen once and receive one file")
    r.add_argument("--host", default="127.0.0.1", help="bind address (default 127.0.0.1; 0.0.0.0 for LAN)")
    r.add_argument("--port", type=int, default=8765, help="bind TCP port (default 8765)")
    r.add_argument("--output", "-o", default=".", help="output directory (default .)")
    r.add_argument("--timeout", type=float, default=300.0, help="accept/socket timeout seconds")
    r.add_argument("-v", "--verbose", action="store_true")
    r.set_defaults(func=run_receiver)

    v = sub.add_parser("verify", help="compare two files byte-for-byte via SHA-256")
    v.add_argument("a")
    v.add_argument("b")
    v.add_argument("--strict-metadata", action="store_true",
                   help="also require identical mtime_ns (mode mismatch is warn-only)")
    v.set_defaults(func=run_verify)

    m = sub.add_parser("manifest", help="write a SHA-256/chunk manifest for a file")
    m.add_argument("file")
    m.add_argument("--chunk-size", type=int, default=CHUNK_SIZE)
    m.add_argument("--out", help="manifest output path")
    m.set_defaults(func=run_manifest)
    return parser


def main(argv: Optional[list] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        return 130
    except (ConnectionError, OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
        print("ERROR: %s: %s" % (type(exc).__name__, exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
