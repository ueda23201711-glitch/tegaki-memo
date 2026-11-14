// 手書きメモ用 Service Worker（iOS 9 では使われない。新しい端末でのオフライン起動用）
// ドライブ動画の中継（字幕プレイヤー player.html 用。./__drive__?... を受け持つ）。先に読み込むので、こちらが先に応答する
importScripts("./drive-sw.js");
// この端末に取り込んだ動画を、少しずつ <video> に渡す（./__local__）。メモリの少ない iPhone で落ちないように
importScripts("./local-sw.js");
const CACHE = "tegaki-memo-v235";
const ASSETS = [
  "./",
  "./index.html",
  "./player.html",
  "./fileshare.js",
  "./manifest.webmanifest",
  "./icons/icon-v2-192.png",
  "./icons/icon-v2-512.png",
  "./icons/maskable-v2-192.png",
  "./icons/maskable-v2-512.png",
  "./icons/apple-touch-icon-v2-180.png",
  "./icons/favicon-v2-32.png",
  "./vendor/qrcode.js",
  "./vendor/jsQR.js"
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("tegaki-memo-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  // Firebase など別サイトへの通信には関与しない（メモのデータは常に最新を取りに行く）
  if (new URL(req.url).origin !== self.location.origin) return;
  if (/\/__(drive|local)__$/.test(new URL(req.url).pathname)) return;   // 中継（drive-sw.js）が受け持つ

  if (req.mode === "navigate") {
    // ページ本体：ネット優先（更新がすぐ届く）。つながらないときはキャッシュ。字幕プレイヤー（player.html）は別に置く
    const page = /\/player\.html$/.test(new URL(req.url).pathname) ? "./player.html" : "./index.html";
    // ネットが遅い・つながりにくいとき（電波の弱い所など）、2.5 秒待っても返事がなければ手元の版ですぐ開く。
    // （字幕プレイヤー ⇄ 英文リーダーの切り替えで「押しても戻らない」ことがないように。新しい版はその後で手元に入る）
    const net = fetch(req, { cache: "no-cache" })   // GitHub Pages の10分キャッシュで古い版が出ないように
      .then((res) => { if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(page, copy)); } return res; });
    const cached = () => caches.match(page).then((c) => c || caches.match("./index.html"));
    event.respondWith(new Promise((resolve) => {
      let done = false;
      const fin = (r) => { if (!done && r) { done = true; resolve(r); } };
      const t = setTimeout(() => { cached().then((c) => { if (c) fin(c); }); }, 2500);
      net.then((r) => { clearTimeout(t); fin(r); }).catch(() => { clearTimeout(t); cached().then((c) => fin(c || Response.error())); });
    }));
    event.waitUntil(net.catch(() => {}));
    return;
  }
  // アイコン等：キャッシュ優先
  event.respondWith(caches.match(req).then((c) => c || fetch(req)));
});
