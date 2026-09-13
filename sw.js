// Service Worker: アプリの見た目(HTML/CSS/JS/アイコン)だけをキャッシュする。
// 為替データの取得(Twelve Data API)はキャッシュせず、常に最新を取りに行く。
const CACHE_NAME = "rb-signal-shell-v37"; // v37: 最終最良設計をCoreAlloc(PF構造監査ステージ4、A+確定)に更新。日足コアのトランシェ配分をT0=0.03/T1=0.03/T2=0.02/T3=0.01/T4=0.01の直接指定に変更、EURJPYfadeOutにEJFadeRiskMult=0.75を反映(lot 0.18→0.135)、REFERENCE_MAX_DD_USDをコア単体の最新実機ログ基準に再計算(3369.33→1968.15)。あわせてworker.jsを再生成(2026-09-11の衝突ゲート追加が未反映のまま取り残されていたのも同時に解消)
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
