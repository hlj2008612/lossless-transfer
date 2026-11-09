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
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var token = sessionStorage.getItem('lt_token') || '';
  var tokenRequired = true;
  var serverChunk = 0;
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
    box.scrollTop = box.scrollHeight;
  }

  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KiB';
    if (n < 1073741824) return (n / 1048576).toFixed(2) + ' MiB';
    return (n / 1073741824).toFixed(2) + ' GiB';
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
      $('connInfo').innerHTML =
        '服务：<b>' + info.service + ' ' + info.version + '</b><br>' +
        '分块大小：<b>' + fmtSize(info.chunk_size) + '</b>（' + info.chunk_size + ' 字节）<br>' +
        '鉴权：<b>' + (tokenRequired ? 'X-LT-Token' : '开放模式（无需令牌）') + '</b>　' +
        '协议版本：<b>' + info.protocol + '</b>';
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
      hash: function (text) { row.querySelector('.hash').textContent = text; }
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
  async function downloadFile(name, btn) {
    if (busy) { log('已有传输在进行，请稍候', 'warn'); return; }
    busy = true;
    if (btn) btn.disabled = true;
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
    } catch (e) {
      log('下载失败 ' + name + '：' + e.message, 'err');
    } finally {
      busy = false;
      if (btn) { btn.disabled = false; btn.textContent = '下载并校验'; }
    }
  }

  // ---- library ------------------------------------------------------------
  async function refresh() {
    try {
      var data = (await api('/api/list')).body;
      var list = $('fileList');
      list.innerHTML = '';
      if (!data.files.length) {
        list.innerHTML = '<div class="list-empty">资料库为空。上传一张照片或一段视频试试。</div>';
        return;
      }
      data.files.forEach(function (f) {
        var row = document.createElement('div');
        row.className = 'file-row';
        var head = document.createElement('div');
        head.className = 'file-head';
        var left = document.createElement('div');
        left.innerHTML = '<div class="file-name"></div><div class="file-meta"></div>';
        left.querySelector('.file-name').textContent = f.name;
        left.querySelector('.file-meta').textContent =
          fmtSize(f.size) + ' · ' + new Date(f.mtime_ns / 1e6).toLocaleString('zh-CN');
        var actions = document.createElement('div');
        actions.className = 'row';
        var dl = document.createElement('button');
        dl.className = 'btn primary'; dl.textContent = '下载并校验';
        dl.onclick = function () { downloadFile(f.name, dl); };
        var del = document.createElement('button');
        del.className = 'btn danger'; del.textContent = '删除';
        del.onclick = function () { deleteFile(f.name); };
        actions.appendChild(dl); actions.appendChild(del);
        head.appendChild(left); head.appendChild(actions);
        row.appendChild(head);
        list.appendChild(row);
      });
    } catch (e) {
      log('刷新资料库失败：' + e.message, 'err');
    }
  }

  async function deleteFile(name) {
    if (!confirm('确定删除服务端文件「' + name + '」？')) return;
    try {
      await api('/api/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name })
      });
      log('已删除 ' + name, 'warn');
      await refresh();
    } catch (e) {
      log('删除失败：' + e.message, 'err');
    }
  }

  // ---- wiring -------------------------------------------------------------
  $('token').value = token;
  $('connectBtn').onclick = connect;
  $('token').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') connect();
  });  $('refreshBtn').onclick = refresh;
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

  // Bootstrap: always probe /api/info. In open mode this connects with no
  // input at all; in token mode a 401 triggers the token form instead.
  log('页面就绪，正在连接…', '');
  connect();
})();
