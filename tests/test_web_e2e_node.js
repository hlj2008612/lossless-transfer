/* test_web_e2e_node.js - browser-path integration test.
 *
 * The Python unittest suite drives the HTTP API with hashlib-generated
 * manifests. This test closes the remaining gap: it builds the manifest with
 * the ACTUAL web/sha256.js (the same code the browser loads) and sends chunks
 * with fetch() + a Uint8Array body, exactly like web/app.js does. It then
 * starts a real web_transfer.py server and proves:
 *
 *   - the JS SHA-256 of every chunk and of the whole file matches the
 *     server's independently computed SHA-256 (byte-exact / lossless);
 *   - download manifest + chunks reassemble to identical bytes under JS
 *     SHA-256 verification;
 *   - this works over plain HTTP (no crypto.subtle, no HTTPS), which is the
 *     SakuraFrp/frp tunnel scenario.
 *
 * Run:  node tests/test_web_e2e_node.js
 *   or: py -3 -m unittest ... (this file is standalone, not a unittest)
 *
 * By default it spawns web_transfer.py itself. Set LT_E2E_URL and
 * LT_E2E_TOKEN to test an already-running server instead (e.g. a real
 * SakuraFrp tunnel), in which case no child process is started.
 */
'use strict';

const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const LT = require('../web/sha256.js');

const ROOT = path.resolve(__dirname, '..');
const EXTERNAL_URL = process.env.LT_E2E_URL || '';
const TOKEN = process.env.LT_E2E_TOKEN || ('node-e2e-' + Date.now());
const CHUNK_SIZE = 128; // small, so a modest sample spans many chunks

// ---- assertions -----------------------------------------------------------
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('  ok - ' + msg);
}

// ---- helpers --------------------------------------------------------------
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function sampleBytes(n, seed) {
  const out = Buffer.alloc(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(1103515245, x) + 12345) >>> 0;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
}

async function api(url, pathname, opts) {
  const headers = Object.assign({ 'X-LT-Token': TOKEN }, (opts && opts.headers) || {});
  const res = await fetch(url + pathname, Object.assign({}, opts, { headers }));
  const ct = res.headers.get('content-type') || '';
  let body;
  if (ct.indexOf('application/json') !== -1) body = await res.json();
  else body = new Uint8Array(await res.arrayBuffer());
  if (!res.ok) {
    const m = (body && body.error) ? body.error : ('HTTP ' + res.status);
    throw new Error(m + ' (' + pathname + ')');
  }
  return { res, body };
}

/* Mirror of web/app.js buildManifest(): a Blob stands in for the browser File
 * (Node 24 has global Blob with .slice().arrayBuffer()). */
async function buildManifest(blob, name, chunkSize) {
  const whole = new LT.Sha256();
  const chunks = [];
  let offset = 0, index = 0;
  while (offset < blob.size) {
    const end = Math.min(offset + chunkSize, blob.size);
    const buf = await blob.slice(offset, end).arrayBuffer();
    const bytes = new Uint8Array(buf);
    whole.update(bytes);
    chunks.push({
      index, offset, length: bytes.length,
      sha256: LT.sha256Hex(bytes)
    });
    offset = end;
    index++;
  }
  return {
    name, size: blob.size, sha256: whole.hex(),
    chunk_size: chunkSize, chunks,
    mtime_ns: (BigInt(Date.now()) * 1000000n).toString()
  };
}

async function waitReady(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error('server exited early with code ' + child.exitCode);
    }
    try {
      const r = await fetch(url + '/');
      if (r.status === 200) return;
    } catch (e) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('server did not become ready in ' + timeoutMs + 'ms');
}

