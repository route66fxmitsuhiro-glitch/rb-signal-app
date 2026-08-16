"use strict";
/*
 * RBシグナル(コア版)
 * 日足RideThin(5トランシェ)+週足ドンチャン(3階層)のシグナル判定・
 * ロット計算・保有トランシェの目標/撤退ライン管理を行う。
 * ride サーキットブレーカーと9つの分散レイヤーは未実装(フェーズ2)。
 */

// ========== 設定値(EAの実装に合わせた固定値) ==========

const PAIRS = [
  { symbol: "GBP/JPY", label: "GBPJPY" },
  { symbol: "GBP/USD", label: "GBPUSD" },
  { symbol: "USD/JPY", label: "USDJPY" },
];

// 日足RideThin(Ride15配分)。targetR=nullは目標なし(ride、反対ブレイクのみ+ハードストップ)。
const DAILY_TRANCHES = [
  { name: "T0", weight: 0.20, targetR: 0.1 },
  { name: "T1", weight: 0.20, targetR: 0.2 },
  { name: "T2", weight: 0.25, targetR: 0.3 },
  { name: "T3", weight: 0.20, targetR: 0.5 },
  { name: "ride", weight: 0.15, targetR: null, hardStopR: -1.0 },
];

// 週足ドンチャン(3階層)。Rはブレイク幅そのもの(ATRではない)。rideにハードストップなし(教訓34)。
const WEEKLY_TRANCHES = [
  { name: "T0", weight: 1 / 3, targetR: 0.5 },
  { name: "T1", weight: 1 / 3, targetR: 1.0 },
  { name: "ride", weight: 1 / 3, targetR: null },
];

const BASE_LOT_DAILY = 0.10;   // バックテスト基準ロット(1ペアあたり)
const BASE_LOT_WEEKLY = 0.10;  // バックテスト基準ロット(1ペアあたり)
// 実データの最大DD(口座通貨USD想定、0.10ロット基準)。
// 【重要】このアプリはコア(日足RideThin+週足ドンチャン)のみを実装しており、
// RB12tuned全体(コア+12衛星レイヤー)のDD(2,510.22)ではなく、コア単体の
// DD(3,369.33、2026-08-16に確定損益ベースの疑似エクイティカーブで算出)を
// 使う。12層による分散効果でDDが縮んでいるため、フル構成の数値をそのまま
// 使うとコア単体運用としてはロットを過大評価してしまう。
const REFERENCE_MAX_DD_USD = 3369.33;

const API_OUTPUT_SIZE = 40; // ATR14+週足集計に十分な日数

// ========== ローカルストレージ ==========

const LS_SETTINGS = "rbsignal_settings_v1";
const LS_POSITIONS = "rbsignal_positions_v1";
const LS_THEME = "rbsignal_theme_v1";

function loadSettings() {
  const raw = localStorage.getItem(LS_SETTINGS);
  const defaults = { apiKey: "", capitalJpy: 3000000, ddPct: 20, usdJpy: 150 };
  if (!raw) return defaults;
  try { return { ...defaults, ...JSON.parse(raw) }; } catch { return defaults; }
}

function saveSettings(s) {
  localStorage.setItem(LS_SETTINGS, JSON.stringify(s));
}

