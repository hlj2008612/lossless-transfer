#!/usr/bin/env python3
"""End-to-end HTTP tests for web_transfer.py (stdlib unittest + http.client).

The server is started in-process on a real loopback TCP port with a real
ThreadingHTTPServer, a temporary library directory, a small chunk size and a
fixed token. Every test drives the same JSON/raw-bytes API the browser uses.

Covered:
  * token auth (401 without X-LT-Token), static files stay public;
  * /api/info, /api/list;
  * full upload of opaque photo/video-like bytes -> byte-exact on disk;
  * three-way SHA-256 agreement (source / server chunk / assembled file);
  * idempotent re-upload (status=complete) and conflict on a different file;
  * wire-corruption detection (422) with no bad byte written;
  * crash/resume: re-init returns next_index and the transfer completes;
  * download manifest + chunks reassemble to the identical bytes;
  * empty file, path-traversal rejection, reserved-suffix rejection, delete;
  * mtime_ns sent as a BigInt *string* is actually restored;
  * native TLS (--tls-cert/--tls-key) serves HTTPS and still transfers
    byte-exactly (the mode mainland SakuraFrp nodes require);
  * build_tls_context() rejects a missing cert/key and a mismatched pair.

Run:  python -m unittest discover -s tests -v
"""
from __future__ import annotations

import hashlib
import http.client
import importlib.util
import io
import json
import os
import shutil
import ssl
import struct
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

spec = importlib.util.spec_from_file_location(
    "web_transfer", os.path.join(ROOT, "web_transfer.py"))
wt = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(wt)

TOKEN = "test-token-abcdef"
CHUNK_SIZE = 64  # tiny, so even small samples span many chunks
MTIME_NS = "1600000000123456789"  # deliberately in the past, sent as a string


def sample_bytes(n: int, seed: int = 7) -> bytes:
    """Deterministic opaque binary payload (no image/video codec involved)."""
    out = bytearray()
    x = seed
    while len(out) < n:
        x = (1103515245 * x + 12345) & 0xFFFFFFFF
        out.append((x >> 16) & 0xFF)
    return bytes(out[:n])


def browser_manifest(name: str, data: bytes) -> dict:
    """Mirror web/app.js buildManifest(): raw slices, per-chunk + whole hash."""
    whole = hashlib.sha256()
    chunks = []
    off = 0
    i = 0
    while off < len(data):
        c = data[off:off + CHUNK_SIZE]
        whole.update(c)
        chunks.append({
            "index": i,
            "offset": off,
            "length": len(c),
            "sha256": hashlib.sha256(c).hexdigest(),
        })
        off += len(c)
        i += 1
    return {
        "name": name,
        "size": len(data),
        "sha256": whole.hexdigest(),
        "chunk_size": CHUNK_SIZE,
        "chunks": chunks,
        "mtime_ns": MTIME_NS,
    }


def jpeg_with_exif_thumb(thumb: bytes, big_endian: bool = False,
                         orientation: int = 1) -> bytes:
    """A minimal JPEG carrying `thumb` as its EXIF IFD1 thumbnail.

    Structured exactly like a camera file: SOI, one APP1 "Exif" segment whose
    TIFF block has IFD0 (Orientation) chained to IFD1 (0x0201/0x0202 pointing
    at the thumbnail bytes), then EOI.
    """
    e = ">" if big_endian else "<"
    tiff = bytearray(b"MM" if big_endian else b"II")
    tiff += struct.pack(e + "H", 42)
    tiff += struct.pack(e + "I", 8)                  # IFD0 offset
    ifd0_off = 8
    ifd0_len = 2 + 1 * 12 + 4
    ifd1_off = ifd0_off + ifd0_len
    ifd1_len = 2 + 2 * 12 + 4
    thumb_off = ifd1_off + ifd1_len
    tiff += struct.pack(e + "H", 1)                  # IFD0: 1 entry
    tiff += struct.pack(e + "HHI", 0x0112, 3, 1)     # Orientation, SHORT
    tiff += struct.pack(e + "H", orientation) + b"\x00\x00"
    tiff += struct.pack(e + "I", ifd1_off)           # chain to IFD1
    tiff += struct.pack(e + "H", 2)                  # IFD1: 2 entries
    tiff += struct.pack(e + "HHI", 0x0201, 4, 1)     # JPEGInterchangeFormat
    tiff += struct.pack(e + "I", thumb_off)
    tiff += struct.pack(e + "HHI", 0x0202, 4, 1)     # ...Length
    tiff += struct.pack(e + "I", len(thumb))
    tiff += struct.pack(e + "I", 0)                  # IFD1 has no successor
    assert len(tiff) == thumb_off
    tiff += thumb
    payload = b"Exif\x00\x00" + bytes(tiff)
    app1 = b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload
    return b"\xff\xd8" + app1 + b"\xff\xd9"


