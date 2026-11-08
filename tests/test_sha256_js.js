/* Validate the browser-side pure JS SHA-256 against Node's crypto.
 * Run: node tests/test_sha256_js.js
 */
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const { Sha256, sha256Hex } = require('../web/sha256.js');

function nodeHex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// 1. Published test vectors.
assert.strictEqual(sha256Hex(''),
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
assert.strictEqual(sha256Hex('abc'),
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
assert.strictEqual(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
  '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
assert.strictEqual(sha256Hex('a'.repeat(1000000)),
  'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
  'one million a');

// 2. digest() returns the raw 32 bytes and is repeatable.
const d = new Sha256().update('abc');
assert.strictEqual(Buffer.from(d.digest()).toString('hex'),
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
assert.strictEqual(d.hex(), d.hex(), 'digest must be non-destructive');

// 3. Random buffers of every interesting length, fed in random-sized pieces.
let seed = 0x5eed1234;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; }
const lengths = [0, 1, 2, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129,
                 255, 256, 1000, 4096, 65535, 65536, 1048576 + 37];
for (const len of lengths) {
  const buf = Buffer.alloc(len);
  for (let i = 0; i < len; i++) buf[i] = (rnd() * 256) | 0;
  const expected = nodeHex(buf);
  assert.strictEqual(sha256Hex(new Uint8Array(buf)), expected, 'one-shot len=' + len);

  // Incremental with arbitrary split points (this is how the UI streams File slices).
  const h = new Sha256();
  let pos = 0;
  while (pos < len) {
    let n = 1 + Math.floor(rnd() * 200000);
    n = Math.min(n, len - pos);
    h.update(new Uint8Array(buf.subarray(pos, pos + n)));
    pos += n;
  }
  assert.strictEqual(h.hex(), expected, 'incremental len=' + len);
}

// 4. UTF-8 strings (TextEncoder path).
for (const s of ['中文照片', '📷 视频.mp4', 'a'.repeat(64)]) {
  assert.strictEqual(sha256Hex(s), nodeHex(Buffer.from(s, 'utf8')), 'utf8 ' + s.slice(0, 8));
}

console.log('OK: pure JS SHA-256 matches Node crypto (' + (lengths.length * 2 + 7) + ' cases)');