function loadPositions() {
  const raw = localStorage.getItem(LS_POSITIONS);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

function savePositions(list) {
  localStorage.setItem(LS_POSITIONS, JSON.stringify(list));
}

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

// 「今日」はUTCではなく端末のローカル日付で判定する(JSTユーザーが朝チェックする
// 運用を想定。ymd()はUTC変換のため、todayStr()だけは別実装にする — 修正前は
// UTC日付を使っていたため、JSTの朝〜午前9時台は「今日」がまだ前日のまま判定され、
// 月曜の朝に週境界の判定がずれるバグがあった)
function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ========== Twelve Data 取得 ==========

// 日付文字列(YYYY-MM-DD)の曜日(UTC正午基準、weekKeyOfと同じ解釈)。0=日,6=土。
function dowOf(dateStr) {
  return new Date(dateStr + "T12:00:00Z").getUTCDay();
}

// 2本のバー(aが時系列で先、bが後)を1本にマージする。
function mergeBars(a, b) {
  return {
    date: b.date > a.date ? b.date : a.date, // 平日側の日付ラベルを優先
    open: a.open,
    high: Math.max(a.high, b.high),
    low: Math.min(a.low, b.low),
    close: b.close,
  };
}

// FXはニューヨーク時間17時にクローズするため、日本時間では土曜早朝まで
// 実際に値動きがある。「土曜日付のバー」を単純に除外すると金曜セッション
// 終盤の値動きを切り捨ててしまうため、除外ではなく直前の金曜バーへマージ
// する。日曜日付のバー(シドニー・ウェリントンの週明け早い時間帯)は、
// 直後の月曜バーへマージする。これにより「前日」ではなく実質的に
// 「前営業日」を使った判定になる。
function mergeWeekendIntoWeekdays(rawBars) {
  const sorted = [...rawBars].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const result = [];
  let i = 0;
  while (i < sorted.length) {
    const cur = sorted[i];
    const d = dowOf(cur.date);
    if (d === 6) {
      // 土曜 → 直前の平日バーにマージ(直前がなければ捨てる)
      if (result.length > 0) {
        result[result.length - 1] = mergeBars(result[result.length - 1], cur);
      }
      i++;
    } else if (d === 0) {
      // 日曜 → 直後のバー(通常は月曜)にマージ(直後がなければ捨てる)
      if (i + 1 < sorted.length) {
        result.push(mergeBars(cur, sorted[i + 1]));
        i += 2;
      } else {
        i++;
      }
    } else {
      result.push(cur);
      i++;
    }
  }
  return result;
}

// 実質的に値動きがない(高値=安値)バーは、休場日の繰り越しレコード
// である可能性が高いので、前営業日としては扱わない(土日マージ後に適用)。
function isDegenerateBar(b) {
  return b.high === b.low;
}

async function fetchDailyBars(symbol, apiKey) {
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
  const rawBars = json.values.map((v) => ({
    date: v.datetime.slice(0, 10),
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close),
  }));
  const merged = mergeWeekendIntoWeekdays(rawBars);
  const bars = merged.filter((b) => !isDegenerateBar(b));
  bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // 本日分がまだ形成中の可能性があるバーは除外する(保守的な近似)。
  const today = todayStr();
  const complete = bars.filter((b) => b.date < today);
  return complete.length >= 2 ? complete : bars.slice(0, -1);
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
// 高値・安値を両方同時に更新した場合(アウトサイド)は陽線/陰線で一本化する
// (=「高値を更新したから単純にロング」にはならない点に注意。outsideフラグを
// 呼び出し側に返すのでUIに理由を表示できるようにする)。
function breakoutDirection(prevPrev, prev) {
  const brokeHigh = prev.high > prevPrev.high;
  const brokeLow = prev.low < prevPrev.low;
  let direction = null;
  if (brokeHigh && brokeLow) {
    // EAと同じ扱い: 陽線→ロング、陰線→ショート、終値=始値の完全同値は
    // シグナルなし(direction=nullのまま)。
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
// direction:null は「シグナルなし」(=アプリが正常に動いた上での結論)を意味する。
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
    // 参考値: 当日の逆指値(反対ブレイク水準)は直近完成バーの安値/高値
    todayStopTrigger: res.direction ? (res.direction === "long" ? prev.low : prev.high) : null,
  };
}

// 【重要】実際のEA(RB12tuned.cpp)は「今日が月曜かどうか」ではなく、
// 「直近の完成日足バー(=前営業日)が月曜だったかどうか」で新しい週の
// 確定を検知している(UpdateWeeklyHistory: dow(Time(1))==Monday)。
// これは「月曜の足が閉じて初めて前週が確定し、その翌営業日(通常火曜)の
// 始値でエントリーする」ことを意味する。実データでも週足ドンチャンの
// エントリーは3,890件全件が火曜日だった(2026-08-16に実トレードログで確認済み)。
// 「月曜アンカー」という呼び方に引きずられて当初は月曜判定で実装していたが誤り。
function lastCompleteBarIsMonday(dailyBars) {
  if (dailyBars.length === 0) return false;
  const last = dailyBars[dailyBars.length - 1];
  return dowOf(last.date) === 1; // 1=月曜
}

// 日足バーを月曜始まりの週足に集計する。全ての週グループをそのまま返す
// (「EA確定済みの週」と「まだ確定していないが暦の上では完結している週」を
// 呼び出し側で使い分けられるようにするため)。
function aggregateWeekly(dailyBars) {
  const groups = new Map();
  for (const b of dailyBars) {
    const wk = weekKeyOf(b.date);
    if (!groups.has(wk)) groups.set(wk, []);
    groups.get(wk).push(b);
  }
  const weeks = [];
  for (const [wk, arr] of groups.entries()) {
    arr.sort((a, b) => (a.date < b.date ? -1 : 1));
    const lastDay = arr[arr.length - 1];
    weeks.push({
      weekKey: wk,
      open: arr[0].open,
      high: Math.max(...arr.map((x) => x.high)),
      low: Math.min(...arr.map((x) => x.low)),
      close: arr[arr.length - 1].close,
      lastDayDow: dowOf(lastDay.date), // 暦の上でこの週が金曜まで埋まっているか判定用
    });
  }
  weeks.sort((a, b) => (a.weekKey < b.weekKey ? -1 : 1));
  return weeks;
}

// EAが実際に使う「確定済みの週」だけを取り出す(直近1週グループは常に
// 未確定として除外。月曜の足しかない/金曜まで揃っているが翌週月曜の足が
// まだ来ていない、いずれの場合も同じ扱い)。
function officialWeeks(allWeeks) {
  return allWeeks.length > 0 ? allWeeks.slice(0, -1) : allWeeks;
}

// 「暦の上ではもう金曜まで終わっているが、EAはまだ確定として扱っていない」
// 週がある場合だけ、その週を使った参考プレビュー用の配列を返す(なければnull)。
// 月曜〜次の火曜の朝までの間だけこのプレビューが意味を持つ。
function previewWeeks(allWeeks) {
  if (allWeeks.length < 2) return null;
  const latest = allWeeks[allWeeks.length - 1];
  if (latest.lastDayDow !== 5) return null; // 金曜まで埋まっていなければプレビュー対象外
  const official = officialWeeks(allWeeks);
  if (official.length > 0 && official[official.length - 1].weekKey === latest.weekKey) return null;
  return allWeeks; // 末尾を落とさずそのまま返す(=直近の暦完結週を含む)
}

// シグナルの有無にかかわらず、必ず判定根拠(前々週/前週の高安)を含めて返す。
function computeWeeklySignal(weeklyBars) {
  if (weeklyBars.length < 2) {
    return { direction: null, insufficientData: true };
  }
  const prev = weeklyBars[weeklyBars.length - 1];
  const prevPrev = weeklyBars[weeklyBars.length - 2];
  const res = breakoutDirection(prevPrev, prev);
  return {
    direction: res.direction,
    outside: res.outside,
    prevWeek: prev,
    prevPrevWeek: prevPrev,
    referenceWeek: prev.weekKey,
    todayStopTrigger: res.direction ? (res.direction === "long" ? prev.low : prev.high) : null,
  };
}

// DD逆算方式(教訓27)でロットを算出。resultはbaseLotに掛ける倍率と、丸め後ロットの両方を返す。
function lotScaleFactor(settings) {
  const ddBudgetUsd = (settings.capitalJpy / settings.usdJpy) * (settings.ddPct / 100);
  return ddBudgetUsd / REFERENCE_MAX_DD_USD;
}

// EAのRoundLot()と完全に同じ式(floor(lot*100+0.5)/100、round-half-up)。
// 最小0.01への強制はしない — 実際のEAもスケールが小さすぎて0.005未満に
// 丸まった場合は0を返し、そのトランシェは発注されない(教訓67のロット丸め
// 誤差の議論と同じ挙動)。
function roundLot(v) {
  return Math.floor(v * 100 + 0.5) / 100;
}

function tranchesWithLots(tranches, baseLot, scale) {
  return tranches.map((t) => ({
    ...t,
    lot: roundLot(baseLot * t.weight * scale),
  }));
}

// ========== ポジション(保有トランシェ)モデル ==========
// { id, pairLabel, symbol, timeframe:'daily'|'weekly', direction, entryDate, entryPrice, R,
//   tranches: [{ name, targetR, hardStopR, lot, closed }] }

function buildPositionRecord(pairLabel, symbol, timeframe, direction, entryPrice, R, baseLot, scale) {
  const template = timeframe === "daily" ? DAILY_TRANCHES : WEEKLY_TRANCHES;
  const tranches = tranchesWithLots(template, baseLot, scale).map((t) => ({
    name: t.name,
    targetR: t.targetR,
    hardStopR: t.hardStopR || null,
    lot: t.lot,
    closed: false,
  }));
  return {
    id: `${symbol}-${timeframe}-${Date.now()}`,
    pairLabel,
    symbol,
    timeframe,
    direction,
    entryDate: todayStr(),
    entryPrice,
    R,
    tranches,
  };
}

function targetPrice(pos, tranche) {
  if (tranche.targetR == null) return null;
  const off = pos.R * tranche.targetR;
  return pos.direction === "long" ? pos.entryPrice + off : pos.entryPrice - off;
}

function hardStopPrice(pos, tranche) {
  if (!tranche.hardStopR) return null;
  const off = pos.R * Math.abs(tranche.hardStopR);
  return pos.direction === "long" ? pos.entryPrice - off : pos.entryPrice + off;
}

// 「反対ブレイクによる撤退ライン」を、そのポジションの時間軸に応じた最新の完成バーから計算し、
// hardStopがあればより近い方(エントリーに近い方)を採用する。
function currentExitLevel(pos, latestStopTrigger) {
  if (!latestStopTrigger) return { price: null, source: "データ不足" };
  const rideTranche = pos.tranches.find((t) => t.hardStopR);
  if (!rideTranche || rideTranche.closed) {
    return { price: latestStopTrigger, source: "反対ブレイク水準" };
  }
  const hs = hardStopPrice(pos, rideTranche);
  if (hs == null) return { price: latestStopTrigger, source: "反対ブレイク水準" };
  const nearer =
    pos.direction === "long"
      ? Math.max(latestStopTrigger, hs) // ロングはエントリーに近い方=高い方
      : Math.min(latestStopTrigger, hs); // ショートはエントリーに近い方=低い方
  return { price: nearer, source: nearer === hs ? "ハードストップ(-1.0R)" : "反対ブレイク水準" };
}

// ========== レンダリング ==========

const state = { settings: loadSettings(), positions: loadPositions(), lastFetch: null };

function fmtPrice(v, digits = 3) {
  if (v == null || Number.isNaN(v)) return "—";
  return v.toFixed(digits);
}

function fmtPips(v, symbol) {
  const isJpy = symbol.endsWith("JPY") || symbol.endsWith("/JPY");
  const pipSize = isJpy ? 0.01 : 0.0001;
  return (v / pipSize).toFixed(1);
}

// 内部計算は標準ロット単位(1.0=100,000通貨)のまま行い、表示だけ「枚」
// (1枚=10,000通貨、GMOクリック証券のFXネオ等の単位)に変換する。
// 1ロット=10枚、EAのRoundLot()の0.01ロット刻み=0.1枚刻みに相当。
const MAI_PER_LOT = 10;
function fmtMai(lot) {
  return (lot * MAI_PER_LOT).toFixed(1);
}

// 暦の上ではもう金曜まで終わっているがEAではまだ確定していない週がある
// 場合(主に月曜〜火曜朝)、その週を使った場合の参考プレビューをHTMLで返す。
// なければ空文字。
function renderWeeklyPreview(previewSignal, symbol) {
  if (!previewSignal || !previewSignal.direction) return "";
  const badge = previewSignal.direction === "long" ? "long" : "short";
  return `
    <div class="pair-meta">
      <span class="badge ${badge}">参考プレビュー: ${previewSignal.direction === "long" ? "ロング" : "ショート"}</span>
      (直近の暦完結週を含めた場合。まだEA未確定、火曜になれば正式判定に切り替わる)
    </div>
    <div class="pair-meta">
      根拠: 前々週(${previewSignal.prevPrevWeek.weekKey}週) 高${fmtPrice(previewSignal.prevPrevWeek.high)}/安${fmtPrice(previewSignal.prevPrevWeek.low)}
      → 前週(${previewSignal.prevWeek.weekKey}週) 高${fmtPrice(previewSignal.prevWeek.high)}/安${fmtPrice(previewSignal.prevWeek.low)}
    </div>
  `;
}

function renderSignals(results) {
  const section = document.getElementById("signalsSection");
  const container = document.getElementById("signalCards");
  container.innerHTML = "";
  // シグナルの有無にかかわらず、必ず全ペアを表示する(「シグナルなし」も
  // アプリが正常に動いた結果であることが見えるようにするため)。
  section.classList.remove("hidden");

  for (const r of results) {
    const card = document.createElement("div");
    card.className = "pair-card";

    let html = `<div class="pair-head"><span class="pair-name">${r.label}</span></div>`;

    // --- 日足 ---
    const dsig = r.daily.signal;
    if (dsig && dsig.insufficientData) {
      html += `<div class="pair-meta">日足: <span class="badge none">データ不足</span></div>`;
    } else if (dsig && dsig.direction) {
      const badge = dsig.direction === "long" ? "long" : "short";
      const scale = lotScaleFactor(state.settings);
      const tranches = tranchesWithLots(DAILY_TRANCHES, BASE_LOT_DAILY, scale);
      html += `
        <div class="pair-meta">
          <span class="badge ${badge}">日足 ${dsig.direction === "long" ? "ロング" : "ショート"}</span>
          ${dsig.outside ? '<span class="badge warn">アウトサイド(前日終値で一本化)</span>' : ""}
          ATR14=${fmtPrice(r.daily.atr14, 3)} (R)
        </div>
        <div class="pair-meta">
          判定根拠: 前々日 高${fmtPrice(dsig.prevPrevBar.high)}/安${fmtPrice(dsig.prevPrevBar.low)}
          → 前日 高${fmtPrice(dsig.prevBar.high)}/安${fmtPrice(dsig.prevBar.low)}(${dsig.prevBar.date}、
          ${dsig.prevBar.close >= dsig.prevBar.open ? "陽線" : "陰線"})
        </div>
        <table class="tranche-table">
          <thead><tr><th>枠</th><th>枚数</th><th>目標(pips)</th><th>初期逆指値目安</th></tr></thead>
          <tbody>
            ${tranches
              .map((t) => {
                const offPips = t.targetR != null ? fmtPips(r.daily.atr14 * t.targetR, r.symbol) : "なし(ride)";
                const stopNote = t.hardStopR
                  ? `${fmtPrice(dsig.todayStopTrigger)} / -1.0R`
                  : fmtPrice(dsig.todayStopTrigger);
                return `<tr><td>${t.name}</td><td>${fmtMai(t.lot)}枚</td><td>${offPips}</td><td>${stopNote}</td></tr>`;
              })
              .join("")}
          </tbody>
        </table>
        <p class="section-note">エントリー(今日の始値)後、実際の約定価格を「保有中トランシェ」に記録してください。</p>
        <button class="btn btn-primary btn-small record-entry" data-symbol="${r.symbol}" data-label="${r.label}"
          data-timeframe="daily" data-direction="${dsig.direction}" data-atr="${r.daily.atr14}">
          このシグナルを記録
        </button>
      `;
    } else if (dsig) {
      html += `
        <div class="pair-meta">
          日足: <span class="badge none">本日シグナルなし</span>
        </div>
        <div class="pair-meta">
          判定根拠: 前々日 高${fmtPrice(dsig.prevPrevBar.high)}/安${fmtPrice(dsig.prevPrevBar.low)}
          → 前日 高${fmtPrice(dsig.prevBar.high)}/安${fmtPrice(dsig.prevBar.low)}(${dsig.prevBar.date}、
          高値更新: ${dsig.brokeHigh ? "○" : "×"} / 安値更新: ${dsig.brokeLow ? "○" : "×"})
        </div>
      `;
    }

    // --- 週足 ---
    const wsig = r.weekly.signal;
    if (wsig && wsig.insufficientData) {
      html += `<div class="pair-meta" style="margin-top:10px;">週足: <span class="badge none">データ不足</span></div>`;
    } else if (wsig && wsig.direction) {
      const badge = wsig.direction === "long" ? "long" : "short";
      const scale = lotScaleFactor(state.settings);
      const tranches = tranchesWithLots(WEEKLY_TRANCHES, BASE_LOT_WEEKLY, scale);
      const lastWeek = r.weekly.bars[r.weekly.bars.length - 1];
      const isNewToday = lastCompleteBarIsMonday(r.daily.bars);
      // 実際のR = 約定価格 - 前週安値(ロング) / 前週高値 - 約定価格(ショート)。
      // 約定価格はまだ分からないため、表示用にATR代わりのレンジ幅ではなく
      // 「前週高値/安値を仮の約定価格とみなした場合のR」を参考値として出す
      // (エントリー記録時に実際の約定価格でこの計算をやり直す)。
      const rApprox = lastWeek.high - lastWeek.low;
      html += `
        <div class="pair-meta" style="margin-top:10px;">
          <span class="badge ${badge}">週足 ${wsig.direction === "long" ? "ロング" : "ショート"}</span>
          ${isNewToday ? '<span class="badge warn">本日が新規判定日</span>' : '<span class="badge none">新規判定日は前回の月曜明け(通常火曜)</span>'}
          ${wsig.outside ? '<span class="badge warn">アウトサイド週(前週終値で一本化)</span>' : ""}
          R(参考値、約定前の概算)=${fmtPrice(rApprox, 3)}
        </div>
        <p class="section-note">
          実際のR = 約定価格 - 前週安値(ロング)/前週高値 - 約定価格(ショート)。
          「このシグナルを記録」で実際の約定価格を入力すると正しいRに置き換わります。
          新規エントリーは「直前の完成日足バーが月曜だった日」(通常は火曜)にのみ行われます
          (月曜の足が確定して初めて前週が確定するため)。
        </p>
        <div class="pair-meta">
          判定根拠: 前々週(${wsig.prevPrevWeek.weekKey}週) 高${fmtPrice(wsig.prevPrevWeek.high)}/安${fmtPrice(wsig.prevPrevWeek.low)}
          → 前週(${wsig.prevWeek.weekKey}週) 高${fmtPrice(wsig.prevWeek.high)}/安${fmtPrice(wsig.prevWeek.low)}
          (${wsig.prevWeek.close >= wsig.prevWeek.open ? "陽線" : "陰線"})
        </div>
        <table class="tranche-table">
          <thead><tr><th>枠</th><th>枚数</th><th>目標(pips目安)</th><th>撤退ライン</th></tr></thead>
          <tbody>
            ${tranches
              .map((t) => {
                const offPips = t.targetR != null ? fmtPips(rApprox * t.targetR, r.symbol) : "なし(ride)";
                return `<tr><td>${t.name}</td><td>${fmtMai(t.lot)}枚</td><td>${offPips}</td><td>${fmtPrice(wsig.todayStopTrigger)}</td></tr>`;
              })
              .join("")}
          </tbody>
        </table>
        ${
          isNewToday
            ? `<button class="btn btn-primary btn-small record-entry" data-symbol="${r.symbol}" data-label="${r.label}"
                 data-timeframe="weekly" data-direction="${wsig.direction}"
                 data-prevweekhigh="${lastWeek.high}" data-prevweeklow="${lastWeek.low}">
                 このシグナルを記録
               </button>`
            : `<p class="section-note">本日は新規判定日ではありません。既にエントリー済みなら記録不要、
               まだなら次の月曜明け(通常火曜)を待ってください。</p>`
        }
      `;
      html += renderWeeklyPreview(r.weekly.previewSignal, r.symbol);
    } else if (wsig) {
      const isNewToday = lastCompleteBarIsMonday(r.daily.bars);
      html += `
        <div class="pair-meta" style="margin-top:10px;">
          週足: <span class="badge none">シグナルなし</span>
          ${isNewToday ? '<span class="badge warn">本日は新規判定日</span>' : ""}
        </div>
        <div class="pair-meta">
          判定根拠: 前々週(${wsig.prevPrevWeek.weekKey}週) 高${fmtPrice(wsig.prevPrevWeek.high)}/安${fmtPrice(wsig.prevPrevWeek.low)}
          → 前週(${wsig.prevWeek.weekKey}週) 高${fmtPrice(wsig.prevWeek.high)}/安${fmtPrice(wsig.prevWeek.low)}
          (高値更新: ${wsig.brokeHigh ? "○" : "×"} / 安値更新: ${wsig.brokeLow ? "○" : "×"})
        </div>
      `;
      html += renderWeeklyPreview(r.weekly.previewSignal, r.symbol);
    }

    card.innerHTML = html;
    container.appendChild(card);
  }

  container.querySelectorAll(".record-entry").forEach((btn) => {
    btn.addEventListener("click", () => openEntryModal(btn.dataset));
  });
}

function renderPositions(freshDataBySymbol) {
  const container = document.getElementById("positionCards");
  const empty = document.getElementById("noPositions");
  container.innerHTML = "";
  const openPositions = state.positions.filter((p) => p.tranches.some((t) => !t.closed));
  empty.classList.toggle("hidden", openPositions.length > 0);

  for (const pos of openPositions) {
    const fresh = freshDataBySymbol ? freshDataBySymbol[pos.symbol] : null;
    let stopTrigger = null;
    if (fresh) {
      stopTrigger =
        pos.timeframe === "daily"
          ? pos.direction === "long"
            ? fresh.daily.bars[fresh.daily.bars.length - 1].low
            : fresh.daily.bars[fresh.daily.bars.length - 1].high
          : fresh.weekly.bars.length
          ? pos.direction === "long"
            ? fresh.weekly.bars[fresh.weekly.bars.length - 1].low
            : fresh.weekly.bars[fresh.weekly.bars.length - 1].high
          : null;
    }
    const exit = currentExitLevel(pos, stopTrigger);

    const card = document.createElement("div");
    card.className = "pair-card";
    const badge = pos.direction === "long" ? "long" : "short";
    let html = `
      <div class="pair-head">
        <span class="pair-name">${pos.pairLabel}</span>
        <span class="badge ${badge}">${pos.timeframe === "daily" ? "日足" : "週足"} ${pos.direction === "long" ? "ロング" : "ショート"}</span>
      </div>
      <div class="pair-meta">エントリー ${pos.entryDate} @ ${fmtPrice(pos.entryPrice)} / R=${fmtPrice(pos.R)}</div>
      <div class="pair-meta">現在の撤退ライン: <strong>${fmtPrice(exit.price)}</strong>(${exit.source})</div>
      <table class="tranche-table">
        <thead><tr><th>枠</th><th>枚数</th><th>目標</th><th>済</th></tr></thead>
        <tbody>
    `;
    for (const t of pos.tranches) {
      const tp = targetPrice(pos, t);
      const rowClass = t.closed ? "closed" : "";
      html += `<tr class="${rowClass}">
        <td>${t.name}</td>
        <td>${fmtMai(t.lot)}枚</td>
        <td>${tp != null ? fmtPrice(tp) : "なし(反対ブレイクのみ)"}</td>
        <td><input type="checkbox" class="close-toggle" data-pos="${pos.id}" data-tranche="${t.name}" ${t.closed ? "checked" : ""} /></td>
      </tr>`;
    }
    html += `</tbody></table>`;
    if (
      stopTrigger != null &&
      ((pos.direction === "long" && stopTrigger < pos.entryPrice && exit.price != null) ||
        (pos.direction === "short" && stopTrigger > pos.entryPrice && exit.price != null))
    ) {
      // 参考: 撤退ラインが既に破られていそうな粗いチェックは行わず、常に最新ラインを表示するのみに留める
    }
    html += `<div class="pair-actions">
      <button class="btn btn-ghost btn-small delete-position" data-pos="${pos.id}">削除</button>
    </div>`;
    card.innerHTML = html;
    container.appendChild(card);
  }

  container.querySelectorAll(".close-toggle").forEach((cb) => {
    cb.addEventListener("change", () => {
      const pos = state.positions.find((p) => p.id === cb.dataset.pos);
      const t = pos.tranches.find((x) => x.name === cb.dataset.tranche);
      t.closed = cb.checked;
      savePositions(state.positions);
      renderPositions(freshDataBySymbol);
    });
  });
  container.querySelectorAll(".delete-position").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!confirm("このポジション記録を削除しますか?")) return;
      state.positions = state.positions.filter((p) => p.id !== btn.dataset.pos);
      savePositions(state.positions);
      renderPositions(freshDataBySymbol);
    });
  });
}