class WebTransferE2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.mkdtemp(prefix="lt-web-test-")
        cls.lib = os.path.join(cls.tmp, "received")
        cls.cfg = wt.Config("127.0.0.1", 0, cls.lib, CHUNK_SIZE, TOKEN)
        cls.cfg.ensure_dirs()
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), wt.Handler)
        cls.httpd.daemon_threads = True
        cls.httpd.cfg = cls.cfg
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever,
                                      daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=5)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    # ---- low-level request helper -----------------------------------------
    def req(self, method: str, path: str, body: bytes | None = None,
            headers: dict | None = None, token: str | None = TOKEN):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        h: dict = {}
        if token is not None:
            h["X-LT-Token"] = token
        if headers:
            h.update(headers)
        conn.request(method, path, body=body, headers=h)
        resp = conn.getresponse()
        data = resp.read()
        status = resp.status
        rh = {k.lower(): v for k, v in resp.getheaders()}
        conn.close()
        return status, rh, data

    def req_json(self, method: str, path: str, obj, **kw):
        body = json.dumps(obj, ensure_ascii=False,
                          separators=(",", ":")).encode("utf-8")
        return self.req(method, path, body,
                        {"Content-Type": "application/json"}, **kw)

    def assert_json(self, status: int, data: bytes, want: int):
        self.assertEqual(status, want,
                         "body=%r" % data[:400])
        return json.loads(data.decode("utf-8"))

    def upload_all(self, m: dict, data: bytes, tamper: int | None = None,
                   stop_after: int | None = None):
        """init -> (optionally tamper one chunk) -> POST chunks -> complete."""
        st, _, b = self.req_json("POST", "/api/upload/init", m)
        init = self.assert_json(st, b, 200)
        start = 0
        if init["status"] == "complete":
            return init, None
        self.assertEqual(init["status"], "upload")
        start = init["next_index"]
        for i in range(start, len(m["chunks"])):
            if stop_after is not None and i >= start + stop_after:
                return init, "stopped"
            c = m["chunks"][i]
            raw = data[c["offset"]:c["offset"] + c["length"]]
            if tamper == i:
                bad = bytearray(raw)
                bad[0] ^= 0xFF
                raw = bytes(bad)
            st, _, cb = self.req(
                "POST", "/api/upload/chunk?name=%s&index=%d" % (m["name"], i),
                raw, {"Content-Type": "application/octet-stream"})
            if tamper == i:
                self.assertEqual(st, 422,
                                 "tampered chunk must be rejected; body=%r" % cb[:300])
                return init, "tamper-rejected"
            self.assert_json(st, cb, 200)
        st, _, cb = self.req_json("POST", "/api/upload/complete",
                                  {"name": m["name"], "mtime_ns": m["mtime_ns"]})
        done = self.assert_json(st, cb, 200)
        return init, done

    # ---- tests -------------------------------------------------------------
    def test_00_info_and_auth(self):
        st, _, b = self.req("GET", "/api/info", token=None)
        self.assertEqual(st, 401)
        self.assertIn("X-LT-Token", b.decode("utf-8"))
        st2, _, b2 = self.req("GET", "/api/info")
        info = self.assert_json(st2, b2, 200)
        self.assertEqual(info["chunk_size"], CHUNK_SIZE)
        self.assertEqual(info["service"], "lossless-transfer-web")
        self.assertTrue(info["token_required"])
        self.assertEqual(info["version"], wt.WEB_VERSION)

    def test_01_static_pages_are_public(self):
        for path, needle in (("/", b"<!DOCTYPE html>"),
                             ("/index.html", b"<html"),
                             ("/app.js", b"LTSha256"),
                             ("/app.css", b":root"),
                             ("/sha256.js", b"function sha256Hex")):
            st, _, b = self.req("GET", path, token=None)
            self.assertEqual(st, 200, path)
            self.assertIn(needle, b, path)
        st, _, _ = self.req("GET", "/nope.txt", token=None)
        self.assertEqual(st, 404)

    @unittest.skipUnless(wt.HAS_PIL, "Pillow not installed")
    def test_01b_rendered_preview(self):
        """GET /api/image renders a display copy sized for the screen.

        The card path used to be the camera's 160x120 EXIF thumbnail, which is
        visibly soft at a 350-700 px card. This endpoint is the fix: decode
        once, scale to the requested edge, cache on disk, serve from cache.
        """
        from PIL import Image

        src = os.path.join(self.lib, "render-src.JPG")
        Image.new("RGB", (1200, 800), (30, 120, 200)).save(
            src, "JPEG", quality=92)
        try:
            st, h, body = self.req("GET", "/api/image?name=render-src.JPG&w=400")
            self.assertEqual(st, 200, body[:300])
            self.assertEqual(h.get("content-type"), "image/jpeg")
            with Image.open(io.BytesIO(body)) as im:
                self.assertLessEqual(max(im.size), 400)
                self.assertGreater(min(im.size), 200)   # ratio preserved
                self.assertEqual(im.size[0] > im.size[1], True)  # still landscape

            # same request again: byte-identical cache hit
            st2, h2, body2 = self.req("GET", "/api/image?name=render-src.JPG&w=400")
            self.assertEqual(st2, 200)
            self.assertEqual(body2, body)
            self.assertIn("etag", h2)

            # conditional request revalidates without a body
            st3, _, _ = self.req("GET", "/api/image?name=render-src.JPG&w=400",
                                 headers={"If-None-Match": h2["etag"]})
            self.assertEqual(st3, 304)

            # the rendered copy lives outside the shared listing
            st4, _, listing = self.req("GET", "/api/list")
            names = [f["name"] for f in json.loads(listing)["files"]]
            self.assertNotIn("previews", names)

            # token is still required, and only images can be rendered
            st5, _, _ = self.req("GET", "/api/image?name=render-src.JPG&w=400",
                                 token=None)
            self.assertEqual(st5, 401)
            st6, _, _ = self.req("GET", "/api/image?name=notes.txt&w=400")
            self.assertEqual(st6, 415)
        finally:
            try:
                os.remove(src)
            except OSError:
                pass

    def test_02_full_upload_is_byte_exact(self):
        data = sample_bytes(1000, seed=3)  # 16 chunks at 64 B
        m = browser_manifest("DSC_0001.NEF", data)
        init, done = self.upload_all(m, data)
        self.assertIsNotNone(done)
        self.assertEqual(done["status"], "verified")
        self.assertEqual(done["sha256"], m["sha256"])
        self.assertEqual(done["size"], len(data))
        dest = os.path.join(self.lib, "DSC_0001.NEF")
        with open(dest, "rb") as f:
            on_disk = f.read()
        self.assertEqual(on_disk, data, "stored bytes must equal source bytes")
        self.assertEqual(hashlib.sha256(on_disk).hexdigest(), m["sha256"])
        # mtime_ns was sent as a BigInt string and must have been applied.
        got_ns = os.stat(dest).st_mtime_ns
        self.assertLess(abs(got_ns - int(MTIME_NS)), 1_000_000_000,
                        "string mtime_ns was not restored (got %d)" % got_ns)

    def test_03_idempotent_reupload_and_conflict(self):
        data = sample_bytes(300, seed=11)
        m = browser_manifest("clip.mp4", data)
        _, done = self.upload_all(m, data)
        self.assertEqual(done["status"], "verified")
        # Exact same bytes -> server short-circuits with status=complete.
        st, _, b = self.req_json("POST", "/api/upload/init", m)
        again = self.assert_json(st, b, 200)
        self.assertEqual(again["status"], "complete")
        self.assertEqual(again["sha256"], m["sha256"])
        # Different bytes, same name -> 409, original untouched.
        m2 = browser_manifest("clip.mp4", sample_bytes(300, seed=12))
        st, _, b = self.req_json("POST", "/api/upload/init", m2)
        self.assertEqual(st, 409)
        with open(os.path.join(self.lib, "clip.mp4"), "rb") as f:
            self.assertEqual(f.read(), data)

    def test_04_wire_corruption_rejected_and_recoverable(self):
        data = sample_bytes(500, seed=21)
        m = browser_manifest("photo.CR3", data)
        st, _, b = self.req_json("POST", "/api/upload/init", m)
        init = self.assert_json(st, b, 200)
        self.assertEqual(init["next_index"], 0)
        # chunk 0 good, chunk 1 tampered -> 422 and no bad byte persisted.
        c0 = m["chunks"][0]
        st, _, cb = self.req(
            "POST", "/api/upload/chunk?name=photo.CR3&index=0",
            data[c0["offset"]:c0["offset"] + c0["length"]],
            {"Content-Type": "application/octet-stream"})
        self.assert_json(st, cb, 200)
        c1 = m["chunks"][1]
        bad = bytearray(data[c1["offset"]:c1["offset"] + c1["length"]])
        bad[0] ^= 0xFF
        st, _, cb = self.req(
            "POST", "/api/upload/chunk?name=photo.CR3&index=1",
            bytes(bad), {"Content-Type": "application/octet-stream"})
        self.assertEqual(st, 422)
        self.assertIn(b"wire corruption", cb)
        # State still expects index 1 -> the good chunk 0 was not lost.
        st, _, b = self.req_json("POST", "/api/upload/init", m)
        again = self.assert_json(st, b, 200)
        self.assertEqual(again["next_index"], 1,
                         "resume state must survive a rejected chunk")
        # Finish correctly from index 1.
        for i in range(1, len(m["chunks"])):
            c = m["chunks"][i]
            st, _, cb = self.req(
                "POST", "/api/upload/chunk?name=photo.CR3&index=%d" % i,
                data[c["offset"]:c["offset"] + c["length"]],
                {"Content-Type": "application/octet-stream"})
            self.assert_json(st, cb, 200)
        st, _, cb = self.req_json("POST", "/api/upload/complete",
                                  {"name": "photo.CR3",
                                   "mtime_ns": m["mtime_ns"]})
        done = self.assert_json(st, cb, 200)
        self.assertEqual(done["sha256"], m["sha256"])
        with open(os.path.join(self.lib, "photo.CR3"), "rb") as f:
            self.assertEqual(f.read(), data)

    def test_05_resume_after_interrupted_upload(self):
        data = sample_bytes(777, seed=31)
        m = browser_manifest("long_video.MOV", data)
        # Upload only the first 3 chunks, then "crash".
        st, _, b = self.req_json("POST", "/api/upload/init", m)
        self.assert_json(st, b, 200)
        for i in range(3):
            c = m["chunks"][i]
            st, _, cb = self.req(
                "POST", "/api/upload/chunk?name=long_video.MOV&index=%d" % i,
                data[c["offset"]:c["offset"] + c["length"]],
                {"Content-Type": "application/octet-stream"})
            self.assert_json(st, cb, 200)
        # Re-init with the identical manifest must resume at 3.
        st, _, b = self.req_json("POST", "/api/upload/init", m)
        resumed = self.assert_json(st, b, 200)
        self.assertEqual(resumed["status"], "upload")
        self.assertEqual(resumed["next_index"], 3)
        _, done = self.upload_all(m, data)
        self.assertIsNotNone(done)
        self.assertEqual(done["sha256"], m["sha256"])
        with open(os.path.join(self.lib, "long_video.MOV"), "rb") as f:
            self.assertEqual(f.read(), data)

    def test_06_download_reassembles_identical_bytes(self):
        data = sample_bytes(1333, seed=41)
        m = browser_manifest("download_me.ARW", data)
        _, done = self.upload_all(m, data)
        self.assertEqual(done["sha256"], m["sha256"])
        st, _, b = self.req("GET", "/api/download/manifest?name=download_me.ARW")
        dm = self.assert_json(st, b, 200)
        self.assertEqual(dm["sha256"], m["sha256"])
        self.assertEqual(dm["size"], len(data))
        self.assertEqual(len(dm["chunks"]), len(m["chunks"]))
        whole = hashlib.sha256()
        parts = []
        for i, c in enumerate(dm["chunks"]):
            st, rh, raw = self.req(
                "GET", "/api/download/chunk?name=download_me.ARW&index=%d" % i)
            self.assertEqual(st, 200)
            self.assertEqual(rh.get("x-chunk-sha256"),
                             hashlib.sha256(raw).hexdigest())
            self.assertEqual(hashlib.sha256(raw).hexdigest(), c["sha256"])
            whole.update(raw)
            parts.append(raw)
        joined = b"".join(parts)
        self.assertEqual(joined, data)
        self.assertEqual(whole.hexdigest(), m["sha256"])

    def test_07_empty_file(self):
        m = browser_manifest("empty.bin", b"")
        self.assertEqual(m["chunks"], [])
        self.assertEqual(m["sha256"], hashlib.sha256(b"").hexdigest())
        _, done = self.upload_all(m, b"")
        self.assertIsNotNone(done)
        self.assertEqual(done["status"], "verified")
        self.assertEqual(done["sha256"], m["sha256"])
        self.assertEqual(os.path.getsize(os.path.join(self.lib, "empty.bin")), 0)
        st, _, b = self.req("GET", "/api/download/manifest?name=empty.bin")
        dm = self.assert_json(st, b, 200)
        self.assertEqual(dm["chunks"], [])

    def test_08_bad_names_and_out_of_order(self):
        for bad in ("../evil.bin", "sub/dir.bin", ".hidden", "",
                    "x" + wt.lt.RECV_SUFFIX, "a\\b.bin"):
            m = browser_manifest(bad, b"x")
            st, _, b = self.req_json("POST", "/api/upload/init", m)
            self.assertEqual(st, 400, "should reject name %r" % bad)
        # Out-of-order chunk without init -> 409.
        st, _, _ = self.req("POST", "/api/upload/chunk?name=nope.bin&index=0",
                            b"x", {"Content-Type": "application/octet-stream"})
        self.assertEqual(st, 409)

    def test_09_list_and_delete(self):
        st, _, b = self.req("GET", "/api/list")
        listing = self.assert_json(st, b, 200)
        names = [f["name"] for f in listing["files"]]
        self.assertIn("DSC_0001.NEF", names)
        self.assertNotIn(".lossless-web", names)
        self.assertTrue(all(not n.startswith(".") for n in names))
        for f in listing["files"]:
            self.assertIn("size", f)
            self.assertIn("mtime_ns", f)
        st, _, b = self.req_json("POST", "/api/delete", {"name": "empty.bin"})
        self.assert_json(st, b, 200)
        self.assertFalse(os.path.isfile(os.path.join(self.lib, "empty.bin")))
        st, _, b = self.req("GET", "/api/list")
        self.assertNotIn("empty.bin",
                         [f["name"] for f in json.loads(b)["files"]])

    # ---- preview / thumbnail -----------------------------------------------
    def test_15_static_files_revalidate_with_etag(self):
        st, h, b = self.req("GET", "/app.js", token=None)
        self.assertEqual(st, 200)
        self.assertIn(b"LTSha256", b)
        etag = h.get("etag")
        self.assertTrue(etag, "static files must carry an ETag")
        self.assertIn("no-cache", h.get("cache-control", ""))
        st2, h2, b2 = self.req("GET", "/app.js", token=None,
                               headers={"If-None-Match": etag})
        self.assertEqual(st2, 304, "an unchanged asset must cost no body")
        self.assertEqual(b2, b"")
        self.assertEqual(h2.get("etag"), etag)

    def test_16_keepalive_serves_many_requests_on_one_socket(self):
        # HTTP/1.1 keep-alive is what stops a page load from paying a fresh
        # TCP (+TLS) handshake for every request over a tunnel.
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        try:
            for _ in range(3):
                conn.request("GET", "/api/info",
                             headers={"X-LT-Token": TOKEN})
                resp = conn.getresponse()
                body = resp.read()
                self.assertEqual(resp.status, 200)
                self.assertEqual(resp.version, 11, "must speak HTTP/1.1")
                self.assertEqual(json.loads(body)["service"],
                                 "lossless-transfer-web")
        finally:
            conn.close()

    def test_17_thumb_endpoint_serves_the_embedded_exif_thumbnail(self):
        thumb = b"\xff\xd8" + b"EMBEDDED-THUMB" * 8 + b"\xff\xd9"
        jpg_path = os.path.join(self.lib, "WITH_THUMB.JPG")
        with open(jpg_path, "wb") as f:
            # stored sideways, like a camera shot in portrait
            f.write(jpeg_with_exif_thumb(thumb, orientation=8))
        noexif_path = os.path.join(self.lib, "NO_EXIF.JPG")
        with open(noexif_path, "wb") as f:
            f.write(b"\xff\xd8\xff\xd9")
        try:
            st, h, b = self.req("GET", "/api/thumb?name=WITH_THUMB.JPG")
            self.assertEqual(st, 200, b[:300])
            self.assertEqual(h.get("content-type"), "image/jpeg")
            self.assertEqual(b, thumb, "must be the file's own thumb bytes")
            # the thumb itself has no EXIF: the grid needs this to turn it
            self.assertEqual(h.get("x-thumb-orientation"), "8")
            etag = h.get("etag")
            self.assertTrue(etag)
            self.assertIn("max-age", h.get("cache-control", ""))
            st2, _, b2 = self.req("GET", "/api/thumb?name=WITH_THUMB.JPG",
                                  headers={"If-None-Match": etag})
            self.assertEqual(st2, 304)
            self.assertEqual(b2, b"")

            # No EXIF block -> 415 "no thumbnail", which the UI must not read
            # as "unpreviewable": /api/preview still streams the file.
            st3, _, _ = self.req("GET", "/api/thumb?name=NO_EXIF.JPG")
            self.assertEqual(st3, 415)
            st4, _, b4 = self.req("GET", "/api/preview?name=NO_EXIF.JPG")
            self.assertEqual(st4, 200)
            self.assertEqual(b4, b"\xff\xd8\xff\xd9")

            # only JPEGs can carry this thumbnail; anything else answers 415
            st5, _, _ = self.req("GET", "/api/thumb?name=DSC_0001.NEF")
            self.assertEqual(st5, 415)
            st6, _, _ = self.req("GET", "/api/thumb?name=../escape.JPG")
            self.assertEqual(st6, 400)
            st7, _, _ = self.req("GET", "/api/thumb?name=missing.JPG")
            self.assertEqual(st7, 404)
        finally:
            os.remove(jpg_path)
            os.remove(noexif_path)


    # ---- Range handling: the whole of <video> seeking lives here ----------
    def _put(self, name: str, data: bytes) -> None:
        with open(os.path.join(self.lib, name), "wb") as f:
            f.write(data)

    def test_18_range_first_bytes(self):
        data = sample_bytes(1000, seed=11)
        self._put("range.jpg", data)
        st, h, body = self.req("GET", "/api/preview?name=range.jpg",
                               headers={"Range": "bytes=0-99"})
        self.assertEqual(st, 206)
        self.assertEqual(body, data[:100])
        self.assertEqual(h["content-range"], "bytes 0-99/1000")
        self.assertEqual(h["accept-ranges"], "bytes")
        self.assertEqual(h["content-length"], "100")

    def test_18b_range_suffix(self):
        data = sample_bytes(1000, seed=12)
        self._put("range2.jpg", data)
        st, h, body = self.req("GET", "/api/preview?name=range2.jpg",
                               headers={"Range": "bytes=-100"})
        self.assertEqual(st, 206)
        self.assertEqual(body, data[-100:])
        self.assertEqual(h["content-range"], "bytes 900-999/1000")

    def test_18c_range_open_ended(self):
        data = sample_bytes(1000, seed=13)
        self._put("range3.jpg", data)
        st, h, body = self.req("GET", "/api/preview?name=range3.jpg",
                               headers={"Range": "bytes=900-"})
        self.assertEqual(st, 206)
        self.assertEqual(body, data[900:])
        self.assertEqual(h["content-range"], "bytes 900-999/1000")

    def test_18d_range_beyond_eof_is_416(self):
        data = sample_bytes(1000, seed=14)
        self._put("range4.jpg", data)
        st, h, _ = self.req("GET", "/api/preview?name=range4.jpg",
                            headers={"Range": "bytes=5000-"})
        self.assertEqual(st, 416)
        self.assertEqual(h["content-range"], "bytes */1000")

    def test_18e_malformed_range_is_ignored(self):
        # RFC 9110: a Range a server cannot parse must be ignored, not rejected;
        # answering 416 there would make some players give up instead of
        # falling back to a plain GET.
        data = sample_bytes(300, seed=15)
        self._put("range5.jpg", data)
        st, h, body = self.req("GET", "/api/preview?name=range5.jpg",
                               headers={"Range": "bytes=abc"})
        self.assertEqual(st, 200)
        self.assertEqual(body, data)
        self.assertNotIn("content-range", h)

    def test_18f_unknown_range_unit_is_ignored(self):
        data = sample_bytes(200, seed=16)
        self._put("range6.jpg", data)
        st, _, body = self.req("GET", "/api/preview?name=range6.jpg",
                               headers={"Range": "items=0-10"})
        self.assertEqual(st, 200)
        self.assertEqual(body, data)

    # ---- file-name rules that only bite on Windows peers ------------------
    def _init_status(self, name: str) -> int:
        st, _, _ = self.req_json("POST", "/api/upload/init",
                                 browser_manifest(name, b"x"))
        return st

    def test_19_reserved_device_names_rejected(self):
        for bad in ("CON.MOV", "nul.jpg", "aux", "COM1.txt", "LPT9.MOV"):
            self.assertEqual(self._init_status(bad), 400, bad)

    def test_19b_trailing_dot_or_space_rejected(self):
        for bad in ("vacation.jpg.", "vacation.jpg "):
            self.assertEqual(self._init_status(bad), 400, bad)

    def test_19c_control_character_rejected(self):
        self.assertEqual(self._init_status("bad\tname.jpg"), 400)

    def test_19d_ordinary_names_still_accepted(self):
        # "console" merely *starts* like CON; only the stem before the first
        # dot is compared, so this must pass.
        for good in ("console.log.jpg", "period.2026.jpg", "中文 照片.JPG"):
            self.assertEqual(self._init_status(good), 200, good)


