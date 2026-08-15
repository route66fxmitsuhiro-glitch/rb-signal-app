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
const REFERENCE_MAX_DD_USD = 2510.22; // 実データの最大DD(現行ロット構成、口座通貨USD想定)
const MIN_LOT = 0.01;
const LOT_STEP = 0.01;

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
  const bars = json.values.map((v) => ({
    date: v.datetime.slice(0, 10),
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close),
  }));
  bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // 本日分がまだ形成中の可能性があるバーは除外する(保守的な近似)
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
    direction = prev.close >= prev.open ? "long" : "short";
  } else if (brokeHigh) {
    direction = "long";
  } else if (brokeLow) {
    direction = "short";
  }
  return { direction, outside: brokeHigh && brokeLow, brokeHigh, brokeLow };
}

function computeDailySignal(bars) {
  if (bars.length < 2) return null;
  const prev = bars[bars.length - 1];
  const prevPrev = bars[bars.length - 2];
  const res = breakoutDirection(prevPrev, prev);
  if (!res.direction) return null;
  return {
    direction: res.direction,
    outside: res.outside,
    prevBar: prev,
    prevPrevBar: prevPrev,
    referenceDate: prev.date,
    // 参考値: 当日の逆指値(反対ブレイク水準)は直近完成バーの安値/高値
    todayStopTrigger: res.direction === "long" ? prev.low : prev.high,
  };
}

// 日足バーを月曜始まりの週足に集計。「今日を含む週」は未完成として除外する。
function aggregateWeekly(dailyBars) {
  const groups = new Map();
  for (const b of dailyBars) {
    const wk = weekKeyOf(b.date);
    if (!groups.has(wk)) groups.set(wk, []);
    groups.get(wk).push(b);
  }
  const currentWeekKey = weekKeyOf(todayStr());
  const weeks = [];
  for (const [wk, arr] of groups.entries()) {
    if (wk === currentWeekKey) continue; // 進行中の週は除外
    arr.sort((a, b) => (a.date < b.date ? -1 : 1));
    weeks.push({
      weekKey: wk,
      open: arr[0].open,
      high: Math.max(...arr.map((x) => x.high)),
      low: Math.min(...arr.map((x) => x.low)),
      close: arr[arr.length - 1].close,
    });
  }
  weeks.sort((a, b) => (a.weekKey < b.weekKey ? -1 : 1));
  return weeks;
}

function computeWeeklySignal(weeklyBars) {
  if (weeklyBars.length < 2) return null;
  const prev = weeklyBars[weeklyBars.length - 1];
  const prevPrev = weeklyBars[weeklyBars.length - 2];
  const res = breakoutDirection(prevPrev, prev);
  if (!res.direction) return null;
  return {
    direction: res.direction,
    outside: res.outside,
    prevWeek: prev,
    prevPrevWeek: prevPrev,
    referenceWeek: prev.weekKey,
    todayStopTrigger: res.direction === "long" ? prev.low : prev.high,
  };
}

// DD逆算方式(教訓27)でロットを算出。resultはbaseLotに掛ける倍率と、丸め後ロットの両方を返す。
function lotScaleFactor(settings) {
  const ddBudgetUsd = (settings.capitalJpy / settings.usdJpy) * (settings.ddPct / 100);
  return ddBudgetUsd / REFERENCE_MAX_DD_USD;
}

