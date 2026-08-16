// Service Worker: アプリの見た目(HTML/CSS/JS/アイコン)だけをキャッシュする。
// 為替データの取得(Twelve Data API)はキャッシュせず、常に最新を取りに行く。
const CACHE_NAME = "rb-signal-shell-v6"; // v6: 土曜バーは除外でなく金曜へマージ、日曜は月曜へマージ(app.js更新)
const SHELL_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // 外部API(為替データ)へのリクエストは素通しし、キャッシュしない。
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