class ThumbExtraction(unittest.TestCase):
    """Pure-Python EXIF thumbnail extraction: byte order, bounds, junk input."""

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="lt-thumb-test-")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write(self, name: str, data: bytes) -> str:
        path = os.path.join(self.tmp, name)
        with open(path, "wb") as f:
            f.write(data)
        return path

    def test_reads_both_byte_orders(self):
        thumb = b"\xff\xd8" + b"THUMB" * 13 + b"\xff\xd9"
        for big in (False, True):
            path = self.write("t%s.JPG" % big,
                              jpeg_with_exif_thumb(thumb, big_endian=big))
            got, orient = wt.jpeg_thumbnail(path)
            self.assertEqual(got, thumb, "big_endian=%s" % big)
            self.assertEqual(orient, 1)

    def test_reads_the_orientation_tag(self):
        # A camera photo stored sideways must report it, because the extracted
        # thumbnail is a bare JPEG that carries no orientation of its own.
        thumb = b"\xff\xd8" + b"THUMB" * 9 + b"\xff\xd9"
        for o in (1, 3, 6, 8):
            for big in (False, True):
                path = self.write("o%d%s.JPG" % (o, big),
                                  jpeg_with_exif_thumb(thumb, big_endian=big,
                                                       orientation=o))
                self.assertEqual(wt.jpeg_thumbnail(path), (thumb, o),
                                 "orientation=%d big=%s" % (o, big))
        # out-of-range orientation falls back to 1 (upright) instead of
        # handing the UI a transform it does not know
        path = self.write("bad.JPG", jpeg_with_exif_thumb(thumb, orientation=99))
        self.assertEqual(wt.jpeg_thumbnail(path), (thumb, 1))

    def test_rejects_files_without_a_usable_thumbnail(self):
        # not a JPEG at all
        png = self.write("a.PNG", b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)
        self.assertIsNone(wt.jpeg_thumbnail(png)[0])
        # JPEG with no EXIF segment
        plain = self.write("b.JPG", b"\xff\xd8\xff\xdb\x00\x08" + b"\x00" * 16 +
                           b"\xff\xd9")
        self.assertIsNone(wt.jpeg_thumbnail(plain)[0])
        # EXIF whose IFD1 thumbnail length lies about the data: must not raise
        broken = bytearray(jpeg_with_exif_thumb(b"\xff\xd8\xff\xd9"))
        at = broken.index(struct.pack("<HHI", 0x0202, 4, 1)) + 8
        broken[at:at + 4] = struct.pack("<I", 0xFFFFF0)
        path = self.write("c.JPG", bytes(broken))
        self.assertIsNone(wt.jpeg_thumbnail(path)[0])
        # truncated header region
        self.assertIsNone(wt.jpeg_thumbnail(
            self.write("d.JPG", b"\xff\xd8\xff\xe1"))[0])
        # missing file
        self.assertIsNone(wt.jpeg_thumbnail(
            os.path.join(self.tmp, "nope.JPG"))[0])


