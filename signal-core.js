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
    // lot: EJFadeOutLotSize(0.18) * EJFadeRiskMult(0.75、2026-09-13 PF構造監査
    // ステージ2でA+確定・生産値化)。EAは RoundLot(0.18*0.75*mult) を1回で丸めるので、
    // ここは丸め前の積(0.135)のまま置く(satelliteLot()が scale/mult と合わせて
    // 最後に1回だけ roundLot するのと、桁の丸めタイミングを一致させるため)。
    { id: "ej-fadeout", label: "EURJPYfadeOut", symbol: "EUR/JPY", pair: "EURJPY",
      kind: "outside_fade", title: "アウトサイドデイ・フェード",
      gate: "low", erThreshold: 0.229, stopMult: 1.0, holdDays: 5, lot: 0.135 },
  ];

  // ========== 衝突ゲート(RB_Broker_Conflict.dll の確定パラメータ、2026-09-11) ==========
  // EAの ConflictLotMult(sym, newSide) と同じ考え方。同一シンボル(cfg.pair)上で
  // 既に建玉中の「他の」衛星レイヤーの方向を見て、新規衛星の発注ロットだけを
  // 調整する(シグナルの成立自体・決済ロジックには一切影響しない)。
  //   mode: 0=無効(常に1.0倍、balancedと完全一致) / 1=衛星どうしのみ考慮
  //   (EAのConflictMode=2[コア込み]は予測段階で-4〜-16%と逆効果と判明し不採用、
  //    このアプリにも実装しない)
  // agree(全部同方向)/oppose(全部逆方向)/mixed(両方向混在)の3ケースで倍率を変える。
  // 実機検証: Opp=0.35のとき balanced 比 Return/DD +17.42%(2026-09-11確定)。
  const CONFLICT_GATE = { mode: 1, agreeMult: 1.00, oppMult: 0.35, mixedMult: 1.00 };

  // pair: 対象シンボル(cfg.pair、例"GBPJPY") … このアプリでは実際には呼び出し側が
  //       既に同一pairだけを渡すので未使用だが、EA側の関数シグネチャと対応を
  //       明確にするため引数として残す。
  // direction: 新規に建てようとしているシグナルの方向("long"/"short")
  // openDirections: 同一pair上で現在保有中の「他の」衛星レイヤーの方向の配列
  //       (例: ["long"] や ["long","short"]。自分自身のレイヤーは含めないこと)
  function satelliteConflictMult(pair, direction, openDirections) {
    if (CONFLICT_GATE.mode <= 0 || !direction || !openDirections || !openDirections.length) {
      return 1.0;
    }
    let agree = 0;
    let oppose = 0;
    for (const d of openDirections) {
      if (d === direction) agree++;
      else oppose++;
    }
    if (agree > 0 && oppose > 0) return CONFLICT_GATE.mixedMult;
    if (oppose > 0) return CONFLICT_GATE.oppMult;
    if (agree > 0) return CONFLICT_GATE.agreeMult;
    return 1.0;
  }

  // ========== コアのロット倍率(参考用、実際の計算は app.js の
  // DAILY_TRANCHES/WEEKLY_TRANCHES/tranchesWithLots()が担う。このオブジェクトは
  // どこからも消費されていないが、EA側パラメータとの対応記録として残す) ==========
  // 2026-09-13、PF構造監査ステージ4(コアトランシェ配分の直接指定、A+確定)で
  // trancheWeightベース(重み×共有ロット×DailyRideLotMult)から、
  // CoreT0Lot〜CoreT4Lotの直接指定(T0=0.03/T1=0.03/T2=0.02/T3=0.01/T4=0.01、
  // DailyRideLotMult=1.0に統一)へ変更。合計0.10は変わらず。
  const CORE_LOTS = {
    lotSize: 0.10,          // LotSize(日足RideThin、参照用の合計)
    wdLotSize: 0.10,        // WDLotSize(週足ドンチャン)
    coreTierLot: [0.03, 0.03, 0.02, 0.01, 0.01],  // CoreT0Lot..CoreT4Lot(直接指定)
    tierR: [0.1, 0.2, 0.3, 0.5, null],
    hardStopR: -1.0,
    dailyRideLotMult: 1.0,  // CoreT4Lot=0.01が既にpre-shrinkの最終値のため1.0
    wdT01LotMult: 0.334,    // 週足T0/T1(無改造)
    wdRideLotMult: 0.167,   // 週足ride(無改造)
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

  // 前々日→前日が実際に連続した営業日かを確認する(土日を挟むだけなら正常)。
  // 間に平日が1日でも抜けていれば、その抜けた日の値動きを一切見ずに判定して
  // いることになるため、呼び出し側で強く警告すべき状態(2026-09-14発見のバグ、
  // missingTradingDaysの節を参照)。
  function isNextTradingDay(fromDate, toDate) {
    let d = shiftDate(fromDate, 1);
    while (dowOf(d) === 0 || dowOf(d) === 6) d = shiftDate(d, 1);
    return d === toDate;
  }

  // シグナルの有無にかかわらず、必ず判定根拠(前々日/前日の高安)を含めて返す。
  function computeDailySignal(bars) {
    if (bars.length < 2) {
      return { direction: null, insufficientData: true };
    }
    const prev = bars[bars.length - 1];
    const prevPrev = bars[bars.length - 2];
    const res = breakoutDirection(prevPrev, prev);
    const dateGap = !isNextTradingDay(prevPrev.date, prev.date);
    return {
      direction: res.direction,
      outside: res.outside,
      prevBar: prev,
      prevPrevBar: prevPrev,
      referenceDate: prev.date,
      // 前々日・前日が営業日として連続していない(間の日のデータが丸ごと
      // 欠落している)場合にtrue。trueの時、この判定結果(direction含む)は
      // 信用してはいけない。
      dateGap: dateGap,
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

  // ========== ブローカーのレート一覧スクショから日足を再構成する ==========
  // 2026-09-10、FT5の毎日更新が負担なため導入。GMOクリック証券のレート一覧には
  // 四本値が無いが、BID / H: / L: / 前日比 の4つから直前セッションのOHLCを組める。
  //
  //   高値 = H:            安値 = L:            終値 = BID
  //   始値 = BID − 前日比  (前日比の基準＝前セッションの終値＝当セッションの始値)
  //
  // 【撮影時刻】ブローカーの日足は JST 06:00 に確定しリセットされる(ユーザー確認済み)。
  // 06:00を過ぎるとH:/L:が新セッションにリセットされ、閉じたバーの高安が失われるため、
  // **5:50頃(確定の直前)に撮る**必要がある。この時点でバーは厳密には未確定だが、
  // 残り10分の差は誤差として許容する(ユーザー判断)。
  //
  // 【日付ラベル】JST D日 5:50 に撮ったスクショが完成させるのは、
  // D-1日 06:00 に始まったセッション。FT5のD1もセッション開始日をラベルにしている
  // ため、ラベルは **D-1** になる。

  // 前日比の単位はそのペアの表示最小桁(JPYクロス=0.001、ドルストレート=0.00001)。
  function quoteDecimals(symbol) {
    return symbol.endsWith("JPY") ? 3 : 5;
  }

  // レート一覧の1ペア分から直前セッションのOHLCを組む。
  //   q = { bid, high, low, change }  change は最小桁単位の整数(例: GBPJPY 174 = 0.174)
  function reconstructBarFromQuote(symbol, q, dateLabel) {
    const dec = quoteDecimals(symbol);
    const unit = Math.pow(10, -dec);
    const round = (v) => Number(v.toFixed(dec));
    const open = round(q.bid - q.change * unit);
    return {
      date: dateLabel,
      open: open,
      high: round(q.high),
      low: round(q.low),
      close: round(q.bid),
      src: "shot",
    };
  }

  // 再構成したバーの健全性検査。1桁の誤読が履歴に入ると以後ずっと汚染されるため
  // (教訓78: データ誤りはEA側では防げない)、追記前に必ず通す。
  //   prev … 直前の確定バー(あれば)。ギャップと値幅の異常を見る。
  //   atr  … 直近のATR14(あれば)。値幅の妥当性判定に使う。
  function validateReconstructedBar(symbol, bar, prev, atr) {
    const dec = quoteDecimals(symbol);
    const unit = Math.pow(10, -dec);
    const pip = symbol.endsWith("JPY") ? 0.01 : 0.0001;
    const errors = [];
    const warnings = [];

    if (![bar.open, bar.high, bar.low, bar.close].every((v) => Number.isFinite(v))) {
      errors.push("数値として読めない項目があります");
      return { errors: errors, warnings: warnings };
    }
    if (bar.high < bar.low) errors.push("高値が安値を下回っています");
    if (bar.high < Math.max(bar.open, bar.close) - unit / 2) {
      errors.push(`高値が始値/終値より低い(${((Math.max(bar.open, bar.close) - bar.high) / pip).toFixed(1)}pips)`);
    }
    if (bar.low > Math.min(bar.open, bar.close) + unit / 2) {
      errors.push(`安値が始値/終値より高い(${((bar.low - Math.min(bar.open, bar.close)) / pip).toFixed(1)}pips)`);
    }

    const range = (bar.high - bar.low) / pip;
    if (atr != null && atr > 0) {
      const atrPips = atr / pip;
      if (range > atrPips * 4) warnings.push(`値幅${range.toFixed(0)}pipsがATR14の4倍超(${atrPips.toFixed(0)}pips)`);
      if (range < atrPips * 0.15) warnings.push(`値幅${range.toFixed(0)}pipsがATR14の15%未満`);
    }
    if (prev) {
      const gap = Math.abs(bar.open - prev.close) / pip;
      // 前セッションの終値＝当セッションの始値なので、本来ほぼ一致するはず。
      // 週明け(月曜)だけは週末ギャップで離れうる。
      const isMonday = dowOf(bar.date) === 1;
      const limit = isMonday ? (atr ? (atr / pip) * 1.5 : 200) : 20;
      if (gap > limit) {
        warnings.push(`前日終値との差が${gap.toFixed(0)}pips(${isMonday ? "週明け" : "通常日"}の想定を超過)`);
      }
    }
    return { errors: errors, warnings: warnings };
  }

  // スクショを撮った時刻から、完成させるバーの日付ラベルと撮影窓の状態を返す。
  function screenshotSessionLabel(now) {
    const d = now || new Date();
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(d);
    const get = (t) => parts.find((p) => p.type === t).value;
    const jstDate = `${get("year")}-${get("month")}-${get("day")}`;
    const hh = parseInt(get("hour"), 10);
    const mm = parseInt(get("minute"), 10);
    const jstDow = dowOf(jstDate); // 0=日, 1=月, ... 6=土
    // ラベル = 撮影日の前日。土日をまたぐ場合は直前の金曜まで戻る
    // (セッションは月〜金の 06:00 にしか始まらないため)。
    const label = lastCapturableSessionLabel(d);

    // 【市場が閉じている時間帯(土06:00 〜 月06:00)】
    // ユーザー確認済み: この間もレート一覧は金曜セッションの値を保持する。
    // よって週末はいつ撮っても金曜のバーが確定値で取れる(最も安全)。
    const frozen =
      (jstDow === 6 && hh >= 6) || // 土曜 06:00以降
      jstDow === 0 ||              // 日曜(終日)
      (jstDow === 1 && hh < 6);    // 月曜 06:00前
    if (frozen) {
      return {
        label: label, jstDate: jstDate, state: "frozen",
        note: "市場が閉じており、画面は金曜セッションの確定値のまま止まっています。" +
          "週末のうちに撮ったものなら、月曜 06:00 までいつアップしても構いません。",
      };
    }

    // 【市場が開いている時間帯】06:00 を過ぎると H:/L: が今日のセッションに
    // リセットされ、閉じたバーの高安を復元できなくなる。
    if (hh >= 6) {
      return {
        label: label, jstDate: jstDate, state: "late",
        note: "撮影時刻が JST 06:00 より後です。H:/L: は進行中セッションのもので、" +
          "直前バーの高安ではありません。明朝 05:30〜06:00 に撮り直してください。",
      };
    }
    if (hh < 5 || (hh === 5 && mm < 30)) {
      return {
        label: label, jstDate: jstDate, state: "early",
        note: "JST 05:30 より前です。バーの残り時間が長く、高安・終値がまだ動きます。",
      };
    }
    return { label: label, jstDate: jstDate, state: "ok", note: "" };
  }

  // いま時点で「既に閉じている最後のセッション」のラベル。履歴がどこまで
  // 揃っているべきかの目標値であり、これに足りない分をTwelve Dataで補完する。
  //
  // セッション S(x) は x日 06:00 に始まり x+1日 06:00 に閉じる(JST)。
  //   JST D日 06:00 より前 … 進行中は S(D-1)。5:50のスクショはこれを捉える。
  //   JST D日 06:00 以降   … 進行中は S(D)。閉じた最後は S(D-1)。
  // どちらの場合も目標は D-1。ただし D-1 が土日ならセッションが無いので
  // 直前の金曜まで戻る(月曜朝なら金曜、日曜朝なら金曜)。
  function lastCapturableSessionLabel(now) {
    const d = now || new Date();
    const jst = todayStr(d);
    let label = shiftDate(jst, -1);
    let guard = 0;
    while ((dowOf(label) === 0 || dowOf(label) === 6) && guard++ < 7) {
      label = shiftDate(label, -1);
    }
    return label;
  }

  // 複数ソースの日足を1本の系列にまとめる。同じ日付は優先度の高いソースを採る。
  //   優先度: shot(ブローカー実物) > ft5(実機と同じ日足) > td(Twelve Data補完)
  const BAR_SOURCE_RANK = { shot: 3, ft5: 2, td: 1 };
  function mergeBarSeries() {
    const byDate = new Map();
    for (let i = 0; i < arguments.length; i++) {
      const arr = arguments[i] || [];
      for (const b of arr) {
        const cur = byDate.get(b.date);
        const rank = BAR_SOURCE_RANK[b.src] || 0;
        if (!cur || rank > (BAR_SOURCE_RANK[cur.src] || 0)) byDate.set(b.date, b);
      }
    }
    return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  // 系列の中で欠けている営業日(月〜金)を洗い出す。Twelve Dataでの補完対象。
  //
  // 【2026-09-14修正、重大バグ】旧実装は末尾バーの日付から起点を取っていたため、
  // 「FT5がN日前で止まっている状態でスクショが今日の分だけ先に入る」ケースで、
  // FT5とスクショの間に空いた"内部の穴"(例: 木曜だけ両方とも欠落)を一切検出
  // できなかった(末尾バーの日付が既にthroughLabel以上なら while が1回も回らず
  // gaps=[]のまま)。この穴があると computeDailySignal の前々日/前日が実際には
  // 1営業日隣り合っていない(木曜を飛ばして水曜と金曜を比較する等)のに警告なしで
  // シグナルを計算してしまい、誤った判定(本来アウトサイド継続=ショートのはずが
  // 「シグナルなし」と誤表示される等)につながっていた。修正: 系列の**先頭**バーの
  // 日付から走査することで、末尾だけでなく内部の穴も含めて検出する。
  function missingTradingDays(bars, throughLabel) {
    if (!bars.length) return [];
    const have = new Set(bars.map((b) => b.date));
    const out = [];
    let d = bars[0].date;
    while (d < throughLabel) {
      d = shiftDate(d, 1);
      const wd = dowOf(d);
      if (wd === 0 || wd === 6) continue; // 土日はバーが存在しない
      if (!have.has(d)) out.push(d);
    }
    return out;
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
    CONFLICT_GATE,
    satelliteConflictMult,
    ymd,
    weekKeyOf,
    todayStr,
    brokerBarDate,
    formingBarDate,
    nextBarCloseJst,
    shiftDate,
    quoteDecimals,
    reconstructBarFromQuote,
    validateReconstructedBar,
    screenshotSessionLabel,
    lastCapturableSessionLabel,
    mergeBarSeries,
    missingTradingDays,
    dowOf,
    addTradingDays,
    isDegenerateBar,
    fetchFT5Export,
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