// ========== エントリー記録モーダル ==========

let pendingEntry = null;

function openEntryModal(ds) {
  pendingEntry = ds;
  document.getElementById("entryModalTitle").textContent = `${ds.label} ${ds.timeframe === "daily" ? "日足" : "週足"} ${ds.direction === "long" ? "ロング" : "ショート"} — 約定価格を入力`;
  document.getElementById("entryPriceInput").value = "";
  document.getElementById("entryModal").classList.remove("hidden");
}

function closeEntryModal() {
  document.getElementById("entryModal").classList.add("hidden");
  pendingEntry = null;
}

function confirmEntry() {
  if (!pendingEntry) return;
  const price = parseFloat(document.getElementById("entryPriceInput").value);
  if (!price || price <= 0) {
    alert("約定価格を正しく入力してください");
    return;
  }
  const scale = lotScaleFactor(state.settings);
  let R;
  if (pendingEntry.timeframe === "daily") {
    // 日足のRはATR14そのもの(約定価格に依存しない、EAのr=ComputeATR14()と同じ)
    R = parseFloat(pendingEntry.atr);
  } else {
    // 週足のRは実際の約定価格から計算し直す(EAのr = ep-前週安値 / 前週高値-ep と同じ式)。
    const prevWeekHigh = parseFloat(pendingEntry.prevweekhigh);
    const prevWeekLow = parseFloat(pendingEntry.prevweeklow);
    R = pendingEntry.direction === "long" ? price - prevWeekLow : prevWeekHigh - price;
    if (!(R > 0)) {
      alert("入力された約定価格からRが0以下になりました(EAの実装ではこの場合エントリーしません)。価格を確認してください。");
      return;
    }
  }
  const baseLot = pendingEntry.timeframe === "daily" ? BASE_LOT_DAILY : BASE_LOT_WEEKLY;
  const rec = buildPositionRecord(
    pendingEntry.label,
    pendingEntry.symbol,
    pendingEntry.timeframe,
    pendingEntry.direction,
    price,
    R,
    baseLot,
    scale
  );
  state.positions.push(rec);
  savePositions(state.positions);
  closeEntryModal();
  renderPositions(state.lastFetch);
  alert("記録しました。「保有中トランシェ」に表示されます。");
}

