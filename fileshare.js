/* 📎 ファイル共有（手書きメモ・英文リーダー 共通）
   ・ファイルの中身は Google ドライブ（ご自分の Apps Script 経由）、名前などの一覧は Firebase（合言葉ごと）
   ・送る：2MB ずつに分けて送る（大きな動画も可。目安 100MB まで）
   ・受け取る：3MB ずつ受け取って、その端末で開く・保存する。iPad 2/3 は「リンクで開く」（Safari で表示）
   ・iOS 9（iPad 2/3）でも動くよう ES5 だけで書いています */
(function () {
  'use strict';
  var UP = 8 * 1024 * 1024, ONE = 8 * 1024 * 1024, MAX = 100 * 1024 * 1024;   // 送るのは 8MB ずつ（256KB の倍数）。8MB までは1回で
  var oldIOS = /OS [5-9]_\d.* like Mac OS X/.test(navigator.userAgent);
  var opt = null, ov = null, files = {}, timer = null, upBusy = false, got = {}, jsonpN = 0;

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; }
  function each(a, f) { for (var i = 0; i < a.length; i++) f(a[i], i); }
  function now() { return new Date().getTime(); }
  function fmtSize(n) { n = Number(n) || 0; return n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtTime(t) {
    if (!t) return '';
    var d = new Date(t), n = new Date(), hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    return d.toDateString() === n.toDateString() ? '今日 ' + hm : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  }
  function devName() {
    var u = navigator.userAgent;
    if (/iPad/.test(u) || (/Macintosh/.test(u) && navigator.maxTouchPoints > 1)) return 'iPad';
    if (/iPhone/.test(u)) return 'iPhone';
    if (/Android/.test(u)) return 'Android';
    return 'パソコン';
  }
  function icon(type, name) {
    var t = (type || '') + ' ' + (name || '').toLowerCase();
    if (/video|\.mp4|\.mov|\.m4v/.test(t)) return '🎬';
    if (/image|\.jpe?g|\.png|\.heic|\.gif/.test(t)) return '🖼';
    if (/pdf/.test(t)) return '📕';
    if (/sheet|excel|\.xlsx?|\.csv/.test(t)) return '📗';
    if (/presentation|powerpoint|\.pptx?/.test(t)) return '📙';
    if (/word|\.docx?/.test(t)) return '📘';
    if (/audio|\.mp3|\.m4a|\.wav/.test(t)) return '🎵';
    return '📄';
  }

  /* ---- 通信 ---- */
  function db(method, path, body, cb) {
    try {
      var x = new XMLHttpRequest();
      x.open(method, opt.db + '/memos/' + opt.key() + path + '.json', true);
      x.onreadystatechange = function () {
        if (x.readyState !== 4) return;
        var d = null; try { d = JSON.parse(x.responseText); } catch (e) {}
        cb(x.status >= 200 && x.status < 300 ? null : (x.status || 'net'), d);
      };
      x.send(body === undefined ? null : JSON.stringify(body));
    } catch (e) { cb('net'); }
  }
  function q(params) { var a = []; for (var k in params) a.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k])); return a.join('&'); }
  function gasGet(params, cb) {
    var url = opt.gas(); if (!url) { cb(null, 'nourl'); return; }
    var x = new XMLHttpRequest(), done = false;
    var jsonp = function () {
      if (done) return; done = true;
      var name = '__fs' + (++jsonpN) + '_' + now(), sc = document.createElement('script'), fin = false;
      var end = function (d, e) { if (fin) return; fin = true; try { delete window[name]; } catch (er) { window[name] = undefined; } if (sc.parentNode) sc.parentNode.removeChild(sc); cb(d, e); };
      window[name] = function (d) { end(d, null); };
      sc.onerror = function () { end(null, 'net'); };
      setTimeout(function () { end(null, 'timeout'); }, 120000);
      sc.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + q(params) + '&callback=' + name;
      document.head.appendChild(sc);
    };
    try { x.open('GET', url + (url.indexOf('?') >= 0 ? '&' : '?') + q(params), true); } catch (e) { jsonp(); return; }
    x.timeout = 120000;
    x.onreadystatechange = function () {
      if (x.readyState !== 4 || done) return;
      var d = null; if (x.status === 200) { try { d = JSON.parse(x.responseText); } catch (e) {} }
      if (!d) { jsonp(); return; }
      done = true; cb(d, null);
    };
    x.ontimeout = jsonp;
    try { x.send(); } catch (e) { jsonp(); }
  }
  function gasPost(body, cb, tries) {
    var url = opt.gas(); if (!url) { cb(null, 'nourl'); return; }
    var x = new XMLHttpRequest(), done = false;
    var fail = function (e) { if (done) return; done = true; if ((tries || 0) < 2) setTimeout(function () { gasPost(body, cb, (tries || 0) + 1); }, 3000); else cb(null, e); };
    try { x.open('POST', url, true); } catch (e) { fail('net'); return; }
    x.setRequestHeader('Content-Type', 'text/plain;charset=utf-8');
    x.timeout = 180000;
    x.onreadystatechange = function () {
      if (x.readyState !== 4 || done) return;
      var d = null; if (x.status === 200) { try { d = JSON.parse(x.responseText); } catch (e) {} }
      if (!d) { fail(x.status ? 'http' + x.status : 'net'); return; }
      done = true; cb(d, null);
    };
    x.ontimeout = function () { fail('timeout'); };
    try { x.send(JSON.stringify(body)); } catch (e) { fail('net'); }
  }
  function ab2b64(buf) {
    var u = new Uint8Array(buf), s = '', CHUNK = 0x8000;
    for (var i = 0; i < u.length; i += CHUNK) s += String.fromCharCode.apply(null, u.subarray ? u.subarray(i, i + CHUNK) : Array.prototype.slice.call(u, i, i + CHUNK));
    return btoa(s);
  }
  function b64toBytes(b) { var s = atob(b), u = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
  function errText(e) {
    e = String(e || '');
    if (e === 'nourl') return '翻訳の設定（Apps Script）がありません';
    if (/act|Unexpected|doPost|Script function not found/i.test(e)) return 'Apps Script が古いコードのままです。「⚙ 設定」のコードに貼り替えて「新バージョン」でデプロイしてください';
    if (/notshared/.test(e)) return 'このファイルは共有フォルダにありません（削除された可能性があります）';
    if (/net|timeout|http/.test(e)) return 'Apps Script につながりませんでした。電波を確かめてもう一度どうぞ';
    return e.slice(0, 90);
  }

  /* ---- 画面 ---- */
  var CSS = '#fs-ov{position:fixed;top:0;left:0;right:0;bottom:0;z-index:95;background:#eef2f4;overflow-y:auto;-webkit-overflow-scrolling:touch;font-family:-apple-system,"Hiragino Sans",sans-serif;color:#1f2a30}' +
    '#fs-ov .fs-bar{position:-webkit-sticky;position:sticky;top:0;background:#2f4858;color:#fff;padding:10px 12px;display:-webkit-box;display:-webkit-flex;display:flex;-webkit-box-align:center;-webkit-align-items:center;align-items:center}' +
    '#fs-ov .fs-bar b{-webkit-box-flex:1;-webkit-flex:1;flex:1;font-size:17px;margin-left:8px}' +
    '#fs-ov button,#fs-ov .fs-a{font:inherit;font-size:15px;border:0;border-radius:10px;padding:8px 12px;margin:3px 6px 3px 0;background:#dfe6ea;color:#1f2a30;text-decoration:none;display:inline-block;-webkit-appearance:none}' +
    '#fs-ov .pri{background:#2f6f8f;color:#fff}#fs-ov .dang{background:#f3dede;color:#8a1f1f}' +
    '#fs-ov .fs-bar button{background:rgba(255,255,255,.18);color:#fff}' +
    '#fs-ov .fs-wrap{max-width:720px;margin:0 auto;padding:12px}' +
    '#fs-ov .fs-send{background:#fff;border-radius:14px;padding:14px;margin-bottom:12px;border:2px dashed transparent}#fs-ov .fs-send.drag{border-color:#2f6f8f}' +
    '#fs-ov .note{font-size:13px;color:#5b6870;line-height:1.6;margin:6px 0 0}' +
    '#fs-ov .fs-row{background:#fff;border-radius:14px;padding:12px 14px;margin-bottom:10px}' +
    '#fs-ov .fs-name{font-size:16px;font-weight:600;word-break:break-all}#fs-ov .fs-meta{font-size:13px;color:#5b6870;margin:2px 0 6px}' +
    '#fs-ov .fs-msg{font-size:13px;color:#2f6f8f;margin-top:4px}#fs-ov .fs-prog{height:6px;background:#dfe6ea;border-radius:3px;margin-top:8px;overflow:hidden}#fs-ov .fs-prog i{display:block;height:100%;width:0;background:#2f6f8f}' +
    '#fs-ov .fs-prev img,#fs-ov .fs-prev video{max-width:100%;max-height:60vh;margin-top:8px;border-radius:8px;display:block}';
  function build() {
    var st = el('style'); st.textContent = CSS; (document.head || document.documentElement).appendChild(st);
    ov = el('div'); ov.id = 'fs-ov'; ov.style.display = 'none';
    ov.innerHTML = '<div class="fs-bar"><button type="button" id="fs-close">← 戻る</button><b>📎 ファイル共有</b><button type="button" id="fs-reload">↻</button></div>' +
      '<div class="fs-wrap"><div class="fs-send" id="fs-send">' +
      '<button type="button" class="pri" id="fs-pick">＋ ファイルを送る</button><input type="file" id="fs-file" multiple style="display:none">' +
      '<div id="fs-up"></div>' +
      '<p class="note" id="fs-note"></p></div><div id="fs-list"></div><p class="note" id="fs-empty">まだファイルはありません。</p></div>';
    document.body.appendChild(ov);
    $('fs-note').textContent = '送ったファイルは、ご自分の Google ドライブの「共有ファイル」フォルダに入り、同じ合言葉のほかの端末に一覧が出ます。1つ 100MB くらいまで。' +
      (oldIOS ? 'この iPad から送れるのは写真とビデオです。' : 'パソコンでは、ここへファイルをドラッグしても送れます。');
    $('fs-close').onclick = close;
    $('fs-reload').onclick = function () { load(); };
    $('fs-pick').onclick = function () { if (upBusy) return; $('fs-file').click(); };
    $('fs-file').onchange = function () { var l = []; each(this.files || [], function (f) { l.push(f); }); this.value = ''; sendAll(l); };
    var box = $('fs-send');
    box.addEventListener('dragover', function (e) { e.preventDefault(); box.className = 'fs-send drag'; });
    box.addEventListener('dragleave', function () { box.className = 'fs-send'; });
    box.addEventListener('drop', function (e) { e.preventDefault(); box.className = 'fs-send'; var l = []; each(e.dataTransfer.files || [], function (f) { l.push(f); }); sendAll(l); });
  }
  function open(o) {
    opt = o;
    if (!opt.key()) { alert('先に合言葉を設定してください。'); return; }
    if (!opt.gas()) { alert('ファイル共有には「⚙ 翻訳の設定」（Apps Script）が必要です。先に設定してください。'); return; }
    if (!ov) build();
    ov.style.display = 'block';
    load();
    if (timer) clearInterval(timer);
    timer = setInterval(function () { if (ov.style.display !== 'none' && !document.hidden) load(); }, 15000);
  }
  function close() { ov.style.display = 'none'; if (timer) { clearInterval(timer); timer = null; } }
  function load() {
    db('GET', '/files', undefined, function (err, d) { if (!err) { files = d || {}; render(); } });
  }
  function ids() { var a = []; for (var k in files) if (files[k] && files[k].id) a.push(k); a.sort(function (x, y) { return (files[y].at || 0) - (files[x].at || 0); }); return a; }
  function render() {
    var box = $('fs-list'), list = ids(); box.innerHTML = '';
    $('fs-empty').style.display = list.length ? 'none' : '';
    each(list, function (k) {
      var f = files[k], row = el('div', 'fs-row'); row.id = 'fs-r-' + k;
      row.appendChild(el('div', 'fs-name', icon(f.t, f.n) + ' ' + f.n));
      row.appendChild(el('div', 'fs-meta', fmtSize(f.s) + '・' + fmtTime(f.at) + (f.d ? '・' + f.d + 'から' : '')));
      var btns = el('div'), msg = el('div', 'fs-msg'), extra = el('div', 'fs-prev');
      var add = function (label, cls, fn) { var b = el('button', cls, label); b.type = 'button'; b.onclick = fn; btns.appendChild(b); return b; };
      if (!oldIOS) add('⬇ 開く・保存', 'pri', function () { fetchFile(k, msg, extra); });
      add(oldIOS ? '🔗 Safari で開く' : '🔗 リンクで開く', oldIOS ? 'pri' : '', function () { linkFile(k, msg, extra); });
      add('削除', 'dang', function () { delFile(k, msg); });
      row.appendChild(btns); row.appendChild(msg); row.appendChild(extra);
      if (got[k]) showGot(k, extra);
      box.appendChild(row);
    });
  }

  /* ---- 送る ---- */
  function sendAll(list) {
    if (!list.length || upBusy) return;
    var i = 0;
    var next = function () { if (i >= list.length) { upBusy = false; load(); return; } send(list[i++], next); };
    upBusy = true; next();
  }
  function send(file, done) {
    var box = $('fs-up'); box.innerHTML = '';
    var name = el('div', 'fs-meta', '送信中：' + file.name + '（' + fmtSize(file.size) + '）'), bar = el('div', 'fs-prog'), fill = el('i'), msg = el('div', 'fs-msg');
    bar.appendChild(fill); box.appendChild(name); box.appendChild(bar); box.appendChild(msg);
    var fail = function (e) { msg.textContent = '送れませんでした（' + errText(e) + '）。'; msg.style.color = '#8a1f1f'; done(); };
    if (!file.size) { fail('空のファイルは送れません'); return; }
    if (file.size > MAX) { fail('大きすぎます（100MB まで）'); return; }
    var type = file.type || 'application/octet-stream', t0 = now();
    var finish = function (id) {
      fill.style.width = '100%';
      db('POST', '/files', { n: file.name, s: file.size, t: type, id: id, at: { '.sv': 'timestamp' }, d: devName() }, function (err) {
        msg.textContent = err ? 'ドライブには入りましたが、一覧に載せられませんでした。' : '送りました（' + Math.round((now() - t0) / 1000) + '秒）。';
        done();
      });
    };
    // 8MB までは1回で送る（Apps Script が古いときは、分けて送る方法に戻す）
    if (file.size <= ONE) {
      var fr0 = new FileReader();
      fr0.onerror = function () { fail('ファイルを読めませんでした'); };
      fr0.onload = function () {
        msg.textContent = '送っています…'; fill.style.width = '30%';
        gasPost({ act: 'one', name: file.name, type: type, data: ab2b64(fr0.result) }, function (r0, e0) {
          if (r0 && r0.ok && r0.id) { finish(r0.id); return; }
          if (r0 && r0.error === 'act') { chunked(); return; }
          fail((r0 && r0.error) || e0);
        });
      };
      fr0.readAsArrayBuffer(file);
      return;
    }
    chunked();
    function chunked() {
    gasPost({ act: 'up0', name: file.name, type: type, size: file.size }, function (r, e) {
      if (!r || !r.ok) { fail((r && r.error) || e); return; }
      var off = 0;
      var step = function () {
        var blob = file.slice(off, Math.min(file.size, off + UP)), fr = new FileReader();
        fr.onerror = function () { fail('ファイルを読めませんでした'); };
        fr.onload = function () {
          gasPost({ act: 'upc', up: r.up, off: off, total: file.size, type: type, data: ab2b64(fr.result) }, function (r2, e2) {
            if (!r2 || !r2.ok) { fail((r2 && r2.error) || e2); return; }
            off += blob.size;
            fill.style.width = Math.round(off / file.size * 100) + '%';
            msg.textContent = Math.round(off / file.size * 100) + '%';
            if (!r2.done) { step(); return; }
            finish(r2.id);
          });
        };
        fr.readAsArrayBuffer(blob);
      };
      step();
    });
    }
  }

  /* ---- 受け取る ---- */
  function fetchFile(k, msg, extra) {
    var f = files[k]; if (!f) return;
    if (got[k]) { showGot(k, extra); return; }
    var parts = [], i = 0, n = 1;
    msg.style.color = ''; msg.textContent = '受け取っています…';
    var step = function () {
      gasGet({ f: 'get', id: f.id, part: String(i) }, function (d, e) {
        if (!d || !d.ok) { msg.textContent = '受け取れませんでした（' + errText((d && d.error) || e) + '）。'; msg.style.color = '#8a1f1f'; return; }
        parts.push(b64toBytes(d.a || '')); n = d.n || 1; i++;
        msg.textContent = '受け取っています… ' + Math.round(i / n * 100) + '%';
        if (i < n) { step(); return; }
        var blob = new Blob(parts, { type: d.type || f.t || 'application/octet-stream' });
        got[k] = { url: URL.createObjectURL(blob), type: blob.type, name: f.n };
        msg.textContent = '';
        showGot(k, extra);
      });
    };
    step();
  }
  function showGot(k, extra) {
    var g = got[k]; extra.innerHTML = '';
    var a1 = el('a', 'fs-a pri', '👁 見る'); a1.href = g.url; a1.target = '_blank'; a1.rel = 'noopener';
    var a2 = el('a', 'fs-a', '💾 この端末に保存'); a2.href = g.url; a2.setAttribute('download', g.name);
    extra.appendChild(a1); extra.appendChild(a2);
    if (/^image\//.test(g.type)) { var im = el('img'); im.src = g.url; extra.appendChild(im); }
    else if (/^video\//.test(g.type)) { var v = el('video'); v.src = g.url; v.controls = true; v.setAttribute('playsinline', ''); extra.appendChild(v); }
  }
  function linkFile(k, msg, extra) {
    var f = files[k]; if (!f) return;
    if (!f.pub && !window.confirm('リンクで開くと、このファイルは「リンクを知っている人なら見られる」状態になります（リンクは推測できない長いものです）。開きますか？')) return;
    msg.style.color = ''; msg.textContent = 'リンクを用意しています…';
    gasGet({ f: 'link', id: f.id }, function (d, e) {
      if (!d || !d.ok) { msg.textContent = 'リンクを作れませんでした（' + errText((d && d.error) || e) + '）。'; msg.style.color = '#8a1f1f'; return; }
      if (!f.pub) { f.pub = 1; db('PATCH', '/files/' + k, { pub: 1 }, function () {}); }
      msg.textContent = '';
      extra.innerHTML = '';
      var a = el('a', 'fs-a pri', oldIOS ? '▶ Safari で開く' : '▶ リンクを開く'); a.href = d.url; a.target = '_blank'; a.rel = 'noopener';
      extra.appendChild(a);
    });
  }
  function delFile(k, msg) {
    var f = files[k]; if (!f) return;
    if (!window.confirm('「' + f.n + '」を削除しますか？（ドライブのゴミ箱に移ります。ほかの端末の一覧からも消えます）')) return;
    msg.style.color = ''; msg.textContent = '削除しています…';
    gasGet({ f: 'del', id: f.id }, function (d, e) {
      if (d && !d.ok && !/notshared/.test(d.error || '')) { msg.textContent = '削除できませんでした（' + errText(d.error || e) + '）。'; msg.style.color = '#8a1f1f'; return; }
      db('DELETE', '/files/' + k, undefined, function () { delete files[k]; if (got[k]) { try { URL.revokeObjectURL(got[k].url); } catch (er) {} delete got[k]; } render(); });
    });
  }

  window.FileShare = { open: open, close: close };
})();
