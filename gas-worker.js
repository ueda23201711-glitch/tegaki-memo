/* Apps Script から動画の分割（f=get&part=k）を受け取る裏方（Web Worker）
   iPhone では Apps Script への普通の通信が通らず、ページは JSONP（<script>）で受け取っている。
   約 4MB の Base64 をページで読み込むと、その間ページが固まり、タッチが効かなくなる。
   そこで、JSONP の読み込み（importScripts）と Base64 の変換をここで行い、
   できたデータ（ArrayBuffer）を、そのまま渡す（コピーしない）。

   使い方：worker.postMessage({ url: 'Apps Script の URL?f=get&id=..&part=..' }, [port])
   返事は port に { ok, n, k, size, buf } か { ok: false, error } */
var seq = 0;
self.onmessage = function (e) {
  var q = e.data || {}, port = e.ports && e.ports[0];
  var reply = function (d, tr) { try { if (port) port.postMessage(d, tr || []); else self.postMessage(d, tr || []); } catch (x) {} };
  if (!q.url) { reply({ ok: false, error: 'worker nourl' }); return; }
  var name = '__gw' + (++seq) + '_' + Date.now(), got = null;
  self[name] = function (d) { got = d; };
  try {
    importScripts(q.url + (q.url.indexOf('?') >= 0 ? '&' : '?') + 'callback=' + name);
  } catch (err) {
    try { delete self[name]; } catch (x) { self[name] = undefined; }
    reply({ ok: false, error: 'worker ' + String(err && err.message || err).slice(0, 60) });
    return;
  }
  try { delete self[name]; } catch (x) { self[name] = undefined; }
  if (!got || !got.ok || typeof got.a !== 'string') { reply(got || { ok: false, error: 'worker empty' }); return; }
  var bin = atob(got.a), b = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  reply({ ok: true, n: got.n, k: got.k, size: got.size, type: got.type, buf: b.buffer }, [b.buffer]);
};
