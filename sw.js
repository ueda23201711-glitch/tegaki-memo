// 手書きメモ用 Service Worker（iOS 9 では使われない。新しい端末でのオフライン起動用）
const CACHE = "tegaki-memo-v32";
const ASSETS = [
  "./",
  "./index.html",
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

  if (req.mode === "navigate") {
    // ページ本体：ネット優先（更新がすぐ届く）。つながらないときはキャッシュ
    event.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put("./index.html", copy)); return res; })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }
  // アイコン等：キャッシュ優先
  event.respondWith(caches.match(req).then((c) => c || fetch(req)));
});
