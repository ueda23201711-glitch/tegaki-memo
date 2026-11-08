/* 英文リーダー：この端末に取り込んだ動画を、<video> に少しずつ渡すサービスワーカー（./__local__?db=…&id=…）
   取り込んだ動画は、端末の中に 3MB ずつ分けて保存してある（{ lvParts: 分の数 } の目印＋ id#0, id#1, …）。
   これを 1 つの動画（Blob）にまとめて <video> に渡すと、iPhone 8 などメモリの少ない端末では落ちてしまう。
   そこで <video> が欲しがる範囲（Range）だけを、保存してある分から切り出して返す。
   iPhone（WebKit）向けに、ストリームではなく「長さの決まった中身」で 206 を返す（drive-sw.js と同じやり方）。
   前の取り込み方（1 つの Blob で保存）の動画も、同じように範囲だけ切り出して返す。 */
var LOCAL_CHUNK = 2 * 1024 * 1024;   // 1 回に返す最大の大きさ
var localMeta = {};   // db|id → { n, P, total, type }（分の数・1 つの分の大きさ・全体の大きさ）

self.addEventListener('fetch', function (e) {
  var u = new URL(e.request.url);
  if (u.origin !== self.location.origin || !/\/__local__$/.test(u.pathname)) return;
  e.respondWith(localServe(e.request, u).catch(function (err) {
    return new Response('local: ' + String(err && err.message || err), { status: 500, headers: { 'Content-Type': 'text/plain' } });
  }));
});

function localDb(name) {
  return new Promise(function (ok, ng) {
    var rq = indexedDB.open(name);
    rq.onsuccess = function () { ok(rq.result); };
    rq.onerror = function () { ng(rq.error || new Error('idb')); };
  });
}
function localGet(db, key) {
  return new Promise(function (ok, ng) {
    try {
      var rq = db.transaction('v', 'readonly').objectStore('v').get(key);
      rq.onsuccess = function () { ok(rq.result || null); };
      rq.onerror = function () { ng(rq.error || new Error('get')); };
    } catch (e) { ng(e); }
  });
}
function localBlob(v, type) { return v instanceof Blob ? v : new Blob([v], { type: type || 'application/octet-stream' }); }
function localBuf(b) { return b.arrayBuffer ? b.arrayBuffer() : new Response(b).arrayBuffer(); }

function localServe(req, u) {
  var name = u.searchParams.get('db') || '', id = u.searchParams.get('id') || '', mk = name + '|' + id;
  return localDb(name).then(function (db) {
    var meta = localMeta[mk];
    var getMeta = meta ? Promise.resolve(meta) : localGet(db, id).then(function (v) {
      if (!v) throw new Error('not found');
      if (v.lvParts) {
        var n = v.lvParts;
        return Promise.all([localGet(db, id + '#0'), localGet(db, id + '#' + (n - 1))]).then(function (r) {
          if (!r[0] || !r[1]) throw new Error('part missing');
          var P = localBlob(r[0]).size || r[0].byteLength, L = localBlob(r[1]).size || r[1].byteLength;
          return (localMeta[mk] = { n: n, P: P, total: n === 1 ? P : P * (n - 1) + L, type: v.type || 'video/mp4' });
        });
      }
      var b = localBlob(v);   // 前の取り込み方：1 つの Blob
      return (localMeta[mk] = { n: 1, P: b.size, total: b.size, type: b.type || 'video/mp4', one: true });
    });
    return getMeta.then(function (m) {
      var range = (req.headers.get('range') || '').trim(), r = /^bytes=(\d+)-(\d*)$/.exec(range);
      var start = r ? Number(r[1]) : 0, end = r && r[2] !== '' ? Number(r[2]) : start + LOCAL_CHUNK - 1;
      if (end - start + 1 > LOCAL_CHUNK) end = start + LOCAL_CHUNK - 1;
      if (end >= m.total) end = m.total - 1;
      if (start >= m.total) return new Response('', { status: 416, headers: { 'Content-Range': 'bytes */' + m.total } });
      // 必要な分（1〜2 つ）を読んで、範囲だけ切り出す
      var k1 = Math.floor(start / m.P), k2 = Math.floor(end / m.P), keys = [];
      for (var k = k1; k <= k2; k++) keys.push(m.one ? id : id + '#' + k);
      return Promise.all(keys.map(function (key) { return localGet(db, key); })).then(function (vals) {
        var pieces = vals.map(function (v, i) {
          if (!v) throw new Error('part missing');
          var b = localBlob(v), base = (k1 + i) * m.P;
          var s = Math.max(start, base) - base, e2 = Math.min(end + 1, base + b.size) - base;
          return b.slice(s, e2);
        });
        return localBuf(new Blob(pieces));
      }).then(function (buf) {
        var len = buf.byteLength;
        return new Response(buf, { status: 206, headers: {
          'Content-Type': m.type, 'Content-Length': String(len), 'Accept-Ranges': 'bytes',
          'Content-Range': 'bytes ' + start + '-' + (start + len - 1) + '/' + m.total, 'Cache-Control': 'no-store' } });
      });
    });
  });
}
