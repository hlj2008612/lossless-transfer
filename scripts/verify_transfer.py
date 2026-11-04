#!/usr/bin/env python3
"""Standalone end-to-end verification for lossless-transfer.

This script deliberately drives the REAL command-line interface as two
separate OS processes (a receiver listening on a TCP port, a sender
connecting to it) rather than calling library functions in-process. It
therefore exercises the same code path a user runs in two terminals.

It:
  1. generates binary sample media (JPEG, PNG, MP4/ISO-BMFF, plus edge cases),
  2. starts `lossless_transfer.py receive` in the background,
  3. starts `lossless_transfer.py send` in the foreground for each sample,
  4. checks the received file byte-for-byte and via SHA-256,
  5. checks mtime preservation using actual on-disk values,
  6. simulates an interrupted transfer and verifies resume produces the
     same bytes,
  7. prints a summary table and exits 0 only if every check passed.

Zero third-party dependencies; Python 3.8+.

Usage:
    python3 scripts/verify_transfer.py
    python3 scripts/verify_transfer.py --python py -3   # Windows launcher
"""

from __future__ import annotations

import argparse
import hashlib
import os
import socket
import struct
import subprocess
import sys
import tempfile
import time
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TOOL = os.path.join(ROOT, "lossless_transfer.py")


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(65536), b""):
            h.update(block)
    return h.hexdigest()


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def minimal_jpeg() -> bytes:
    """A tiny but structurally valid baseline JPEG (SOI ... EOI)."""
    return (
        b"\xff\xd8"
        b"\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
        b"\xff\xdb\x00\x43\x00" + bytes([8] * 64) +
        b"\xff\xc0\x00\x0b\x08\x00\x01\x00\x01\x01\x01\x11\x00"
        b"\xff\xc4\x00\x1f\x00\x00\x01\x05\x01\x01\x01\x01\x01\x01\x00\x00"
        b"\x00\x00\x00\x00\x00\x00\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09"
        b"\x0a\x0b"
        b"\xff\xda\x00\x08\x01\x01\x00\x00\x3f\x00\xd2\xcf\x20"
        b"\xff\xd9"
    )


