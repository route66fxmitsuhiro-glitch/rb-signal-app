// [自動生成] `python notify_worker/build_worker.py` で
// signal-core.js + worker_body.js から生成。直接編集しない。
// signal-core.js を変更したら再生成してから Cloudflare に貼り直すこと。

"use strict";
/*
 * RBシグナル・コアロジック(共通モジュール)
 *
 * app.js(ブラウザPWA)と notify/check-signals.js(GitHub Actions通知バッチ)の
 * 両方から読み込まれる、純粋な判定ロジックだけを集めたモジュール。ロジックを
 * 2箇所に別々実装すると、片方だけ直してもう片方が古いままズレる事故が
 * 起きやすい(教訓: 「実データ再重み付け」等で繰り返し確認された「実装が
 * 2箇所に分散すると必ずどちらかが腐る」という教訓と同型)ため、必ずこの
 * ファイル一箇所だけを直せば両方に反映される構成にしている。
 *
 * UMD形式: ブラウザでは <script> タグ読み込みで window.SignalCore として、
 * Node.jsでは require('./signal-core.js') で使える。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SignalCore = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  // コア(日足RideThin・週足ドンチャン)と ER ゲートが使う3ペア。
  // ERゲートは EA の erValue[0..2] = GBPJPY/GBPUSD/USDJPY の平均なので、
  // ここに衛星用のペアを足してはいけない。
  const PAIRS = [
    { symbol: "GBP/JPY", label: "GBPJPY" },
    { symbol: "GBP/USD", label: "GBPUSD" },
    { symbol: "USD/JPY", label: "USDJPY" },
  ];

  // 衛星レイヤーだけが使う追加ペア(コア・ERゲートには参加しない)。
  const EXTRA_PAIRS = [
    { symbol: "AUD/JPY", label: "AUDJPY" },
    { symbol: "EUR/JPY", label: "EURJPY" },
  ];

  // データ取得の対象(コア3 + 追加2)。
  const ALL_PAIRS = PAIRS.concat(EXTRA_PAIRS);

  // ========== 衛星9層(RB_Broker balanced の確定パラメータ) ==========
  // すべて RB_Broker.cpp の RegOption 既定値から直接書き写したもの
  // (2026-09-10、CLAUDE.mdの記述ではなく実ソースを正とする)。
  //
  // gate: "high" … EAの `if (avgER <= th) return;`  → avgER >  th で新規許可
  //       "low"  … EAの `if (avgER >  th) return;`  → avgER <= th で新規許可
  //       "none" … ERゲートなし
  // ERは常に GBPJPY/GBPUSD/USDJPY の3ペア平均(EAの erValue[0..2])。
  const SATELLITES = [
    { id: "gbp-outside", label: "GBPOutside", symbol: "GBP/JPY", pair: "GBPJPY",
      kind: "outside_cont", title: "アウトサイドデイ継続",
      gate: "high", erThreshold: 0.0, stopMult: 1.5, holdDays: 4, lot: 0.09 },
    { id: "gbp-fade", label: "GBPFade", symbol: "GBP/JPY", pair: "GBPJPY",
      kind: "range_fade", title: "レンジフェード",
      gate: "low", erThreshold: 0.147, lookback: 7, stopMult: 2.0, holdDays: 10, lot: 0.06 },
    { id: "gbp-streak", label: "GBPJPYstreak", symbol: "GBP/JPY", pair: "GBPJPY",
      kind: "streak_rev", title: "ストリーク逆張り",
      gate: "low", erThreshold: 0.147, n: 3, stopMult: 2.0, holdDays: 3, lot: 0.02 },
    { id: "usd-outside", label: "USDOutside", symbol: "USD/JPY", pair: "USDJPY",
      kind: "outside_cont", title: "アウトサイドデイ継続",
      gate: "high", erThreshold: 0.16, stopMult: 2.25, holdDays: 5, lot: 0.18 },
    { id: "usd-streak", label: "USDJPYstreak", symbol: "USD/JPY", pair: "USDJPY",
      kind: "streak_rev", title: "ストリーク逆張り",
      gate: "none", n: 3, stopMult: 2.5, holdDays: 5, lot: 0.04 },
    { id: "usd-wstreak", label: "USDWeeklyStreak", symbol: "USD/JPY", pair: "USDJPY",
      kind: "weekly_streak_rev", title: "週足ストリーク逆張り",
      gate: "low", erThreshold: 0.229, n: 2, stopMult: 2.0, holdWeeks: 6, lot: 0.09 },
    { id: "aud-outside", label: "AUDoutside", symbol: "AUD/JPY", pair: "AUDJPY",
      kind: "outside_cont", title: "アウトサイドデイ継続",
      gate: "high", erThreshold: 0.18, stopMult: 1.0, holdDays: 5, lot: 0.18 },
    { id: "aud-day2", label: "AUDday2fail", symbol: "AUD/JPY", pair: "AUDJPY",
      kind: "day2_fail", title: "day-2ブレイク失敗フェード",
      gate: "high", erThreshold: 0.18, lookback: 15, stopMult: 1.5, holdDays: 7, lot: 0.18 },
    { id: "ej-fadeout", label: "EURJPYfadeOut", symbol: "EUR/JPY", pair: "EURJPY",
      kind: "outside_fade", title: "アウトサイドデイ・フェード",
      gate: "low", erThreshold: 0.229, stopMult: 1.0, holdDays: 5, lot: 0.18 },
  ];

  // ========== コアのロット倍率(RB_Broker balanced の確定値) ==========
  const CORE_LOTS = {
    lotSize: 0.10,          // LotSize(日足RideThin)
    wdLotSize: 0.10,        // WDLotSize(週足ドンチャン)
    trancheWeight: [0.20, 0.20, 0.25, 0.20, 0.15],
    tierR: [0.1, 0.2, 0.3, 0.5, null],
    hardStopR: -1.0,
    dailyRideLotMult: 0.5,  // DailyRideLotMult。rideトランシェのみに掛かる
    wdT01LotMult: 0.334,    // 週足T0/T1
    wdRideLotMult: 0.167,   // 週足ride
    wdTierR: [0.5, 1.0, null],
  };

  // ========== 日付・週の補助関数 ==========

  function ymd(d) {
    return d.toISOString().slice(0, 10);
  }

  // 月曜始まりの週キー(その週の月曜日のYYYY-MM-DD)を返す
  function weekKeyOf(dateStr) {
    const d = new Date(dateStr + "T00:00:00Z");
    const day = d.getUTCDay(); // 0=日,1=月,...
    const diffToMonday = day === 0 ? 6 : day - 1;
    d.setUTCDate(d.getUTCDate() - diffToMonday);
    return ymd(d);
  }

  // 「今日」は常に日本時間(JST)基準で判定する。ブラウザ(端末がJST設定の
  // 前提)だけでなく、UTC実行のGitHub Actionsランナー上のNode.jsからも
  // 同じ結果になるよう、Intl.DateTimeFormatで明示的にAsia/Tokyoへ変換する
  // (システムのローカルタイムゾーンには依存しない)。
  function todayStr(now) {
    const d = now || new Date();
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(d);
    const y = parts.find((p) => p.type === "year").value;
    const m = parts.find((p) => p.type === "month").value;
    const day = parts.find((p) => p.type === "day").value;
    return `${y}-${m}-${day}`;
  }

  // 日付文字列(YYYY-MM-DD)の曜日(UTC正午基準、weekKeyOfと同じ解釈)。0=日,6=土。
  function dowOf(dateStr) {
    return new Date(dateStr + "T12:00:00Z").getUTCDay();
  }

  // ========== 日足バーの区切り(ブローカー時間 NY 17:00) ==========
  // EA(RB_Broker)は FT5 の TimeZone=2 / DST=1、すなわちニューヨーククローズ
  // 区切りで動く。日本時間では夏 朝6:00 / 冬 朝7:00 が日足の切り替わりで、
  // 日曜の立ち上がり足は月曜に吸収され1週間は月〜金の5本になる
  // (FT5のD1キャッシュで実測: 月1215 火1213 水1214 木1214 金1215 土日0)。
  // このため旧版にあった「土曜バーを金曜へマージ」「日曜足を残すか捨てるか」
  // といった週末処理はブローカー時間では一切不要になった。

  // NY時刻に +7時間 して暦日を取ると NY 17:00 が新しい日の 00:00 になる
  // (broker_time.py と同一の定義)。Python側で2026年の全8,760時点を
  // 突き合わせ、DST境界2回を含めて完全一致することを確認済み。
  function brokerBarDate(ms) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(ms + 7 * 3600 * 1000));
    const y = parts.find((p) => p.type === "year").value;
    const m = parts.find((p) => p.type === "month").value;
    const d = parts.find((p) => p.type === "day").value;
    return `${y}-${m}-${d}`;
  }

  // 今まさに形成中(未確定)のバーの日付ラベル。
  // FT5エクスポート側のバーは常に確定済みなので、これを使うのは
  // Twelve Dataから1時間足を組み上げるフォールバック経路だけ。
  function formingBarDate(now) {
    return brokerBarDate((now || new Date()).getTime());
  }

  // 次に日足が確定する日本時間(夏"06:00"/冬"07:00")。表示用。
  function nextBarCloseJst(now) {
    const d = now || new Date();
    const off = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", timeZoneName: "short",
    }).formatToParts(d).find((p) => p.type === "timeZoneName").value;
    return off === "EDT" ? "06:00" : "07:00";
  }

  // 日付文字列を n 日ずらす。
  function shiftDate(dateStr, n) {
    const d = new Date(dateStr + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return ymd(d);
  }

  // dateStr から平日を n 日進めた日付(YYYY-MM-DD)。土日はスキップ、祝日は
  // 考慮しない目安。EAは新しい日足バー確定ごとに保有日数を+1し、HoldDays に
  // 達した最初のティックで手仕舞うため、n=HoldDays でその手仕舞い日に相当する。
  function addTradingDays(dateStr, n) {
    const d = new Date(dateStr + "T00:00:00Z");
    let added = 0;
    while (added < n) {
      d.setUTCDate(d.getUTCDate() + 1);
      const wd = d.getUTCDay();
      if (wd !== 0 && wd !== 6) added++;
    }
    return ymd(d);
  }

  // 2本のバー(aが時系列で先、bが後)を1本にマージする。dateLabelは呼び出し側が
  // 明示的に指定する。
  // 実質的に値動きがない(高値=安値)バーは、休場日の繰り越しレコードである
  // 可能性が高いので前営業日としては扱わない。
  function isDegenerateBar(b) {
    return b.high === b.low;
  }

  // rawBars → 整形済み日足配列。
  // ブローカー時間では土日ラベルのバーが存在しないため、旧版の週末マージ処理は
  // 廃止した(コア用/USDOutside用に2系列を作り分ける必要も無くなった)。
  //   opts.dropForming … 形成中のバーを落とす。FT5エクスポートは確定済みバー
  //     しか含まないので false、Twelve Dataから組んだ場合だけ true。
  function processDailyBars(rawBars, opts) {
    const dropForming = !!(opts && opts.dropForming);
    const bars = [...rawBars]
      .filter((b) => !isDegenerateBar(b))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (!dropForming) return bars;
    const forming = formingBarDate();
    const complete = bars.filter((b) => b.date < forming);
    return complete.length >= 2 ? complete : bars.slice(0, -1);
  }

  // ========== Twelve Data(フォールバック): 1時間足からブローカー日足を組む ==========
  // Twelve Data の 1day はカレンダー日区切りなので NY17:00 には組み替えられない。
  // NY 17:00 は UTC 21:00(夏)/22:00(冬)ちょうどなので、1時間足なら正確に
  // 積み上げられる。無料枠は outputsize 5000 まで、リクエスト数は1ペア1回で同じ。
  const TD_HOURLY_OUTPUT = 3000; // 約125日分

  async function fetchTwelveDataDaily(symbol, apiKey) {
    const url =
      `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}` +
      `&interval=1h&outputsize=${TD_HOURLY_OUTPUT}&timezone=UTC` +
      `&apikey=${encodeURIComponent(apiKey)}`;
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      throw new Error(`通信エラー(CORSでブロックされている可能性があります): ${e.message}`);
    }
    if (!res.ok) throw new Error(`HTTPエラー ${res.status}`);
    const json = await res.json();
    if (json.status === "error" || !Array.isArray(json.values)) {
      throw new Error(json.message || "APIがエラーを返しました(シンボル/APIキーを確認してください)");
    }
    const rows = json.values
      .map((v) => ({
        ms: Date.parse(String(v.datetime).replace(" ", "T") + "Z"),
        open: parseFloat(v.open),
        high: parseFloat(v.high),
        low: parseFloat(v.low),
        close: parseFloat(v.close),
      }))
      .filter((r) => Number.isFinite(r.ms) && Number.isFinite(r.close))
      .sort((a, b) => a.ms - b.ms);

    const byDate = new Map();
    for (const r of rows) {
      const d = brokerBarDate(r.ms);
      const cur = byDate.get(d);
      if (!cur) {
        byDate.set(d, { date: d, open: r.open, high: r.high, low: r.low, close: r.close });
      } else {
        if (r.high > cur.high) cur.high = r.high;
        if (r.low < cur.low) cur.low = r.low;
        cur.close = r.close;
      }
    }
    return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  // Twelve Dataから組んだ日足の「日付ラベル」を、FT5のD1(基準)に合わせる。
  //
  // FT5内部の区切り規約は外から再現できないと実測で分かっている
  // (History分足とTesting/D1が別データで、どの固定UTCオフセットでも一致しない。
  //  2026-09-10の調査)。そこで規約を推測せず、**両者が重なる期間の終値を
  // 突き合わせて実測でズレ日数を決める**。FT5エクスポートは120本あるので、
  // フォールバックが起きる状況でも通常100本以上が重なる。
  function calibrateShift(tdBars, ft5Bars) {
    if (!ft5Bars || ft5Bars.length < 10 || !tdBars || tdBars.length < 10) return null;
    const ref = new Map(ft5Bars.map((b) => [b.date, b.close]));
    let best = null;
    for (const shift of [0, 1, -1, 2, -2]) {
      let hit = 0;
      let n = 0;
      for (const b of tdBars) {
        const r = ref.get(shiftDate(b.date, shift));
        if (r == null || !(r > 0)) continue;
        n++;
        if (Math.abs(b.close - r) / r < 0.0005) hit++; // 終値が0.05%以内なら同じバー
      }
      if (n >= 10) {
        const rate = hit / n;
        if (!best || rate > best.rate) best = { shift, rate, n };
      }
    }
    return best;
  }

  // ========== FT5データを優先し、古すぎる場合だけTwelve Dataへフォールバック ==========
  // 2026-09-06: Twelve Data(サードパーティAPI)とFT5(EAの実機検証に使われてきた
  // Standard Data Feed/Forexite)のOHLCが数〜十数pips食い違い、日足RideThinの
  // N=1ブレイク判定が最大3割ほど狂いうることが判明したため、EAと同じデータへの
  // 切り替えを目指す。PC側で ft5_export/export_daily.py を実行して生成した
  // data/ft5_daily.json(GitHub Pagesでホスト)を最優先で読み、ユーザーがFT5の
  // データ更新・エクスポートを怠って古くなっている場合だけ、黙って古いデータを
  // 使わずTwelve Dataへ自動フォールバックする(どちらを使ったかは必ず表示する)。
  const FT5_EXPORT_URL = "https://route66fxmitsuhiro-glitch.github.io/rb-signal-app/data/ft5_daily.json";
  const FT5_MAX_STALE_TRADING_DAYS = 1; // 直近の確定日足からこれを超えて営業日が経っていたら古すぎると判断

  // 土日を除いた営業日数で dateA(exclusive)から dateB(exclusive)までの日数を数える。
  function tradingDaysBetween(dateA, dateB) {
    let d = new Date(dateA + "T00:00:00Z");
    const end = new Date(dateB + "T00:00:00Z");
    let count = 0;
    while (d < end) {
      d.setUTCDate(d.getUTCDate() + 1);
      const wd = d.getUTCDay();
      if (wd !== 0 && wd !== 6) count++;
    }
    return count;
  }

  let ft5ExportCache; // モジュール内キャッシュ(undefined=未取得、null=取得失敗、object=成功)
  async function fetchFT5Export() {
    if (ft5ExportCache !== undefined) return ft5ExportCache;
    try {
      const res = await fetch(FT5_EXPORT_URL, { cache: "no-store" });
      if (!res.ok) {
        ft5ExportCache = null;
      } else {
        ft5ExportCache = await res.json();
      }
    } catch (e) {
      ft5ExportCache = null;
    }
    return ft5ExportCache;
  }

  // FT5エクスポートを優先し、無い/古すぎる場合だけTwelve Dataへフォールバックする。
  //
  // 戻り値: { raw, source, note, dropForming, align }
  //   raw         … 日足配列(processDailyBars に渡す)
  //   dropForming … true なら形成中バーを落とす必要がある(Twelve Data経路のみ)
  //   align       … Twelve Data経路での日付ラベル較正結果(null可)
  async function fetchRawDailyValuesAuto(symbol, apiKey) {
    const exp = await fetchFT5Export();
    const ft5Bars = (exp && exp.pairs && exp.pairs[symbol]) || null;

    if (ft5Bars && ft5Bars.length) {
      const lastDate = ft5Bars[ft5Bars.length - 1].date;
      const staleTradingDays = tradingDaysBetween(lastDate, todayStr());
      if (staleTradingDays <= FT5_MAX_STALE_TRADING_DAYS) {
        // FT5のD1キャッシュ = EAが実際に見ているバーそのもの。確定済みなので
        // 形成中バーの除外は不要。
        return {
          raw: ft5Bars,
          source: "FT5",
          note: `FT5(実機と同じ日足、${lastDate}時点)`,
          dropForming: false,
          align: null,
        };
      }
    }

    // --- フォールバック ---
    const td = await fetchTwelveDataDaily(symbol, apiKey);
    const align = calibrateShift(td, ft5Bars);
    let raw = td;
    let alignNote;
    if (align && align.rate >= 0.8) {
      raw = align.shift === 0 ? td : td.map((b) => ({ ...b, date: shiftDate(b.date, align.shift) }));
      alignNote = align.shift === 0
        ? `日付ラベルはFT5と一致(${align.n}本中${Math.round(align.rate * 100)}%で照合)`
        : `日付ラベルを${align.shift > 0 ? "+" : ""}${align.shift}日ずらしてFT5に合わせた` +
          `(${align.n}本中${Math.round(align.rate * 100)}%で照合)`;
    } else if (align) {
      alignNote = `⚠日付ラベルの照合率が低い(最良で${Math.round(align.rate * 100)}%)。` +
        `バーの対応が実機とズレている可能性があります`;
    } else {
      alignNote = "⚠FT5データと重なる期間が無く、日付ラベルの整合を確認できていません";
    }

    const staleNote = ft5Bars && ft5Bars.length
      ? `FT5データが${ft5Bars[ft5Bars.length - 1].date}時点で古いため自動切替。PCでFT5更新→エクスポートを実行してください`
      : "FT5エクスポートが見つかりません";

    return {
      raw,
      source: "TwelveData",
      note: `Twelve Data 1時間足→NY17:00で日足化(${staleNote}。${alignNote})`,
      dropForming: true,
      align,
    };
  }

  // ========== 計算ロジック ==========

  // ATR14(単純平均、EAのComputeATR14()相当。Wilder平滑化ではない点に注意)
  function computeATR14(bars) {
    if (bars.length < 15) return null;
    const trs = [];
    for (let i = 1; i < bars.length; i++) {
      const cur = bars[i], prev = bars[i - 1];
      const tr = Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low - prev.close)
      );
      trs.push(tr);
    }
    const last14 = trs.slice(-14);
    return last14.reduce((a, b) => a + b, 0) / last14.length;
  }

  // 直近2本の完成バーからN=1ブレイクアウト方向を判定。
  // 高値・安値を両方同時に更新した場合(アウトサイド)は陽線/陰線で一本化する。
  function breakoutDirection(prevPrev, prev) {
    const brokeHigh = prev.high > prevPrev.high;
    const brokeLow = prev.low < prevPrev.low;
    let direction = null;
    if (brokeHigh && brokeLow) {
      if (prev.close > prev.open) direction = "long";
      else if (prev.close < prev.open) direction = "short";
    } else if (brokeHigh) {
      direction = "long";
    } else if (brokeLow) {
      direction = "short";
    }
    return { direction, outside: brokeHigh && brokeLow, brokeHigh, brokeLow };
  }

  // シグナルの有無にかかわらず、必ず判定根拠(前々日/前日の高安)を含めて返す。
  function computeDailySignal(bars) {
    if (bars.length < 2) {
      return { direction: null, insufficientData: true };
    }
    const prev = bars[bars.length - 1];
    const prevPrev = bars[bars.length - 2];
    const res = breakoutDirection(prevPrev, prev);
    return {
      direction: res.direction,
      outside: res.outside,
      prevBar: prev,
      prevPrevBar: prevPrev,
      referenceDate: prev.date,
      todayStopTrigger: res.direction ? (res.direction === "long" ? prev.low : prev.high) : null,
    };
  }

  // ========== 分散レイヤー: USDJPYアウトサイドデイ継続 ==========

  // Kaufman効率比(EAの ComputeER(window) と同じ)。bars は昇順、末尾が最新の
  // 確定バー(EAの Close(1) 相当)。window+1 本前の終値との正味変化 ÷ 直近
  // window 本の1日ごとの終値変化の絶対値合計。確定バーが window+1 本に満たなければ null。
  function computeER(bars, window) {
    if (!bars || bars.length < window + 1) return null;
    const n = bars.length;
    const netMove = Math.abs(bars[n - 1].close - bars[n - 1 - window].close);
    let pathLen = 0;
    for (let k = 1; k <= window; k++) {
      pathLen += Math.abs(bars[n - k].close - bars[n - k - 1].close);
    }
    if (pathLen <= 0) return 0;
    return netMove / pathLen;
  }

  // 3ペア(GBPJPY/GBPUSD/USDJPY)の効率比の平均。EAは RunDailySignals 内で
  // erValue[p] を更新し、ERゲート付きの各レイヤーが avgER=(3ペア平均) を閾値と
  // 比較して新規の可否を決める。barsBySymbol は
  //   { "GBP/JPY": [...], "GBP/USD": [...], "USD/JPY": [...] }。
  // back=0 … 直近の確定バーまでで計算した現在のER
  // back=1 … 1本前の状態のER(下の ER_LAG_PAIRS 参照)
  function computeAvgER(barsBySymbol, window, back) {
    const w = window || 20;
    const k = back || 0;
    const perPair = {};
    const ers = [];
    for (const p of PAIRS) {
      const all = barsBySymbol && barsBySymbol[p.symbol];
      const b = k > 0 && all ? all.slice(0, all.length - k) : all;
      const er = computeER(b, w);
      if (er == null) return { ready: false, avgER: null, perPair: {} };
      perPair[p.label] = er;
      ers.push(er);
    }
    return { ready: true, avgER: ers.reduce((a, b) => a + b, 0) / ers.length, perPair };
  }

  // 【ERゲートのラグ】FT5はシンボルをアルファベット順に処理するため、
  // ERペア(GBPJPY/GBPUSD/USDJPY)より前に来るペア(AUDJPY・EURJPY)の
  // 衛星レイヤーは、その日の erValue が更新される前に評価される
  //  = **前日のER**を見ることになる。
  // 実機ログ(2026-09-10、8層2,513エントリー)との照合で:
  //   ラグ0一律 93.9% → ペア別ラグ 95.9%
  //   AUDoutside 87.5→95.2 / AUDday2fail 85.1→93.5 / EURJPYfadeOut 90.0→95.0
  // と、この規則で説明できる分だけ一致率が上がることを確認済み。
  function erLagForPair(pairCode) {
    return pairCode < "GBPJPY" ? 1 : 0;
  }

  // ========== 衛星9層のシグナル判定 ==========
  // EAのバー添字 index i は「末尾からi本目」。bars は昇順なので at(bars,1)=前日、
  // at(bars,2)=前々日。EAの High(1) / Close(2) 等とそのまま対応する。
  function at(bars, i) {
    return bars[bars.length - i];
  }

  // ERゲートの開閉。EAの各 Run*Signal 冒頭の early return と同じ意味。
  //   "high" … EAは `if (avgER <= th) return;` なので avgER > th で開く
  //   "low"  … EAは `if (avgER >  th) return;` なので avgER <= th で開く
  function gateOpenFor(cfg, er) {
    if (cfg.gate === "none") return { ready: true, open: true };
    if (!er || !er.ready) return { ready: false, open: false };
    const open = cfg.gate === "high" ? er.avgER > cfg.erThreshold : er.avgER <= cfg.erThreshold;
    return { ready: true, open: open };
  }

  // 各メカニズムの方向判定(ERゲート適用前)。判定できなければ direction=null。
  // detail は画面に「なぜシグナルが出ていないか」を出すための根拠。
  function rawDirectionFor(cfg, bars) {
    const b1 = at(bars, 1); // 前日
    const b2 = at(bars, 2); // 前々日
    const detail = { prevBar: b1, prevPrevBar: b2 };

    if (cfg.kind === "outside_cont" || cfg.kind === "outside_fade") {
      const outside = b1.high > b2.high && b1.low < b2.low;
      detail.outside = outside;
      if (!outside) return { direction: null, detail: detail };
      const up = b1.close > b1.open;
      const dn = b1.close < b1.open;
      if (!up && !dn) return { direction: null, detail: detail }; // 同値はシグナルなし
      const cont = up ? "long" : "short";
      const dir = cfg.kind === "outside_cont" ? cont : (cont === "long" ? "short" : "long");
      return { direction: dir, detail: detail };
    }

    if (cfg.kind === "streak_rev") {
      // EA: k=1..n の全バーが Close>Open なら連続陽線 → フェードでショート
      let allUp = true;
      let allDown = true;
      for (let k = 1; k <= cfg.n; k++) {
        const b = at(bars, k);
        if (!(b.close > b.open)) allUp = false;
        if (!(b.close < b.open)) allDown = false;
      }
      detail.allUp = allUp;
      detail.allDown = allDown;
      detail.streakN = cfg.n;
      if (allUp && !allDown) return { direction: "short", detail: detail };
      if (allDown && !allUp) return { direction: "long", detail: detail };
      return { direction: null, detail: detail };
    }

    if (cfg.kind === "range_fade") {
      // EA: k=2..lookback+1 の高安レンジに前日がタッチしたが終値は戻った(失敗ブレイク)
      let rollHigh = -Infinity;
      let rollLow = Infinity;
      for (let k = 2; k <= cfg.lookback + 1; k++) {
        const b = at(bars, k);
        if (b.high > rollHigh) rollHigh = b.high;
        if (b.low < rollLow) rollLow = b.low;
      }
      const failedUp = b1.high >= rollHigh && b1.close < rollHigh;
      const failedDown = b1.low <= rollLow && b1.close > rollLow;
      detail.rollHigh = rollHigh;
      detail.rollLow = rollLow;
      detail.failedUp = failedUp;
      detail.failedDown = failedDown;
      if (failedUp && !failedDown) return { direction: "short", detail: detail };
      if (failedDown && !failedUp) return { direction: "long", detail: detail };
      return { direction: null, detail: detail };
    }

    if (cfg.kind === "day2_fail") {
      // EA: day1=index2 が k=3..(3+lookback-1) の極値を終値で確定ブレイクし、
      //     day2=index1 がその極値を更新できなかった(伸び悩んだ)らフェード
      let rollHigh = -Infinity;
      let rollLow = Infinity;
      for (let k = 3; k < 3 + cfg.lookback; k++) {
        const b = at(bars, k);
        if (b.high > rollHigh) rollHigh = b.high;
        if (b.low < rollLow) rollLow = b.low;
      }
      const day1Up = b2.close > rollHigh;
      const day1Down = b2.close < rollLow;
      detail.rollHigh = rollHigh;
      detail.rollLow = rollLow;
      detail.day1Up = day1Up;
      detail.day1Down = day1Down;
      if (!day1Up && !day1Down) return { direction: null, detail: detail };
      const extreme = day1Up ? b2.high : b2.low;
      const extended = day1Up ? b1.high > extreme : b1.low < extreme;
      detail.day1Extreme = extreme;
      detail.extended = extended;
      if (extended) return { direction: null, detail: detail };
      return { direction: day1Up ? "short" : "long", detail: detail };
    }

    return { direction: null, detail: detail };
  }

  // 週足ATR14(EAの RunUSDWeeklyStreakSignal 内の計算と同じ)。
  // weeks は昇順、末尾が直近の確定週。15週分必要。
  function weeklyATR14(weeks) {
    if (!weeks || weeks.length < 15) return null;
    let sum = 0;
    for (let i = 0; i < 14; i++) {
      const cur = weeks[weeks.length - 1 - i];
      const prev = weeks[weeks.length - 2 - i];
      const tr = Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low - prev.close)
      );
      sum += tr;
    }
    return sum / 14;
  }

  // 週足ストリーク逆張り(USDWeeklyStreak)。weeks は確定済みの週足(昇順)。
  // EAは「新しい週が確定したティック」でだけ新規判定するため newWeek を渡す。
  function computeWeeklyStreakSignal(cfg, weeks, er, newWeek) {
    const base = {
      layer: cfg.id, label: cfg.label, symbol: cfg.symbol, title: cfg.title,
      kind: cfg.kind, pair: cfg.pair, gate: cfg.gate, erThreshold: cfg.erThreshold,
      lot: cfg.lot, stopMult: cfg.stopMult, holdWeeks: cfg.holdWeeks, weekly: true,
    };
    if (!weeks || weeks.length < cfg.n + 15) {
      return Object.assign({}, base, { direction: null, insufficientData: true });
    }
    let allUp = true;
    let allDown = true;
    for (let k = 0; k < cfg.n; k++) {
      const w = weeks[weeks.length - 1 - k];
      if (!(w.close > w.open)) allUp = false;
      if (!(w.close < w.open)) allDown = false;
    }
    let raw = null;
    if (allUp && !allDown) raw = "short";
    else if (allDown && !allUp) raw = "long";

    const g = gateOpenFor(cfg, er);
    const atr = weeklyATR14(weeks);
    const fired = !!raw && g.open && !!newWeek && atr != null && atr > 0;
    return Object.assign({}, base, {
      direction: fired ? raw : null,
      rawDirection: raw,
      allUp: allUp,
      allDown: allDown,
      streakN: cfg.n,
      newWeek: !!newWeek,
      atr14: atr,
      erThreshold: cfg.erThreshold,
      gate: cfg.gate,
      avgER: er && er.ready ? er.avgER : null,
      gateReady: g.ready,
      gateOpen: g.open,
      referenceWeek: weeks[weeks.length - 1].weekKey,
    });
  }

  // 日足の衛星レイヤー(週足ストリーク以外の8層)。
  // シグナルの有無にかかわらず判定根拠を必ず返す。
  function computeSatelliteSignal(cfg, bars, er) {
    const base = {
      layer: cfg.id, label: cfg.label, symbol: cfg.symbol, title: cfg.title,
      kind: cfg.kind, pair: cfg.pair, gate: cfg.gate, erThreshold: cfg.erThreshold,
      lot: cfg.lot, stopMult: cfg.stopMult, holdDays: cfg.holdDays, weekly: false,
    };
    const need = Math.max(16, (cfg.lookback || 0) + 4, (cfg.n || 0) + 2);
    if (!bars || bars.length < need) {
      return Object.assign({}, base, { direction: null, insufficientData: true });
    }
    const res = rawDirectionFor(cfg, bars);
    const g = gateOpenFor(cfg, er);
    const atr14 = computeATR14(bars);
    const fired = !!res.direction && g.open && atr14 != null && atr14 > 0;
    return Object.assign({}, base, res.detail, {
      direction: fired ? res.direction : null,
      rawDirection: res.direction,
      referenceDate: at(bars, 1).date,
      atr14: atr14,
      erThreshold: cfg.erThreshold,
      gate: cfg.gate,
      avgER: er && er.ready ? er.avgER : null,
      perPairER: er && er.ready ? er.perPair : null,
      gateReady: g.ready,
      gateOpen: g.open,
    });
  }

  // 全9層をまとめて判定する。
  //   barsBySymbol  … { "GBP/JPY": [...], "USD/JPY": [...], "AUD/JPY": [...], "EUR/JPY": [...] }
  //   er            … computeAvgER の戻り値(コア3ペアから計算)
  //   weeksBySymbol … { "USD/JPY": [確定済み週足...] }
  //   newWeek       … 直近の完成日足が月曜か(EAの新しい週の検知)
  //   er      … computeAvgER(bars, 20, 0) … ERペア上の層が見る現在のER
  //   erPrev  … computeAvgER(bars, 20, 1) … AUDJPY/EURJPY上の層が見る前日のER
  function computeAllSatellites(barsBySymbol, er, erPrev, weeksBySymbol, newWeek) {
    return SATELLITES.map(function (cfg) {
      const e = erLagForPair(cfg.pair) === 1 ? (erPrev || er) : er;
      if (cfg.kind === "weekly_streak_rev") {
        return computeWeeklyStreakSignal(
          cfg, weeksBySymbol && weeksBySymbol[cfg.symbol], e, newWeek);
      }
      return computeSatelliteSignal(cfg, barsBySymbol && barsBySymbol[cfg.symbol], e);
    });
  }

  // 【重要】実際のEA(RB12tuned.cpp)は「今日が月曜かどうか」ではなく、
  // 「直近の完成日足バー(=前営業日)が月曜だったかどうか」で新しい週の
  // 確定を検知している。実データでも週足ドンチャンのエントリーは3,890件
  // 全件が火曜日だった(2026-08-16に実トレードログで確認済み)。
  function lastCompleteBarIsMonday(dailyBars) {
    if (dailyBars.length === 0) return false;
    const last = dailyBars[dailyBars.length - 1];
    return dowOf(last.date) === 1; // 1=月曜
  }

  // 日足バーを月曜始まりの週足に集計する。全ての週グループをそのまま返す。
  // EA(RB12tuned)の UpdateWeeklyHistory と同じ規則で日足バーを週足に集計する。
  // 【重要】新しい週は「月曜バーが現れたとき」だけ始まる。カレンダー上のISO週で
  // 機械的に区切るのではない。月曜が休場(月曜バーなし)の週は、EA同様その週の
  // 火〜金が前の週に併合される(EAの UpdateWeeklyHistory は dow==Monday の時だけ
  // curWeek を確定・ロールオーバーし、それ以外の曜日は curWeek に加算し続けるため)。
  // 週の open=月曜バーの始値、high/low=週内の最大/最小、close=週内最後のバーの終値。
  function aggregateWeekly(dailyBars) {
    const sorted = [...dailyBars].sort((a, b) => (a.date < b.date ? -1 : 1));
    const weeks = [];
    let cur = null;
    let curMondayDate = null; // 現在の週を開始した月曜バーの日付(休場起点なら null)
    for (const b of sorted) {
      const isMonday = dowOf(b.date) === 1;
      if (isMonday && b.date !== curMondayDate) {
        if (cur) weeks.push(cur);
        cur = { weekKey: b.date, open: b.open, high: b.high, low: b.low, close: b.close, lastDate: b.date, lastDayDow: 1 };
        curMondayDate = b.date;
      } else if (!cur) {
        // データ先頭が月曜以外(取得窓の先頭 or 月曜休場)。EAもこれを1つの週として扱う。
        cur = { weekKey: weekKeyOf(b.date), open: b.open, high: b.high, low: b.low, close: b.close, lastDate: b.date, lastDayDow: dowOf(b.date) };
      } else {
        if (b.high > cur.high) cur.high = b.high;
        if (b.low < cur.low) cur.low = b.low;
        cur.close = b.close;
        cur.lastDate = b.date;
        cur.lastDayDow = dowOf(b.date);
      }
    }
    if (cur) weeks.push(cur);
    return weeks;
  }

  // EAが実際に使う「確定済みの週」だけを取り出す(直近1週グループは常に未確定として除外)。
  function officialWeeks(allWeeks) {
    return allWeeks.length > 0 ? allWeeks.slice(0, -1) : allWeeks;
  }

  // 「暦の上ではもう金曜まで終わっているが、EAはまだ確定として扱っていない」
  // 週がある場合だけ、その週を使った参考プレビュー用の配列を返す(なければnull)。
  function previewWeeks(allWeeks) {
    if (allWeeks.length < 2) return null;
    const latest = allWeeks[allWeeks.length - 1];
    if (latest.lastDayDow !== 5) return null;
    const official = officialWeeks(allWeeks);
    if (official.length > 0 && official[official.length - 1].weekKey === latest.weekKey) return null;
    return allWeeks;
  }

  // シグナルの有無にかかわらず、必ず判定根拠(前々週/前週の高安)を含めて返す。
  //
  // latestDailyBar(任意): 直近の完成日足バー(新規判定日=通常火曜なら「月曜の足」)。
  // 渡すと entryGuard を計算する。EAの RunWeeklyDonchianSignals は
  //   ep = 火曜始値;  r = ep - 前週安値(ロング) / 前週高値 - ep(ショート);  if (r > 0) だけ新規建て
  // という順張り回避ガードを持つ。火曜始値はまだ取得できないため、直前の完成日足バー
  // (通常は月曜)で近似判定する。月曜が撤退ライン(前週安値/高値)を終値で越えていれば
  // 火曜始値もその向こう側になる可能性が高く、EAは新規建てを見送る(vetoed=true)。
  // ヒゲだけ越えて終値は戻した場合は「火曜始値次第で見送りうる」警告(kind="wick")。
  function computeWeeklySignal(weeklyBars, latestDailyBar) {
    if (weeklyBars.length < 2) {
      return { direction: null, insufficientData: true };
    }
    const prev = weeklyBars[weeklyBars.length - 1];
    const prevPrev = weeklyBars[weeklyBars.length - 2];
    const res = breakoutDirection(prevPrev, prev);
    const stopLevel = res.direction
      ? (res.direction === "long" ? prev.low : prev.high)
      : null;

    let entryGuard = null;
    if (res.direction && stopLevel != null && latestDailyBar) {
      const b = latestDailyBar;
      if (res.direction === "long") {
        if (b.close < stopLevel) {
          entryGuard = { vetoed: true, kind: "close", direction: "long", level: stopLevel, barDate: b.date, barValue: b.close };
        } else if (b.low < stopLevel) {
          entryGuard = { vetoed: false, kind: "wick", direction: "long", level: stopLevel, barDate: b.date, barValue: b.low };
        }
      } else {
        if (b.close > stopLevel) {
          entryGuard = { vetoed: true, kind: "close", direction: "short", level: stopLevel, barDate: b.date, barValue: b.close };
        } else if (b.high > stopLevel) {
          entryGuard = { vetoed: false, kind: "wick", direction: "short", level: stopLevel, barDate: b.date, barValue: b.high };
        }
      }
    }

    return {
      direction: res.direction,
      outside: res.outside,
      prevWeek: prev,
      prevPrevWeek: prevPrev,
      referenceWeek: prev.weekKey,
      todayStopTrigger: stopLevel,
      entryGuard,
    };
  }

  return {
    PAIRS,
    EXTRA_PAIRS,
    ALL_PAIRS,
    SATELLITES,
    CORE_LOTS,
    ymd,
    weekKeyOf,
    todayStr,
    brokerBarDate,
    formingBarDate,
    nextBarCloseJst,
    shiftDate,
    dowOf,
    addTradingDays,
    isDegenerateBar,
    fetchTwelveDataDaily,
    calibrateShift,
    fetchRawDailyValuesAuto,
    processDailyBars,
    computeATR14,
    breakoutDirection,
    computeDailySignal,
    computeER,
    computeAvgER,
    erLagForPair,
    computeSatelliteSignal,
    computeWeeklyStreakSignal,
    computeAllSatellites,
    weeklyATR14,
    lastCompleteBarIsMonday,
    aggregateWeekly,
    officialWeeks,
    previewWeeks,
    computeWeeklySignal,
  };
});

// ===== RBシグナル通知 Cloudflare Worker 本体 =====
// signal-core.js(上に連結される)の判定ロジックをそのまま使い、GBPJPY/GBPUSD/
// USDJPY の日足・週足シグナルを Cron Triggers で定期チェックし、新規シグナルが
// あれば Discord Webhook に投稿する。GitHub Actions 版(notify/check-signals.js)の
// 置き換え。時刻精度・重複防止(KV)・秘密情報がすべて Cloudflare 側で完結する。
//
// 必要な設定(README.md 参照):
//   Secret  TWELVE_DATA_API_KEY  … Twelve Data の APIキー
//   Secret  DISCORD_WEBHOOK_URL  … Discord チャンネルの Webhook URL
//   KV binding  RB_KV            … 「その取引日は通知済み」フラグの保存先
//   Cron Triggers                … "45 20 * * *", "45 21 * * *", "30 23 * * *"

const SC = globalThis.SignalCore;
const {
  PAIRS,
  ALL_PAIRS,
  dowOf,
  fetchRawDailyValuesAuto,
  processDailyBars,
  computeATR14,
  computeDailySignal,
  computeAvgER,
  computeAllSatellites,
  lastCompleteBarIsMonday,
  aggregateWeekly,
  officialWeeks,
  computeWeeklySignal,
} = SC;

// --- NY 17:00 境界ウィンドウ判定(check-signals.js から移植) ---
// FXの新しい取引日は NY 17:00(EDT=UTC 21:00 / EST=UTC 22:00)に始まる。
// Cron が多少ずれても拾えるよう「直近に過ぎた NY 17:00 境界」の -30分〜+8時間を
// 対象ウィンドウとし、境界の UTC 日付を一意キーに KV で重複送信を防ぐ。
// 金曜・土曜の NY 17:00 境界(直後にセッション無し)はスキップ。
const WINDOW_BEFORE_MIN = 30;
const WINDOW_AFTER_MIN = 8 * 60;

function nyFivePmUtcForUtcDate(y, m, d) {
  for (const offsetHours of [4, 5]) {
    const cand = new Date(Date.UTC(y, m, d, 17 + offsetHours, 0, 0));
    const hh = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(cand);
    const dd = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(cand);
    const wantDd = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (parseInt(hh, 10) % 24 === 17 && dd === wantDd) return cand;
  }
  return null;
}

function mostRecentNyBoundary(now) {
  const horizon = new Date(now.getTime() + WINDOW_BEFORE_MIN * 60000);
  for (let back = 0; back <= 2; back++) {
    const probe = new Date(Date.UTC(horizon.getUTCFullYear(), horizon.getUTCMonth(), horizon.getUTCDate() - back));
    const b = nyFivePmUtcForUtcDate(probe.getUTCFullYear(), probe.getUTCMonth(), probe.getUTCDate());
    if (b && b.getTime() <= horizon.getTime()) return b;
  }
  return null;
}

function evaluateWindow(now) {
  const boundary = mostRecentNyBoundary(now);
  if (!boundary) return { inWindow: false, reason: "NY境界の算出に失敗" };
  const from = boundary.getTime() - WINDOW_BEFORE_MIN * 60000;
  const to = boundary.getTime() + WINDOW_AFTER_MIN * 60000;
  const inWindow = now.getTime() >= from && now.getTime() <= to;
  const key = boundary.toISOString().slice(0, 10);
  const nyWd = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(boundary);
  const tradingDay = ["Sun", "Mon", "Tue", "Wed", "Thu"].includes(nyWd);
  const offsetMin = (now.getTime() - boundary.getTime()) / 60000;
  const reason = `now=${now.toISOString()} 直近境界=${boundary.toISOString()}(NY ${nyWd}) 経過=${offsetMin.toFixed(0)}分 inWindow=${inWindow} tradingDay=${tradingDay}`;
  return { inWindow, boundary, key, tradingDay, reason };
}

function fmtPrice(v, symbol) {
  if (v == null || Number.isNaN(v)) return "—";
  const isJpy = symbol.endsWith("JPY") || symbol.endsWith("/JPY");
  return v.toFixed(isJpy ? 3 : 5);
}
const dirLabel = (d) => (d === "long" ? "ロング" : "ショート");

// bars: 日足RideThin用(日曜足あり=EAのD1系列に一致)。weeklySrcBars: 週足ドンチャン用
// (日曜足なし、撤退ライン汚染対策 2026-08-18)。isFT5: barsがFT5由来か(true)、
// Twelve Dataフォールバックか(false)。火曜の注記の確度を出し分けるために使う。
function analysePair(pair, bars, weeklySrcBars, isFT5) {
  const atr14 = computeATR14(bars);
  const dailySignal = computeDailySignal(bars);
  const allWeeklyBars = aggregateWeekly(weeklySrcBars);
  const weeklyBars = officialWeeks(allWeeklyBars);
  const latestDailyBar = weeklySrcBars.length ? weeklySrcBars[weeklySrcBars.length - 1] : null;
  const weeklySignal = computeWeeklySignal(weeklyBars, latestDailyBar);
  const weeklyIsNewToday = lastCompleteBarIsMonday(weeklySrcBars);

  const lines = [];
  if (dailySignal && dailySignal.direction) {
    // 判定に日曜の薄商いバーが使われている場合の注記(2026-09-05、詳細はCLAUDE.md参照)。
    // 月曜=前日が日曜足(全体寄与3.8%・勝率43%で見送っても影響小)、
    // 火曜=前々日が日曜足(全体寄与32%で最大・チャートでは再現できないため本判定を優先すべき)。
    let sunTag = "";
    if (dowOf(dailySignal.prevBar.date) === 0) sunTag = "(月曜・薄商いバー由来、見送り可)";
    else if (dowOf(dailySignal.prevPrevBar.date) === 0) {
      // 2026-09-06: Twelve Data由来だとこの曜日の判定一致率が実測3〜6割(FT5なら高信頼)。
      sunTag = isFT5
        ? "(火曜・薄商いバー由来、FT5データのため信頼度高)"
        : "(火曜・薄商いバー由来、⚠️Twelve Dataフォールバック中で信頼度低)";
    }
    lines.push(
      `${pair.label} 日足${dirLabel(dailySignal.direction)}` +
        (dailySignal.outside ? "(アウトサイド)" : "") +
        sunTag +
        ` [前日高${fmtPrice(dailySignal.prevBar.high, pair.symbol)}/安${fmtPrice(dailySignal.prevBar.low, pair.symbol)} ATR14=${fmtPrice(atr14, pair.symbol)}]`
    );
  }
  const vetoed = weeklySignal && weeklySignal.entryGuard && weeklySignal.entryGuard.vetoed;
  if (weeklyIsNewToday && weeklySignal && weeklySignal.direction && !vetoed) {
    lines.push(
      `${pair.label} 週足${dirLabel(weeklySignal.direction)}` +
        (weeklySignal.outside ? "(アウトサイド週)" : "") +
        (weeklySignal.entryGuard ? "(撤退ライン一時越え・要注意)" : "") +
        ` [前週高${fmtPrice(weeklySignal.prevWeek.high, pair.symbol)}/安${fmtPrice(weeklySignal.prevWeek.low, pair.symbol)}]`
    );
  } else if (weeklyIsNewToday && vetoed) {
    // 通知はしないがログには残す
    return { lines, note: `${pair.label} 週足シグナルは entryGuard で抑制` };
  }
  return { lines };
}

async function postDiscord(url, lines) {
  const content = "📈 **RBシグナル**\n" + lines.join("\n") + "\n※自動発注はしません。手動で発注してください。";
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: content.slice(0, 1900) }),
  });
  return r.status;
}

async function runCheck(env, opts) {
  opts = opts || {};
  const now = new Date();
  const win = evaluateWindow(now);
  const log = [win.reason];

  if (!opts.skipGates) {
    if (!win.inWindow) return { skipped: "out-of-window", log };
    if (!win.tradingDay) return { skipped: "weekend-boundary", log };
    if (env.RB_KV) {
      const done = await env.RB_KV.get("done:" + win.key);
      if (done) return { skipped: "already-done:" + win.key, log };
    }
  }

  const lines = [];
  let anyOk = false;

  // まず全ペアの生日足を取得(1シンボル1回)。FT5エクスポート(EAと同じ
  // Standard Data Feed/Forexite)を優先し、古すぎる場合だけTwelve Dataへ自動
  // フォールバックする(2026-09-06、fetchRawDailyValuesAuto参照)。日足RideThin・
  // ER用(日曜足あり=EAのD1系列に一致)と週足ドンチャン用(日曜足破棄、撤退ライン
  // 汚染対策 2026-08-18)の2系列を派生させる。
  const rawBySymbol = {};
  const sourceBySymbol = {}; // "FT5" or "TwelveData"
  const dropFormingBySymbol = {}; // Twelve Data経路のみ形成中バーの除外が必要
  for (const pair of ALL_PAIRS) {
    try {
      const fetched = await fetchRawDailyValuesAuto(pair.symbol, env.TWELVE_DATA_API_KEY);
      rawBySymbol[pair.symbol] = fetched.raw;
      sourceBySymbol[pair.symbol] = fetched.source;
      dropFormingBySymbol[pair.symbol] = fetched.dropForming;
      log.push(`${pair.label} data: ${fetched.note}`);
      anyOk = true;
    } catch (e) {
      log.push(`${pair.label} error: ${e.message}`);
    }
  }
  // 2026-09-10: ブローカー時間(NY17:00)では土日ラベルのバーが存在しないため、
  // 旧版の2系列(日曜足あり/なし)の作り分けは不要。単一系列で日足・週足・ERを賄う。
  const barsBySymbol = {};
  const weeklySrcBySymbol = {};
  for (const pair of ALL_PAIRS) {
    if (!rawBySymbol[pair.symbol]) continue;
    const bars = processDailyBars(rawBySymbol[pair.symbol],
      { dropForming: !!dropFormingBySymbol[pair.symbol] });
    barsBySymbol[pair.symbol] = bars;
    weeklySrcBySymbol[pair.symbol] = bars;
  }
  for (const pair of PAIRS) {
    const bars = barsBySymbol[pair.symbol];
    if (!bars) continue;
    const r = analysePair(pair, bars, weeklySrcBySymbol[pair.symbol], sourceBySymbol[pair.symbol] === "FT5");
    if (r.note) log.push(r.note);
    lines.push(...r.lines);
  }

  // 分散レイヤー9層(2026-09-10、balanced対応)。
  // ERゲートはコア3ペア平均。AUDJPY/EURJPY上の層はFT5の処理順の都合で
  // 前日のERを見るため、erPrev を別に渡す(signal-core.js の erLagForPair 参照)。
  try {
    const er = computeAvgER(barsBySymbol, 20, 0);
    const erPrev = computeAvgER(barsBySymbol, 20, 1);
    const usdWeeks = officialWeeks(aggregateWeekly(barsBySymbol["USD/JPY"] || []));
    const newWeek = lastCompleteBarIsMonday(barsBySymbol["USD/JPY"] || []);
    const sats = computeAllSatellites(
      barsBySymbol, er, erPrev, { "USD/JPY": usdWeeks }, newWeek);
    for (const sg of sats) {
      if (sg.direction) {
        const rName = sg.weekly ? "週足ATR14" : "ATR14";
        const timeout = sg.weekly ? `保有${sg.holdWeeks}週` : `保有${sg.holdDays}営業日`;
        lines.push(
          `${sg.pair} ${sg.title} ${dirLabel(sg.direction)}` +
            ` [${rName}=${fmtPrice(sg.atr14, sg.symbol)}` +
            (sg.avgER != null ? ` avgER=${sg.avgER.toFixed(3)}` : "") +
            ` 逆指値≈${sg.stopMult}R ${timeout}]`
        );
      }
      // シグナルの有無にかかわらず判定根拠を log に残す(このコードが走った確認にもなる)
      if (sg.insufficientData) {
        log.push(`${sg.label}: バー不足で判定不可`);
      } else {
        const aer = sg.avgER != null ? sg.avgER.toFixed(3) : "n/a";
        log.push(
          `${sg.label}: 基準=${sg.referenceDate || sg.referenceWeek || "?"} ` +
            `dir=${sg.rawDirection} avgER=${aer}(` +
            (sg.gate === "none" ? "ゲートなし" : `${sg.gate}ゲート 閾値${sg.erThreshold}`) +
            ") → " +
            (sg.direction ? "発火 " + sg.direction : "発火なし")
        );
      }
    }
  } catch (e) {
    log.push(`satellites error: ${e.message}`);
  }

  let sent = null;
  if (lines.length === 0) {
    log.push("新規シグナルなし");
  } else if (opts.nosend || !env.DISCORD_WEBHOOK_URL) {
    log.push(env.DISCORD_WEBHOOK_URL ? "nosend 指定" : "DISCORD_WEBHOOK_URL 未設定");
  } else {
    try {
      sent = await postDiscord(env.DISCORD_WEBHOOK_URL, lines);
      log.push(`discord ${sent}`);
    } catch (e) {
      log.push(`discord error: ${e.message}`);
    }
  }

  // 全ペア取得成功したときだけ「処理済み」を記録(取得失敗なら次回リトライ)。
  if (!opts.skipGates && anyOk && env.RB_KV) {
    await env.RB_KV.put("done:" + win.key, "1", { expirationTtl: 60 * 60 * 24 * 3 });
    log.push("KV done:" + win.key + " 記録");
  }

  return { key: win.key, lines, sent, anyOk, log };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runCheck(env)
        .then((r) => console.log("RB notify:", JSON.stringify(r)))
        .catch((e) => console.error("RB notify fatal:", e && e.stack ? e.stack : e))
    );
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.searchParams.get("test") !== "1") {
      return new Response(
        "RB signal notify worker.\n" +
          "?test=1        … いますぐ判定を実行(時刻ウィンドウ・重複フラグを無視。シグナルがあれば Discord に送信)\n" +
          "?test=1&nosend=1 … 送信せず結果だけ表示\n",
        { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }
      );
    }
    const r = await runCheck(env, {
      skipGates: true,
      nosend: url.searchParams.get("nosend") === "1",
    });
    return new Response(JSON.stringify(r, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  },
};
