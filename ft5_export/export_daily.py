# -*- coding: utf-8 -*-
"""
FT5(Forex Tester 5、デスクトップ版)が持っている**日足そのもの**を抜き出し、
rb_signal_app/data/ft5_daily.json に書き出す。

【2026-09-10、設計変更: 分足からの再集計をやめ、FT5のD1キャッシュを直読みする】
EA(RB_Broker)は FT5 の TimeZone=2 / DST=1、つまりニューヨーククローズ
(NY 17:00 = 日本時間 夏6:00 / 冬7:00)区切りの日足で動いている。

旧版は History の1分足をPython側でNY17:00区切りに集計し直していたが、
FT5が実際に使っている日足と**丸1日ずれる**ことが実測で判明した
(FT5のD1と突き合わせると、こちらのラベルDがFT5のD+1に対応し、しかも
端の値が数pips食い違う)。FT5内部の区切りの正確な規約を外から再現するのは
割に合わないため、**FT5が自分で作った日足をそのまま読む**方式に変更した。

  読む場所: C:\\ForexTester5\\data\\Testing\\<SYM>\\1440\\Bars.dat

これは FT5 がプロジェクトのタイムゾーン設定で生成する日足キャッシュで、
EAが `High(1)` などで参照するバーと同一。区切りの計算がゼロになるので、
このセッションで丸一日溶かした「1日ずれ」の類のバグが構造的に起こらない。

【重要な前提と安全装置】
Testing/ のキャッシュは「最後に開いた/実行したプロジェクト」の設定で
作り直される。TimeZone=0 のプロジェクトを開くとカレンダー日区切りの
日足に置き換わってしまうため、書き出し前に**直近1年に土日ラベルの日足が
無いこと**(ブローカー時間なら週5本になる)を検査し、違っていれば中止する。

使い方:
  1. FT5で TimeZone=2 / DST=1 のプロジェクトを開き、データを最新化して実行する
     (D1キャッシュはこのときに作られる)
  2. このスクリプトを実行する: python export_daily.py
  3. git add/commit/push する(update_and_push.ps1 でまとめて実行可能)
"""
import json
import os
import sys
from collections import Counter
from datetime import datetime, timezone, timedelta

import numpy as np
import pandas as pd

HEADER_SIZE = 12
RECORD_SIZE = 48
OLE_EPOCH = pd.Timestamp("1899-12-30")

FT5_TESTING = r"C:\ForexTester5\data\Testing"

# アプリの signal-core.js の PAIRS と揃える(symbol文字列がそのままキーになる)。
# balanced 版の9衛星が必要とするペアを全部含む:
#   GBPJPY … コア日足/週足・GBPFade・GBPJPYstreak・GBPOutside・ERゲート
#   GBPUSD … コア日足/週足・ERゲート
#   USDJPY … コア日足/週足・USDOutside・USDJPYstreak・USDWeeklyStreak・ERゲート
#   AUDJPY … AUDoutside・AUDday2fail
#   EURJPY … EURJPYfadeOut
# CHFJPY は現構成でどの層も使っていないため対象外。
PAIRS = {
    "GBP/JPY": "GBPJPY",
    "GBP/USD": "GBPUSD",
    "USD/JPY": "USDJPY",
    "AUD/JPY": "AUDJPY",
    "EUR/JPY": "EURJPY",
}

# 書き出す日足の本数。一番長い前提は週足ATR14(15本の週足 ≒ 75営業日)なので
# それに余裕を持たせる。1本あたり約80バイトなので120本でも数十KB。
EXPORT_BARS = 120

# 土日ラベル検査の対象期間(日)。古いデータには週末バーが混じっている
# ペアがある(AUDJPYは2023-03以前に105本)ため、直近だけを見る。
WEEKEND_CHECK_DAYS = 365

_HERE = os.path.dirname(os.path.abspath(__file__))
OUT_PATH = os.path.join(_HERE, "..", "data", "ft5_daily.json")


def parse_bars_dat_tail(path, max_records):
    """Bars.dat の末尾だけを読んでDataFrameを返す(タイムフレーム共通の形式)。

    date_ole はそのバーの時刻。旧実装は1分足向けに -1分 していたが、
    ここでは補正せず生の値を使い、日付ラベルはこの生の時刻の暦日とする
    (この規約でFT5のD1が月〜金の週5本になることを実測で確認済み)。
    """
    with open(path, "rb") as f:
        f.seek(0, 2)
        size = f.tell()
        total = (size - HEADER_SIZE) // RECORD_SIZE
        n = min(total, max_records)
        f.seek(HEADER_SIZE + (total - n) * RECORD_SIZE)
        raw = f.read(n * RECORD_SIZE)

    arr = np.frombuffer(raw, dtype="<f8").reshape(-1, 6)
    open_, close_, high_, low_, volume, date_ole = arr.T
    dt = (OLE_EPOCH + pd.to_timedelta(date_ole, unit="D")).round("min")
    df = pd.DataFrame({"datetime": dt, "open": open_, "high": high_,
                       "low": low_, "close": close_})
    return df[date_ole > 0].reset_index(drop=True)