def minimal_png() -> bytes:
    """A valid 1x1 RGBA PNG built with zlib (zlib used only to CONSTRUCT the
    sample, never by the transfer tool itself)."""
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data +
                struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)
    raw = b"\x00" + b"\x2a\x7f\xd4\xff"  # filter byte + one RGBA pixel
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) +
            chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def minimal_mp4() -> bytes:
    """A small ISO-BMFF / MP4 container: ftyp + mdat boxes, padded with
    deterministic pseudo-random bytes to force multiple transfer chunks."""
    def box(tag: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", 8 + len(payload)) + tag + payload
    ftyp = box(b"ftyp", b"isom" + struct.pack(">I", 0x200) + b"isomiso2mp41")
    # deterministic filler (no external RNG dependency for reproducibility)
    filler = bytes((i * 37 + 11) & 0xFF for i in range(4096))
    mdat = box(b"mdat", filler)
    return ftyp + mdat


def samples() -> list:
    return [
        ("photo.jpg", minimal_jpeg()),
        ("photo.png", minimal_png()),
        ("clip.mp4", minimal_mp4()),
        ("padded_video.mp4", minimal_mp4() + os.urandom(5000)),
        ("empty.bin", b""),
        ("one.bin", b"\x00"),
    ]


def make_base(explicit: list) -> list:
    if explicit:
        return list(explicit)
    return [sys.executable]


class Runner:
    def __init__(self, base: list, timeout: float = 60.0):
        self.base = base
        self.timeout = timeout
        self.lines: list = []

    def receiver_cmd(self, port: int, out_dir: str) -> list:
        return self.base + [TOOL, "receive", "--host", "127.0.0.1",
                            "--port", str(port), "-o", out_dir,
                            "--timeout", str(self.timeout)]

    def sender_cmd(self, src: str, port: int, chunk_size: int) -> list:
        return self.base + [TOOL, "send", src, "--host", "127.0.0.1",
                            "--port", str(port), "--chunk-size", str(chunk_size),
                            "--timeout", str(self.timeout)]

    def run_transfer(self, src: str, out_dir: str, chunk_size: int = 512):
        port = free_port()
        recv = subprocess.Popen(
            self.receiver_cmd(port, out_dir),
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        # Give the listener a moment to bind before the sender connects.
        time.sleep(0.25)
        send = subprocess.run(
            self.sender_cmd(src, port, chunk_size),
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            timeout=self.timeout,
        )
        recv_out, _ = recv.communicate(timeout=self.timeout)
        self.lines.append((os.path.basename(src), send.stdout, recv_out))
        return send.returncode, recv.returncode, send.stdout, recv_out


def check(condition: bool, label: str, results: list, detail: str = "") -> bool:
    results.append((label, bool(condition), detail))
    print("  [%s] %s%s" % ("PASS" if condition else "FAIL", label,
                           (" - " + detail) if detail else ""))
    return bool(condition)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="End-to-end lossless-transfer verification")
    ap.add_argument("--python", nargs=argparse.REMAINDER, default=[],
                    help="python launcher, e.g. `--python py -3` on Windows")
    ap.add_argument("--keep", action="store_true", help="keep temp dir for inspection")
    args = ap.parse_args(argv)

    print("=" * 72)
    print("lossless-transfer :: standalone end-to-end verification")
    print("=" * 72)
    print("tool    : %s" % TOOL)
    base = make_base(args.python)
    print("python  : %s" % " ".join(base))
    if not os.path.isfile(TOOL):
        print("FATAL: tool not found: %s" % TOOL, file=sys.stderr)
        return 2

    results: list = []
    tmp = tempfile.mkdtemp(prefix="lossless_verify_")
    try:
        src_dir = os.path.join(tmp, "src")
        out_dir = os.path.join(tmp, "received")
        os.makedirs(src_dir, exist_ok=True)
        os.makedirs(out_dir, exist_ok=True)

        paths = []
        print("\n[1] generating binary media samples")
        for name, data in samples():
            p = os.path.join(src_dir, name)
            with open(p, "wb") as f:
                f.write(data)
            paths.append((name, p, data))
            print("  %-18s %7d bytes" % (name, len(data)))

        runner = Runner(base)

        print("\n[2] real two-process TCP transfer + byte comparison")
        for name, src, data in paths:
            s_rc, r_rc, s_out, r_out = runner.run_transfer(src, out_dir, chunk_size=512)
            dst = os.path.join(out_dir, name)
            ok_rc = check(s_rc == 0 and r_rc == 0, "%s: both processes exit 0" % name,
                          results, "sender=%d receiver=%d" % (s_rc, r_rc))
            exists = check(os.path.isfile(dst), "%s: received file exists" % name, results)
            byte_ok = False
            hash_ok = False
            if exists:
                with open(dst, "rb") as f:
                    got = f.read()
                byte_ok = check(got == data, "%s: bytes identical" % name, results,
                                "%d bytes" % len(got))
                hash_ok = check(sha256_file(dst) == sha256_file(src),
                                "%s: SHA-256 identical" % name, results)
            verified = check("VERIFIED: receiver SHA-256 matches source" in s_out,
                             "%s: sender printed VERIFIED" % name, results)
            if not (ok_rc and exists and byte_ok and hash_ok and verified):
                print("     sender output:\n%s" % s_out)
                print("     receiver output:\n%s" % r_out)

        print("\n[3] mtime preservation (compare actual on-disk values)")
        name, src, data = paths[2]  # clip.mp4
        dst = os.path.join(out_dir, name)
        if os.path.isfile(dst):
            a = os.stat(src).st_mtime_ns
            b = os.stat(dst).st_mtime_ns
            check(a == b, "mtime_ns preserved for %s" % name, results,
                  "src=%d dst=%d" % (a, b))
        else:
            check(False, "mtime check skipped (no file)", results)

        print("\n[4] offline verify CLI (pass + tamper detection)")
        v = subprocess.run(base + [TOOL, "verify", paths[0][1],
                                   os.path.join(out_dir, paths[0][0]),
                                   "--strict-metadata"],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        check(v.returncode == 0 and "PASS: SHA-256 identical" in v.stdout,
              "verify reports lossless PASS", results)
        tamper_path = os.path.join(out_dir, paths[0][0])
        if os.path.isfile(tamper_path):
            with open(tamper_path, "r+b") as f:
                first = f.read(1)
                f.seek(0)
                f.write(b"\xff" if first != b"\xff" else b"\x00")
            t = subprocess.run(base + [TOOL, "verify", paths[0][1], tamper_path],
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            check(t.returncode == 1, "verify detects a single-byte tamper", results)
            # restore so the summary below stays coherent
            with open(tamper_path, "r+b") as f:
                f.seek(0)
                f.write(first)

        print("\n[5] resume after simulated interruption")
        # Craft a valid partial state + .part prefix for padded_video.mp4, then
        # let a real transfer resume from it and confirm the final bytes match.
        # Use a dedicated output dir: step [2] already placed a complete copy
        # of this file in out_dir, which would trigger the "already complete"
        # shortcut instead of exercising the resume path.
        resume_dir = os.path.join(tmp, "resume_received")
        os.makedirs(resume_dir, exist_ok=True)
        rname, rsrc, rdata = paths[3]
        rdst = os.path.join(resume_dir, rname)
        chunk_size = 512
        manifest = subprocess.run(
            base + [TOOL, "manifest", rsrc, "--chunk-size", str(chunk_size),
                    "--out", os.path.join(tmp, "m.json")],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        check(manifest.returncode == 0, "manifest generated for resume scenario", results)
        import json
        with open(os.path.join(tmp, "m.json"), "r", encoding="utf-8") as f:
            m = json.load(f)
        n = 3
        prefix = rdata[:sum(c["length"] for c in m["chunks"][:n])]
        with open(rdst + ".part", "wb") as f:
            f.write(prefix)
        state = {
            "version": m["version"], "name": m["name"], "size": m["size"],
            "sha256": m["sha256"], "chunk_size": m["chunk_size"],
            "chunks": m["chunks"], "next_index": n, "updated_at": time.time(),
        }
        with open(rdst + ".lossless-state.json", "w", encoding="utf-8") as f:
            json.dump(state, f)
        s_rc, r_rc, s_out, r_out = runner.run_transfer(rsrc, resume_dir, chunk_size)
        resumed = "resuming from chunk %d" % n in r_out
        check(resumed, "receiver resumed from chunk %d" % n, results)
        check(s_rc == 0 and r_rc == 0, "resumed transfer exits 0", results)
        if os.path.isfile(rdst):
            with open(rdst, "rb") as f:
                got = f.read()
            check(got == rdata, "resumed file bytes identical to source", results,
                  "%d bytes" % len(got))
            check(sha256_file(rdst) == sha256_file(rsrc),
                  "resumed file SHA-256 identical", results)
        else:
            check(False, "resumed file missing", results)
        if not resumed:
            print("     receiver output:\n%s" % r_out)

        print("\n[6] summary")
        passed = sum(1 for _, ok, _ in results if ok)
        total = len(results)
        print("  %d/%d checks passed" % (passed, total))
        failed = [(label, detail) for label, ok, detail in results if not ok]
        if failed:
            print("  FAILED CHECKS:")
            for label, detail in failed:
                print("    - %s %s" % (label, detail))
        print("=" * 72)
        if args.keep:
            print("temp dir kept: %s" % tmp)
            return 0 if not failed else 1
        return 0 if not failed else 1
    finally:
        if not args.keep:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
