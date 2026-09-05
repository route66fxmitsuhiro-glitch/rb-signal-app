# RBシグナル(コア版) — セットアップ手順

GBPJPY/GBPUSD/USDJPYの**日足RideThin(5トランシェ)+週足ドンチャン(3階層)**のコアに加え、
分散レイヤー第1弾として**USDJPYアウトサイドデイ継続**(前日アウトサイドデイ＋3ペア平均効率比
> 0.16 で前日終値方向へ順張り、固定逆指値 2.25×ATR14、5営業日で時間切れ手仕舞い)を実装した
PWA(Webアプリ)です。ride サーキットブレーカーと残りの分散レイヤーは未実装(順次追加予定)。

## できること / できないこと

**できること**
- ボタン一つで当日の新規ブレイクアウト・シグナル(方向)を日足・週足それぞれ判定
- ATR14(日足)・先週レンジ幅(週足)からRを算出し、各トランシェの目標値幅を表示
- 運用資金・DD許容度から実際のロット数を自動計算(教訓27のDD逆算方式)
- 実際の約定価格を記録すると、保有中トランシェの固定目標値と、毎朝更新される
  撤退ライン(反対ブレイク水準、rideはハードストップとの近い方)を表示
- (任意設定)Cloudflare Worker が新規シグナルが出た日の朝(米国東部時間17:00の
  取引日境界の前後)に判定し、Discord へ通知する(`notify_worker/README.md` 参照)。
  通知はあくまで「シグナルが出たことを知らせる」だけで、発注は行わない。

**できないこと(重要)**
- 自動発注はしません。表示された内容を見て、自分でブローカーに発注してください。
- ride サーキットブレーカーと、USDJPYアウトサイドデイ継続を除く分散レイヤー
  (EURJPY/CHFJPYフェード、各種ストリーク逆張り、インサイドデイ等)は未実装です。
  今のところ「本家RideBreaker(12層)」の一部分しか再現していません。
- ロジックはCLAUDE.mdの記述・EA本体(`RB12tuned_WDLite.cpp`)から移植したもので、
  実機(FT5)トレードログとの紙トレード数値照合を実施済み(2026-09-04〜05)。
  **日足RideThin: 99.4%一致 / 週足ドンチャン: 98.1%一致 / USDJPYアウトサイドデイ:
  91.9%一致**(いずれもEAの実エントリー日・方向との照合。詳細はCLAUDE.mdの
  「紙トレード数値照合」関連の節を参照)。残り数%はFT5データの日足セッション
  境界のナイフエッジ差によるもので既知の限界。ただし本番のデータソースは
  Twelve Data(FT5ではない)のため、この一致率にさらにデータソース差が乗る点に注意。
- ATR14は単純平均で実装しています(Wilder平滑化ではありません)。EA側と一致確認済み。

## 1. Twelve Data の無料APIキーを取得する

1. https://twelvedata.com/ でアカウント登録(無料)
2. ダッシュボードでAPIキーをコピー
3. 無料プランは1日800リクエストまで(このアプリは1回の判定取得で3ペア×1リクエスト
   = 3リクエスト程度しか使わないので十分)

## 2. 動作確認(自分のPCで)

このフォルダで簡易サーバーを立てて、PCのブラウザで一度動作確認してください。

```powershell
cd rb_signal_app
python -m http.server 8000
```

ブラウザで `http://localhost:8000/` を開き、設定にAPIキーを入力→「本日の判定を取得」
を押して、エラーなくシグナルが表示されるか確認します。

**Twelve DataがブラウザからのCORSリクエストをブロックしている場合**、コンソールに
CORSエラーが出ます。その場合は無料のCORSプロキシ(例: corsproxy.io等)を`app.js`の
`fetchDailyBars()`内のURLに挟むか、別のデータAPIへの切り替えが必要です(未検証の
残課題として認識しておいてください)。

## 3. スマホからアクセスできるようにホスティングする

ローカルの `python -m http.server` はPCと同じWiFi内からしかアクセスできず、
PWAのインストール(ホーム画面追加)にはHTTPSが必要なため、無料の静的ホスティングに
上げるのが確実です。

**GitHub Pages(推奨・無料)**
1. このフォルダの中身をGitHubリポジトリにpush
2. リポジトリ設定 → Pages → ブランチを指定して公開
3. 発行されたURL(`https://ユーザー名.github.io/リポジトリ名/`)にAndroidのChromeで
   アクセス

## 4. Androidのホーム画面に追加する

1. Android版Chromeで上記URLを開く
2. 右上のメニュー(縦三点) → 「アプリをインストール」または「ホーム画面に追加」
3. ホーム画面のアイコンをタップすると、アドレスバーのないアプリのような見た目で開く

## 5. シグナル通知(Web Push)を設定する(任意)

アプリを開かなくても、新規シグナルが出た朝にスマホへプッシュ通知を届けたい場合の
手順です。GitHub Actionsが自動でシグナルを判定し、ブラウザ純正のプッシュ通知
(Web Push)を送ります(発注は行いません、あくまで通知だけです)。新しいアプリの
インストールは不要です。

### 5-1. アプリで通知を有効にする

1. アプリの「設定」を開き、一番下の「通知を有効にする」ボタンを押す
2. ブラウザから通知の許可を求められるので「許可」する
3. 「登録できました」と表示され、テキストエリアにJSONが出るので「コピー」ボタンで
   コピーする(このJSONがこの端末への通知の宛先情報です)

