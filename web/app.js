/* app.js - browser client for lossless-transfer web.
 *
 * Guarantee implemented here:
 *   - the local File is read slice-by-slice as raw bytes (never decoded);
 *   - every slice is hashed with our own SHA-256 (web/sha256.js), and one
 *     rolling hash covers the entire file;
 *   - the server also hashes every chunk and the assembled file;
 *   - we compare the server's whole-file hash with our source hash and only
 *     then label the transfer VERIFIED (byte-exact / lossless).
 * Works over plain HTTP (frp tunnels) because crypto.subtle is not required.
 *
 * Preview path (thumbnails, lightbox, video playback) is display-only: it
 * reads GET /api/preview through fetch with the X-LT-Token header, so it works
 * exactly like every other API call. Downloading - the byte-exact path - always
 * goes through /api/download/manifest + /api/download/chunk.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var token = sessionStorage.getItem('lt_token') || '';
  var tokenRequired = true;
  var serverChunk = 0;
  var mediaToken = '';      // header-less media use this instead of X-LT-Token
  var busy = false;

  // ---- logging ------------------------------------------------------------
  function log(msg, cls) {
    var box = $('logBox');
    var d = document.createElement('div');
    var t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    d.innerHTML = '<span class="t">[' + t + ']</span> ';
    var span = document.createElement('span');
    span.className = cls || '';
    span.textContent = msg;
    d.appendChild(span);
    box.appendChild(d);
    while (box.childNodes.length > 600) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }

  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KiB';
    if (n < 1073741824) return (n / 1048576).toFixed(2) + ' MiB';
    return (n / 1073741824).toFixed(2) + ' GiB';
  }

  function fmtDate(ns) {
    try {
      return new Date(Number(ns) / 1e6).toLocaleString('zh-CN');
    } catch (e) { return ''; }
  }

  // ---- API ----------------------------------------------------------------
  async function api(path, opts) {
    opts = opts || {};
    var headers = Object.assign({ 'X-LT-Token': token }, opts.headers || {});
    var res = await fetch(path, Object.assign({}, opts, { headers: headers }));
    var ct = res.headers.get('Content-Type') || '';
    var body;
    if (ct.indexOf('application/json') !== -1) {
      body = await res.json();
    } else {
      body = await res.arrayBuffer();
    }
    if (!res.ok) {
      var msg = (body && body.error) ? body.error : ('HTTP ' + res.status);
      var err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return { res: res, body: body };
  }

  function qs(s) { return encodeURIComponent(s); }

  // ---- connection ---------------------------------------------------------
  async function connect() {
    token = (($('token') && $('token').value.trim()) || token);
    var info;
    try {
      info = (await api('/api/info')).body;
      serverChunk = info.chunk_size;
      mediaToken = info.media_token || '';
      tokenRequired = info.token_required !== false;
    } catch (e) {
      // 401 means the server does require a token: show the input and stop.
      if (e.status === 401) {
        showTokenInput();
        log('需要 ACCESS TOKEN：请输入服务端启动时打印的令牌。', 'err');
        return;
      }
      $('connBadge').className = 'badge badge-off';
      $('connBadge').textContent = '未连接';
      log('连接失败：' + e.message, 'err');
      return;
    }
    if (tokenRequired) {
      if (!token) { showTokenInput(); log('请先输入 ACCESS TOKEN', 'err'); return; }
      sessionStorage.setItem('lt_token', token);
    } else {
      // Open mode: nothing to type, so hide the connection card entirely.
      hideTokenInput();
    }
    try {
      $('connBadge').className = 'badge badge-on';
      $('connBadge').textContent = '已连接 v' + info.version;
      // Built as elements, never HTML strings: file names and server strings
      // are untrusted text and must not be able to inject markup.
      var infoRows = [
        ['服务', info.service + ' ' + info.version],
        ['分块大小', fmtSize(info.chunk_size) + '（' + info.chunk_size + ' 字节）'],
        ['鉴权', tokenRequired ? 'X-LT-Token' : '开放模式（无需令牌）'],
        ['协议版本', String(info.protocol)]
      ];
      var box = $('connInfo');
      box.innerHTML = '';
      infoRows.forEach(function (kv) {
        var row = document.createElement('div');
        var k = document.createElement('span');
        k.className = 'kv-k';
        k.textContent = kv[0];
        var v = document.createElement('span');
        v.className = 'kv-v';
        v.textContent = kv[1];
        v.title = kv[1];
        row.appendChild(k);
        row.appendChild(v);
        box.appendChild(row);
      });
      $('workspace').classList.remove('hidden');
      log('连接成功，服务端 chunk_size=' + serverChunk, 'ok');
      if (!tokenRequired) log('该共享文件夹为开放模式：任何人打开此地址均可上传/下载/删除。', 'warn');
      await refresh();
    } catch (e) {
      log('连接失败：' + e.message, 'err');
    }
  }

  function showTokenInput() {
    var card = $('connCard'), row = $('tokenRow'), hint = $('connHint');
    if (card) card.classList.remove('hidden');
    if (row) row.classList.remove('hidden');
    if (hint) hint.classList.remove('hidden');
  }

  function hideTokenInput() {
    var row = $('tokenRow'), hint = $('connHint');
    if (row) row.classList.add('hidden');
    if (hint) hint.classList.add('hidden');
  }

  // ---- hashing helpers ----------------------------------------------------
  async function buildManifest(file, chunkSize) {
    var whole = new LTSha256.Sha256();
    var chunks = [];
    var offset = 0;
    var index = 0;
    // A zero-length file legitimately has zero chunks: the SHA-256 of the
    // empty byte string is the whole-file hash the server will recompute.
    while (offset < file.size) {
      var end = Math.min(offset + chunkSize, file.size);
      var buf = await file.slice(offset, end).arrayBuffer();
      var bytes = new Uint8Array(buf);
      whole.update(bytes);
      chunks.push({
        index: index,
        offset: offset,
        length: bytes.length,
        sha256: LTSha256.sha256Hex(bytes)
      });
      offset = end;
      index++;
    }
    return {
      name: file.name,
      size: file.size,
      sha256: whole.hex(),
      chunk_size: chunkSize,
      chunks: chunks,
      // BigInt keeps nanosecond precision (lastModified is ms since epoch).
      mtime_ns: (BigInt(file.lastModified) * 1000000n).toString()
    };
  }

  // ---- upload -------------------------------------------------------------
  function uploadRow(name, size) {
    var row = document.createElement('div');
    row.className = 'file-row';
    row.innerHTML =
      '<div class="file-head"><span class="file-name"></span>' +
      '<span class="file-status st-wait">准备中</span></div>' +
      '<div class="file-meta"></div>' +
      '<div class="bar"><i></i></div>' +
      '<div class="hash"></div>';
    row.querySelector('.file-name').textContent = name;
    row.querySelector('.file-meta').textContent = fmtSize(size) + ' · 计算本地 SHA-256…';
    $('uploadQueue').appendChild(row);
    return {
      status: function (text, cls) {
        var el = row.querySelector('.file-status');
        el.textContent = text; el.className = 'file-status ' + cls;
      },
      meta: function (text) { row.querySelector('.file-meta').textContent = text; },
      bar: function (pct) { row.querySelector('.bar > i').style.width = pct + '%'; },
      hash: function (text) { row.querySelector('.hash').textContent = text; },
      remove: function () { if (row.parentNode) row.parentNode.removeChild(row); }
    };
  }

  async function postChunk(name, index, bytes, tries) {
    tries = tries || 0;
    try {
      await api('/api/upload/chunk?name=' + qs(name) + '&index=' + index, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: bytes
      });
    } catch (e) {
      if (tries < 3) {
        log('分块 ' + index + ' 失败（' + e.message + '），重试 ' + (tries + 1) + '/3', 'warn');
        return postChunk(name, index, bytes, tries + 1);
      }
      throw e;
    }
  }

  async function uploadFile(file) {
    var ui = uploadRow(file.name, file.size);
    try {
      ui.status('计算校验值', 'st-run');
      var m = await buildManifest(file, serverChunk);
      ui.meta(fmtSize(file.size) + ' · ' + m.chunks.length + ' 块 · 本地 SHA-256 ' + m.sha256.slice(0, 16) + '…');
      ui.hash('local  sha256 = ' + m.sha256);

      ui.status('初始化', 'st-run');
      var init = (await api('/api/upload/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(m)
      })).body;

      var start = 0;
      if (init.status === 'complete') {
        ui.status('已存在（完全相同）', 'st-ok');
        ui.bar(100);
        ui.hash('local  sha256 = ' + m.sha256 + '\nserver sha256 = ' + init.sha256);
        log(file.name + '：服务端已存在同哈希文件，跳过', 'ok');
        await refresh();
        return;
      }
      start = init.next_index || 0;
      if (start > 0) {
        log(file.name + '：从第 ' + start + ' 块断点续传（共 ' + m.chunks.length + ' 块）', 'ok');
        ui.bar(Math.round(start / Math.max(m.chunks.length, 1) * 100));
      }
      ui.status('上传中', 'st-run');
      for (var i = start; i < m.chunks.length; i++) {
        var c = m.chunks[i];
        var buf = await file.slice(c.offset, c.offset + c.length).arrayBuffer();
        await postChunk(m.name, i, new Uint8Array(buf));
        ui.bar(Math.round((i + 1) / m.chunks.length * 100));
        ui.meta(fmtSize(file.size) + ' · 已传 ' + (i + 1) + '/' + m.chunks.length + ' 块');
      }
      ui.status('服务端校验中', 'st-run');
      var done = (await api('/api/upload/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: m.name, mtime_ns: m.mtime_ns })
      })).body;
      ui.bar(100);
      ui.hash('local  sha256 = ' + m.sha256 + '\nserver sha256 = ' + done.sha256);
      if (done.sha256 === m.sha256 && done.size === m.size) {
        ui.status('✓ 已验证 · 字节完全一致', 'st-ok');
        ui.meta(fmtSize(done.size) + ' · SHA-256 双端一致 · 无损');
        log('VERIFIED: ' + file.name + ' 字节级一致（' + m.sha256 + '）', 'ok');
      } else {
        ui.status('✗ 哈希不一致', 'st-err');
        log('ERROR: ' + file.name + ' 服务端哈希与源文件不一致', 'err');
      }
      await refresh();
    } catch (e) {
      ui.status('✗ 失败', 'st-err');
      ui.meta(fmtSize(file.size) + ' · ' + e.message);
      log('上传失败 ' + file.name + '：' + e.message, 'err');
    }
  }

  async function uploadFiles(files) {
    if (busy) { log('已有传输在进行，请稍候', 'warn'); return; }
    busy = true;
    try {
      for (var i = 0; i < files.length; i++) await uploadFile(files[i]);
    } finally { busy = false; }
  }

  // ---- download -----------------------------------------------------------
  // Unchanged lossless path: manifest -> every chunk -> SHA-256 of each chunk
  // and of the whole file -> Blob -> save. `btn` is optional (batch downloads
  // drive the same function without an individual card button).
  async function downloadFile(name, btn) {
    if (busy) { log('已有传输在进行，请稍候', 'warn'); return false; }
    busy = true;
    if (btn) btn.disabled = true;
    var ok = false;
    try {
      log('下载 ' + name + '：取清单', '');
      var m = (await api('/api/download/manifest?name=' + qs(name))).body;
      var whole = new LTSha256.Sha256();
      var parts = [];
      for (var i = 0; i < m.chunks.length; i++) {
        var r = await api('/api/download/chunk?name=' + qs(name) + '&index=' + i);
        var bytes = new Uint8Array(r.body);
        var got = LTSha256.sha256Hex(bytes);
        if (got !== m.chunks[i].sha256 || got !== r.res.headers.get('X-Chunk-Sha256')) {
          throw new Error('分块 ' + i + ' SHA-256 不一致，已中止下载');
        }
        whole.update(bytes);
        parts.push(bytes);
        if (btn) btn.textContent = '下载中 ' + Math.round((i + 1) / m.chunks.length * 100) + '%';
      }
      var local = whole.hex();
      if (local !== m.sha256) {
        throw new Error('整文件 SHA-256 与服务端清单不一致（' + local + ' != ' + m.sha256 + '）');
      }
      var blob = new Blob(parts, { type: 'application/octet-stream' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      log('VERIFIED: ' + name + ' 下载后 SHA-256 = ' + local + '（字节级一致，无损）', 'ok');
      ok = true;
    } catch (e) {
      log('下载失败 ' + name + '：' + e.message, 'err');
    } finally {
      busy = false;
      if (btn) { btn.disabled = false; btn.textContent = '下载并校验'; }
    }
    return ok;
  }

  // ---- preview fetching ---------------------------------------------------
  // Every preview byte comes from GET /api/preview with the token header, so
  // no file ever needs to be in the static whitelist.
  var PREVIEW_CONCURRENCY = 4;   // thumbnails at once: gentle on a tunnel
  var PREVIEW_TIMEOUT_MS = 30000;
  var previewSlots = PREVIEW_CONCURRENCY;
  var previewWaiters = [];
  var previewControllers = {};   // name+version -> AbortController (live only)

  function takePreviewSlot() {
    if (previewSlots > 0) { previewSlots--; return Promise.resolve(); }
    return new Promise(function (resolve) { previewWaiters.push(resolve); });
  }
  function releasePreviewSlot() {
    var next = previewWaiters.shift();
    if (next) next(); else previewSlots++;
  }

  function previewPath(f, index) {
    return '/api/preview?name=' + qs(f.name) + '&index=' + (index || 0);
  }

  // Read the response body, bounded by Content-Length. With HTTP/1.0 the
  // body ends at EOF, so honouring the declared length keeps this correct
  // even if keep-alive is ever enabled. With a Range it streams to memory.
  async function readPreviewBytes(res, onProgress) {
    var len = parseInt(res.headers.get('Content-Length') || '0', 10) || 0;
    if (!res.body || !res.body.getReader || !len) {
      return new Uint8Array(await res.arrayBuffer());
    }
    var reader = res.body.getReader();
    var out = new Uint8Array(len);
    var got = 0;
    while (got < len) {
      var step = await reader.read();
      if (step.done) break;
      var chunk = step.value;
      if (got + chunk.length > len) chunk = chunk.subarray(0, len - got);
      out.set(chunk, got);
      got += chunk.length;
      if (onProgress) onProgress(got, len);
    }
    try { reader.cancel(); } catch (e) { /* already closed */ }
    return got === len ? out : out.subarray(0, got);
  }

  // Ranged fetch used by the thumbnail <img> when the tunnel/resource does
  // not support 206 responses: pull the first `want` bytes in one request,
  // then try to decode with createImageBitmap (which needs complete data).
  async function probeImage(f, index, want) {
    return fetchRangedHead(f, index, want);
  }

  async function fetchRangedHead(f, index, want) {
    await takePreviewSlot();
    try {
      var res = await fetch(previewPath(f, index), {
        headers: { 'X-LT-Token': token, 'Range': 'bytes=0-' + (want - 1) }
      });
      if (!res.ok && res.status !== 206) return null;
      var bytes = await readPreviewBytes(res);
      if (!bytes.length) return null;
      var blob = new Blob([bytes], { type: res.headers.get('Content-Type') || '' });
      // Complete only if the server really capped the range at `want`.
      if (bytes.length < want) return blob;
      return await decodeLimit(blob);
    } catch (e) {
      return null;
    } finally {
      releasePreviewSlot();
    }
  }

  function decodeLimit(blob) {
    if (typeof createImageBitmap !== 'function') return Promise.resolve(null);
    return createImageBitmap(blob).then(function (bmp) {
      if (bmp.close) bmp.close();
      return blob;
    }, function () { return null; });
  }

  // Fallback: first `want` bytes, then let the browser's own decoder decide
  // (an <img> with just a header often renders the full image already).
  async function fetchHeadBytes(f, index, want) {
    await takePreviewSlot();
    try {
      var res = await fetch(previewPath(f, index), {
        headers: { 'X-LT-Token': token, 'Range': 'bytes=0-' + (want - 1) }
      });
      if (!res.ok && res.status !== 206) return null;
      var bytes = await readPreviewBytes(res);
      if (!bytes.length) return null;
      return new Blob([bytes], { type: res.headers.get('Content-Type') || '' });
    } catch (e) {
      return null;
    } finally {
      releasePreviewSlot();
    }
  }

  // Full (Range-less) preview blob with progress - used by the lightbox for
  // images and, where MediaSource is missing (plain HTTP), for videos.
  function fetchPreviewBlob(f, index, onProgress) {
    var key = f.name + '#' + index;
    var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    previewControllers[key] = ctrl;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, PREVIEW_TIMEOUT_MS);
    function done() {
      clearTimeout(timer);
      delete previewControllers[key];
    }
    return takePreviewSlot().then(async function () {
      try {
        var res = await fetch(previewPath(f, index), {
          headers: { 'X-LT-Token': token },
          signal: ctrl ? ctrl.signal : undefined
        });
        if (!res.ok) {
          var msg = 'HTTP ' + res.status;
          try { msg = (await res.json()).error || msg; } catch (e) { /* not JSON */ }
          var err = new Error(msg); err.status = res.status; throw err;
        }
        var bytes = await readPreviewBytes(res, onProgress);
        return new Blob([bytes], { type: res.headers.get('Content-Type') || '' });
      } finally {
        releasePreviewSlot();
        done();
      }
    }, function (e) {
      done();
      throw e;
    });
  }

  function abortPreviews() {
    Object.keys(previewControllers).forEach(function (k) {
      try { previewControllers[k].abort(); } catch (e) { /* ignore */ }
    });
    previewControllers = {};
  }

  // ---- media grid ---------------------------------------------------------
  var files = [];          // current listing from /api/list
  var selected = {};       // name -> true
  var viewed = [];         // previewable files, in grid order (lightbox walk)
  var cards = {};          // name -> {el, thumbUrl, thumbInfo, ...} live only
  var io = null;           // IntersectionObserver for lazy thumbnails

  if (typeof IntersectionObserver === 'function') {
    io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        var name = en.target.getAttribute('data-name');
        io.unobserve(en.target);
        var card = cards[name];
        if (!card) return;
        if (card.file.kind === 'video') loadVideoStill(card);
        else loadThumb(card);
      });
    }, { rootMargin: '300px 0px' });
  }

  // Video poster: the video element fetches the media itself (it cannot send
  // X-LT-Token headers), so the query string carries the token instead. The
  // server still rejects a wrong one with 401; only the thumbnail request may
  // use this, never a verified download.
  function tokenQuery() {
    return mediaToken ? '&t=' + qs(mediaToken) : '';
  }

  function loadVideoStill(card) {
    if (card.loading || card.unpreviewable) return;
    var v = card.el.querySelector('.card-poster');
    if (!v) return;
    var url = previewPath(card.file, card.index) + tokenQuery();
    var settled = false;
    var timer = 0;
    function finish(ok) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      card.loading = false;
      if (ok) {
        // has-still itself hides the static placeholder: the <video> element
        // paints the frame, so a dimmed arrow must not sit on top of it.
        card.el.classList.add('thumb-loaded', 'has-still');
        card.el.classList.remove('thumb-unsupported');
      } else {
        v.removeAttribute('src');
        try { v.load(); } catch (e) { /* ignore */ }
        if (!card.unpreviewable) card.el.classList.add('thumb-unsupported');
      }
    }
    // <video> cannot send X-LT-Token, so the token rides in the query string.
    // The element fetches lazily and sizes its own Range requests, so simply
    // pointing it at the URL is enough. Seek past the exact first keyframe
    // (t=0 usually paints nothing); currentTime is clamped if the clip is
    // shorter. Muted autoplay is permitted everywhere, so the frame paints
    // even where a poster ack via play() would be blocked outright.
    v.addEventListener('loadedmetadata', function () {
      if (!v.duration || !isFinite(v.duration)) return;
      try { v.currentTime = Math.min(0.2, v.duration / 4); } catch (e) { /* ignore */ }
    });
    v.addEventListener('loadeddata', function () { finish(true); });
    v.addEventListener('error', function () {
      // decode errors after a frame already painted are not a card state.
      finish(false);
    });
    timer = setTimeout(function () { finish(false); }, 20000);
    card.loading = true;
    // The poster frame only helps if the bytes are really ours: ask for one
    // byte first with the header token, so 415 becomes a clear "not
    // previewable" state instead of a silent media error.
    fetch(previewPath(card.file, card.index), {
      headers: { 'X-LT-Token': token, 'Range': 'bytes=0-0' }
    }).then(function (res) {
      if (!res.ok && res.status !== 206) {
        if (res.status === 415) markNoPreview(card.file.name, '此视频格式浏览器无法预览，请下载查看');
        return finish(false);
      }
      try { res.body && res.body.cancel(); } catch (e) { /* ignore */ }
      v.src = url;
      v.load();
    }).catch(function () { finish(false); });
  }

  function thumbFail(card, status) {
    card.el.classList.remove('is-loading');
    card.el.classList.add('thumb-unsupported');
    // 415 = the server says this type is not previewable: no point retrying.
    if (status === 415) markNoPreview(card.file.name, '此格式浏览器无法预览，请下载查看');
  }

  function markNoPreview(name, reason) {
    var entry = viewed.find(function (v) { return v.name === name; });
    if (entry) entry.unpreviewable = reason;
    var card = cards[name];
    if (card) {
      card.unpreviewable = reason;
      card.el.classList.add('thumb-unsupported');
    }
  }

  function setThumb(card, blob) {
    if (card.thumbUrl) URL.revokeObjectURL(card.thumbUrl);
    card.thumbUrl = URL.createObjectURL(blob);
    var img = card.el.querySelector('.card-thumb');
    img.onload = null;
    img.src = card.thumbUrl;
    card.el.classList.remove('is-loading');
    card.el.classList.add('thumb-loaded');
  }

  async function viaImg(card, blob) {
    var img = card.el.querySelector('.card-thumb');
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(blob);
      img.onload = function () { img.onload = null; resolve(url); };
      img.onerror = function () {
        img.onerror = null;
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    });
  }

  // Progressive: 128 KiB header first, then 512 KiB, then the whole image.
  // Most JPEGs show their (embedded) thumbnail after the first step, and a
  // whole-image read only happens where neither a plain <img> nor a Range
  // could do it - all of it bounded by the same concurrency limiter.
  async function loadThumb(card) {
    var f = card.file;
    if (card.loading) return;
    card.loading = true;
    var index = card.index;
    try {
      var blob = await fetchRangedHead(f, index, 131072);
      if (!blob) return thumbFail(card);
      var url = await viaImg(card, blob);
      if (url) { setThumb(card, blob); URL.revokeObjectURL(url); return; }
      blob = await fetchRangedHead(f, index, 524288) || await fetchHeadBytes(f, index, 524288);
      if (blob && await viaImg(card, blob)) { setThumb(card, blob); return; }
      var probe = await probeImage(f, index, 4 << 20);
      if (probe) { setThumb(card, probe); return; }
      // Last resort: the complete image.
      blob = await fetchPreviewBlob(f, index);
      if (blob) setThumb(card, blob); else thumbFail(card);
    } catch (e) {
      if (!(e && e.name === 'AbortError')) thumbFail(card, e && e.status);
    } finally {
      card.loading = false;
    }
  }

  function thumbIcon(kind) {
    return kind === 'video' ? '▶' : '▣';
  }

  function buildCard(f, index) {
    var el = document.createElement('article');
    el.className = 'card-item kind-' + (f.kind || 'other');
    el.setAttribute('data-name', f.name);
    if (f.kind === 'image') el.classList.add('is-loading');

    var fig = document.createElement('div');
    fig.className = 'card-fig';

    if (f.kind === 'image') {
      var img = document.createElement('img');
      img.className = 'card-thumb';
      img.alt = f.name;
      img.decoding = 'async';
      img.draggable = false;
      fig.appendChild(img);
    } else {
      fig.innerHTML = '<div class="card-ph"><span class="card-ph-icon">' +
        thumbIcon(f.kind) + '</span><span class="card-ph-kind">' +
        (f.kind === 'video' ? '视频' : '文件') + '</span></div>';
    }

    if (f.kind === 'video') {
      // The poster frame is streamed in by a muted, preload=metadata
      // <video>; until (or unless) it paints, the placeholder icon stays.
      var poster = document.createElement('video');
      poster.className = 'card-poster';
      poster.muted = true;
      poster.setAttribute('playsinline', '');
      poster.setAttribute('tabindex', '-1');
      poster.setAttribute('aria-hidden', 'true');
      poster.preload = 'metadata';
      fig.appendChild(poster);
      var badge = document.createElement('span');
      badge.className = 'card-badge';
      badge.textContent = '▶ 视频';
      fig.appendChild(badge);
    }

    // selection checkbox (never opens the lightbox)
    var pick = document.createElement('label');
    pick.className = 'pick';
    pick.title = '选择';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!selected[f.name];
    cb.addEventListener('click', function (e) { e.stopPropagation(); });
    cb.addEventListener('change', function () {
      toggleSelect(f.name, cb.checked);
    });
    pick.appendChild(cb);
    pick.addEventListener('click', function (e) { e.stopPropagation(); });
    fig.appendChild(pick);

    if (f.kind === 'image' || f.kind === 'video') {
      var open = document.createElement('button');
      open.type = 'button';
      open.className = 'card-open';
      open.setAttribute('aria-label', '预览 ' + f.name);
      open.addEventListener('click', function () { openLightbox(f.name); });
      fig.appendChild(open);
    }
    el.appendChild(fig);

    var info = document.createElement('div');
    info.className = 'card-info';
    var nm = document.createElement('div');
    nm.className = 'card-name';
    nm.textContent = f.name;
    nm.title = f.name;
    var meta = document.createElement('div');
    meta.className = 'card-meta';
    meta.textContent = fmtSize(f.size) + ' · ' + fmtDate(f.mtime_ns);
    info.appendChild(nm);
    info.appendChild(meta);
    el.appendChild(info);

    var acts = document.createElement('div');
    acts.className = 'card-acts';
    var dl = document.createElement('button');
    dl.className = 'btn ghost small';
    dl.textContent = '下载';
    dl.title = '下载并校验 SHA-256';
    dl.onclick = function () { downloadFile(f.name, dl); };
    var del = document.createElement('button');
    del.className = 'btn ghost small danger-text';
    del.textContent = '删除';
    del.onclick = function () { deleteFile(f.name); };
    acts.appendChild(dl);
    acts.appendChild(del);
    el.appendChild(acts);

    return {
      file: f, index: index, el: el, thumbUrl: null, loading: false
    };
  }

  function revokeCards() {
    Object.keys(cards).forEach(function (name) {
      var c = cards[name];
      if (c.thumbUrl) URL.revokeObjectURL(c.thumbUrl);
      c.thumbUrl = null;
      if (io) io.unobserve(c.el);
    });
    cards = {};
  }

  function clearGrid() {
    revokeCards();
    if (io) io.disconnect();
    var list = $('fileList');
    list.innerHTML = '';
  }

  function renderGrid() {
    clearGrid();
    var list = $('fileList');
    viewed = [];
    if (!files.length) {
      list.classList.add('empty');
      list.innerHTML = '<div class="list-empty">资料库为空。上传一张照片或一段视频试试。</div>';
      updateSelBar();
      return;
    }
    list.classList.remove('empty');
    var thumbIndex = 0;
    files.forEach(function (f) {
      if (f.kind === 'image' || f.kind === 'video') {
        thumbIndex += 1;
        viewed.push({ file: f, thumbIndex: thumbIndex, unpreviewable: null });
      }
      var idx = thumbIndex;    // stable-ish version key for preview URLs
      var card = buildCard(f, idx);
      cards[f.name] = card;
      list.appendChild(card.el);
      if (f.kind === 'image') {
        if (io) io.observe(card.el);
        else loadThumb(card);
      } else if (f.kind === 'video') {
        if (io) io.observe(card.el);
        else loadVideoStill(card);
      }
    });
    updateSelBar();
  }

  function countNote() {
    var nImg = 0, nVid = 0, nOther = 0;
    files.forEach(function (f) {
      if (f.kind === 'image') nImg++;
      else if (f.kind === 'video') nVid++;
      else nOther++;
    });
    var parts = [];
    if (nImg) parts.push(nImg + ' 张照片');
    if (nVid) parts.push(nVid + ' 段视频');
    if (nOther) parts.push(nOther + ' 个其他文件');
    return parts.length ? '共 ' + files.length + ' 项 · ' + parts.join(' · ') : '';
  }

  async function refresh() {
    try {
      var data = (await api('/api/list')).body;
      files = data.files || [];
      // Drop selections of files that no longer exist.
      var alive = {};
      files.forEach(function (f) { if (selected[f.name]) alive[f.name] = true; });
      selected = alive;
      $('libCount').textContent = countNote();
      renderGrid();
      // Keep an open lightbox in step with the new list.
      if (lb.state.open) relight();
    } catch (e) {
      log('刷新资料库失败：' + e.message, 'err');
    }
  }

  async function deleteFile(name) {
    if (!confirm('确定删除服务端文件「' + name + '」？')) return;
    if (lb.state.open && lb.state.name === name) closeLightbox();
    // The element (and its object URL) is about to go away with the refresh.
    var card = cards[name];
    if (card && card.thumbUrl) { URL.revokeObjectURL(card.thumbUrl); card.thumbUrl = null; }
    try {
      await api('/api/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name })
      });
      log('已删除 ' + name, 'warn');
      delete selected[name];
      await refresh();
    } catch (e) {
      log('删除失败：' + e.message, 'err');
    }
  }

  // ---- selection & batch download ----------------------------------------
  function toggleSelect(name, on) {
    if (on) selected[name] = true; else delete selected[name];
    var card = cards[name];
    if (card) {
      var cb = card.el.querySelector('.pick input');
      if (cb) cb.checked = !!on;
      card.el.classList.toggle('is-selected', !!on);
    }
    updateSelBar();
  }

  function selectedNames() {
    return files.filter(function (f) { return selected[f.name]; })
                .map(function (f) { return f.name; });
  }

  function updateSelBar() {
    var names = selectedNames();
    var n = names.length;
    var total = 0;
    var byName = {};
    files.forEach(function (f) { byName[f.name] = f.size; });
    names.forEach(function (nm) { total += byName[nm] || 0; });
    var bar = $('selBar');
    $('selText').textContent = n
      ? '已选 ' + n + ' 项 · 共 ' + fmtSize(total)
      : '未选中任何文件';
    bar.classList.toggle('hidden', n === 0);
    $('selDownloadBtn').disabled = n === 0;
    $('invertBtn').disabled = files.length === 0;
    $('selDownloadBtn').textContent = n > 1 ? '下载选中（' + n + '）' : '下载选中';
    var all = files.length > 0 && n === files.length;
    var sa = $('selectAll');
    sa.disabled = files.length === 0;
    sa.checked = all;
    sa.indeterminate = n > 0 && !all;
    syncSelBar();
  }

  // The bar lives in the library card; once the grid top has scrolled out of
  // view it pins itself to the bottom of the viewport (so batch actions are
  // always reachable), and it un-pins the moment the library comes back.
  var selPinned = false;
  function scrollY() { return window.pageYOffset || document.documentElement.scrollTop || 0; }
  function syncSelBar() {
    var on = selectedNames().length > 0;
    var libTop = $('libCard').getBoundingClientRect().top + scrollY();
    var pin = on && scrollY() > libTop + 8;
    if (pin !== selPinned) {
      selPinned = pin;
      $('selBar').classList.toggle('sel-pinned', pin);
    }
    document.body.classList.toggle('has-selbar', on && pin);
  }

  async function downloadSelected() {
    var names = selectedNames();
    if (!names.length) return;
    var btn = $('selDownloadBtn');
    if (busy) { log('已有传输在进行，请稍候', 'warn'); return; }
    btn.disabled = true;
    var okCount = 0, fail = [];
    var saved = btn.textContent;
    try {
      for (var i = 0; i < names.length; i++) {
        btn.textContent = '下载 ' + (i + 1) + '/' + names.length;
        var ok = await downloadFile(names[i], null);
        if (ok) okCount++; else fail.push(names[i]);
      }
    } finally {
      btn.textContent = saved;
      updateSelBar();
    }
    if (fail.length) {
      log('批量下载完成：' + okCount + ' 项已校验，' + fail.length + ' 项失败（' +
          fail.join('、') + '）', 'err');
    } else {
      log('批量下载完成：' + okCount + ' 项全部 SHA-256 校验通过（无损）', 'ok');
      // Clear the selection only if nothing was added meanwhile.
      selected = {};
      files.forEach(function (f) {
        var c = cards[f.name];
        if (c) c.el.classList.remove('is-selected');
        var cb = c && c.el.querySelector('.pick input');
        if (cb) cb.checked = false;
      });
      updateSelBar();
    }
  }

  // ---- lightbox -----------------------------------------------------------
  var lb = {
    state: { open: false, name: null, index: 0, seq: 0 },
    el: null,
    currentUrl: null,
    videoUrl: null
  };

  function lbEl(sel) { return lb.el.querySelector(sel); }

  function ensureLightbox() {
    if (lb.el) return;
    var tpl = $('lightboxTpl');
    var node = document.importNode(tpl.content, true);
    var root = node.querySelector('.lb');
    document.body.appendChild(node);
    lb.el = root;
    root.querySelector('[data-lb="bg"]').addEventListener('click', closeLightbox);
    root.querySelector('[data-lb="prev"]').addEventListener('click', function () { step(-1); });
    root.querySelector('[data-lb="next"]').addEventListener('click', function () { step(1); });
    root.querySelector('[data-lb="close"]').addEventListener('click', closeLightbox);
    root.querySelector('[data-lb="download"]').addEventListener('click', function () {
      if (lb.state.name) downloadFile(lb.state.name, this);
    });
    root.querySelector('.lb-video').addEventListener('error', function () {
      // Codec the browser cannot decode (e.g. HEVC in .mp4/.MOV).
      showLbFallback('这段视频的编码浏览器无法解码（如 HEVC），请下载后查看原片。');
    });
  }

  function showLbFallback(msg) {
    if (!lb.el) return;
    var fb = lbEl('.lb-fallback');
    fb.textContent = msg;
    fb.classList.remove('hidden');
    lbEl('.lb-img').classList.add('hidden');
    lbEl('.lb-video').classList.add('hidden');
  }

  // Release whichever object URLs the lightbox currently holds. Block blobs
  // pin the node's memory; look at your disk before downloading a 2 GB video.
  function releaseLbMedia() {
    lb.state.seq += 1;
    if (lb.currentUrl) { URL.revokeObjectURL(lb.currentUrl); lb.currentUrl = null; }
    if (lb.videoUrl) { URL.revokeObjectURL(lb.videoUrl); lb.videoUrl = null; }
    if (!lb.el) return;
    var v = lbEl('.lb-video');
    try { v.pause(); } catch (e) { /* ignore */ }
    v.removeAttribute('src');
    try { v.load(); } catch (e) { /* ignore */ }
    var img = lbEl('.lb-img');
    img.removeAttribute('src');
    img.classList.add('hidden');
    v.classList.add('hidden');
    lbEl('.lb-fallback').classList.add('hidden');
  }

  function openLightbox(name) {
    var i = viewed.findIndex(function (v) { return v.file.name === name; });
    if (i < 0) return;      // not previewable: the card offers download instead
    ensureLightbox();
    lb.state.open = true;
    lb.state.closingOnClose = false;
    document.body.classList.add('lb-open');
    lb.el.classList.add('open');
    showLightbox(i);
  }

  function relight() {
    if (!lb.state.open) return;
    var i = viewed.findIndex(function (v) { return v.file.name === lb.state.name; });
    closeLightbox();     // the file vanished from the library
    if (i < 0) return;
    openLightboxAt(i);
  }

  function openLightboxAt(i) {
    ensureLightbox();
    lb.state.open = true;
    document.body.classList.add('lb-open');
    lb.el.classList.add('open');
    showLightbox(i);
  }

  function step(delta) {
    if (!lb.state.open || viewed.length < 2) return;
    var i = (lb.state.index + delta + viewed.length) % viewed.length;
    showLightbox(i);
  }

  function showLightbox(i) {
    var entry = viewed[i];
    if (!entry) return;
    var f = entry.file;
    releaseLbMedia();
    lb.state.name = f.name;
    lb.state.index = i;
    var seq = lb.state.seq;

    lbEl('.lb-name').textContent = f.name;
    lbEl('.lb-sub').textContent = (i + 1) + ' / ' + viewed.length + ' · ' +
      fmtSize(f.size) + ' · ' + fmtDate(f.mtime_ns);
    lbEl('.lb-prev').classList.toggle('hidden', viewed.length < 2);
    lbEl('.lb-next').classList.toggle('hidden', viewed.length < 2);
    lbEl('.lb-video').classList.add('hidden');
    lbEl('.lb-img').classList.add('hidden');
    lbEl('.lb-fallback').classList.add('hidden');

    if (entry.unpreviewable) { showLbFallback(entry.unpreviewable); return; }

    if (f.kind === 'image') {
      var img = lbEl('.lb-img');
      img.classList.remove('hidden');
      img.alt = f.name;
      fetchPreviewBlob(f, entry.thumbIndex).then(function (blob) {
        if (seq !== lb.state.seq) return;
        lbEl('.lb-img').closest('.lb').classList.remove('lb-loading');
        lb.currentUrl = URL.createObjectURL(blob);
        img.src = lb.currentUrl;
      }).catch(function (e) {
        if (seq !== lb.state.seq) return;
        lbEl('.lb').classList.remove('lb-loading');
        if (e && e.status === 415) {
          entry.unpreviewable = e.message;
          showLbFallback(e.message);
        } else {
          showLbFallback('预览加载失败：' + e.message + '（可直接下载并校验）');
        }
      });
      return;
    }

    // video
    var v = lbEl('.lb-video');
    v.classList.remove('hidden');
    var src = previewPath(f, entry.thumbIndex);
    if (typeof MediaSource === 'function' && window.MediaSource) {
      // Normal case (HTTP/1.1 / range support): the element streams and
      // seeks straight from the server through a 206-aware request. The
      // media element cannot set headers, so the token travels as `t`.
      v.src = src + tokenQuery();
      v.play().catch(function () { /* autoplay policies: user can press play */ });
    } else {
      // Older browsers without MediaSource: fetch the whole file with the
      // token header, then play the blob (no seeking until it is complete).
      fetchPreviewBlob(f, entry.thumbIndex).then(function (blob) {
        if (seq !== lb.state.seq) return;
        lb.videoUrl = URL.createObjectURL(blob);
        v.src = lb.videoUrl;
        v.play().catch(function () { /* ignore */ });
      }).catch(function (e) {
        if (seq !== lb.state.seq) return;
        if (e && e.status === 415) { entry.unpreviewable = e.message; showLbFallback(e.message); }
        else showLbFallback('视频加载失败：' + e.message);
      });
    }
  }

  function closeLightbox() {
    if (!lb.state.open) return;
    lb.state.open = false;
    releaseLbMedia();
    if (lb.el) lb.el.classList.remove('open', 'lb-loading');
    document.body.classList.remove('lb-open');
  }

  function lbIsOpen() { return !!lb.state.open; }

  document.addEventListener('keydown', function (e) {
    if (!lbIsOpen()) return;
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  });

  // Swipe left/right on touch devices (images only: never steal a seek drag
  // from the native video controls).
  (function () {
    var x0 = null, y0 = null;
    document.addEventListener('touchstart', function (e) {
      if (!lbIsOpen() || e.touches.length !== 1) { x0 = null; return; }
      if (e.target.closest && e.target.closest('video')) { x0 = null; return; }
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
    }, { passive: true });
    document.addEventListener('touchend', function (e) {
      if (x0 === null || !lbIsOpen()) return;
      var dx = e.changedTouches[0].clientX - x0;
      var dy = e.changedTouches[0].clientY - y0;
      x0 = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        step(dx < 0 ? 1 : -1);
      }
    }, { passive: true });
  })();

  // Leaving the page: free every blob the grid and the lightbox created.
  window.addEventListener('pagehide', function () {
    abortPreviews();
    revokeCards();
    releaseLbMedia();
  });

  // ---- wiring -------------------------------------------------------------
  $('token').value = token;
  $('connectBtn').onclick = connect;
  $('token').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') connect();
  });
  $('refreshBtn').onclick = refresh;
  $('selectAll').addEventListener('change', function (e) {
    var on = e.target.checked;
    files.forEach(function (f) { toggleSelect(f.name, on); });
  });
  $('invertBtn').onclick = function () {
    files.forEach(function (f) { toggleSelect(f.name, !selected[f.name]); });
  };
  $('selClearBtn').onclick = function () {
    files.forEach(function (f) { toggleSelect(f.name, false); });
  };
  $('selDownloadBtn').onclick = downloadSelected;
  $('logClearBtn').onclick = function () { $('logBox').innerHTML = ''; };
  $('fileInput').onchange = function (e) {
    uploadFiles(Array.prototype.slice.call(e.target.files));
    e.target.value = '';
  };
  var drop = $('drop');
  ['dragenter', 'dragover'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('hover'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('hover'); });
  });
  drop.addEventListener('drop', function (e) {
    uploadFiles(Array.prototype.slice.call(e.dataTransfer.files));
  });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });
  var scrollPending = false;
  function onScrollOrResize() {
    if (scrollPending) return;
    scrollPending = true;
    (window.requestAnimationFrame || setTimeout)(function () {
      scrollPending = false;
      syncSelBar();
    });
  }
  window.addEventListener('scroll', onScrollOrResize, { passive: true });
  window.addEventListener('resize', onScrollOrResize);

  // Bootstrap: always probe /api/info. In open mode this connects with no
  // input at all; in token mode a 401 triggers the token form instead.
  log('页面就绪，正在连接…', '');
  connect();
})();
