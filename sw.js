// Service Worker: アプリの見た目(HTML/CSS/JS/アイコン)だけをキャッシュする。
// 為替データの取得(Twelve Data API)はキャッシュせず、常に最新を取りに行く。
const CACHE_NAME = "rb-signal-shell-v40"; // v40: 「過去1週間分の4本値を手動編集」ページ(edit-bars.html/edit-bars.js)を新設。毎朝の確定前スクショで終値等がずれた場合に、直近10営業日分の日足を直接書き換えてlocalStorage(rb_bar_history_v1)に保存できる。既存のスクショ取り込みと同じ保存先・同じ検算ロジック(validateReconstructedBar)を共有するため、loadBarHistory/saveBarHistory/appendShotBars/removeShotBarをapp.jsからsignal-core.jsへ移動(教訓90、二重実装の防止)。index.htmlに導線リンクを追加。
const SHELL_FILES = [
  "./",
  "./index.html",
  "./edit-bars.html",
  "./style.css",
  "./signal-core.js",
  "./app.js",
  "./edit-bars.js",
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