function manualAddPosition() {
  const symbol = prompt("通貨ペア(GBP/JPY, GBP/USD, USD/JPY のいずれか):", "GBP/JPY");
  if (!symbol) return;
  const pairInfo = PAIRS.find((p) => p.symbol.toLowerCase() === symbol.trim().toLowerCase());
  if (!pairInfo) { alert("対応していない通貨ペアです"); return; }
  const timeframe = confirm("日足なら「OK」、週足なら「キャンセル」を押してください") ? "daily" : "weekly";
  const direction = confirm("ロングなら「OK」、ショートなら「キャンセル」を押してください") ? "long" : "short";
  const price = parseFloat(prompt("約定価格:", ""));
  const R = parseFloat(prompt(timeframe === "daily" ? "エントリー時のATR14:" : "R(先週レンジ幅の概算):", ""));
  if (!price || !R) { alert("入力が不正です"); return; }
  const scale = lotScaleFactor(state.settings);
  const baseLot = timeframe === "daily" ? BASE_LOT_DAILY : BASE_LOT_WEEKLY;
  const rec = buildPositionRecord(pairInfo.label, pairInfo.symbol, timeframe, direction, price, R, baseLot, scale);
  state.positions.push(rec);
  savePositions(state.positions);
  renderPositions(state.lastFetch);
}

