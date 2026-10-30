/* 字幕プレイヤー：ドライブの動画を「この端末からの動画」として中継するサービスワーカー
   iPhone の <video> はドライブ API の URL を直接読めない（コード 4）が、ページからの fetch は通る。
   そこで <video> には同じサイトの ./__drive__?... を渡し、ここで fetch して返す。動画は端末に保存しない。

   iPhone（WebKit）向けの注意：
   - ドライブの応答をストリームのまま <video> に流すと、途中で止まったりコード 4 になったりする。
     そこで、1 回に最大 CHUNK バイトだけ取り、受け取り切ってから「正確な長さ」で返す。
   - 「bytes=N-」（終わりなし）の要求も CHUNK で区切って 206 で返す（Safari は続きを自分で取りに来る）。
   - Content-Range / Content-Length は、受け取った実際のバイト数から作る（推測しない）。 */
var VERSION = 'v2';
var CHUNK = 2 * 1024 * 1024;   // 2MB

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', function (e) {
  var u = new URL(e.request.url);
  if (u.origin !== self.location.origin || !/\/__drive__$/.test(u.pathname)) return;
  e.respondWith(relay(e.request, u).catch(function (err) {
    return text(502, 'relay ' + VERSION + ': ' + String(err && err.message || err));
  }));
});

function text(st, t, extra) {
  var h = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Relay': VERSION };
  if (extra) for (var k in extra) h[k] = extra[k];
  return new Response(t, { status: st, headers: h });
}

function relay(req, u) {
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

  return fetch(api, { headers: { Range: 'bytes=' + start + '-' + end }, cache: 'no-store' }).then(function (res) {
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
  });
}
