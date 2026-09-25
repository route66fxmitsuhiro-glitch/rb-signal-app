// Service Worker: アプリの見た目(HTML/CSS/JS/アイコン)だけをキャッシュする。
// 為替データの取得(Twelve Data API)はキャッシュせず、常に最新を取りに行く。
const CACHE_NAME = "rb-signal-shell-v56"; // v56: 分散レイヤーの「保有中」表示をシグナルの有無と無関係に出す(以前はシグナル成立日しか出ず、保有中の層が「シグナルなし」だけに見えた)。 // v55: コアの「既に保有中」判定が同じペア・同じ向きの衛星建玉(timeframe=daily)まで数えていたバグを修正(hasOpenPositionでisSatelliteを除外)。 // v54: 保有中トランシェの削除・決済・記録の後に「本日の新規シグナル」欄も描き直す(削除後も「既に保有中」が残るバグ)。削除時に決済済み記録も消えることを警告。手動追加でエントリー日を指定可能に。 // v53: フォワード記録ページに「約定履歴スクショ→決済価格」のAI読み取りを追加(未入力の欄に下書きを入れ、保存はユーザーが押す)。signal-core.js に callClaudeJson/downscaleImage/readFileAsDataUrl を共通化。 // v52: ERゲートのラグを全層0に(+90分執行ではAUDJPY/EURJPYの層も当日ERを見る。v5実機ログとの照合で11層95.9%→99.4%)。 // v51: ロット計算の基準DD(REFERENCE_MAX_DD_USD)を旧コア単体の1,968.15から v5全体の実測スプレッド後の最大DD 3,024 に更新(表示枚数は約65%に)。 // v50: フォワード記録ページ(forward.html/forward.js/forward-ref.js)を新設。決済チェック時に決済価格を入力、記録ボタンが出たシグナルを端末に記録、v5バックテストの期間別分布(10/50/90%)と実績を比較。 // v49: 「判定根拠を自分の目で検算する方法」を現行のNY17:00区切り(朝6:00/冬7:00)に合わせて書き直し。 // v48: 本日の新規シグナル欄で「前日/前々日」を mm/dd(曜) 表記に変更し、ペアカードの取得元バッジ(FT5○本/スクショ○本)と取得完了行の取得元一覧を非表示に(ユーザー要望)。 // v47: EA最終版 Exec730v5 に合わせて衛星ロットを更新(GBPJPYstreak 0.02→0.04 / USDOutside 0.18→0.12 / USDWeeklyStreak 0.09→0.20 / AUDoutside 0.18→0.22)し、ピンバー反転2層(GBPJPY・GBPUSD、衝突ゲート非参加)を追加。 // v46: 自動通知機能を廃止。Web Push → GitHub Actions → Cloudflare Worker + Discord と3度作り替えたが、判定に使うデータ(スクショ取り込み・手動補正した4本値)が端末のlocalStorageにしか無いため、通知側はそれを見られず、アプリと判定が食い違う構造だった(2026-09-10に「保留中の課題」として記録済み)。notify_worker/を削除し、index.htmlの通知セクション・README.mdの旧Web Push手順・app.js/signal-core.jsの通知関連コメントを撤去。執行時刻は画面上部のバナーが常時示す。 // v44: v43で直した「1ペアの失敗が他ペアを巻き添えにする」バグの続報。「一部ペアが保存されなかった」ことが淡いグレー文字の注記1行だけで、成功時と見分けにくく見落とされやすかった(ユーザーからの「エラーメッセージで表示される仕様か」という質問で発覚)ため、①読み取り直後のステータス行を赤色化、②NG行がある時に赤帯の警告文を追加、③取り込み後に保存されなかったペアがあればalert()で明示、の3点で目立たせるよう修正(app.js/style.css)。v43: スクショ取り込みで5ペア中1ペアでもエラーになると、正しく読めていた残り4ペアまで含めて「取り込む」ボタンが消え、その日は全ペア未保存のままTwelve Dataフォールバックに落ちるバグを発見(GBPJPY 2026-09-17の高値が209.245[TD]のまま209.103[ブローカー実値]に更新されなかった実例で発覚。教訓100)。renderShotReview()を、エラーのないペアだけを個別に取り込み対象にする方式に修正(app.js)。v42: FT5のD1キャッシュが付けている日付ラベルが、実際のセッション開始日(ブローカー・EAのOpenTime・1分足PKL集計と一致する規則)より常に1営業日進んでいたことが判明(ユーザーがブローカーのチャートと見比べて発見。分足データとの直接比較・PKLベース日足との比較の両方で確認)。ft5_export/export_daily.pyでラベルを1営業日前にシフトする修正を行い、data/ft5_daily.jsonを再生成した(アプリ側のsignal-core.js/app.js/edit-bars.jsのコードは無変更、データが正しくなるだけ)。v41: edit-bars.htmlがFT5+スクショ履歴だけを見ていてTwelve Data補完を実装していなかったため(index.htmlはacquireBars()で自動補完している)、両ページで表示が食い違う不整合があった。acquireBars/loadSettings/saveSettingsをapp.jsからsignal-core.jsへ移動して共有し、edit-bars.htmlでもAPIキーが設定されていればTwelve Dataで自動補完されるようにした(教訓90)。v40: 「過去1週間分の4本値を手動編集」ページ(edit-bars.html/edit-bars.js)を新設。
const SHELL_FILES = [
  "./",
  "./index.html",
  "./edit-bars.html",
  "./forward.html",
  "./style.css",
  "./signal-core.js",
  "./app.js",
  "./edit-bars.js",
  "./forward.js",
  "./forward-ref.js",
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
