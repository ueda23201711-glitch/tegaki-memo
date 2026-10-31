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
     ここでは JSONP が使えないので、そのときはページに頼んで、取り込みと同じ gasCall で受け取ってもらう。
   - 頼んだページが閉じたり別の画面に移ったりすると、返事は来ない。字幕プレイヤー⇔英文リーダーの行き来で
     そうなるので、待っている頼みは「頼んだページ」ごとに分け、別のページからの要求は新しく頼み直す。
   - 再生が始まるまでを短く（v6）：
     ・各動画の先頭の分割（動画の作りの情報＝moov が入っている）と、最近見た分割をいくつか、端末（Cache Storage）に置く。
       2 回目からは、先頭や続きの場面を Apps Script に取りに行かずにすぐ返せる。
     ・大きい動画（BIG 以上）はドライブ API がつながらないので、最初から Apps Script にする（毎回の失敗待ちをなくす）。
     ・分割の大きさは Apps Script と同じ 3MB と決めておき、0 番を待たずに必要な分割を取りに行く。
     ・先読みは 2 つ先まで。 */
var VERSION = 'v6';
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
  if (!key || apiBad[fid] || (gas && total > BIG)) return viaGas();
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
var PS = 3 * 1024 * 1024;     // Apps Script の f=get の分割の大きさ（Apps Script 側の CH と同じ）
var BIG = 95 * 1024 * 1024;   // これより大きい動画は、ドライブ API を試さない
/* 分割を端末に置く（Cache Storage）。先頭は動画ごとに HEADS 個まで、それ以外は最近の RECENT 個まで */
var STORE = 'drive-relay-v1', HEADS = 15, RECENT = 8;
function storeKey(fid, k) { return new Request(self.registration.scope + '__part__/' + encodeURIComponent(fid) + '/' + k); }
function storeGet(fid, k) {
  try {
    return caches.open(STORE).then(function (c) { return c.match(storeKey(fid, k)); })
      .then(function (r) { return r ? r.arrayBuffer().then(function (b) { return new Uint8Array(b); }) : null; })
      .catch(function () { return null; });
  } catch (e) { return Promise.resolve(null); }
}
var storeQ = Promise.resolve();
function storePut(fid, k, b) {
  storeQ = storeQ.then(function () {
    return caches.open(STORE).then(function (c) {
      return c.put(storeKey(fid, k), new Response(b, { headers: { 'Content-Type': 'application/octet-stream' } })).then(function () {
        // 古いものを消す（先頭とそれ以外を別々に数える。keys() は入れた順）
        return c.keys().then(function (ks) {
          var heads = [], rest = [];
          ks.forEach(function (q) { (/\/0$/.test(q.url) ? heads : rest).push(q); });
          var del = heads.slice(0, Math.max(0, heads.length - HEADS)).concat(rest.slice(0, Math.max(0, rest.length - RECENT)));
          return Promise.all(del.map(function (q) { return c['delete'](q); }));
        });
      });
    }).catch(function () {});
  });
  return storeQ;
}

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
      var t = setTimeout(function () { fin(new Error('page timeout')); }, 130000);
      // 頼んだページがなくなった（別の画面に移った）ら、待つのをやめる
      var w = setInterval(function () {
        self.clients.get(c.id).then(function (x) { if (!x) fin(new Error('page gone')); }, function () {});
      }, 2000);
      var fin = function (err, data) { clearTimeout(t); clearInterval(w); if (err) ng(err); else ok(data); };
      ch.port1.onmessage = function (ev) { fin(null, ev.data); };
      c.postMessage({ type: 'ep-gas-part', id: fid, part: k }, [ch.port2]);
    });
  });
}

function gasPart(gas, fid, k, cid) {
  var id = fid + '#' + k;
  if (parts[id]) return Promise.resolve(parts[id]);
  // 取りに行っている途中のもの：直接（ページを通さない）か、同じページに頼んだものだけ待つ
  var fl = flying[id];
  if (fl && (fl.cid === null || fl.cid === (cid || ''))) return fl.p;
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
      if (!meta[fid] || !meta[fid].n || k === 0) meta[fid] = { n: d.n || 1, ps: k === 0 && (d.n || 1) > 1 ? b.length : ((meta[fid] && meta[fid].ps) || PS) };
      return b;
    }).catch(function (err) {
      if (n < 3) return new Promise(function (ok) { setTimeout(ok, 1500 * (n + 1)); }).then(function () { return tryOnce(n + 1); });
      throw err;
    });
  };
  var me = { cid: gasDirectBad ? (cid || '') : null };
  var fromStore = false;
  me.p = storeGet(fid, k).then(function (b) {
    if (b && b.length) { fromStore = true; return b; }
    return tryOnce(0);
  }).then(function (b) {
    if (flying[id] === me) delete flying[id];
    if (!meta[fid] && k === 0) meta[fid] = { n: 0, ps: b.length };
    if (!fromStore) storePut(fid, k, b);
    parts[id] = b; order.push(id);
    while (order.length > KEEP) delete parts[order.shift()];
    return b;
  }, function (err) { if (flying[id] === me) delete flying[id]; throw err; });
  flying[id] = me;
  return me.p;
}

function fromGas(gas, fid, start, end, total, type, ev) {
  var cid = ev && (ev.clientId || ev.resultingClientId) || '';
  // 分割の大きさは 3MB（Apps Script と同じ）。全体の大きさが分かっていれば、0 番を待たずに必要な分割へ
  var ready = (meta[fid] && meta[fid].ps && meta[fid].n) || total ? Promise.resolve() : gasPart(gas, fid, 0, cid);
  return ready.then(function () {
    var ps = (meta[fid] && meta[fid].ps) || PS, n = (meta[fid] && meta[fid].n) || Math.max(1, Math.ceil(total / ps)), k = Math.floor(start / ps);
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
      // 先読み：2 つ先まで（同時に頼みすぎないよう、1 つずつ順に）
      if (k + 1 < n) {
        var pre = gasPart(gas, fid, k + 1, cid).then(function () { if (k + 2 < n) return gasPart(gas, fid, k + 2, cid); }).catch(function () {});
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
