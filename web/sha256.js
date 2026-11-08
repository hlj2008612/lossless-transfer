/* sha256.js - dependency-free, incremental SHA-256 for browsers and Node.
 *
 * Why this exists instead of crypto.subtle:
 *   window.crypto.subtle is only exposed in a "secure context" (HTTPS or
 *   localhost). A SakuraFrp / frp TCP tunnel normally serves plain HTTP on a
 *   remote host, so subtle is undefined there. This implementation works in
 *   any context, has no dependencies, and streams data block by block so a
 *   multi-gigabyte video never has to be held in memory all at once.
 *
 * It is deliberately standalone: no modules, no build step, no globals other
 * than LTSha256. Node can `require()` the same file for testing.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.LTSha256 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  var H0 = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  function compress(h, block, off) {
    var w = new Uint32Array(64), i, j, x, y, s0, s1;
    for (i = 0; i < 16; i++) {
      j = off + i * 4;
      w[i] = ((block[j] << 24) | (block[j + 1] << 16) |
              (block[j + 2] << 8) | block[j + 3]) >>> 0;
    }
    for (i = 16; i < 64; i++) {
      x = w[i - 15];
      y = w[i - 2];
      s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    var a = h[0], b = h[1], c = h[2], d = h[3];
    var e = h[4], f = h[5], g = h[6], hh = h[7];
    for (i = 0; i < 64; i++) {
      var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      var ch = (e & f) ^ (~e & g);
      var t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      var maj = (a & b) ^ (a & c) ^ (b & c);
      var t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }

  function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (typeof input === 'string') {
      if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(input);
      var s = unescape(encodeURIComponent(input)), out = [];
      for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
      return new Uint8Array(out);
    }
    return new Uint8Array(input);
  }

  function Sha256() {
    this._h = Uint32Array.from(H0);
    this._buf = new Uint8Array(64);
    this._len = 0;    // bytes currently buffered (0..63)
    this._total = 0;  // total bytes fed; JS Number is exact up to 2^53 bytes
  }

  Sha256.prototype.update = function (input) {
    var b = toBytes(input), n = b.length, pos = 0;
    this._total += n;
    if (this._len) {
      var take = Math.min(64 - this._len, n);
      this._buf.set(b.subarray(0, take), this._len);
      this._len += take; pos += take;
      if (this._len === 64) { compress(this._h, this._buf, 0); this._len = 0; }
    }
    while (pos + 64 <= n) { compress(this._h, b, pos); pos += 64; }
    if (pos < n) { this._buf.set(b.subarray(pos), 0); this._len = n - pos; }
    return this;
  };

  Sha256.prototype.digest = function () {
    // Work on a clone so digest()/hex() can be called more than once.
    var h = Uint32Array.from(this._h);
    var bitLen = this._total * 8;
    var total = Math.ceil((this._len + 9) / 64) * 64;
    var tail = new Uint8Array(total);
    tail.set(this._buf.subarray(0, this._len), 0);
    tail[this._len] = 0x80;
    var dv = new DataView(tail.buffer);
    dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000));
    dv.setUint32(total - 4, bitLen >>> 0);
    for (var off = 0; off < total; off += 64) compress(h, tail, off);
    var out = new Uint8Array(32), od = new DataView(out.buffer);
    for (var i = 0; i < 8; i++) od.setUint32(i * 4, h[i]);
    return out;
  };

  Sha256.prototype.hex = function () {
    var d = this.digest(), s = '';
    for (var i = 0; i < 32; i++) s += ('0' + d[i].toString(16)).slice(-2);
    return s;
  };

  function sha256Hex(input) { return new Sha256().update(input).hex(); }

  return { Sha256: Sha256, sha256Hex: sha256Hex };
});
