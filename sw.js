// Service Worker: アプリの見た目(HTML/CSS/JS/アイコン)だけをキャッシュする。
// 為替データの取得(Twelve Data API)はキャッシュせず、常に最新を取りに行く。
const CACHE_NAME = "rb-signal-shell-v43"; // v43: スクショ取り込みで5ペア中1ペアでもエラーになると、正しく読めていた残り4ペアまで含めて「取り込む」ボタンが消え、その日は全ペア未保存のままTwelve Dataフォールバックに落ちるバグを発見(GBPJPY 2026-09-17の高値が209.245[TD]のまま209.103[ブローカー実値]に更新されなかった実例で発覚。教訓100)。renderShotReview()を、エラーのないペアだけを個別に取り込み対象にする方式に修正(app.js)。v42: FT5のD1キャッシュが付けている日付ラベルが、実際のセッション開始日(ブローカー・EAのOpenTime・1分足PKL集計と一致する規則)より常に1営業日進んでいたことが判明(ユーザーがブローカーのチャートと見比べて発見。分足データとの直接比較・PKLベース日足との比較の両方で確認)。ft5_export/export_daily.pyでラベルを1営業日前にシフトする修正を行い、data/ft5_daily.jsonを再生成した(アプリ側のsignal-core.js/app.js/edit-bars.jsのコードは無変更、データが正しくなるだけ)。v41: edit-bars.htmlがFT5+スクショ履歴だけを見ていてTwelve Data補完を実装していなかったため(index.htmlはacquireBars()で自動補完している)、両ページで表示が食い違う不整合があった。acquireBars/loadSettings/saveSettingsをapp.jsからsignal-core.jsへ移動して共有し、edit-bars.htmlでもAPIキーが設定されていればTwelve Dataで自動補完されるようにした(教訓90)。v40: 「過去1週間分の4本値を手動編集」ページ(edit-bars.html/edit-bars.js)を新設。
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
