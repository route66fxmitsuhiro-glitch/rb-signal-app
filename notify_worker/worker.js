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
  const PAIRS = [
    { symbol: "GBP/JPY", label: "GBPJPY" },
    { symbol: "GBP/USD", label: "GBPUSD" },
    { symbol: "USD/JPY", label: "USDJPY" },
  ];

  // 分散レイヤー: USDJPYアウトサイドデイ継続(EAの RunUSDOutsideSignal 相当)。
  // 前日の高安が前々日の高安を両方とも更新(アウトサイドデイ)し、かつ前日が
  // 明確な陽線/陰線、さらに3ペア平均の効率比(ER)が閾値超(トレンド状態)の
  // ときだけ、前日終値方向へ「今日の始値」で順張り。利食い目標なし、固定逆指値
  // (約定 ∓ StopMult×ATR14、トレールしない)、HoldDays 営業日で時間切れ手仕舞い。
  // パラメータは RB12tuned_WDLite.cpp の RegOption 既定値と一致させている
  // (ロット再配分後の確定値 USDOutsideLotSize=0.08 を含む)。
  const USD_OUTSIDE = {
    symbol: "USD/JPY",
    label: "USDJPY",
    erWindow: 20, // EJFadeERWindow(ERゲートは3ペア共通で20)
    erThreshold: 0.16, // USDOutsideERThreshold(avgER > これ で新規許可 = 高ERゲート)
    stopMult: 2.25, // USDOutsideStopMult
    holdDays: 5, // USDOutsideHoldDays(この営業日数で時間切れ手仕舞い)
    lot: 0.08, // USDOutsideLotSize(ロット再配分後の確定値、基準ロット0.10と同じ土俵)
  };

  // ATR14(15本)・週足集計に加え、20本ERゲート(確定日足21本必要)にも
  // 余裕を持たせるため多めに取得する。無料枠は outputsize 40 でも 60 でも
  // 1リクエストで変わらない。週足側は末尾2週しか使わないため増やしても無害。
  const API_OUTPUT_SIZE = 60;

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
  function mergeBars(a, b, dateLabel) {
    return {
      date: dateLabel,
      open: a.open,
      high: Math.max(a.high, b.high),
      low: Math.min(a.low, b.low),
      close: b.close,
    };
  }

  // FXはニューヨーク時間17時にクローズするため、日本時間では土曜早朝まで
  // 実際に値動きがある。「土曜日付のバー」を単純に除外すると金曜セッション
  // 終盤の値動きを切り捨ててしまうため、除外ではなく直前の金曜バーへマージ
  // する。日曜日付のバー(週明けの立ち上がりの数時間)の扱いは keepSunday で
  // 切り替える:
  //   keepSunday=false(既定, コア用) … 破棄する。薄商いの非現実的なヒゲを
  //     月曜/週足の高安・ATRに持ち込まないため(2026-08-18 の対応)。
  //   keepSunday=true(USDOutsideレイヤー用) … 独立した1本として残す。EA(FT5)の
  //     D1系列は日曜の立ち上がりバーを1本持っており、このレイヤーの
  //     「アウトサイドデイ」判定は EA と同じバー構成でないと大きくズレる
  //     (火曜エントリー = 月曜が日曜スタブ足を包んだ、という判定が主戦力の
  //     ため。紙トレード照合 2026-09-04 で確認)。
  function mergeWeekendIntoWeekdays(rawBars, keepSunday) {
    const sorted = [...rawBars].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const result = [];
    let i = 0;
    while (i < sorted.length) {
      const cur = sorted[i];
      const d = dowOf(cur.date);
      if (d === 6) {
        // 土曜 → 直前の平日バーにマージ(直前がなければ捨てる)。日付ラベルは金曜(平日側)を維持する。
        if (result.length > 0) {
          const prev = result[result.length - 1];
          result[result.length - 1] = mergeBars(prev, cur, prev.date);
        }
        i++;
      } else if (d === 0 && !keepSunday) {
        i++; // 日曜 → 破棄
      } else {
        result.push(cur);
        i++;
      }
    }
    return result;
  }

  // 実質的に値動きがない(高値=安値)バーは、休場日の繰り越しレコードである
  // 可能性が高いので、前営業日としては扱わない(土日マージ後に適用)。
  function isDegenerateBar(b) {
    return b.high === b.low;
  }

  // Twelve Data の生レスポンスから rawBars 配列(カレンダー日、未整形)を取り出す。
  // HTTP は 1シンボルにつき1回だけ。整形(週末処理・整列・当日足除外)は
  // processDailyBars で行い、コア用/USDOutside用の2系列を1回の取得から作れるようにする。
  async function fetchRawDailyValues(symbol, apiKey) {
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=${API_OUTPUT_SIZE}&apikey=${encodeURIComponent(apiKey)}`;
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
    return json.values.map((v) => ({
      date: v.datetime.slice(0, 10),
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
    }));
  }

  // rawBars → 整形済み日足配列。opts.keepSunday で日曜足の扱いを切り替える。
  function processDailyBars(rawBars, opts) {
    const keepSunday = !!(opts && opts.keepSunday);
    const merged = mergeWeekendIntoWeekdays(rawBars, keepSunday);
    const bars = merged.filter((b) => !isDegenerateBar(b));
    bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    // 本日分がまだ形成中の可能性があるバーは除外する(保守的な近似)。
    const today = todayStr();
    const complete = bars.filter((b) => b.date < today);
    return complete.length >= 2 ? complete : bars.slice(0, -1);
  }

  // 既存の呼び出し互換: コア用(日曜足を破棄した)整形済み日足を取得する。
  async function fetchDailyBars(symbol, apiKey) {
    return processDailyBars(await fetchRawDailyValues(symbol, apiKey), { keepSunday: false });
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
  function computeAvgER(barsBySymbol, window) {
    const w = window || 20;
    const perPair = {};
    const ers = [];
    for (const p of PAIRS) {
      const er = computeER(barsBySymbol && barsBySymbol[p.symbol], w);
      if (er == null) return { ready: false, avgER: null, perPair: {} };
      perPair[p.label] = er;
      ers.push(er);
    }
    return { ready: true, avgER: ers.reduce((a, b) => a + b, 0) / ers.length, perPair };
  }

  // USDJPYアウトサイドデイ継続シグナル(EAの RunUSDOutsideSignal と同じ判定)。
  // シグナルの有無にかかわらず、判定根拠(前々日/前日の高安・ER・ゲート状態)を
  // 必ず含めて返す。er は computeAvgER の戻り値(nullでも可)。
  function computeUsdOutsideSignal(usdjpyBars, er) {
    const cfg = USD_OUTSIDE;
    if (!usdjpyBars || usdjpyBars.length < 16) {
      return { layer: "usd-outside", symbol: cfg.symbol, label: cfg.label, direction: null, insufficientData: true };
    }
    const n = usdjpyBars.length;
    const prev = usdjpyBars[n - 1];
    const prevPrev = usdjpyBars[n - 2];
    const outside = prev.high > prevPrev.high && prev.low < prevPrev.low;
    const closeUp = prev.close > prev.open;
    const closeDown = prev.close < prev.open;
    // EAの継続方向: 陽線→ロング / 陰線→ショート / 同値(始値=終値)→シグナルなし
    let rawDirection = null;
    if (outside && closeUp && !closeDown) rawDirection = "long";
    else if (outside && closeDown && !closeUp) rawDirection = "short";

    const atr14 = computeATR14(usdjpyBars);
    const gateReady = !!(er && er.ready);
    const gateOpen = gateReady ? er.avgER > cfg.erThreshold : false;
    const fired = !!rawDirection && gateOpen && atr14 != null && atr14 > 0;

    return {
      layer: "usd-outside",
      symbol: cfg.symbol,
      label: cfg.label,
      direction: fired ? rawDirection : null,
      rawDirection, // ゲート適用前の方向(診断表示用)
      outside,
      brokeHigh: prev.high > prevPrev.high,
      brokeLow: prev.low < prevPrev.low,
      prevBar: prev,
      prevPrevBar: prevPrev,
      referenceDate: prev.date,
      atr14,
      stopMult: cfg.stopMult,
      holdDays: cfg.holdDays,
      lot: cfg.lot,
      erThreshold: cfg.erThreshold,
      avgER: gateReady ? er.avgER : null,
      perPairER: gateReady ? er.perPair : null,
      gateReady,
      gateOpen,
    };
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
    API_OUTPUT_SIZE,
    USD_OUTSIDE,
    ymd,
    weekKeyOf,
    todayStr,
    dowOf,
    addTradingDays,
    mergeBars,
    mergeWeekendIntoWeekdays,
    isDegenerateBar,
    fetchRawDailyValues,
    processDailyBars,
    fetchDailyBars,
    computeATR14,
    breakoutDirection,
    computeDailySignal,
    computeER,
    computeAvgER,
    computeUsdOutsideSignal,
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
  dowOf,
  fetchRawDailyValues,
  processDailyBars,
  computeATR14,
  computeDailySignal,
  computeAvgER,
  computeUsdOutsideSignal,
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
// (日曜足なし、撤退ライン汚染対策 2026-08-18)。
function analysePair(pair, bars, weeklySrcBars) {
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
    else if (dowOf(dailySignal.prevPrevBar.date) === 0) sunTag = "(火曜・薄商いバー由来、チャート未表示でも本判定を優先)";
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

  // まず全ペアの生日足を取得(1シンボル1回)。日足RideThin・ER用(日曜足あり=EAの
  // D1系列に一致)と週足ドンチャン用(日曜足破棄、撤退ライン汚染対策 2026-08-18)の
  // 2系列を派生させる(2026-09-05: 日足RideThinも紙トレード照合でSunday-keptに統一)。
  const rawBySymbol = {};
  for (const pair of PAIRS) {
    try {
      rawBySymbol[pair.symbol] = await fetchRawDailyValues(pair.symbol, env.TWELVE_DATA_API_KEY);
      anyOk = true;
    } catch (e) {
      log.push(`${pair.label} error: ${e.message}`);
    }
  }
  const barsBySymbol = {};       // 日足RideThin・ER(日曜足あり)
  const weeklySrcBySymbol = {};  // 週足ドンチャン(日曜足なし)
  for (const pair of PAIRS) {
    if (!rawBySymbol[pair.symbol]) continue;
    barsBySymbol[pair.symbol] = processDailyBars(rawBySymbol[pair.symbol], { keepSunday: true });
    weeklySrcBySymbol[pair.symbol] = processDailyBars(rawBySymbol[pair.symbol], { keepSunday: false });
  }
  for (const pair of PAIRS) {
    const bars = barsBySymbol[pair.symbol];
    if (!bars) continue;
    const r = analysePair(pair, bars, weeklySrcBySymbol[pair.symbol]);
    if (r.note) log.push(r.note);
    lines.push(...r.lines);
  }

  // 分散レイヤー: USDJPYアウトサイドデイ継続(3ペア平均ER > 0.16 のときだけ)。
  // 日足RideThinと同じ日曜足ありの系列で判定。
  if (barsBySymbol["USD/JPY"]) {
    try {
      const erAll = computeAvgER(barsBySymbol, 20);
      const uo = computeUsdOutsideSignal(barsBySymbol["USD/JPY"], erAll);
      if (uo && uo.direction) {
        lines.push(
          `USDJPY アウトサイドデイ継続 ${dirLabel(uo.direction)}` +
            ` [ATR14=${fmtPrice(uo.atr14, "USD/JPY")} avgER=${uo.avgER.toFixed(3)}>${uo.erThreshold}` +
            ` 逆指値≈${uo.stopMult}R 保有${uo.holdDays}営業日]`
        );
      }
      // シグナルの有無にかかわらず判定根拠を log に残す(このコードが走ったことの確認にもなる)
      if (uo && uo.insufficientData) {
        log.push("USDOutside: 日足不足で判定不可");
      } else if (uo) {
        const aer = uo.avgER != null ? uo.avgER.toFixed(3) : "n/a";
        log.push(
          `USDOutside: 前日=${uo.prevBar ? uo.prevBar.date : "?"} ` +
            `outside=${uo.outside} dir=${uo.rawDirection} ` +
            `avgER=${aer}(閾値${uo.erThreshold}) → ${uo.direction ? "発火 " + uo.direction : "発火なし"}`
        );
      }
    } catch (e) {
      log.push(`USDOutside error: ${e.message}`);
    }
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