def drop_forming_bars(df, code):
    """形成中(未確定)の日足を落とす。

    FT5のD1キャッシュは**まだ完成していないバーも含む**。実測(2026-09-10)では
    最終バーが分足175本(通常1,436本)しかない状態でエクスポートされ、
    アプリ・通知がその未確定バーを「前日」として判定していた。
    2026-09-07に朝9:00区切りで踏んだのと同じ罠。

    D1のラベルは Testing/<SYM>/1/Bars.dat の分足の暦日と一致するので、
    日ごとの分足数を数え、中央値の60%未満の日を未確定として落とす。
    分足ファイルが無い場合は落とさず警告だけ返す(判断材料が無いため)。
    """
    mpath = os.path.join(FT5_TESTING, code, "1", "Bars.dat")
    if not os.path.exists(mpath):
        return df, f"{code}: 分足が見つからず未確定バーの判定ができません"
    m = parse_bars_dat_tail(mpath, 60000)
    if m.empty:
        return df, f"{code}: 分足が空で未確定バーの判定ができません"
    counts = m.groupby(m["datetime"].dt.date).size()
    if len(counts) < 5:
        return df, None
    med = counts.median()
    thin = {str(d) for d, c in counts.items() if c < med * 0.6}
    if not thin:
        return df, None
    # **末尾から連続する分だけ**落とす。途中の薄い日(祝日など。実測では
    # 2026-08-24・08-31 のような月曜)は取引が少ないだけの正当な確定バーで、
    # これを抜くと日足の連続性が壊れ N=1 ブレイクの前日/前々日比較がずれる。
    dates = df["datetime"].dt.date.astype(str).tolist()
    cut = len(dates)
    while cut > 0 and dates[cut - 1] in thin:
        cut -= 1
    if cut == len(dates):
        return df, None
    dropped = dates[cut:]
    note = (f"{code}: 末尾の未確定バーを{len(dropped)}本除外 {dropped} "
            f"(分足が中央値{med:.0f}本の60%未満)")
    return df.iloc[:cut], note


def check_broker_boundary(df, symbol):
    """直近1年に土日ラベルの日足が無いことを確認する。

    ブローカー時間(NY17:00区切り)なら日曜の立ち上がり足が月曜に吸収され、
    1週間はきっかり月〜金の5本になる。土日が出てくるということは、
    キャッシュがカレンダー日区切り(TimeZone=0)で作り直されている。
    """
    recent = df[df["datetime"] >= df["datetime"].max() - pd.Timedelta(days=WEEKEND_CHECK_DAYS)]
    we = int((recent["datetime"].dt.weekday >= 5).sum())
    if we:
        c = Counter(recent["datetime"].dt.weekday)
        return (f"{symbol}: 直近{WEEKEND_CHECK_DAYS}日に土日ラベルの日足が{we}本あります"
                f"(内訳 土{c.get(5,0)} 日{c.get(6,0)})。"
                f"FT5のD1キャッシュがブローカー時間で作られていません。")
    return None


def main():
    out = {
        "generated_at": datetime.now(timezone(timedelta(hours=9))).isoformat(),
        "source": "FT5 Testing/<SYM>/1440/Bars.dat (D1 cache, TimeZone=2/DST=1)",
        "boundary": "broker-NY17:00",
        "pairs": {},
    }
    errors = []
    for symbol, code in PAIRS.items():
        path = os.path.join(FT5_TESTING, code, "1440", "Bars.dat")
        print(f"{symbol}: {path}")
        if not os.path.exists(path):
            errors.append(f"{symbol}: D1キャッシュがありません({path})")
            print("  ! 見つかりません")
            continue
        # 検査用に多めに読んでから末尾EXPORT_BARS本だけ書き出す。
        # ファイル末尾に無効レコード(date_ole<=0のパディング)が数百件ある
        # ペアがあるため(AUDJPY/CHFJPYで実測)、余裕を持って読む。
        df = parse_bars_dat_tail(path, 3000)
        err = check_broker_boundary(df, symbol)
        if err:
            errors.append(err)
            print(f"  ! {err}")
            continue
        df, drop_note = drop_forming_bars(df, code)
        if drop_note:
            print(f"  {drop_note}")
        tail = df.tail(EXPORT_BARS)
        out["pairs"][symbol] = [
            {"date": r["datetime"].date().isoformat(),
             "open": round(float(r["open"]), 6), "high": round(float(r["high"]), 6),
             "low": round(float(r["low"]), 6), "close": round(float(r["close"]), 6)}
            for _, r in tail.iterrows()
        ]
        print(f"  {len(tail)}本  {tail['datetime'].min().date()} 〜 {tail['datetime'].max().date()}")

    if errors:
        print("\n中止しました:")
        for e in errors:
            print(f"  - {e}")
        print("\nFT5で TimeZone=2 / DST=1 のプロジェクトを開いて実行し、"
              "D1キャッシュを作り直してから再試行してください。")
        sys.exit(1)

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    size_kb = os.path.getsize(OUT_PATH) / 1024
    print(f"\n書き出し完了: {os.path.abspath(OUT_PATH)}  ({size_kb:.0f} KB)")
    for symbol in PAIRS:
        if out["pairs"].get(symbol):
            print(f"  {symbol}: 最終日 {out['pairs'][symbol][-1]['date']}")


if __name__ == "__main__":
    main()
