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
  executionWindow,
  EXEC_LEAD_MIN,
} = SC;

// --- 執行ウィンドウ判定(2026-09-22に改定) ---
// 旧実装は「NY17:00境界の -30分〜+8時間」だったため、**足が確定する前にも
// 発火しうる**うえ、通知がロールオーバー直後(1日で最もスプレッドが広い瞬間)に
// 届いていた。実測(GBPJPY 20〜30pips・USDJPY 約10pips、7:30で解消)に基づき、
// **執行推奨は足の確定から90分後**(夏7:30 / 冬8:30 JST)に変更。
// 通知はその10分前から出し、遅延に備えて確定+8時間までを対象ウィンドウとする。
// 判定ロジックは signal-core.js の executionWindow() に集約してあり、
// アプリ本体のバナーと同じ関数を使う(実装が2箇所に分かれて腐るのを防ぐ)。
const WINDOW_AFTER_MIN = 8 * 60;   // 確定からの上限

function evaluateWindow(now) {
  const w = executionWindow(now);
  if (!w) return { inWindow: false, reason: "NY境界の算出に失敗" };
  const inWindow = w.minsFromExec >= -EXEC_LEAD_MIN && w.minsFromClose <= WINDOW_AFTER_MIN;
  const reason = `now=${now.toISOString()} 確定=${w.close.toISOString()}`
    + ` 執行推奨=${w.execAt.toISOString()}(JST ${w.execJst})`
    + ` 推奨からの経過=${w.minsFromExec}分 inWindow=${inWindow} tradingDay=${w.tradingDay}`;
  return { inWindow, boundary: w.close, key: w.key, tradingDay: w.tradingDay,
           execJst: w.execJst, closeJst: w.closeJst,
           minsFromExec: w.minsFromExec, reason };
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
  // 2026-09-14発見: 前々日・前日が連続した営業日でない(間の平日が丸ごと
  // 欠落している)場合、日足判定(シグナルの有無・方向とも)は信用できない。
  // missingTradingDaysのバグ(末尾バー起点で走査していたため内部の穴を
  // 検出できなかった)は修正済みだが、Twelve Dataキー未設定等でなお穴が
  // 残りうるため、通知でも二重に警告する。
  if (dailySignal && dailySignal.dateGap && dailySignal.prevBar && dailySignal.prevPrevBar) {
    lines.push(
      `⚠️ ${pair.label} 日足: 前々日(${dailySignal.prevPrevBar.date})と前日(${dailySignal.prevBar.date})の間の` +
        `営業日データが欠落しています。この日足判定は信用できません(スクショで補完してください)。`
    );
  }
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

async function postDiscord(url, lines, win) {
  // 執行時刻の注意書き。ロールオーバー直後に発注させないための一文。
  const execNote = (win && win.execJst)
    ? "\n⏰ 執行推奨 " + win.execJst + "(足の確定から90分後)。"
      + "ロールオーバー直後はGBPJPYで20〜30pips開くので、この時刻まで待つこと。"
    : "";
  const content = "📈 **RBシグナル**\n" + lines.join("\n") + execNote
    + "\n※自動発注はしません。手動で発注してください。";
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
      sent = await postDiscord(env.DISCORD_WEBHOOK_URL, lines, win);
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