function roundLot(v) {
  const r = Math.round(v / LOT_STEP) * LOT_STEP;
  return Math.max(MIN_LOT, Math.round(r * 100) / 100);
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

function renderSignals(results) {
  const section = document.getElementById("signalsSection");
  const container = document.getElementById("signalCards");
  container.innerHTML = "";
  const withSignal = results.filter((r) => r.daily.signal || r.weekly.signal);
  if (withSignal.length === 0) {
    section.classList.add("hidden");
    return;
  }
  section.classList.remove("hidden");

  for (const r of results) {
    if (!r.daily.signal && !r.weekly.signal) continue;
    const card = document.createElement("div");
    card.className = "pair-card";

    let html = `<div class="pair-head"><span class="pair-name">${r.label}</span></div>`;

    if (r.daily.signal) {
      const sig = r.daily.signal;
      const badge = sig.direction === "long" ? "long" : "short";
      const scale = lotScaleFactor(state.settings);
      const tranches = tranchesWithLots(DAILY_TRANCHES, BASE_LOT_DAILY, scale);
      html += `
        <div class="pair-meta">
          <span class="badge ${badge}">日足 ${sig.direction === "long" ? "ロング" : "ショート"}</span>
          ${sig.outside ? '<span class="badge warn">アウトサイド(前日終値で一本化)</span>' : ""}
          ATR14=${fmtPrice(r.daily.atr14, 3)} (R)
        </div>
        <div class="pair-meta">
          判定根拠: 前々日 高${fmtPrice(sig.prevPrevBar.high)}/安${fmtPrice(sig.prevPrevBar.low)}
          → 前日 高${fmtPrice(sig.prevBar.high)}/安${fmtPrice(sig.prevBar.low)}(${sig.prevBar.date}、
          ${sig.prevBar.close >= sig.prevBar.open ? "陽線" : "陰線"})
        </div>
        <table class="tranche-table">
          <thead><tr><th>枠</th><th>ロット</th><th>目標(pips)</th><th>初期逆指値目安</th></tr></thead>
          <tbody>
            ${tranches
              .map((t) => {
                const offPips = t.targetR != null ? fmtPips(r.daily.atr14 * t.targetR, r.symbol) : "なし(ride)";
                const stopNote = t.hardStopR
                  ? `${fmtPrice(sig.todayStopTrigger)} / -1.0R`
                  : fmtPrice(sig.todayStopTrigger);
                return `<tr><td>${t.name}</td><td>${t.lot.toFixed(2)}</td><td>${offPips}</td><td>${stopNote}</td></tr>`;
              })
              .join("")}
          </tbody>
        </table>
        <p class="section-note">エントリー(今日の始値)後、実際の約定価格を「保有中トランシェ」に記録してください。</p>
        <button class="btn btn-primary btn-small record-entry" data-symbol="${r.symbol}" data-label="${r.label}"
          data-timeframe="daily" data-direction="${sig.direction}" data-atr="${r.daily.atr14}">
          このシグナルを記録
        </button>
      `;
    }

    if (r.weekly.signal) {
      const sig = r.weekly.signal;
      const badge = sig.direction === "long" ? "long" : "short";
      const scale = lotScaleFactor(state.settings);
      const tranches = tranchesWithLots(WEEKLY_TRANCHES, BASE_LOT_WEEKLY, scale);
      const lastWeek = r.weekly.bars[r.weekly.bars.length - 1];
      const oppositeExtreme = sig.direction === "long" ? lastWeek.low : lastWeek.high;
      const breakoutLevel = sig.direction === "long" ? lastWeek.high : lastWeek.low;
      const rApprox = Math.abs(breakoutLevel - oppositeExtreme);
      html += `
        <div class="pair-meta" style="margin-top:10px;">
          <span class="badge ${badge}">週足 ${sig.direction === "long" ? "ロング" : "ショート"}(月曜のみ新規判定)</span>
          ${sig.outside ? '<span class="badge warn">アウトサイド週(前週終値で一本化)</span>' : ""}
          R(概算・先週レンジ幅)=${fmtPrice(rApprox, 3)}
        </div>
        <div class="pair-meta">
          判定根拠: 前々週(${sig.prevPrevWeek.weekKey}週) 高${fmtPrice(sig.prevPrevWeek.high)}/安${fmtPrice(sig.prevPrevWeek.low)}
          → 前週(${sig.prevWeek.weekKey}週) 高${fmtPrice(sig.prevWeek.high)}/安${fmtPrice(sig.prevWeek.low)}
          (${sig.prevWeek.close >= sig.prevWeek.open ? "陽線" : "陰線"})
        </div>
        <table class="tranche-table">
          <thead><tr><th>枠</th><th>ロット</th><th>目標(pips目安)</th><th>撤退ライン</th></tr></thead>
          <tbody>
            ${tranches
              .map((t) => {
                const offPips = t.targetR != null ? fmtPips(rApprox * t.targetR, r.symbol) : "なし(ride)";
                return `<tr><td>${t.name}</td><td>${t.lot.toFixed(2)}</td><td>${offPips}</td><td>${fmtPrice(sig.todayStopTrigger)}</td></tr>`;
              })
              .join("")}
          </tbody>
        </table>
        <button class="btn btn-primary btn-small record-entry" data-symbol="${r.symbol}" data-label="${r.label}"
          data-timeframe="weekly" data-direction="${sig.direction}" data-r="${rApprox}">
          このシグナルを記録
        </button>
      `;
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
        <thead><tr><th>枠</th><th>ロット</th><th>目標</th><th>済</th></tr></thead>
        <tbody>
    `;
    for (const t of pos.tranches) {
      const tp = targetPrice(pos, t);
      const rowClass = t.closed ? "closed" : "";
      html += `<tr class="${rowClass}">
        <td>${t.name}</td>
        <td>${t.lot.toFixed(2)}</td>
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
    R = parseFloat(pendingEntry.atr);
  } else {
    R = parseFloat(pendingEntry.r);
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
      const weeklyBars = aggregateWeekly(bars);
      const weeklySignal = computeWeeklySignal(weeklyBars);
      const r = {
        symbol: p.symbol,
        label: p.label,
        daily: { bars, atr14, signal: dailySignal },
        weekly: { bars: weeklyBars, signal: weeklySignal },
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
