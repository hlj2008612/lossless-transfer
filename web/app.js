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

  // Two pages share this script: the home page (connect / upload / log) and the
  // photo-wall gallery. Every piece of wiring is guarded by page, so neither
  // page ever touches an element that only the other one has.
  var PAGE = document.body.getAttribute('data-page') || 'home';
  var isGallery = PAGE === 'gallery';

  // localStorage (not just sessionStorage) so the token follows you from the
  // home page into the gallery; sessionStorage stays as the fallback for a
  // token saved by an older build of this file.
  var token = localStorage.getItem('lt_token') ||
              sessionStorage.getItem('lt_token') || '';
  var tokenRequired = true;
  var serverChunk = 0;
  var mediaToken = '';      // header-less media use this instead of X-LT-Token
  var serverPil = false;    // /api/image can render display copies server-side
  var busy = false;

  // ---- logging ------------------------------------------------------------
  // The home page owns the log panel. The gallery has no panel: it surfaces the
  // same messages as a transient toast instead, so nothing is lost off-screen.
  var toastTimer = 0;
  function toast(msg, cls) {
    if (!isGallery) return;
    var el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast ' + (cls || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast hidden'; }, 4200);
  }

  function log(msg, cls) {
    var box = $('logBox');
    if (!box) {
      if (cls) toast(msg, cls);
      return;
    }
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

  // One formatter for the whole page: toLocaleString() allocates a fresh
  // Intl.DateTimeFormat per call, which adds up over a few hundred cards. The
  // numeric layout is also what fits a card footer without wrapping.
  var dateFmt = null;
  try {
    if (typeof Intl === 'object' && Intl.DateTimeFormat) {
      dateFmt = new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
      });
    }
  } catch (e) { dateFmt = null; }

  function fmtDate(ns) {
    var d = new Date(Number(ns) / 1e6);
    if (isNaN(d.getTime())) return '';
    try {
      return dateFmt ? dateFmt.format(d) : d.toLocaleString('zh-CN');
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
  function setBadge(text, on) {
    var b = $('connBadge');
    if (!b) return;
    b.className = 'badge ' + (on ? 'badge-on' : 'badge-off');
    b.textContent = text;
  }

  async function connect() {
    token = (($('token') && $('token').value.trim()) || token);
    var info;
    try {
      info = (await api('/api/info')).body;
      serverChunk = info.chunk_size;
      mediaToken = info.media_token || '';
      tokenRequired = info.token_required !== false;
      serverPil = info.preview_pipeline === true;
    } catch (e) {
      // 401 means the server does require a token: show the input and stop.
      if (e.status === 401) {
        if (isGallery) {
          toast('需要 ACCESS TOKEN：请先回到首页输入令牌', 'err');
          return;
        }
        showTokenInput();
        log('需要 ACCESS TOKEN：请输入服务端启动时打印的令牌。', 'err');
        return;
      }
      setBadge('未连接', false);
      log('连接失败：' + e.message, 'err');
      return;
    }
    if (tokenRequired) {
      if (!token) {
        if (isGallery) { toast('需要 ACCESS TOKEN：请先回到首页输入令牌', 'err'); return; }
        showTokenInput();
        log('请先输入 ACCESS TOKEN', 'err');
        return;
      }
      sessionStorage.setItem('lt_token', token);
      localStorage.setItem('lt_token', token);
    } else {
      // Open mode: nothing to type, so hide the connection card entirely.
      hideTokenInput();
    }
    try {
      setBadge('已连接 v' + info.version, true);
      // Built as elements, never HTML strings: file names and server strings
      // are untrusted text and must not be able to inject markup.
      var infoRows = [
        ['服务', info.service + ' ' + info.version],
        ['分块大小', fmtSize(info.chunk_size) + '（' + info.chunk_size + ' 字节）'],
        ['鉴权', tokenRequired ? 'X-LT-Token' : '开放模式（无需令牌）'],
        ['协议版本', String(info.protocol)]
      ];
      var box = $('connInfo');
      if (box) {
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
      }
      var ws = $('workspace');
      if (ws) ws.classList.remove('hidden');
      // On the wall page the badge already says "已连接"; a toast on every load
      // would just sit on top of the photos.
      if (!isGallery) log('连接成功，服务端 chunk_size=' + serverChunk, 'ok');      if (!tokenRequired && !isGallery) {
        log('该共享文件夹为开放模式：任何人打开此地址均可上传/下载/删除。', 'warn');
      }
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
  // Every preview byte comes from GET /api/thumb or /api/preview with the
  // X-LT-Token header, so no file ever needs to be in the static whitelist.
  var PREVIEW_CONCURRENCY = 4;   // preview requests at once: gentle on a tunnel
  var PREVIEW_IDLE_MS = 25000;   // abort only when the stream stops moving
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

  // `index` is a hint the server validates but never uses to pick a file, and
  // `v` (size-mtime) changes whenever the stored bytes change, so a cached
  // preview can never be shown for a different version of the same name.
  function versionQuery(f) { return '&v=' + f.size + '-' + f.mtime_ns; }
  function previewPath(f, index) {
    return '/api/preview?name=' + qs(f.name) + '&index=' + (index || 0) +
           versionQuery(f);
  }
  function thumbPath(f) {
    return '/api/thumb?name=' + qs(f.name) + versionQuery(f);
  }
  // A display copy the server renders at the size the screen needs (longest
  // edge `w`). The camera thumbnail is only 160x120; this is what keeps a card
  // sharp when it is 350-700 CSS px wide.
  function imagePath(f, w) {
    return '/api/image?name=' + qs(f.name) + '&w=' + w + versionQuery(f);
  }

  // Read the response body, bounded by Content-Length. fetch() already frames
  // HTTP/1.1 keep-alive responses, and honouring the declared length on top of
  // that keeps this correct whatever the transport does.
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

  // One GET -> Blob. A non-2xx answer becomes an Error carrying .status plus
  // the server's message, so callers can tell 415 (nothing to preview) from
  // 401 (token) and from a transport failure.
  async function fetchBlob(path, headers, onProgress, signal) {
    var res = await fetch(path, { headers: headers, signal: signal });
    if (!res.ok) {
      var msg = 'HTTP ' + res.status;
      try { msg = (await res.json()).error || msg; } catch (e) { /* not JSON */ }
      var err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    var bytes = await readPreviewBytes(res, onProgress);
    return new Blob([bytes], { type: res.headers.get('Content-Type') || '' });
  }

  // The camera's own EXIF thumbnail (~10-30 KB, always a complete JPEG). This
  // is the fast path for every camera/phone photo: one tiny request instead of
  // pulling a 10 MB original over the tunnel. null = no embedded thumbnail.
  //
  // It comes back with `orient` (EXIF 0x0112 of the main file): the thumbnail
  // is a bare JPEG with no EXIF of its own, so a photo shot in portrait would
  // otherwise sit sideways in the grid while the full image - which the
  // browser turns using the main file's tag - looks right.
  async function fetchThumbBlob(f) {
    await takePreviewSlot();
    try {
      var res = await fetch(thumbPath(f), { headers: { 'X-LT-Token': token } });
      if (!res.ok) {
        try { res.body && res.body.cancel(); } catch (e) { /* ignore */ }
        return null;
      }
      var bytes = await readPreviewBytes(res);
      if (!bytes.length) return null;
      var orient = parseInt(res.headers.get('X-Thumb-Orientation') || '1', 10);
      return {
        blob: new Blob([bytes], { type: 'image/jpeg' }),
        orient: (orient >= 2 && orient <= 8) ? orient : 1
      };
    } catch (e) {
      return null;
    } finally {
      releasePreviewSlot();
    }
  }

  // A truncated JPEG renders its WHOLE frame only when it is progressive
  // (SOF2). A truncated baseline JPEG (SOF0/1) - and a truncated PNG, whose
  // rows come top-down - paints just the top band, which reads as a broken
  // picture, so those need the complete file before they may be shown.
  function fillsFrameFromPrefix(bytes) {
    var pos = 2;                                  // past SOI (checked by SOF0)
    while (pos + 4 <= bytes.length) {
      if (bytes[pos] !== 0xFF) return false;
      var m = bytes[pos + 1];
      if (m === 0xFF) { pos += 1; continue; }
      if (m === 0x01 || (m >= 0xD0 && m <= 0xD9)) { pos += 2; continue; }
      if (m === 0xDA) return false;               // scan started, no SOF2 found
      var len = (bytes[pos + 2] << 8) | bytes[pos + 3];
      if (len < 2) return false;
      if (m === 0xC2) return true;                // progressive JPEG
      if (m === 0xC0 || m === 0xC1) return false; // baseline / extended
      pos += 2 + len;
    }
    return false;
  }

  // First `want` bytes of the file. `complete` means the server capped the
  // range at the file's real size, i.e. these bytes ARE the whole file.
  async function fetchPrefix(f, index, want) {
    await takePreviewSlot();
    try {
      var blob = await fetchBlob(previewPath(f, index), {
        'X-LT-Token': token, 'Range': 'bytes=0-' + (want - 1)
      });
      var complete = blob.size < want;
      var partialOk = false;
      if (!complete) {
        var head = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
        partialOk = fillsFrameFromPrefix(head);
      }
      return { blob: blob, complete: complete, partialOk: partialOk };
    } catch (e) {
      if (e && e.status) return { blob: null, status: e.status };
      return null;
    } finally {
      releasePreviewSlot();
    }
  }

  // Full (Range-less) preview blob with progress - used by the lightbox for
  // images and, where MediaSource is missing (plain HTTP), for videos.
  // The timeout is idle-based: as long as bytes keep arriving a 10 MB photo on
  // a slow tunnel is allowed to finish (a fixed 30 s cap used to abort it and
  // leave the card stuck in its loading state).
  function fetchPreviewBlob(f, index, onProgress) {
    var key = f.name + '#' + index;
    var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    previewControllers[key] = ctrl;
    var timer = 0;
    function arm() {
      clearTimeout(timer);
      timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, PREVIEW_IDLE_MS);
    }
    function done() {
      clearTimeout(timer);
      delete previewControllers[key];
    }
    return takePreviewSlot().then(function () {
      arm();                      // start counting only once the request runs
      return fetchBlob(previewPath(f, index), { 'X-LT-Token': token },
        function (got, total) {
          arm();
          if (onProgress) onProgress(got, total);
        },
        ctrl ? ctrl.signal : undefined);
    }).then(function (blob) {
      done(); releasePreviewSlot();
      return blob;
    }, function (e) {
      done(); releasePreviewSlot();
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
    var v = card.poster || card.el.querySelector('.card-poster');
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
        // A clip is usually 16:9, not the 3:4 stand-in the column maths used;
        // adopt the real size now that metadata has arrived.
        if (v.videoWidth && v.videoHeight) {
          var vfig = card.fig || card.el.querySelector('.card-fig');
          if (vfig) vfig.style.aspectRatio = (v.videoWidth / v.videoHeight);
        }
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

  function thumbFail(card, status, note) {
    card.el.classList.remove('is-loading');
    if (card.thumbOk) return;             // something is already on screen
    var unpreviewable = status === 415;
    // Only a format the browser cannot render gets the hatched "no preview"
    // surface; "too big to fetch for a card / undecodable" just keeps the
    // quiet placeholder with its explanation.
    if (unpreviewable) card.el.classList.add('thumb-unsupported');
    var kindEl = card.el.querySelector('.card-ph-kind');
    if (kindEl) kindEl.textContent = note || '无法预览';
    // 415 = the server will not hand out these bytes in a form a browser can
    // render (CR3/NEF/RAW...): no point retrying in the lightbox either.
    if (unpreviewable) {
      markNoPreview(card.file.name, '此格式浏览器无法预览，请下载查看');
    }
  }

  function markNoPreview(name, reason) {
    var entry = viewed.find(function (v) { return v.file.name === name; });
    if (entry) entry.unpreviewable = reason;
    var card = cards[name];
    if (card) {
      card.unpreviewable = reason;
      card.el.classList.add('thumb-unsupported');
    }
  }

  // Every card keeps its own aspect ratio - that is what makes the wall read as
  // photos instead of uniform tiles. The EXIF thumbnail is a scaled copy of the
  // full frame, so its natural size is the true ratio of the stored pixels; for
  // a 90/270 transfer (orient 5-8) the stored frame lies sideways and the box
  // ratio must be swapped so the CSS rotation lands exactly in the box.
  function applyCardAspect(card, w, h) {
    if (!w || !h) return;
    var fig = card.fig || card.el.querySelector('.card-fig');
    if (!fig) return;
    var ratio = (card.orient >= 5) ? (h / w) : (w / h);
    // A corrupt thumbnail tag can claim an absurd size; clamping keeps one card
    // from turning a column into a tower.
    ratio = Math.min(Math.max(ratio, 0.25), 4);
    fig.style.aspectRatio = ratio;
    // 90/270 turns need to grow by 1/boxRatio to cover the box again
    card.el.style.setProperty('--rot', (1 / ratio).toFixed(4));
  }

  // Put a blob on the card's <img> and let the browser's decoder be the judge:
  // when these bytes cannot be rendered the card keeps its placeholder and the
  // caller tries a larger slice. Resolves true only when something was shown.
  // `orient` is the EXIF orientation to apply - only the embedded thumbnail
  // needs it; a full file carries its own tag and the browser turns it.
  function showOnCard(card, blob, orient) {
    var img = card.img || card.el.querySelector('.card-thumb');
    if (!img) return Promise.resolve(false);
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(blob);
      function done(ok) {
        img.onload = null;
        img.onerror = null;
        if (!ok) { URL.revokeObjectURL(url); resolve(false); return; }
        if (card.thumbUrl) URL.revokeObjectURL(card.thumbUrl);
        card.thumbUrl = url;
        card.thumbOk = true;
        card.orient = (orient >= 2 && orient <= 8) ? orient : 1;
        if (card.orient > 1) card.el.setAttribute('data-orient', card.orient);
        else card.el.removeAttribute('data-orient');
        applyCardAspect(card, img.naturalWidth, img.naturalHeight);
        card.el.classList.remove('is-loading', 'thumb-unsupported');
        card.el.classList.add('thumb-loaded');
        resolve(true);
      }
      img.onload = function () { done(img.naturalWidth > 0); };
      img.onerror = function () { done(false); };
      img.src = url;
    });
  }

  // Thumbnail strategy, cheapest first:
  //   1. the camera's embedded EXIF thumbnail - one ~20 KB request, and always
  //      a complete JPEG (covers nearly every camera/phone photo);
  //   2. a prefix of the file (256 KiB, 1 MiB, 3 MiB), shown only when the
  //      format fills the frame from partial data (progressive JPEG);
  //   3. the whole file, streamed - for everything else, and never for a big
  //      one (a card must not pull 40 MB; it says "点开查看" and the lightbox
  //      does that work on demand).
  var PREFIX_STEPS = [262144, 1048576, 3145728];
  var THUMB_FULL_MAX = 8 << 20;

  // Server-rendered display copy sized for this card at the screen's own pixel
  // density (a 358 px card on a 2x screen asks for 720 px), so nothing is ever
  // upscaled. null = no pipeline on this server, or this file cannot be
  // decoded, in which case the caller keeps the EXIF-thumbnail behaviour.
  async function fetchRendered(card, f) {
    var fig = card.fig || card.el.querySelector('.card-fig');
    var cw = (fig && fig.clientWidth) || 320;
    var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    // Quantise to 40 px steps: fewer distinct renders, better cache reuse
    // across cards of slightly different widths.
    var want = Math.round(cw * dpr / 40) * 40;
    want = Math.min(1080, Math.max(320, want));
    await takePreviewSlot();
    try {
      return await fetchBlob(imagePath(f, want), { 'X-LT-Token': token });
    } catch (e) {
      if (e && e.status === 501) serverPil = false;   // server has no Pillow
      return null;
    } finally {
      releasePreviewSlot();
    }
  }

  async function loadThumb(card) {
    if (card.loading || card.thumbOk) return;
    card.loading = true;
    var f = card.file;
    var index = card.index;
    try {
      // Sharpest path first when the server can render: one request, no
      // upscaling. Falls through to the camera thumbnail when it cannot.
      if (serverPil) {
        var rendered = await fetchRendered(card, f);
        // The render is already upright (EXIF applied server-side), so the
        // client must not rotate it a second time.
        if (rendered && await showOnCard(card, rendered, 1)) return;
      }
      var small = await fetchThumbBlob(f);
      if (small && await showOnCard(card, small.blob, small.orient)) return;

      for (var i = 0; i < PREFIX_STEPS.length; i++) {
        var head = await fetchPrefix(f, index, PREFIX_STEPS[i]);
        if (!head || !head.blob) return thumbFail(card, head && head.status);
        // Complete data is definitive: it renders or the file cannot be shown.
        if (head.complete) {
          if (await showOnCard(card, head.blob)) return;
          return thumbFail(card, head.status, '无法解码');
        }
        if (head.partialOk && await showOnCard(card, head.blob)) return;
      }
      if (f.size > THUMB_FULL_MAX) return thumbFail(card, 0, '点开查看');

      var whole = await fetchPreviewBlob(f, index);
      if (whole && await showOnCard(card, whole)) return;
      thumbFail(card);
    } catch (e) {
      // Includes the idle-timeout abort: a card must never stay pulsing.
      thumbFail(card, e && e.status);
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
    // Kept on the card record: the thumbnail/poster code touches these on every
    // load, and re-querying the subtree each time is needless work.
    var imgEl = null;
    var posterEl = null;

    if (f.kind === 'image') {
      var img = document.createElement('img');
      img.className = 'card-thumb';
      img.alt = f.name;
      img.decoding = 'async';
      img.draggable = false;
      imgEl = img;
      fig.appendChild(img);
      // Placeholder under the picture: it pulses while the thumbnail is on its
      // way and carries the reason if the image can never be shown.
      var ph = document.createElement('div');
      ph.className = 'card-ph';
      ph.innerHTML = '<span class="card-ph-icon">▣</span>' +
        '<span class="card-ph-kind">照片</span>';
      fig.appendChild(ph);
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
      posterEl = poster;
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
      file: f, index: index, el: el, fig: fig, img: imgEl, poster: posterEl,
      thumbUrl: null, thumbOk: false, loading: false
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
    if (list) list.innerHTML = '';
    wallCols = [];
  }

  // ---- photo wall (masonry) ----------------------------------------------
  // Column count follows the same seven steps the reference site uses, so the
  // wall keeps its density at every width instead of drifting with a linear
  // formula (the gaps between steps are uneven on purpose).
  function columnCount() {
    var w = window.innerWidth;
    if (w >= 1900) return 8;
    if (w >= 1680) return 7;
    if (w >= 1500) return 6;
    if (w >= 1280) return 5;
    if (w >= 1024) return 4;
    if (w >= 768) return 3;
    return 2;
  }

  var wallCols = [];
  var lastColCount = 0;

  function buildColumns(list) {
    list.innerHTML = '';
    wallCols = [];
    // A handful of photos must not be spread over eight empty columns: the
    // count shrinks to the number of items (never below one), and the CSS caps
    // each column's width so a two-photo wall reads as a neat centred pair
    // instead of two huge slabs.
    var n = Math.min(columnCount(), Math.max(1, files.length));
    for (var i = 0; i < n; i++) {
      var col = document.createElement('div');
      col.className = 'wall-col';
      list.appendChild(col);
      wallCols.push(col);
    }
    lastColCount = n;
    return wallCols;
  }

  // Rough height of a card at this column width. It only decides WHICH column a
  // card goes into; the exact height arrives with the thumbnail and the card
  // simply grows in place, which is what a waterfall is supposed to do.
  // `colWidth` is passed in (not read per card) so laying out 100 files does
  // not force 100 layout flushes just to measure an unchanged width.
  function estimateHeight(f, colWidth) {
    var cw = colWidth || 260;
    var ratio = (f.kind === 'video') ? (16 / 9) : (3 / 4);
    return cw / ratio + 96;
  }

  function shortest(heights) {
    var target = 0;
    for (var i = 1; i < heights.length; i++) {
      if (heights[i] < heights[target]) target = i;
    }
    return target;
  }

  function renderGrid() {
    if (!isGallery) return;          // the home page keeps only a summary
    clearGrid();
    var list = $('fileList');
    if (!list) return;
    viewed = [];
    if (!files.length) {
      list.classList.add('empty');
      list.innerHTML = '<div class="list-empty">资料库还是空的<br>回到首页上传第一张照片吧</div>';
      updateSelBar();
      return;
    }
    list.classList.remove('empty');
    var cols = buildColumns(list);
    var heights = cols.map(function () { return 0; });
    // one measurement for the whole wall: every column is equally wide
    var colWidth = (cols[0] && cols[0].clientWidth) || 260;
    var thumbIndex = 0;
    var order = 0;
    files.forEach(function (f) {
      if (f.kind === 'image' || f.kind === 'video') {
        thumbIndex += 1;
        viewed.push({ file: f, thumbIndex: thumbIndex, unpreviewable: null });
      }
      var idx = thumbIndex;    // stable-ish version key for preview URLs
      var card = buildCard(f, idx);
      cards[f.name] = card;
      // staggered entrance, capped so a big library is not a 30-second show
      card.el.style.setProperty('--d', Math.min(order, 18) * 30 + 'ms');
      var target = shortest(heights);
      cols[target].appendChild(card.el);
      heights[target] += estimateHeight(f, colWidth);
      order += 1;
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

  // Crossing a column breakpoint re-deals the existing cards. The <img> blobs
  // stay attached to their elements, so this never refetches a preview.
  function relayoutWall() {
    if (!isGallery || !files.length) return;
    var want = Math.min(columnCount(), Math.max(1, files.length));
    if (want === lastColCount) return;
    var list = $('fileList');
    if (!list) return;
    // Measure BEFORE the columns are rebuilt: buildColumns() empties the list,
    // and a detached element reports offsetHeight 0, which used to make every
    // re-deal fall back to the 3:4 estimate.
    var measured = {};
    files.forEach(function (f) {
      var c = cards[f.name];
      measured[f.name] = c ? c.el.offsetHeight : 0;
    });
    var cols = buildColumns(list);
    var heights = cols.map(function () { return 0; });
    var colWidth = (cols[0] && cols[0].clientWidth) || 260;
    files.forEach(function (f) {
      var card = cards[f.name];
      if (!card) return;
      var target = shortest(heights);
      cols[target].appendChild(card.el);
      heights[target] += (measured[f.name] || estimateHeight(f, colWidth));
    });
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
      var count = $('libCount');
      if (count) count.textContent = countNote();
      var empty = $('libEmpty');
      if (empty) empty.classList.toggle('hidden', files.length > 0);
      var pill = $('libPill');
      if (pill) {
        pill.textContent = files.length ? files.length + ' 项' : '';
        pill.classList.toggle('hidden', !files.length);
      }
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
    if (!isGallery) return;          // selection lives on the photo wall only
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

  // On the wall page the bar is always docked to the viewport (see
  // gallery.css), so there is no pin/unpin dance: it just appears while
  // something is selected and reserves room at the bottom of the page.
  function syncSelBar() {
    if (!isGallery) return;
    var on = selectedNames().length > 0;
    document.body.classList.toggle('has-selbar', on);
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
    img.removeAttribute('data-orient');
    img.classList.remove('lb-blur');
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
      var root = lb.el;
      var sub = lbEl('.lb-sub');
      var subText = sub.textContent;
      img.classList.remove('hidden');
      img.alt = f.name;
      img.classList.remove('lb-blur');
      img.removeAttribute('data-orient');
      // Show what the grid already decoded (usually the 20 KB EXIF thumbnail)
      // so the stage is never blank, then swap in the full-resolution bytes.
      // A thumbnail stored sideways (orientation 6/8) would have to be laid
      // out rotated inside a contain-sized box, so those just get the spinner.
      var card = cards[f.name];
      var orient = (card && card.orient) || 1;
      if (card && card.thumbUrl && orient <= 4) {
        img.src = card.thumbUrl;
        if (orient > 1) img.setAttribute('data-orient', orient);
        img.classList.add('lb-blur');
      } else {
        root.classList.add('lb-loading');
      }
      // 1600 px is sharper than any screen this lands on and costs ~200 KB
      // instead of the original's 10 MB; without a server pipeline the original
      // is streamed exactly as before.
      var big = serverPil
        ? fetchBlob(imagePath(f, 1600), { 'X-LT-Token': token })
        : fetchPreviewBlob(f, entry.thumbIndex, function (got, total) {
            if (seq !== lb.state.seq || !total) return;
            sub.textContent = subText + ' · 载入 ' +
              Math.floor(got / total * 100) + '%';
          });
      big.then(function (blob) {
        if (seq !== lb.state.seq) return;
        root.classList.remove('lb-loading');
        sub.textContent = subText;
        img.classList.remove('lb-blur');
        img.removeAttribute('data-orient');
        lb.currentUrl = URL.createObjectURL(blob);
        img.src = lb.currentUrl;
      }).catch(function (e) {
        if (seq !== lb.state.seq) return;
        root.classList.remove('lb-loading');
        sub.textContent = subText;
        img.classList.remove('lb-blur');
        img.removeAttribute('data-orient');
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
  if (isGallery) {
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
    // No scroll handler: the bar is position:fixed and the selection only
    // changes on user input, so recomputing on every scroll event was pure
    // O(files) work per frame while flicking through a large wall.
    var relayoutPending = false;
    window.addEventListener('resize', function () {
      if (relayoutPending) return;
      relayoutPending = true;
      (window.requestAnimationFrame || setTimeout)(function () {
        relayoutPending = false;
        relayoutWall();
      });
    });
  } else {
    $('token').value = token;
    $('connectBtn').onclick = connect;
    $('token').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') connect();
    });
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
  }

  // Bootstrap: always probe /api/info. In open mode this connects with no
  // input at all; in token mode a 401 triggers the token form instead.
  log('页面就绪，正在连接…', '');
  connect();
})();