// ========== メインフロー ==========

async function fetchAndRender() {
  const statusEl = document.getElementById("fetchStatus");
  const btn = document.getElementById("fetchBtn");
  const s = state.settings;
  if (!s.apiKey) {
    statusEl.textContent = "設定でTwelve DataのAPIキーを入力してください";
    statusEl.classList.add("error");
    return;
  }
  btn.disabled = true;
  statusEl.classList.remove("error");
  statusEl.textContent = "取得中…";

  const results = [];
  const freshBySymbol = {};
  try {
    for (const p of PAIRS) {
      const bars = await fetchDailyBars(p.symbol, s.apiKey);
      const atr14 = computeATR14(bars);
      const dailySignal = computeDailySignal(bars);
      const allWeeklyBars = aggregateWeekly(bars);
      const weeklyBars = officialWeeks(allWeeklyBars);
      const weeklySignal = computeWeeklySignal(weeklyBars);
      // 暦の上ではもう金曜まで終わっているがEAはまだ確定として扱っていない
      // 週がある場合(月曜〜火曜朝によくある)、参考プレビューも計算する。
      const pvWeeks = previewWeeks(allWeeklyBars);
      const previewSignal = pvWeeks ? computeWeeklySignal(pvWeeks) : null;
      const r = {
        symbol: p.symbol,
        label: p.label,
        daily: { bars, atr14, signal: dailySignal },
        weekly: { bars: weeklyBars, signal: weeklySignal, previewSignal },
      };
      results.push(r);
      freshBySymbol[p.symbol] = r;
    }
    state.lastFetch = freshBySymbol;
    renderSignals(results);
    renderPositions(freshBySymbol);
    statusEl.textContent = `取得完了(${new Date().toLocaleString("ja-JP")})`;
  } catch (e) {
    statusEl.textContent = `エラー: ${e.message}`;
    statusEl.classList.add("error");
  } finally {
    btn.disabled = false;
  }
}

