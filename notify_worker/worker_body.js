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
  fetchRawDailyValuesAuto,
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
  for (const pair of PAIRS) {
    try {
      const fetched = await fetchRawDailyValuesAuto(pair.symbol, env.TWELVE_DATA_API_KEY);
      rawBySymbol[pair.symbol] = fetched.raw;
      sourceBySymbol[pair.symbol] = fetched.source;
      log.push(`${pair.label} data: ${fetched.note}`);
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
    const r = analysePair(pair, bars, weeklySrcBySymbol[pair.symbol], sourceBySymbol[pair.symbol] === "FT5");
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
