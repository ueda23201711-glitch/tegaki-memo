/* 字幕プレイヤー：ドライブの動画を「この端末からの動画」として中継するサービスワーカー
   iPhone の <video> はドライブ API の URL を直接読めない（コード 4）が、ページからの fetch は通る。
   そこで <video> には同じサイトの ./__drive__?... を渡し、ここで fetch して返す。動画は端末に保存しない。

   iPhone（WebKit）向けの注意：
   - ドライブの応答をストリームのまま <video> に流すと、途中で止まったりコード 4 になったりする。
     そこで、1 回に最大 CHUNK バイトだけ取り、受け取り切ってから「正確な長さ」で返す。
   - 「bytes=N-」（終わりなし）の要求も CHUNK で区切って 206 で返す（Safari は続きを自分で取りに来る）。
   - Content-Range / Content-Length は、受け取った実際のバイト数から作る（推測しない）。
   - 大きいファイルなどでドライブ API がつながらない（Load failed）ときは、Apps Script（gas=）から
     「取り込み」と同じ 3MB ずつの分割（f=get&part=k、Base64）で受け取り、必要な範囲だけ切り出して返す。
     受け取った分割はメモリに少しだけ置き、次の分割も先に取りに行く（端末には保存しない）。
   - iPhone では Apps Script への普通の通信（CORS）が通らないことがある（ページは JSONP で取っている）。
     ここでは JSONP が使えないので、そのときはページに頼んで、取り込みと同じ gasCall で受け取ってもらう。 */
var VERSION = 'v4';
var CHUNK = 2 * 1024 * 1024;   // 2MB

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', function (e) {
  var u = new URL(e.request.url);
  if (u.origin !== self.location.origin || !/\/__drive__$/.test(u.pathname)) return;
  e.respondWith(relay(e.request, u, e).catch(function (err) {
    return text(502, 'relay ' + VERSION + ': ' + String(err && err.message || err));
  }));
});

function text(st, t, extra) {
  var h = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Relay': VERSION };
  if (extra) for (var k in extra) h[k] = extra[k];
  return new Response(t, { status: st, headers: h });
}

function relay(req, u, e) {
  var fid = u.searchParams.get('id') || '', key = u.searchParams.get('key') || '';
  var total = Number(u.searchParams.get('size')) || 0, type = u.searchParams.get('type') || 'video/mp4';
  if (!/^video\/|^audio\//.test(type)) type = 'video/mp4';
  var api = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fid) + '?alt=media&key=' + encodeURIComponent(key);

  var range = (req.headers.get('range') || '').trim(), m = /^bytes=(\d+)-(\d*)$/.exec(range);
  // 範囲指定なし（Safari の <video> は普通は付けてくる）：先頭から CHUNK だけ 206 で返す
  var start = m ? Number(m[1]) : 0;
  var end = m && m[2] !== '' ? Number(m[2]) : start + CHUNK - 1;
  if (end - start + 1 > CHUNK) end = start + CHUNK - 1;
  if (total && end >= total) end = total - 1;
  if (total && start >= total) return Promise.resolve(text(416, '', { 'Content-Range': 'bytes */' + total }));

  var gas = u.searchParams.get('gas') || '';
  var viaGas = function (why) {
    if (!gas) return Promise.reject(new Error(why || 'no api'));
    return fromGas(gas, fid, start, end, total, type, e).catch(function (err) {
      throw new Error((why ? why + ' / ' : '') + 'gas ' + (err && err.message || err));
    });
  };
  if (!key || apiBad[fid]) return viaGas();
  return fetch(api, { headers: { Range: 'bytes=' + start + '-' + end }, cache: 'no-store' }).then(function (res) {
    if (res.status >= 400 && gas) { apiBad[fid] = 1; return viaGas('api ' + res.status); }
    if (res.status >= 400) return res.text().then(function (t) { return text(res.status, t); });
    return res.arrayBuffer().then(function (buf) {
      var len = buf.byteLength;
      var cr = res.headers.get('content-range') || '';
      var mm = /\/(\d+)\s*$/.exec(cr);
      var whole = mm ? Number(mm[1]) : total;
      if (res.status === 200 && !whole) whole = len;   // ドライブが範囲を無視して全体を返したとき
      var body = buf;
      if (res.status === 200 && len > end - start + 1) {   // 全体が来た → 必要な部分だけ切り出す
        body = buf.slice(start, end + 1); len = body.byteLength;
      }
      var last = start + len - 1;
      var h = new Headers();
      h.set('Content-Type', type);
      h.set('Accept-Ranges', 'bytes');
      h.set('Cache-Control', 'no-store');
      h.set('Content-Length', String(len));
      h.set('Content-Range', 'bytes ' + start + '-' + last + '/' + (whole || '*'));
      h.set('X-Relay', VERSION);
      return new Response(body, { status: 206, statusText: 'Partial Content', headers: h });
    });
  }, function (err) {
    if (!gas) throw err;
    apiBad[fid] = 1;   // この動画はドライブ API がだめ：以後は最初から Apps Script
    return viaGas('api ' + (err && err.message || err));
  });
}

