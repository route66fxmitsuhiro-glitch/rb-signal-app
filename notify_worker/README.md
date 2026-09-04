# RBシグナル通知 — Cloudflare Worker 版

新規シグナルが出た日の朝(NY 17:00 = 取引日の変わり目の前後)に、GBPJPY /
GBPUSD / USDJPY の日足・週足シグナルをチェックして **Discord に通知**します。

旧 GitHub Actions 版(`notify/check-signals.js`)の置き換えです。GitHub の
スケジュール実行は数時間遅延することがあり、Web Push の購読も失効しやすく
エラーの原因になっていました。この版は:

- **Cron Triggers** … Cloudflare のスケジュールは時刻がほぼ正確
- **通知先が Discord Webhook** … 失効しない。スマホの Discord アプリに届く
- **重複防止が Workers KV** … git へのコミット戻しが不要
- 秘密情報(APIキー・Webhook URL)はすべて Cloudflare 側に置く

判定ロジック(`signal-core.js`)はアプリ本体と共通です。`worker.js` は
`build_worker.py` が `signal-core.js` + `worker_body.js` から自動生成した
**単一ファイル**なので、そのまま貼り付けられます。

---

## セットアップ(ダッシュボードで貼る場合・CLI不要)

### 1. Discord の Webhook URL を用意

Discord のサーバー → 通知を受けたいチャンネル → 歯車(チャンネルの編集) →
**連携サービス → ウェブフック → 新しいウェブフック → ウェブフックURLをコピー**。
`https://discord.com/api/webhooks/....` の形式。

### 2. Cloudflare で Worker を作る

1. [dash.cloudflare.com](https://dash.cloudflare.com) にログイン(無料アカウントでOK)
2. **Workers & Pages → Create → Workers → Create Worker** → 名前は `rb-signal-notify` など
3. **Edit code** を開き、既定のコードを全部消して **`notify_worker/worker.js` の中身を丸ごと貼り付け** → **Deploy**

### 3. KV(重複防止フラグ)を用意してバインド

1. **Workers & Pages → KV → Create a namespace** → 名前は `rb-signal-kv` など
2. さっきの Worker → **Settings → Bindings → Add → KV namespace**
   - Variable name: **`RB_KV`**(この名前ちょうど)
   - KV namespace: 作った namespace を選択
   - Save

### 4. Secret を2つ登録

Worker → **Settings → Variables and Secrets → Add**、**Type = Secret** で:

| 名前 | 値 |
|---|---|
| `TWELVE_DATA_API_KEY` | Twelve Data の APIキー(アプリで使っているものと同じでOK) |
| `DISCORD_WEBHOOK_URL` | 手順1でコピーした Webhook URL |

### 5. Cron Triggers を設定

Worker → **Settings → Triggers → Cron Triggers → Add Cron Trigger**、以下を3つ:

```
45 20 * * *
45 21 * * *
30 23 * * *
```

(夏時間の NY 17:00 = UTC 21:00、冬時間 = UTC 22:00。その少し前に発火。Worker 側で
「直近の NY 17:00 境界の -30分〜+8時間」なら処理 + KV で取引日ごと1回に制限するので、
多少ずれても複数発火しても通知は1回だけ。)

### 6. 動作確認

ブラウザで Worker の URL を開く:

- `https://rb-signal-notify.<あなた>.workers.dev/?test=1&nosend=1`
  → 時刻ウィンドウを無視して判定だけ実行し、結果 JSON を表示(Discord には送らない)
- `?test=1`(nosend なし) → シグナルがあれば実際に Discord に送信

`log` に `discord 204` が出れば送信成功。`新規シグナルなし` なら今日はエントリー不要。

---

## セットアップ(wrangler CLI を使う場合)

```bash
npm i -g wrangler
cd notify_worker
wrangler kv namespace create RB_KV      # 出力の id を wrangler.toml の id= に貼る
wrangler secret put TWELVE_DATA_API_KEY
wrangler secret put DISCORD_WEBHOOK_URL
wrangler deploy
```

`wrangler.toml` に cron と KV バインドが書いてあります。

---

## メンテナンス

`signal-core.js` を変更したら、Worker にも反映が必要です:

```bash
python notify_worker/build_worker.py     # worker.js を再生成
```

再生成した `worker.js` を Cloudflare のエディタに貼り直す(または `wrangler deploy`)。

---

## 旧 GitHub Actions 版について

`.github/workflows/rb-signal-notify.yml` と `notify/check-signals.js` は削除しました。
GitHub Secrets の `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `PUSH_SUBSCRIPTION` は
もう使いません(残しておいても害はありませんが、消して構いません)。
`TWELVE_DATA_API_KEY` は Cloudflare 側にも登録する形になります。