class WebTransferTLS(unittest.TestCase):
    """Native HTTPS server (the mode mainland SakuraFrp nodes require).

    Uses a deliberately-public throwaway key in tests/fixtures; it is NOT a
    secret and must never be used for anything real.
    """
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.mkdtemp(prefix="lt-web-tls-test-")
        cls.lib = os.path.join(cls.tmp, "received")
        cls.cfg = wt.Config("127.0.0.1", 0, cls.lib, CHUNK_SIZE, TOKEN)
        cls.cfg.ensure_dirs()
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), wt.Handler)
        cls.httpd.daemon_threads = True
        cls.httpd.cfg = cls.cfg
        fixtures = os.path.join(HERE, "fixtures")
        ctx = wt.build_tls_context(os.path.join(fixtures, "test_cert.pem"),
                                   os.path.join(fixtures, "test_key.pem"))
        cls.httpd.socket = ctx.wrap_socket(cls.httpd.socket, server_side=True)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever,
                                      daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=5)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def tls_req(self, method, path, body=None, headers=None):
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE  # self-signed throwaway fixture
        conn = http.client.HTTPSConnection("127.0.0.1", self.port,
                                          timeout=15, context=ctx)
        h = {"X-LT-Token": TOKEN}
        if headers:
            h.update(headers)
        conn.request(method, path, body=body, headers=h)
        resp = conn.getresponse()
        data, status = resp.read(), resp.status
        conn.close()
        return status, data

    def test_10_tls_info_and_full_upload_byte_exact(self):
        st, b = self.tls_req("GET", "/api/info")
        info = json.loads(b.decode("utf-8"))
        self.assertEqual(st, 200)
        self.assertTrue(info["tls"], "server must report native TLS")
        data = sample_bytes(1000, 31)
        m = browser_manifest("TLS_VIDEO.MP4", data)
        st, b = self.tls_req("POST", "/api/upload/init",
                             json.dumps(m).encode("utf-8"),
                             {"Content-Type": "application/json"})
        init = json.loads(b.decode("utf-8"))
        self.assertEqual(init["status"], "upload")
        for c in m["chunks"]:
            st, b = self.tls_req(
                "POST",
                "/api/upload/chunk?name=TLS_VIDEO.MP4&index=%d" % c["index"],
                data[c["offset"]:c["offset"] + c["length"]],
                {"Content-Type": "application/octet-stream"})
            self.assertEqual(st, 200, "chunk %d: %r" % (c["index"], b[:200]))
        st, b = self.tls_req("POST", "/api/upload/complete",
                             json.dumps({"name": "TLS_VIDEO.MP4",
                                         "mtime_ns": m["mtime_ns"]}).encode("utf-8"),
                             {"Content-Type": "application/json"})
        done = json.loads(b.decode("utf-8"))
        self.assertEqual(done["status"], "verified")
        self.assertEqual(done["sha256"], m["sha256"])
        with open(os.path.join(self.lib, "TLS_VIDEO.MP4"), "rb") as f:
            self.assertEqual(f.read(), data,
                             "bytes over HTTPS must be byte-exact")
        # A plain HTTP request to a TLS-only socket must fail.
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        try:
            conn.request("GET", "/api/info", headers={"X-LT-Token": TOKEN})
            conn.getresponse()
            self.fail("plain HTTP should not succeed against a TLS socket")
        except (http.client.BadStatusLine, OSError, ssl.SSLError):
            pass
        finally:
            conn.close()

    def test_11_build_tls_context_rejects_bad_input(self):
        fixtures = os.path.join(HERE, "fixtures")
        cert = os.path.join(fixtures, "test_cert.pem")
        key = os.path.join(fixtures, "test_key.pem")
        with self.assertRaises(ValueError):
            wt.build_tls_context("", key)
        with self.assertRaises(ValueError):
            wt.build_tls_context(cert, os.path.join(fixtures, "missing.pem"))
        # A valid pair builds a real server-side context.
        ctx = wt.build_tls_context(cert, key)
        self.assertIsInstance(ctx, ssl.SSLContext)