// ========== 初期化 ==========

function applyTheme() {
  const saved = localStorage.getItem(LS_THEME);
  if (saved) document.documentElement.setAttribute("data-theme", saved);
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem(LS_THEME, next);
}

function initSettingsUI() {
  const s = state.settings;
  document.getElementById("apiKey").value = s.apiKey;
  document.getElementById("capitalJpy").value = s.capitalJpy;
  document.getElementById("ddPct").value = s.ddPct;
  document.getElementById("usdJpy").value = s.usdJpy;

  document.getElementById("settingsToggle").addEventListener("click", () => {
    const body = document.getElementById("settingsBody");
    const chevron = document.getElementById("settingsChevron");
    body.classList.toggle("hidden");
    chevron.classList.toggle("open");
  });

  document.getElementById("saveSettings").addEventListener("click", () => {
    state.settings = {
      apiKey: document.getElementById("apiKey").value.trim(),
      capitalJpy: parseFloat(document.getElementById("capitalJpy").value) || 0,
      ddPct: parseFloat(document.getElementById("ddPct").value) || 0,
      usdJpy: parseFloat(document.getElementById("usdJpy").value) || 150,
    };
    saveSettings(state.settings);
    const flag = document.getElementById("settingsSaved");
    flag.classList.remove("hidden");
    setTimeout(() => flag.classList.add("hidden"), 2000);
  });
}

function init() {
  applyTheme();
  document.getElementById("themeToggle").addEventListener("click", toggleTheme);
  initSettingsUI();
  document.getElementById("fetchBtn").addEventListener("click", fetchAndRender);
  document.getElementById("addPositionBtn").addEventListener("click", manualAddPosition);
  document.getElementById("entryModalCancel").addEventListener("click", closeEntryModal);
  document.getElementById("entryModalConfirm").addEventListener("click", confirmEntry);
  renderPositions(null);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

document.addEventListener("DOMContentLoaded", init);