// ---- main -----------------------------------------------------------------
(async function () {
  let child = null;
  let tmpDir = null;
  let url = EXTERNAL_URL;
  try {
    if (!url) {
      const port = await freePort();
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-web-node-'));
      url = 'http://127.0.0.1:' + port;
      const py = process.env.PYTHON_EXE || 'py';
      child = spawn(py, ['-3', 'web_transfer.py',
        '--host', '127.0.0.1', '--port', String(port),
        '--dir', path.join(tmpDir, 'received'),
        '--chunk-size', String(CHUNK_SIZE), '--token', TOKEN],
        { cwd: ROOT, stdio: 'ignore', windowsHide: true });
      child.on('error', e => { console.error('spawn error:', e.message); });
      await waitReady(url, child, 20000);
    }

    console.log('browser-path e2e against ' + url);

    // ---- info / auth ----
    let bad = 0;
    try { await api(url, '/api/info', { headers: { 'X-LT-Token': 'wrong' } }); }
    catch (e) { bad = 1; }
    ok(bad === 1, 'wrong token is rejected');
    const info = (await api(url, '/api/info')).body;
    ok(info.chunk_size > 0, 'server advertises chunk_size=' + info.chunk_size);
    const cs = info.chunk_size;

    // ---- source data: opaque "photo/video"-like bytes, never decoded ----
    const data = sampleBytes(5000, 12345);            // spans many chunks
    const blob = new Blob([data]);                    // like a browser File
    const name = 'DSC_9001.CR3';
    const m = await buildManifest(blob, name, cs);

    // Cross-check the JS whole-file hash against Node's native crypto: this
    // proves the manifest the browser would send is a real SHA-256.
    const native = crypto.createHash('sha256').update(data).digest('hex');
    ok(m.sha256 === native, 'JS whole-file SHA-256 == native crypto');
    ok(m.chunks.length === Math.ceil(data.length / cs),
       'manifest has ' + m.chunks.length + ' chunks');
    let joined = Buffer.alloc(0);
    for (const c of m.chunks) {
      const slice = data.subarray(c.offset, c.offset + c.length);
      ok(LT.sha256Hex(slice) === crypto.createHash('sha256').update(slice).digest('hex'),
         'JS chunk ' + c.index + ' SHA-256 == native crypto');
      joined = Buffer.concat([joined, slice]);
    }
    ok(joined.equals(data), 'chunk concatenation reproduces source bytes');

    // ---- upload: init -> chunk POSTs (Uint8Array bodies) -> complete ----
    const init = (await api(url, '/api/upload/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(m)
    })).body;
    ok(init.status === 'upload' || init.status === 'complete',
       'init returned status=' + init.status);
    if (init.status === 'upload') {
      for (const c of m.chunks) {
        const bytes = new Uint8Array(data.subarray(c.offset, c.offset + c.length));
        // Exactly what app.js postChunk() sends: fetch + Uint8Array body.
        await api(url, '/api/upload/chunk?name=' + encodeURIComponent(name) +
                  '&index=' + c.index, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: bytes
        });
      }
      const done = (await api(url, '/api/upload/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mtime_ns: m.mtime_ns })
      })).body;
      ok(done.status === 'verified', 'server verified the assembled file');
      ok(done.sha256 === m.sha256,
         'SERVER SHA-256 == BROWSER JS SHA-256 (byte-exact, lossless)');
      ok(done.size === data.length, 'server size == source size');
    }

    // ---- download: manifest + chunks, verified in JS, reassembled ----
    const dm = (await api(url, '/api/download/manifest?name=' +
                          encodeURIComponent(name))).body;
    ok(dm.sha256 === m.sha256, 'download manifest hash == source hash');
    const dlWhole = new LT.Sha256();
    const parts = [];
    for (const c of dm.chunks) {
      const r = await api(url, '/api/download/chunk?name=' +
                          encodeURIComponent(name) + '&index=' + c.index);
      const bytes = r.body; // Uint8Array
      ok(LT.sha256Hex(bytes) === c.sha256, 'download chunk ' + c.index + ' JS hash matches manifest');
      ok(r.res.headers.get('x-chunk-sha256') === c.sha256,
         'download chunk ' + c.index + ' header hash matches');
      dlWhole.update(bytes);
      parts.push(Buffer.from(bytes));
    }
    ok(dlWhole.hex() === m.sha256, 'reassembled download JS SHA-256 == source');
    ok(Buffer.concat(parts).equals(data), 'downloaded bytes == original bytes');

    // ---- bigInt mtime string round-trips as a real timestamp ----
    const list = (await api(url, '/api/list')).body;
    const entry = list.files.find(f => f.name === name);
    ok(!!entry && entry.size === data.length, 'file appears in /api/list with correct size');
    ok(Number.isFinite(entry.mtime_ns) || typeof entry.mtime_ns === 'number',
       '/api/list returns mtime_ns');

    // ---- wire-corruption detection with JS-computed hashes ----
    const badBytes = new Uint8Array(data.subarray(0, m.chunks[0].length));
    badBytes[0] ^= 0xff;
    let rejected = false;
    try {
      // Re-init a fresh name so we can tamper chunk 0.
      const m2 = await buildManifest(new Blob([sampleBytes(300, 9)]), 'tamper.bin', cs);
      await api(url, '/api/upload/init', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(m2)
      });
      await api(url, '/api/upload/chunk?name=tamper.bin&index=0', {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
        body: badBytes.slice(0, m2.chunks[0].length)
      });
    } catch (e) {
      rejected = /SHA-256|corruption|length/i.test(e.message);
    }
    ok(rejected, 'corrupted chunk is rejected by server hash check');

    console.log('\nOK: browser-path e2e passed (' + checks + ' checks)');
  } catch (e) {
    console.error('\n' + e.stack);
    process.exitCode = 1;
  } finally {
    if (child) {
      try { child.kill(); } catch (e) { /* ignore */ }
    }
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
  }
})();
