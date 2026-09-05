# -*- coding: utf-8 -*-
"""
FT5(Forex Tester 5、デスクトップ版)の Bars.dat から直近の日足を抽出し、
rb_signal_app/data/ft5_daily.json に書き出す。

EAの実機検証(23年分)に使われてきたのと全く同じデータソース
(Standard Data Feed/Forexite)から、アプリが「今日の判定」に使う直近分だけを
取り出すためのスクリプト。Twelve Data(サードパーティAPI)とFT5のOHLCが
数〜十数pips食い違い、日足RideThinのN=1ブレイク判定を最大3割ほど狂わせうる
ことが2026-09-05〜06の検証で判明したため、EAと同じデータへの切り替えを
目指す(アプリ側は ft5_daily.json を最優先で読み、古すぎる場合だけ
Twelve Dataへ自動フォールバックする設計、signal-core.js 参照)。

出力する日足は「カレンダー日でそのまま集計」した生の値(土曜マージ・日曜足の
扱いなどの加工は一切しない)。これは Twelve Data から取得した際の
fetchRawDailyValues() の出力形式と揃えてあり、加工(processDailyBars)は
すべて JS 側の既存ロジックに任せる(ロジックの二重実装を避けるため)。

使い方:
  1. FT5アプリで「データ更新」を実行し、Bars.datを最新化する
  2. このスクリプトを実行する: python export_daily.py
  3. git add/commit/push する(update_and_push.ps1 でまとめて実行可能)
"""
import json
import struct
import sys
from datetime import datetime, timezone, timedelta

import numpy as np
import pandas as pd

HEADER_SIZE = 12
RECORD_SIZE = 48
OLE_EPOCH = pd.Timestamp("1899-12-30")

# アプリの signal-core.js の PAIRS と揃える(symbol文字列がそのままキーになる)
PAIRS = {
    "GBP/JPY": r"C:\ForexTester5\data\History\GBPJPY\Bars.dat",
    "GBP/USD": r"C:\ForexTester5\data\History\GBPUSD\Bars.dat",
    "USD/JPY": r"C:\ForexTester5\data\History\USDJPY\Bars.dat",
}

# 直近何日分(カレンダー日)の1分足を読めば足りるか。ATR14・ER20本ゲートに
# 必要な確定日足21本+週足集計の余裕を見て、Twelve Data側のAPI_OUTPUT_SIZE=60
# より広めに200日分を対象にする(ファイルサイズは小さいまま、余裕重視)。
LOOKBACK_DAYS = 200

OUT_PATH = r"c:\Users\route\Desktop\ai作業場\rb_signal_app\data\ft5_daily.json"


def parse_bars_dat_tail(path, lookback_days):
    """Bars.dat 全体を読まず、末尾 lookback_days*1440分 相当だけを読む
    (400MB超のファイルを毎回全部パースすると遅いため)。"""
    record_count_needed = lookback_days * 24 * 60 + 2000  # 少し余裕を持たせる
    with open(path, "rb") as f:
        f.seek(0, 2)
        file_size = f.tell()
        total_records = (file_size - HEADER_SIZE) // RECORD_SIZE
        read_records = min(total_records, record_count_needed)
        offset = HEADER_SIZE + (total_records - read_records) * RECORD_SIZE
        f.seek(offset)
        raw = f.read(read_records * RECORD_SIZE)

    arr = np.frombuffer(raw, dtype="<f8").reshape(-1, 6)
    open_, close_, high_, low_, volume, date_ole = arr.T
    dt = OLE_EPOCH + pd.to_timedelta(date_ole, unit="D") - pd.Timedelta(minutes=1)
    dt = dt.round("min")
    df = pd.DataFrame({"datetime": dt, "Open": open_, "High": high_, "Low": low_, "Close": close_})
    df = df[date_ole > 0].reset_index(drop=True)
    return df


def to_daily_raw(df_min, lookback_days):
    cutoff = df_min["datetime"].max() - pd.Timedelta(days=lookback_days)
    df_min = df_min[df_min["datetime"] >= cutoff]
    g = df_min.groupby(df_min["datetime"].dt.date).agg(
        open=("Open", "first"), high=("High", "max"), low=("Low", "min"), close=("Close", "last"))
    g = g.reset_index().rename(columns={"datetime": "date"}).sort_values("date").reset_index(drop=True)
    return [
        {"date": str(r["date"]), "open": round(float(r["open"]), 6), "high": round(float(r["high"]), 6),
         "low": round(float(r["low"]), 6), "close": round(float(r["close"]), 6)}
        for _, r in g.iterrows()
    ]


def main():
    out = {
        "generated_at": datetime.now(timezone(timedelta(hours=9))).isoformat(),
        "source": "FT5 Bars.dat (Standard Data Feed/Forexite)",
        "pairs": {},
    }
    for symbol, path in PAIRS.items():
        print(f"{symbol}: {path} を読み込み中...")
        try:
            df_min = parse_bars_dat_tail(path, LOOKBACK_DAYS)
        except FileNotFoundError:
            print(f"  ! ファイルが見つかりません、スキップします")
            continue
        daily = to_daily_raw(df_min, LOOKBACK_DAYS)
        out["pairs"][symbol] = daily
        last = daily[-1] if daily else None
        print(f"  {len(daily)}本  最終日: {last['date'] if last else 'なし'}")

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"\n書き出し完了: {OUT_PATH}")
    for symbol in PAIRS:
        if symbol in out["pairs"] and out["pairs"][symbol]:
            print(f"  {symbol}: 最終日 {out['pairs'][symbol][-1]['date']}")


if __name__ == "__main__":
    main()
