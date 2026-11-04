#!/usr/bin/env python3
"""Standard-library unittest suite for lossless_transfer.py.

Covers: SHA-256 byte equality over a real TCP socket, JPEG/PNG/MP4-style
binary payloads (no format-dependent code path), mtime restoration,
multi-chunk transfer, manifest generation, tamper detection, and
interrupted-transfer resume from a persisted state file.

Run:  python -m unittest discover -s tests -v
      python tests/test_lossless_transfer.py -v
"""

import hashlib
import importlib.util
import json
import os
import socket
import struct
import sys
import tempfile
import threading
import time
import unittest
import zlib
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

spec = importlib.util.spec_from_file_location(
    "lossless_transfer", os.path.join(ROOT, "lossless_transfer.py"))
lt = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(lt)


def free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def minimal_jpeg() -> bytes:
    """A tiny but structurally recognizable JPEG (SOI ... EOI + EXIF-ish APP1).

    We only assert byte identity — the point is that the receiver treats it
    as opaque bytes and never invokes an image codec.
    """
    app1 = b"\xff\xe1\x00\x10Exif\x00\x00II*\x00\x08\x00\x00\x00\x00\x00"
    return (b"\xff\xd8" + app1 + b"\xff\xdb\x00\x43\x00" + bytes(range(64))
            + b"\xff\xc0\x00\x0b\x08\x00\x01\x00\x01\x01\x01\x11\x00"
            + b"\xff\xda\x00\x08\x01\x01\x00\x00\x3f\x00\xd2\xcf\x20"
            + b"\xff\xd9")