/* ---- Apps Script から分割で受け取る ---- */
var apiBad = {};            // ドライブ API がつながらなかった動画
var meta = {};              // fid → { n: 分割数, ps: 1 分割の大きさ }
var parts = {}, order = [];  // 'fid#k' → Uint8Array（最近の数個だけ）
var flying = {};            // 'fid#k' → Promise
var KEEP = 6;               // メモリに置く分割の数（約 18MB）
var gasDirectBad = false;   // ここから Apps Script へ直接つながらない（CORS）

// ページ（player.html）に、取り込みと同じ gasCall で分割を受け取ってもらう
function askPage(cid, fid, k) {
  var pick = cid ? self.clients.get(cid) : Promise.resolve(null);
  return pick.then(function (c) {
    if (c) return c;
    return self.clients.matchAll({ type: 'window' }).then(function (all) { return all[0]; });
  }).then(function (c) {
    if (!c) throw new Error('no page');
    return new Promise(function (ok, ng) {
      var ch = new MessageChannel();
      var t = setTimeout(function () { ng(new Error('page timeout')); }, 130000);
      ch.port1.onmessage = function (ev) { clearTimeout(t); ok(ev.data); };
      c.postMessage({ type: 'ep-gas-part', id: fid, part: k }, [ch.port2]);
    });
  });
}

function gasPart(gas, fid, k, cid) {
  var id = fid + '#' + k;
  if (parts[id]) return Promise.resolve(parts[id]);
  if (flying[id]) return flying[id];
  var url = gas + (gas.indexOf('?') >= 0 ? '&' : '?') + 'f=get&id=' + encodeURIComponent(fid) + '&part=' + k;
  var direct = function () {
    if (gasDirectBad) return Promise.reject(new Error('direct off'));
    return fetch(url, { cache: 'no-store', redirect: 'follow' }).then(function (r) { return r.json(); }).catch(function (err) {
      gasDirectBad = true;   // 以後はページに頼む
      throw err;
    });
  };
  var get = function () { return direct().catch(function () { return askPage(cid, fid, k); }); };
  var tryOnce = function (n) {
    return get().then(function (d) {
      if (!d || !d.ok || typeof d.a !== 'string') throw new Error((d && d.error) || 'gas');
      var bin = atob(d.a), b = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
      if (!meta[fid] || k === 0) meta[fid] = { n: d.n || 1, ps: k === 0 ? b.length : (meta[fid] && meta[fid].ps) };
      return b;
    }).catch(function (err) {
      if (n < 3) return new Promise(function (ok) { setTimeout(ok, 1500 * (n + 1)); }).then(function () { return tryOnce(n + 1); });
      throw err;
    });
  };
  flying[id] = tryOnce(0).then(function (b) {
    delete flying[id];
    parts[id] = b; order.push(id);
    while (order.length > KEEP) delete parts[order.shift()];
    return b;
  }, function (err) { delete flying[id]; throw err; });
  return flying[id];
}

function fromGas(gas, fid, start, end, total, type, ev) {
  var cid = ev && (ev.clientId || ev.resultingClientId) || '';
  // 1 分割の大きさは、0 番を受け取ると分かる（最初の 1 回だけ）
  var ready = meta[fid] && meta[fid].ps ? Promise.resolve() : gasPart(gas, fid, 0, cid);
  return ready.then(function () {
    var ps = meta[fid].ps, n = meta[fid].n, k = Math.floor(start / ps);
    if (k >= n) return text(416, '', { 'Content-Range': 'bytes */' + (total || '*') });
    // start〜end を、必要なら分割をまたいでつなげる（end は CHUNK 以内に切ってある）
    var out = [], got = 0, want = end - start + 1, kk = k;
    var step = function () {
      return gasPart(gas, fid, kk, cid).then(function (b) {
        var off = Math.max(0, start + got - kk * ps);
        var piece = b.subarray(off, Math.min(b.length, off + (want - got)));
        out.push(piece); got += piece.length;
        if (got < want && kk + 1 < n && b.length === ps) { kk++; return step(); }
      });
    };
    return step().then(function () {
      var body = new Uint8Array(got), at = 0;
      out.forEach(function (x) { body.set(x, at); at += x.length; });
      k = kk;
      if (k + 1 < n) {   // 次の分割を先に取りに行く
        var pre = gasPart(gas, fid, k + 1, cid).catch(function () {});
        try { if (ev && ev.waitUntil) ev.waitUntil(pre); } catch (x) {}
      }
      var whole = total || (got < want ? start + got : 0);
      var h = new Headers();
      h.set('Content-Type', type);
      h.set('Accept-Ranges', 'bytes');
      h.set('Cache-Control', 'no-store');
      h.set('Content-Length', String(body.byteLength));
      h.set('Content-Range', 'bytes ' + start + '-' + (start + body.byteLength - 1) + '/' + (whole || '*'));
      h.set('X-Relay', VERSION + '-gas');
      return new Response(body, { status: 206, statusText: 'Partial Content', headers: h });
    });
  });
}
