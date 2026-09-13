// Service Worker: アプリの見た目(HTML/CSS/JS/アイコン)だけをキャッシュする。
// 為替データの取得(Twelve Data API)はキャッシュせず、常に最新を取りに行く。
const CACHE_NAME = "rb-signal-shell-v38"; // v38: 重大バグ修正。missingTradingDaysが末尾バーの日付を起点に走査していたため、FT5とスクショの間に空いた"内部の穴"(例: 木曜だけ両方とも欠落)を検出できず、日足判定が前々日・前日として1営業日隔たっていない2本(例: 水曜と金曜)を無警告で比較していた(GBPJPYで実例確認: 本来アウトサイド継続=ショートのはずが「シグナルなし」と誤表示)。先頭バー起点の走査に修正し、Twelve Dataキー未設定等でなお穴が残る場合に備え日足カード・Discord通知の両方に「⚠前々日と前日の間が欠落」警告を追加。worker.js再生成済み。
const SHELL_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./signal-core.js",
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

// GitHub Actions(notify/check-signals.js)からのプッシュ通知を受信して表示する。
self.addEventListener("push", (event) => {
  let data = { title: "RBシグナル", body: "新しいシグナルがあります" };
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data.body = event.data.text();
    }
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "RBシグナル", {
      body: data.body || "",
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
    })
  );
});

// 通知タップでアプリを開く(既に開いているタブがあればそれをフォーカス)。
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("./");
      return undefined;
    })
  );
});
