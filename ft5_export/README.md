# FT5データ・エクスポート(アプリの本番データソースをTwelve DataからFT5へ)

## 背景

2026-09-05〜06の検証で、アプリが使っていたTwelve Data(サードパーティAPI)と
FT5(EAの実機検証に使ってきたStandard Data Feed/Forexite)のOHLCが数〜十数pips
食い違い、日足RideThinのN=1ブレイク判定が最大3割ほど狂いうることが判明した
(直近の健全な期間で比較しても水木金は88〜90%一致・月火は29〜60%まで低下)。

「EAで検証してきたのと同じデータにアプリも忠実であるべき」という方針のもと、
**FT5のBars.dat(このPC上のFT5アプリが持つ実データ)を最優先のデータソースにし、
古すぎる場合だけTwelve Dataへ自動フォールバックする**設計にした。

## 使い方(毎回この順番で)

1. **Forex Tester 5アプリを開き、「データ更新」を実行する**(ヒストリーの
   再ダウンロード。この操作自体はこのプロジェクトで既にお使いの機能です)
2. このフォルダの **`update_and_push.ps1` を右クリック→PowerShellで実行**
   (`export_daily.py`を実行→変更があればGitHubへコミット・push、を自動で行う)
3. 数十秒〜数分待てば、GitHub Pages経由でスマホアプリ・通知Workerの両方に反映される

手順1を忘れると、Bars.dat自体が更新されないため意味がありません。

## 仕組み

- `export_daily.py`: `C:\ForexTester5\data\History\<PAIR>\Bars.dat` から直近
  200日分の1分足を読み、日足に集計して `../data/ft5_daily.json` に書き出す
  (GBPJPY/GBPUSD/USDJPYの3ペア、コアが使う分のみ)。カレンダー日でそのまま
  集計した生の値(土曜マージ・日曜足の扱いなどの加工はしない)。加工は
  `signal-core.js` の既存ロジック(`processDailyBars`)が担当する。
- アプリ・通知Workerは `fetchRawDailyValuesAuto()` 経由でこのJSONを取得する。
  **最終日が直近1営業日以内なら採用、それより古ければ自動的にTwelve Dataへ
  切り替える**(黙って古いデータを使わないための安全弁)。どちらを使ったかは
  画面の各ペアのバッジ・取得ステータス欄に必ず表示される。

## 注意

- `data/ft5_daily.json` は数十KBの小さいファイルで、リポジトリにコミットする
  (`Bars.dat` 本体[数百MB]はコミットしない、これは各自のPCにのみ存在)。
- CHFJPY・AUDJPYのBars.datは2023年で更新が止まっている(教訓、このプロジェクト
  で以前から既知の制約)。今のところコア(GBPJPY/GBPUSD/USDJPY)のみが対象。