**iPhoneの場合**: Safariで直接開いた状態では動作しません。必ずSafariで
「ホーム画面に追加」してPWAとしてインストールし、ホーム画面のアイコンから
開いた状態で上記の手順を行ってください(iOS16.4以降が必要)。

### 5-2. VAPID鍵を発行する(初回のみ、1回だけ)

Web Pushの送信元を認証するための鍵ペアです。PCで以下を実行して生成します
(Pythonの`pywebpush`ライブラリを使用、`pip install pywebpush`で事前にインストール)。

```python
from py_vapid import Vapid02
from cryptography.hazmat.primitives import serialization
import base64

v = Vapid02()
v.generate_keys()

raw_public = v.public_key.public_bytes(
    encoding=serialization.Encoding.X962,
    format=serialization.PublicFormat.UncompressedPoint,
)
print("公開鍵:", base64.urlsafe_b64encode(raw_public).decode().rstrip("="))

priv_value = v.private_key.private_numbers().private_value
priv_bytes = priv_value.to_bytes(32, "big")
print("秘密鍵:", base64.urlsafe_b64encode(priv_bytes).decode().rstrip("="))
```

生成した**公開鍵**は`app.js`の`VAPID_PUBLIC_KEY`に埋め込み済みです(変更する場合は
書き換えてデプロイし直してください)。**秘密鍵**は次の手順でSecretsにのみ登録し、
コードには書きません。

### 5-3. GitHub Actions Secretsに登録する

このリポジトリの GitHub上のページ → Settings → Secrets and variables → Actions →
「New repository secret」で、以下の4つを登録します(コードには絶対に直接書かない)。

- `TWELVE_DATA_API_KEY` … 手順1で取得したTwelve DataのAPIキー
- `VAPID_PUBLIC_KEY` … 5-2で生成した公開鍵(`app.js`に埋め込んだものと同じ値)
- `VAPID_PRIVATE_KEY` … 5-2で生成した秘密鍵
- `PUSH_SUBSCRIPTION` … 5-1でコピーしたJSON

### 5-4. 動作確認

1. GitHubリポジトリの「Actions」タブ → 左側の「RBシグナル通知」ワークフロー →
   「Run workflow」ボタンで手動実行できます(スケジュール実行を待たずにテスト可能。
   ただし手動実行時も「今が対象時刻に近いか」の判定はそのまま行われるため、対象
   時刻から離れた時間に実行すると「対象時刻ではありません」で何もせず終了します。
   ロジック自体を試したいだけなら`notify/check-signals.js`の`isNowTargetTime()`
   呼び出しを一時的にコメントアウトしてテストしてください)
2. 実行ログで正常終了を確認し、シグナルがある日ならスマホに通知が届くか確認して
   ください

### 5-5. 通知のタイミング・仕組み

- FXの新しい取引日は米国東部時間17:00に始まる。この15分前(16:45
  America/New_York)を狙って通知する。サマータイム(3月〜11月)は自動的に
  JST5:45頃、冬時間(11月〜3月)はJST6:45頃にずれる
- GitHub Actionsのcronはサマータイムに連動しないため、`.github/workflows/
  rb-signal-notify.yml`は夏時間用・冬時間用の2つの固定UTC時刻で毎日起動し、
  `check-signals.js`自身がAmerica/New_Yorkのタイムゾーン変換で「今日、実際に
  対象時刻かどうか」を判定する(該当しない方の起動は数秒で終了する)
- 日足シグナルは判定した日にシグナルがあれば毎回通知
- 週足シグナルは「本日が新規判定日(直前の完成日足バーが月曜)」の日、つまり通常
  火曜日だけ通知します。これをしないと、同じ週足シグナルが確定してから次の月曜の
  足が閉じるまで最大1週間、毎回同じ内容を通知し続けてしまうためです
- その日に新規シグナルが1件もなければ、通知自体を送信しません(無音)
- 判定ロジックは`signal-core.js`をアプリ本体(`app.js`)と共有しているため、
  通知の内容とアプリを開いたときの表示は必ず一致します
- 端末を機種変更した場合や、ブラウザデータを消去した場合は、5-1をやり直して
  `PUSH_SUBSCRIPTION`を更新してください(古い購読情報は自然に無効化されます)

## ファイル構成

- `index.html` / `style.css` / `app.js` — アプリ本体(UI・localStorage管理)
- `signal-core.js` — シグナル判定の純粋ロジック(アプリ本体と通知バッチの両方から
  共有で読み込む。ブラウザの`<script>`タグからもNode.jsの`require()`からも使える)
- `notify/check-signals.js` — GitHub Actionsから実行するWeb Push通知バッチ(Node.js)
- `.github/workflows/rb-signal-notify.yml` — 通知バッチの自動実行スケジュール設定
  (夏時間・冬時間の2つの固定UTC時刻、実際の対象時刻判定はスクリプト側で行う)
- `manifest.json` — PWA設定(アイコン・アプリ名等)
- `sw.js` — オフラインでも画面が開けるようにするService Worker(為替データはキャッシュ
  しない)。プッシュ通知の受信・表示処理もここに実装。
- `icons/` — アプリアイコン(192px/512px)
- 設定・保有ポジション記録はすべて**端末のブラウザのlocalStorageに保存**され、外部には
  送信されません(Twelve Data APIへのリクエストを除く)。通知機能を有効にした場合のみ、
  ブラウザのプッシュ購読情報がGitHub Secretsに保存され(リポジトリのコードには含まれ
  ません)、GitHub Actionsからブラウザのプッシュサービス経由でシグナル内容が送信されます。