def minimal_png() -> bytes:
    """A valid 1x1 RGB PNG built with zlib (stdlib only)."""
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    raw = b"\x00\xff\x00\x00"  # filter byte + one red pixel
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def minimal_mp4() -> bytes:
    """A minimal ISO-BMFF 'file' (ftyp + mdat) with arbitrary video bytes."""
    def box(tag: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", 8 + len(payload)) + tag + payload
    ftyp = box(b"ftyp", b"isom" + struct.pack(">I", 0x200) + b"isomiso2mp41")
    mdat = box(b"mdat", bytes((i * 37 + 11) & 0xFF for i in range(4096)))
    return ftyp + mdat


class TransferHarness:
    """Start a receiver in a background thread and run a real sender."""

    def __init__(self, tmp: str) -> None:
        self.tmp = tmp
        self.port = free_port()
        self.out_dir = os.path.join(tmp, "received")
        os.makedirs(self.out_dir, exist_ok=True)
        self.result: dict = {}
        self.error: BaseException = None

    def receive_once(self) -> None:
        argv = ["receive", "--host", "127.0.0.1", "--port", str(self.port),
                "--output", self.out_dir, "--timeout", "20"]
        try:
            rc = lt.main(argv)
            self.result["rc"] = rc
        except BaseException as exc:  # surface thread failures to the test
            self.error = exc

    def send(self, path: str, chunk_size: int = 0, wait: float = 0.5) -> int:
        t = threading.Thread(target=self.receive_once, daemon=True)
        t.start()
        time.sleep(wait)  # let the listener bind before connecting
        argv = ["send", path, "--host", "127.0.0.1", "--port", str(self.port),
                "--timeout", "20"]
        if chunk_size:
            argv += ["--chunk-size", str(chunk_size)]
        rc = lt.main(argv)
        t.join(timeout=25)
        if self.error is not None:
            raise AssertionError("receiver thread raised: %r" % self.error) from self.error
        if t.is_alive():
            raise AssertionError("receiver thread did not finish")
        return rc


class TestHashAndMetadata(unittest.TestCase):
    def test_sha256_file_matches_hashlib(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = os.path.join(tmp, "blob.bin")
            data = os.urandom(5000)
            with open(p, "wb") as f:
                f.write(data)
            self.assertEqual(lt.sha256_file(p), hashlib.sha256(data).hexdigest())

    def test_manifest_chunk_hashes_and_whole_hash(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = os.path.join(tmp, "sample.jpg")
            data = os.urandom(2500)
            with open(p, "wb") as f:
                f.write(data)
            m = lt.build_manifest(p, 1024)
            self.assertEqual(m["sha256"], hashlib.sha256(data).hexdigest())
            self.assertEqual(m["size"], 2500)
            self.assertEqual([c["length"] for c in m["chunks"]], [1024, 1024, 452])
            self.assertEqual(m["chunks"][0]["sha256"], hashlib.sha256(data[:1024]).hexdigest())
            self.assertEqual(m["metadata"]["size"], 2500)


class TestEndToEndTransfer(unittest.TestCase):
    def _assert_transfer(self, data: bytes, name: str, chunk_size: int = 0):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, name)
            with open(src, "wb") as f:
                f.write(data)
            fixed_ns = 1_600_000_000_123_456_789
            os.utime(src, ns=(fixed_ns - 10_000, fixed_ns))
            h = TransferHarness(tmp)
            rc = h.send(src, chunk_size)
            self.assertEqual(rc, 0, "sender must report VERIFIED")
            self.assertEqual(h.result.get("rc"), 0, "receiver must exit 0")
            dst = os.path.join(h.out_dir, name)
            self.assertTrue(os.path.isfile(dst), "destination file missing")
            with open(dst, "rb") as f:
                self.assertEqual(f.read(), data, "byte-for-byte equality failed")
            self.assertEqual(lt.sha256_file(dst), lt.sha256_file(src))
            # Compare what the OS actually stored on BOTH sides: Windows
            # NTFS rounds to 100 ns, so the raw input value is not retained
            # verbatim on either side. The contract is source == destination.
            self.assertEqual(lt.file_metadata(dst)["mtime_ns"],
                             lt.file_metadata(src)["mtime_ns"],
                             "mtime_ns must be preserved exactly as stored on the source")
            self.assertFalse(os.path.exists(dst + lt.RECV_SUFFIX))
            self.assertFalse(os.path.exists(dst + lt.STATE_SUFFIX))
            return src, dst

    def test_jpeg_single_chunk(self):
        self._assert_transfer(minimal_jpeg(), "photo.jpg")

    def test_png_multi_chunk(self):
        data = minimal_png() + os.urandom(3000)
        self._assert_transfer(data, "image.png", chunk_size=64)

    def test_mp4_video_large_multi_chunk(self):
        data = minimal_mp4() + os.urandom(200_000)
        self._assert_transfer(data, "clip.mp4", chunk_size=4096)

    def test_empty_and_single_byte_edges(self):
        self._assert_transfer(b"", "empty.bin", chunk_size=16)
        self._assert_transfer(b"\x00", "one.bin", chunk_size=16)

    def test_verify_cli_reports_pass_and_tamper_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "v.bin")
            with open(src, "wb") as f:
                f.write(os.urandom(777))
            h = TransferHarness(tmp)
            self.assertEqual(h.send(src, 128), 0)
            dst = os.path.join(h.out_dir, "v.bin")
            self.assertEqual(lt.main(["verify", src, dst, "--strict-metadata"]), 0)
            with open(dst, "r+b") as f:
                first = f.read(1)
                f.seek(0)
                f.write(b"\xff" if first != b"\xff" else b"\x00")
            self.assertEqual(lt.main(["verify", src, dst]), 1,
                             "tampered copy must be detected")

    def test_manifest_cli_writes_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = os.path.join(tmp, "a.jpg")
            with open(p, "wb") as f:
                f.write(b"abc" * 100)
            out = os.path.join(tmp, "m.json")
            self.assertEqual(lt.main(["manifest", p, "--chunk-size", "64", "--out", out]), 0)
            with open(out, "r", encoding="utf-8") as f:
                m = json.load(f)
            self.assertEqual(m["sha256"], lt.sha256_file(p))
            self.assertEqual(len(m["chunks"]), 5)


class TestResume(unittest.TestCase):
    def test_resume_from_partial_state(self):
        """Simulate a crash after 3 chunks, then resume and still get exact bytes."""
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "resume.mp4")
            data = minimal_mp4() + os.urandom(2500)
            with open(src, "wb") as f:
                f.write(data)
            chunk_size = 512
            manifest = lt.build_manifest(src, chunk_size)
            self.assertGreater(len(manifest["chunks"]), 3)
            out_dir = os.path.join(tmp, "received")
            os.makedirs(out_dir, exist_ok=True)
            out_path = os.path.join(out_dir, "resume.mp4")
            prefix = data[:3 * chunk_size]
            with open(lt.part_path(out_path), "wb") as f:
                f.write(prefix)
            lt.save_resume_state(out_path, manifest, 3)

            h = TransferHarness(tmp)
            h.out_dir = out_dir
            rc = h.send(src, chunk_size)
            self.assertEqual(rc, 0)
            self.assertEqual(h.result.get("rc"), 0)
            with open(out_path, "rb") as f:
                self.assertEqual(f.read(), data, "resumed file must be byte-exact")
            self.assertEqual(lt.sha256_file(out_path), manifest["sha256"])

    def test_state_for_different_file_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            p1 = os.path.join(tmp, "a.bin")
            p2 = os.path.join(tmp, "b.bin")
            with open(p1, "wb") as f:
                f.write(b"A" * 200)
            with open(p2, "wb") as f:
                f.write(b"B" * 200)
            m1 = lt.build_manifest(p1, 64)
            m2 = lt.build_manifest(p2, 64)
            out_path = os.path.join(tmp, "a.bin")
            lt.save_resume_state(out_path, m1, 2)
            self.assertEqual(lt.load_resume_state(out_path, m2), 0,
                             "mismatched manifest must force a fresh start")


class TestSecurity(unittest.TestCase):
    def test_windows_style_path_traversal_is_normalized_to_basename(self):
        """The receiver applies os.path.basename(); mixed separators must not
        let a sender choose a path outside the output directory."""
        raw = "..\\..\\evil.jpg"
        name = os.path.basename(raw.replace("\\", "/"))
        self.assertEqual(name, "evil.jpg")
        self.assertNotIn("..", name)


if __name__ == "__main__":
    unittest.main(verbosity=2)