class WebTransferOpenMode(unittest.TestCase):
    """--no-auth: an empty token means every request is accepted on purpose."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.mkdtemp(prefix="lt-web-open-")
        cls.lib = os.path.join(cls.tmp, "shared")
        cls.cfg = wt.Config("127.0.0.1", 0, cls.lib, CHUNK_SIZE, "")
        cls.cfg.ensure_dirs()
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), wt.Handler)
        cls.httpd.daemon_threads = True
        cls.httpd.cfg = cls.cfg
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever,
                                      daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=5)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def req(self, method: str, path: str, body: bytes | None = None,
            headers: dict | None = None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        conn.request(method, path, body=body, headers=headers or {})
        resp = conn.getresponse()
        data = resp.read()
        status = resp.status
        conn.close()
        return status, data

    def test_12_open_mode_needs_no_token(self):
        st, body = self.req("GET", "/api/info")
        self.assertEqual(st, 200)
        info = json.loads(body.decode("utf-8"))
        self.assertFalse(info["token_required"],
                         "open mode must advertise token_required=false")

    def test_13_open_mode_full_roundtrip_without_token(self):
        data = os.urandom(CHUNK_SIZE * 2 + 37)
        m = browser_manifest("open.bin", data)
        body = json.dumps(m, ensure_ascii=False,
                          separators=(",", ":")).encode("utf-8")
        st, b = self.req("POST", "/api/upload/init", body,
                         {"Content-Type": "application/json"})
        self.assertEqual(st, 200, "no token required, body=%r" % b[:300])
        init = json.loads(b.decode("utf-8"))
        self.assertEqual(init["status"], "upload")
        for c in m["chunks"]:
            raw = data[c["offset"]:c["offset"] + c["length"]]
            st, b = self.req("POST", "/api/upload/chunk?name=open.bin&index=%d"
                             % c["index"], raw,
                             {"Content-Type": "application/octet-stream"})
            self.assertEqual(st, 200, "chunk %d: %r" % (c["index"], b[:200]))
        done = json.dumps({"name": "open.bin",
                           "mtime_ns": MTIME_NS}).encode("utf-8")
        st, b = self.req("POST", "/api/upload/complete", done,
                         {"Content-Type": "application/json"})
        self.assertEqual(st, 200, b[:300])
        self.assertEqual(json.loads(b.decode("utf-8"))["status"], "verified")
        with open(os.path.join(self.lib, "open.bin"), "rb") as f:
            self.assertEqual(f.read(), data, "open mode stays byte-exact")

    def test_14_no_auth_and_token_are_exclusive(self):
        self.assertEqual(wt.main(["--no-auth", "--token", "x", "--port",
                                  "0", "--dir", self.lib]), 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)


class DiskReserve(unittest.TestCase):
    """An upload must not be able to eat the last free bytes of the disk."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.mkdtemp(prefix="lt-web-disk-")
        cls.lib = os.path.join(cls.tmp, "shared")
        # A reserve larger than any real disk makes the check fire every time,
        # which is what we want to observe here.
        cls.cfg = wt.Config("127.0.0.1", 0, cls.lib, CHUNK_SIZE, "",
                            min_free_bytes=1 << 60)
        cls.cfg.ensure_dirs()
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), wt.Handler)
        cls.httpd.daemon_threads = True
        cls.httpd.cfg = cls.cfg
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever,
                                      daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=5)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_20_upload_refused_when_free_space_below_reserve(self):
        data = sample_bytes(200, seed=21)
        m = browser_manifest("big.jpg", data)
        body = json.dumps(m, separators=(",", ":")).encode()
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        conn.request("POST", "/api/upload/init", body=body,
                     headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        payload = resp.read()
        status = resp.status
        conn.close()
        self.assertEqual(status, 507, payload[:300])
        self.assertIn(b"disk space", payload)

    def test_20b_reserve_of_zero_disables_the_check(self):
        self.cfg.min_free_bytes = 0
        try:
            data = sample_bytes(200, seed=22)
            m = browser_manifest("ok.jpg", data)
            body = json.dumps(m, separators=(",", ":")).encode()
            conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
            conn.request("POST", "/api/upload/init", body=body,
                         headers={"Content-Type": "application/json"})
            resp = conn.getresponse()
            payload = resp.read()
            status = resp.status
            conn.close()
            self.assertEqual(status, 200, payload[:300])
        finally:
            self.cfg.min_free_bytes = 1 << 60
