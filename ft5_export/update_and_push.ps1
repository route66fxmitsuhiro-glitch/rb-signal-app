# FT5のBars.datから最新の日足を抽出し、GitHubへpushしてアプリに反映する。
#
# 前提: このスクリプトを実行する前に、Forex Tester 5 アプリで「データ更新」
# (ヒストリーの再ダウンロード)を先に済ませておくこと。それをせずにこの
# スクリプトだけ実行しても、Bars.dat の中身が古いままなので意味がない。
#
# 使い方: このファイルを右クリック→「PowerShellで実行」、または
#   powershell -ExecutionPolicy Bypass -File update_and_push.ps1

$ErrorActionPreference = "Stop"
$scriptDir = $PSScriptRoot
$repoRoot = Split-Path -Parent $scriptDir

Write-Host "=== 1/3: FT5のBars.datから日足を抽出 ===" -ForegroundColor Cyan
$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) { $py = Get-Command py -ErrorAction SilentlyContinue }
if (-not $py) {
    Write-Host "エラー: python(またはpy)コマンドが見つかりません。Pythonをインストールしてください。" -ForegroundColor Red
    exit 1
}
& $py.Source "$scriptDir\export_daily.py"
if ($LASTEXITCODE -ne 0) {
    Write-Host "エラー: export_daily.py が失敗しました。" -ForegroundColor Red
    exit 1
}

Write-Host "`n=== 2/3: 変更の確認 ===" -ForegroundColor Cyan
Set-Location $repoRoot
$diff = git status --porcelain data/ft5_daily.json
if (-not $diff) {
    Write-Host "前回と同じデータのため、変更なし。ここで終了します。" -ForegroundColor Yellow
    exit 0
}
Write-Host "変更を検出。コミット・pushします。"

Write-Host "`n=== 3/3: Git commit & push ===" -ForegroundColor Cyan
git add data/ft5_daily.json
git commit -m "FT5日足データを更新 ($(Get-Date -Format 'yyyy-MM-dd HH:mm'))"
git push origin main
if ($LASTEXITCODE -ne 0) {
    Write-Host "エラー: git push に失敗しました。ネットワークやログイン状態を確認してください。" -ForegroundColor Red
    exit 1
}
Write-Host "`n完了しました。GitHub Pagesへの反映まで数十秒〜数分かかります。" -ForegroundColor Green
