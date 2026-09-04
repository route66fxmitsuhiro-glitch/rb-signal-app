"use strict";
/*
 * RBシグナル(コア版)
 * 日足RideThin(5トランシェ)+週足ドンチャン(3階層)のシグナル判定・
 * ロット計算・保有トランシェの目標/撤退ライン管理を行う。
 * ride サーキットブレーカーと9つの分散レイヤーは未実装(フェーズ2)。
 */

// ========== 共通ロジック(signal-core.js)からの読み込み ==========
// シグナル判定の純粋ロジックは signal-core.js に集約し、通知バッチ
// (notify/check-signals.js)と共有している。ここでは分割代入で必要な
// 関数・定数を取り出すだけにし、二重実装によるロジックのズレを防ぐ。
const {
  PAIRS,
  USD_OUTSIDE,
  weekKeyOf,
  todayStr,
  addTradingDays,
  fetchDailyBars,
  computeATR14,
  computeDailySignal,
  computeAvgER,
  computeUsdOutsideSignal,
  lastCompleteBarIsMonday,
  aggregateWeekly,
  officialWeeks,
  previewWeeks,
  computeWeeklySignal,
} = SignalCore;

// ========== 設定値(EAの実装に合わせた固定値) ==========

// 日足RideThin(Ride15配分)。targetR=nullは目標なし(ride、反対ブレイクのみ+ハードストップ)。
const DAILY_TRANCHES = [
  { name: "T0", weight: 0.20, targetR: 0.1 },
  { name: "T1", weight: 0.20, targetR: 0.2 },
  { name: "T2", weight: 0.25, targetR: 0.3 },
  { name: "T3", weight: 0.20, targetR: 0.5 },
  { name: "ride", weight: 0.15, targetR: null, hardStopR: -1.0 },
];

// 週足ドンチャン(3階層)。Rはブレイク幅そのもの(ATRではない)。rideにハードストップなし(教訓34)。
// WDLite(2026-08-31): DD削減のため各トランシェのロットを縮小。
// EAは tierLot = RoundLot(WDLotSize/3) = RoundLot(0.10/3) = 0.03 を作り、
// T0/T1 に ×0.667(→0.02)、ride に ×0.333(→0.01)を掛けて再度丸める2段階。lotMult がその倍率。
const WEEKLY_TRANCHES = [
  { name: "T0", weight: 1 / 3, targetR: 0.5, lotMult: 0.667 },
  { name: "T1", weight: 1 / 3, targetR: 1.0, lotMult: 0.667 },
  { name: "ride", weight: 1 / 3, targetR: null, lotMult: 0.333 },
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

// ========== ローカルストレージ ==========

const LS_SETTINGS = "rbsignal_settings_v1";
const LS_POSITIONS = "rbsignal_positions_v1";
const LS_THEME = "rbsignal_theme_v1";

function loadSettings() {
  const raw = localStorage.getItem(LS_SETTINGS);
  const defaults = {
    apiKey: "", capitalJpy: 3000000, ddPct: 20, usdJpy: 150,
    usdJpyAuto: true,       // USD/JPYレートを前日終値から自動取得する
    usdJpyCached: null,     // 直近の取得値(セッションをまたいでロット計算に使う)
    usdJpyCachedDate: null,
    anthropicKey: "",       // 注文チェックのAI照合用(任意)。この端末にのみ保存。
    visionModel: "claude-opus-5",
  };
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

// 日付・週の補助関数、Twelve Data取得、シグナル計算ロジックは
// signal-core.js に集約済み(ファイル冒頭の分割代入を参照)。

// 有効なUSD/JPYレート。自動ONなら「今回取得した前日終値(なければ前回キャッシュ)」、
// OFFなら手動入力値。用途はロットサイジングのJPY→USD換算だけなので前日終値で十分。
function effectiveUsdJpy(settings) {
  if (settings.usdJpyAuto) {
    const auto = (state.autoUsdJpy && state.autoUsdJpy.rate) || settings.usdJpyCached;
    if (auto && auto > 0) return auto;
  }
  return settings.usdJpy || 150;
}

// DD逆算方式(教訓27)でロットを算出。resultはbaseLotに掛ける倍率と、丸め後ロットの両方を返す。
function lotScaleFactor(settings) {
  const ddBudgetUsd = (settings.capitalJpy / effectiveUsdJpy(settings)) * (settings.ddPct / 100);
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
  return tranches.map((t) => {
    let lot;
    if (t.lotMult != null) {
      // EA(WDLite)互換: tierLot = RoundLot(baseLot * weight) を作ってから lotMult を掛けて再度丸める2段階。
      const tierLot = roundLot(baseLot * t.weight);
      lot = roundLot(tierLot * t.lotMult * scale);
    } else {
      lot = roundLot(baseLot * t.weight * scale);
    }
    return { ...t, lot };
  });
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
    exitOverride: null, // ブローカー実チャートとの乖離時に手動設定する撤退ライン(nullなら自動計算値を使う)
    orderCheck: {},     // 注文チェック画面でユーザーが「一致」を確認した項目キーの集合
  };
}

// USDJPYアウトサイドデイ継続の建玉レコード。コアの5トランシェとは形が違う:
// 単一ユニット・利食い目標なし・固定逆指値(トレールしない)・時間切れ手仕舞い。
// 既存の renderPositions / orderCheckItems / close-toggle 配線をそのまま流用できる
// よう、tranches は1要素(name:"unit")で表現しつつ kind で分岐する。
function buildSatelliteRecord(sig, entryPrice, scale) {
  const lot = roundLot(sig.lot * scale);
  const R = sig.atr14;
  const fixedStop =
    sig.direction === "long"
      ? entryPrice - sig.stopMult * R
      : entryPrice + sig.stopMult * R;
  const entryDate = todayStr();
  return {
    id: `${sig.symbol}-usdoutside-${Date.now()}`,
    kind: "usd-outside",
    pairLabel: sig.label,
    symbol: sig.symbol,
    timeframe: "daily",
    direction: sig.direction,
    entryDate,
    entryPrice,
    R,
    stopMult: sig.stopMult,
    holdDays: sig.holdDays,
    fixedStop,
    exitDate: addTradingDays(entryDate, sig.holdDays), // 時間切れ手仕舞い目安(平日カウント)
    tranches: [{ name: "unit", targetR: null, hardStopR: null, lot, closed: false }],
    exitOverride: null,
    orderCheck: {},
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

// 週足の撤退ライン根拠を、実際の日足バー内訳(どの日の安値/高値が採用値かを含む)まで
// 遡って返す。ブローカー表示とのズレを切り分けるための診断表示に使う。
function weeklyBreakdown(weekBar, dailyBars, direction) {
  if (!weekBar || !dailyBars) return null;
  const daysInWeek = dailyBars.filter((b) => weekKeyOf(b.date) === weekBar.weekKey);
  const extremeVal = direction === "long" ? weekBar.low : weekBar.high;
  return {
    weekKey: weekBar.weekKey,
    days: daysInWeek.map((d) => ({
      date: d.date,
      low: d.low,
      high: d.high,
      isExtreme: direction === "long" ? d.low === extremeVal : d.high === extremeVal,
    })),
  };
}

// 「反対ブレイクによる撤退ライン」を、そのポジションの時間軸に応じた最新の完成バーから計算し、
// hardStopがあればより近い方(エントリーに近い方)を採用する。
function currentExitLevel(pos, latestStopTrigger) {
  // USDOutside は固定逆指値(約定 ∓ StopMult×ATR14)。トレールも反対ブレイクも使わない。
  if (pos.kind === "usd-outside") {
    return { price: pos.fixedStop, source: `固定逆指値(${pos.stopMult}R、トレールなし)` };
  }
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

const state = { settings: loadSettings(), positions: loadPositions(), lastFetch: null, lastResults: null, autoUsdJpy: null, avgER: null, orderShot: null, orderCheckAiMeta: null };

// EAのUSDOutsideレイヤーは専用の建玉スロットを1つだけ持ち、そのスロットが
// 埋まっている間は新規シグナルを一切評価しない(方向は問わない = 同時に持てる
// のは1本だけ)。このアプリはEAの内部状態を持たないため、ユーザーが記録済みの
// 未決済 usd-outside ポジションで代用判定する。
function hasOpenSatellite(kind) {
  return state.positions.some(
    (p) => p.kind === kind && p.tranches.some((t) => !t.closed)
  );
}

// EAの AnyOpen()/WDAnyOpen() 相当。同じペア・時間軸・方向のトランシェが
// 1つでも未決済で残っている間、EAは新しいブレイクアウトが成立しても
// 新規エントリーしない(rideトランシェは反対ブレイクまで長く保有される
// ため、保有中に同方向のブレイクが再度起きることは珍しくない)。
// このアプリはEAの内部状態(handle配列)を持たないため、ユーザーが
// 「保有中トランシェ」に記録している未決済ポジションで代用判定する。
function hasOpenPosition(symbol, timeframe, direction) {
  return state.positions.some(
    (p) =>
      p.symbol === symbol &&
      p.timeframe === timeframe &&
      p.direction === direction &&
      p.tranches.some((t) => !t.closed)
  );
}

// 【重要】円ペア(pip=0.01)は小数3桁で十分だが、GBPUSD等(pip=0.0001)は
// 3桁では10pips未満の差を区別できず、例えばT0(0.5R)とT1(1.0R)の目標が
// 同じ表示に丸まってしまうバグがあった(2026-08-17発見・修正)。
// 第2引数にシンボル文字列を渡せばペアに応じた桁数を自動選択する
// (円ペア=3桁、非円ペア=5桁)。数値を渡した場合は従来通り桁数を明示指定できる。
function fmtPrice(v, symbolOrDigits) {
  if (v == null || Number.isNaN(v)) return "—";
  let digits;
  if (typeof symbolOrDigits === "number") {
    digits = symbolOrDigits;
  } else if (typeof symbolOrDigits === "string") {
    const isJpy = symbolOrDigits.endsWith("JPY") || symbolOrDigits.endsWith("/JPY");
    digits = isJpy ? 3 : 5;
  } else {
    digits = 3;
  }
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

// 保有カード等に出す時間軸ラベル。分散レイヤーはレイヤー名を返す。
function tfLabel(pos) {
  if (pos.kind === "usd-outside") return "アウトサイドデイ継続";
  return pos.timeframe === "daily" ? "日足" : "週足";
}

// 暦の上ではもう金曜まで終わっているがEAではまだ確定していない週がある
// 場合(主に月曜〜火曜朝)、その週を使った場合の参考プレビューをHTMLで返す。
// なければ空文字。
// 週足の entryGuard(EAの r>0 ガードの近似判定)を人間向けの1行に整形する。
// vetoed=true なら「EAは新規建てしない」、kind="wick" なら「要注意」。
function weeklyGuardHtml(guard, symbol) {
  if (!guard) return "";
  const lvlName = guard.direction === "long" ? "安値" : "高値";
  const verb = guard.direction === "long" ? "割り込み" : "上抜け";
  const what = guard.kind === "close" ? "終値" : lvlName;
  const msg =
    `直近日足(${guard.barDate})の${what} ${fmtPrice(guard.barValue, symbol)} が ` +
    `前週${lvlName} ${fmtPrice(guard.level, symbol)} を${verb}`;
  if (guard.vetoed) {
    return `<p class="section-note"><strong>${msg}。</strong>
      現値が撤退ラインの向こう側にあるため、EAはこの週の新規建てを見送ります(r≤0)。</p>`;
  }
  return `<p class="section-note">${msg}(終値は戻す)。
    火曜の始値が撤退ラインの外側で寄れば、EAはこの週の新規建てを見送ります。</p>`;
}

function renderWeeklyPreview(previewSignal, symbol) {
  if (!previewSignal || !previewSignal.direction) return "";
  const badge = previewSignal.direction === "long" ? "long" : "short";
  return `
    <div class="pair-meta">
      <span class="badge ${badge}">参考プレビュー: ${previewSignal.direction === "long" ? "ロング" : "ショート"}</span>
      (直近の暦完結週を含めた場合。まだEA未確定、火曜になれば正式判定に切り替わる)
      ${previewSignal.entryGuard && previewSignal.entryGuard.vetoed ? '<span class="badge short">この状況ならEAは見送り</span>' : ""}
    </div>
    ${weeklyGuardHtml(previewSignal.entryGuard, symbol)}
    <div class="pair-meta">
      根拠: 前々週(${previewSignal.prevPrevWeek.weekKey}週) 高${fmtPrice(previewSignal.prevPrevWeek.high, symbol)}/安${fmtPrice(previewSignal.prevPrevWeek.low, symbol)}
      → 前週(${previewSignal.prevWeek.weekKey}週) 高${fmtPrice(previewSignal.prevWeek.high, symbol)}/安${fmtPrice(previewSignal.prevWeek.low, symbol)}
    </div>
  `;
}

// USDJPYアウトサイドデイ継続レイヤーの表示ブロック。シグナルの有無にかかわらず
// 判定根拠(アウトサイドデイ成否・ER・ゲート状態)を必ず出す。
function renderUsdOutsideBlock(sig, symbol) {
  let h = `<div class="pair-meta" style="margin-top:10px;">
    <span class="badge none">分散レイヤー: アウトサイドデイ継続(USDJPY)</span></div>`;

  if (sig.insufficientData) {
    h += `<div class="pair-meta">データ不足(確定日足が足りません)</div>`;
    return h;
  }

  const gateTxt = !sig.gateReady
    ? "ER算出に必要な確定日足(21本)が不足"
    : `avgER=${sig.avgER.toFixed(3)}(閾値 ${sig.erThreshold} ${sig.gateOpen ? "超 → ゲート開" : "以下 → ゲート閉"})`;
  h += `<div class="pair-meta">効率比ゲート(3ペア平均、高ERで有効): ${gateTxt}
    ${sig.perPairER ? `<span class="section-note">[GBPJPY ${sig.perPairER.GBPJPY.toFixed(3)} / GBPUSD ${sig.perPairER.GBPUSD.toFixed(3)} / USDJPY ${sig.perPairER.USDJPY.toFixed(3)}]</span>` : ""}
  </div>`;
  h += `<div class="pair-meta">
    判定根拠: 前々日 高${fmtPrice(sig.prevPrevBar.high, symbol)}/安${fmtPrice(sig.prevPrevBar.low, symbol)}
    → 前日 高${fmtPrice(sig.prevBar.high, symbol)}/安${fmtPrice(sig.prevBar.low, symbol)}(${sig.prevBar.date}、
    ${sig.prevBar.close > sig.prevBar.open ? "陽線" : sig.prevBar.close < sig.prevBar.open ? "陰線" : "同値"}) /
    アウトサイドデイ: ${sig.outside ? "○(高安とも更新)" : `×(高値更新 ${sig.brokeHigh ? "○" : "×"} / 安値更新 ${sig.brokeLow ? "○" : "×"})`}
  </div>`;

  if (!sig.direction) {
    let reason;
    if (!sig.outside) reason = "前日がアウトサイドデイではない";
    else if (!sig.rawDirection) reason = "前日の実体がない(始値=終値)";
    else if (!sig.gateOpen) reason = sig.gateReady ? "効率比が閾値以下(もみ合い)でゲート閉" : "効率比を算出できない";
    else reason = "ATR14を算出できない";
    h += `<div class="pair-meta"><span class="badge none">本日シグナルなし</span> — ${reason}</div>`;
    return h;
  }

  const scale = lotScaleFactor(state.settings);
  const lot = roundLot(sig.lot * scale);
  const stopPips = fmtPips(sig.atr14 * sig.stopMult, symbol);
  const badge = sig.direction === "long" ? "long" : "short";
  const alreadyOpen = hasOpenSatellite("usd-outside");
  h += `
    <div class="pair-meta">
      <span class="badge ${badge}">継続 ${sig.direction === "long" ? "ロング" : "ショート"}</span>
      ${sig.prevBar.close > sig.prevBar.open ? "前日陽線 → 順張り買い" : "前日陰線 → 順張り売り"}
      ${alreadyOpen ? '<span class="badge warn">既に保有中(EAは1本しか持たない)</span>' : ""}
      ATR14=${fmtPrice(sig.atr14, symbol)}(R)
    </div>
    <table class="tranche-table">
      <thead><tr><th>枚数</th><th>利食い</th><th>逆指値(固定)</th><th>時間切れ</th></tr></thead>
      <tbody>
        <tr>
          <td>${fmtMai(lot)}枚</td>
          <td>なし(目標なし)</td>
          <td>約定 ${sig.direction === "long" ? "−" : "+"} ${stopPips}pips(${sig.stopMult}×ATR14、トレールなし)</td>
          <td>${sig.holdDays}営業日で手仕舞い</td>
        </tr>
      </tbody>
    </table>
    ${
      alreadyOpen
        ? `<p class="section-note">USDOutside レイヤーの建玉を既に保有中です。EA(RB12tuned)はこのレイヤーの
           建玉スロットを1つしか持たず、埋まっている間は方向を問わず新規を取りません。ここで記録しないでください。</p>`
        : `<p class="section-note">今日の始値でエントリー後、実際の約定価格を記録してください
           (固定逆指値と手仕舞い予定日が計算されます)。</p>
           <button class="btn btn-primary btn-small record-entry" data-symbol="${sig.symbol}" data-label="${sig.label}"
             data-timeframe="daily" data-direction="${sig.direction}" data-layer="usd-outside">
             このシグナルを記録
           </button>`
    }
  `;
  return h;
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
      const alreadyOpen = hasOpenPosition(r.symbol, "daily", dsig.direction);
      html += `
        <div class="pair-meta">
          <span class="badge ${badge}">日足 ${dsig.direction === "long" ? "ロング" : "ショート"}</span>
          ${dsig.outside ? '<span class="badge warn">アウトサイド(前日終値で一本化)</span>' : ""}
          ${alreadyOpen ? '<span class="badge warn">既に保有中(EAは新規建てしない)</span>' : ""}
          ATR14=${fmtPrice(r.daily.atr14, r.symbol)} (R)
        </div>
        <div class="pair-meta">
          判定根拠: 前々日 高${fmtPrice(dsig.prevPrevBar.high, r.symbol)}/安${fmtPrice(dsig.prevPrevBar.low, r.symbol)}
          → 前日 高${fmtPrice(dsig.prevBar.high, r.symbol)}/安${fmtPrice(dsig.prevBar.low, r.symbol)}(${dsig.prevBar.date}、
          ${dsig.prevBar.close >= dsig.prevBar.open ? "陽線" : "陰線"})
        </div>
        <table class="tranche-table">
          <thead><tr><th>枠</th><th>枚数</th><th>目標(pips)</th><th>初期逆指値目安</th></tr></thead>
          <tbody>
            ${tranches
              .map((t) => {
                const offPips = t.targetR != null ? fmtPips(r.daily.atr14 * t.targetR, r.symbol) : "なし(ride)";
                const stopNote = t.hardStopR
                  ? `${fmtPrice(dsig.todayStopTrigger, r.symbol)} / -1.0R`
                  : fmtPrice(dsig.todayStopTrigger, r.symbol);
                return `<tr><td>${t.name}</td><td>${fmtMai(t.lot)}枚</td><td>${offPips}</td><td>${stopNote}</td></tr>`;
              })
              .join("")}
          </tbody>
        </table>
        ${
          alreadyOpen
            ? `<p class="section-note">同じペア・方向のトランシェを既に保有中です。EA(RB12tuned)は
               <code>AnyOpen()</code>により、そのトランシェが全て決済されるまで同方向の新規シグナルを
               取りません。ここで改めて記録すると実機の挙動より多く建ててしまうため、記録しないでください。</p>`
            : `<p class="section-note">エントリー(今日の始値)後、実際の約定価格を「保有中トランシェ」に記録してください。</p>
               <button class="btn btn-primary btn-small record-entry" data-symbol="${r.symbol}" data-label="${r.label}"
                 data-timeframe="daily" data-direction="${dsig.direction}" data-atr="${r.daily.atr14}">
                 このシグナルを記録
               </button>`
        }
      `;
    } else if (dsig) {
      html += `
        <div class="pair-meta">
          日足: <span class="badge none">本日シグナルなし</span>
        </div>
        <div class="pair-meta">
          判定根拠: 前々日 高${fmtPrice(dsig.prevPrevBar.high, r.symbol)}/安${fmtPrice(dsig.prevPrevBar.low, r.symbol)}
          → 前日 高${fmtPrice(dsig.prevBar.high, r.symbol)}/安${fmtPrice(dsig.prevBar.low, r.symbol)}(${dsig.prevBar.date}、
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
      const alreadyOpenWeekly = hasOpenPosition(r.symbol, "weekly", wsig.direction);
      html += `
        <div class="pair-meta" style="margin-top:10px;">
          <span class="badge ${badge}">週足 ${wsig.direction === "long" ? "ロング" : "ショート"}</span>
          ${isNewToday ? '<span class="badge warn">本日が新規判定日</span>' : '<span class="badge none">新規判定日は前回の月曜明け(通常火曜)</span>'}
          ${wsig.outside ? '<span class="badge warn">アウトサイド週(前週終値で一本化)</span>' : ""}
          ${alreadyOpenWeekly ? '<span class="badge warn">既に保有中(EAは新規建てしない)</span>' : ""}
          ${wsig.entryGuard && wsig.entryGuard.vetoed ? '<span class="badge short">EA新規建て見送り(R≤0)</span>' : ""}
          ${wsig.entryGuard && !wsig.entryGuard.vetoed ? '<span class="badge warn">撤退ラインを一時越え・要注意</span>' : ""}
          R(参考値、約定前の概算)=${fmtPrice(rApprox, r.symbol)}
        </div>
        ${weeklyGuardHtml(wsig.entryGuard, r.symbol)}
        <p class="section-note">
          実際のR = 約定価格 - 前週安値(ロング)/前週高値 - 約定価格(ショート)。
          「このシグナルを記録」で実際の約定価格を入力すると正しいRに置き換わります。
          新規エントリーは「直前の完成日足バーが月曜だった日」(通常は火曜)にのみ行われます
          (月曜の足が確定して初めて前週が確定するため)。
        </p>
        <div class="pair-meta">
          判定根拠: 前々週(${wsig.prevPrevWeek.weekKey}週) 高${fmtPrice(wsig.prevPrevWeek.high, r.symbol)}/安${fmtPrice(wsig.prevPrevWeek.low, r.symbol)}
          → 前週(${wsig.prevWeek.weekKey}週) 高${fmtPrice(wsig.prevWeek.high, r.symbol)}/安${fmtPrice(wsig.prevWeek.low, r.symbol)}
          (${wsig.prevWeek.close >= wsig.prevWeek.open ? "陽線" : "陰線"})
        </div>
        <table class="tranche-table">
          <thead><tr><th>枠</th><th>枚数</th><th>目標(pips目安)</th><th>撤退ライン</th></tr></thead>
          <tbody>
            ${tranches
              .map((t) => {
                const offPips = t.targetR != null ? fmtPips(rApprox * t.targetR, r.symbol) : "なし(ride)";
                return `<tr><td>${t.name}</td><td>${fmtMai(t.lot)}枚</td><td>${offPips}</td><td>${fmtPrice(wsig.todayStopTrigger, r.symbol)}</td></tr>`;
              })
              .join("")}
          </tbody>
        </table>
        ${
          alreadyOpenWeekly
            ? `<p class="section-note">同じペア・方向のトランシェを既に保有中です。EA(RB12tuned)は
               <code>WDAnyOpen()</code>により、そのトランシェが全て決済されるまで同方向の新規シグナルを
               取りません。ここで改めて記録しないでください。</p>`
            : isNewToday && wsig.entryGuard && wsig.entryGuard.vetoed
            ? `<p class="section-note">現値が撤退ライン(前週${wsig.direction === "long" ? "安値" : "高値"})を既に越えているため、
               EA(RB12tuned)はこの週の新規建てを見送ります(<code>r = 火曜始値 − 前週${wsig.direction === "long" ? "安値" : "高値"}</code>が
               0以下になるため)。記録しないでください。火曜の始値が撤退ラインの内側に戻れば建てる可能性はあります。</p>`
            : isNewToday
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
          判定根拠: 前々週(${wsig.prevPrevWeek.weekKey}週) 高${fmtPrice(wsig.prevPrevWeek.high, r.symbol)}/安${fmtPrice(wsig.prevPrevWeek.low, r.symbol)}
          → 前週(${wsig.prevWeek.weekKey}週) 高${fmtPrice(wsig.prevWeek.high, r.symbol)}/安${fmtPrice(wsig.prevWeek.low, r.symbol)}
          (高値更新: ${wsig.brokeHigh ? "○" : "×"} / 安値更新: ${wsig.brokeLow ? "○" : "×"})
        </div>
      `;
      html += renderWeeklyPreview(r.weekly.previewSignal, r.symbol);
    }

    // --- 分散レイヤー: USDJPYアウトサイドデイ継続(USD/JPYのカードにだけ表示) ---
    if (r.usdOutside) {
      html += renderUsdOutsideBlock(r.usdOutside, r.symbol);
    }

    card.innerHTML = html;
    container.appendChild(card);
  }

  container.querySelectorAll(".record-entry").forEach((btn) => {
    btn.addEventListener("click", () => openEntryModal(btn.dataset));
  });
}

// USDJPYアウトサイドデイ継続の保有カード。固定逆指値 + 時間切れ手仕舞い日を表示。
// クラス名・data属性はコアのカードと揃えてあるので、renderPositions 末尾の
// close-toggle / delete-position / edit-exit / clear-exit-override 配線をそのまま流用できる。
function renderSatelliteCard(pos) {
  const card = document.createElement("div");
  card.className = "pair-card";
  const badge = pos.direction === "long" ? "long" : "short";
  const t = pos.tranches[0];
  const auto = currentExitLevel(pos, null); // 固定逆指値(トレールしない)
  const hasOverride = pos.exitOverride != null;
  const exit = hasOverride ? { price: pos.exitOverride, source: "手動設定" } : auto;
  const today = todayStr();
  const dueToday = today >= pos.exitDate;
  const overdue = today > pos.exitDate;

  card.innerHTML = `
    <div class="pair-head">
      <span class="pair-name">${pos.pairLabel}</span>
      <span class="badge ${badge}">アウトサイドデイ継続 ${pos.direction === "long" ? "ロング" : "ショート"}</span>
      ${dueToday ? `<span class="badge warn">${overdue ? "手仕舞い予定日を経過" : "本日が手仕舞い予定日"}</span>` : ""}
    </div>
    <div class="pair-meta">エントリー ${pos.entryDate} @ ${fmtPrice(pos.entryPrice, pos.symbol)} / R(ATR14)=${fmtPrice(pos.R, pos.symbol)}</div>
    <div class="pair-meta">
      逆指値(固定): <strong>${fmtPrice(exit.price, pos.symbol)}</strong>(${exit.source})
      <button class="btn btn-ghost btn-small edit-exit" data-pos="${pos.id}">編集</button>
      ${hasOverride ? `<button class="btn btn-ghost btn-small clear-exit-override" data-pos="${pos.id}">自動に戻す</button>` : ""}
    </div>
    ${
      hasOverride && auto.price != null
        ? `<div class="pair-meta section-note">自動計算値(参考): ${fmtPrice(auto.price, pos.symbol)}(${auto.source})</div>`
        : ""
    }
    <div class="pair-meta section-note">
      時間切れ手仕舞い目安: <strong>${pos.exitDate}</strong>(エントリーから${pos.holdDays}営業日、祝日は未考慮)。
      その日の寄り付きで成行手仕舞い。利食い指値は置きません。
    </div>
    <table class="tranche-table">
      <thead><tr><th>枠</th><th>枚数</th><th>目標</th><th>済</th></tr></thead>
      <tbody>
        <tr class="${t.closed ? "closed" : ""}">
          <td>unit</td>
          <td>${fmtMai(t.lot)}枚</td>
          <td>なし(時間切れ or 固定逆指値)</td>
          <td><input type="checkbox" class="close-toggle" data-pos="${pos.id}" data-tranche="unit" ${t.closed ? "checked" : ""} /></td>
        </tr>
      </tbody>
    </table>
    <div class="pair-actions">
      <button class="btn btn-ghost btn-small delete-position" data-pos="${pos.id}">削除</button>
    </div>
  `;
  return card;
}

function renderPositions(freshDataBySymbol) {
  const container = document.getElementById("positionCards");
  const empty = document.getElementById("noPositions");
  container.innerHTML = "";
  const openPositions = state.positions.filter((p) => p.tranches.some((t) => !t.closed));
  empty.classList.toggle("hidden", openPositions.length > 0);

  for (const pos of openPositions) {
    // 分散レイヤー(USDOutside 等)は形が違うので専用カードで描画する。
    if (pos.kind === "usd-outside") {
      container.appendChild(renderSatelliteCard(pos));
      continue;
    }
    const fresh = freshDataBySymbol ? freshDataBySymbol[pos.symbol] : null;
    let stopTrigger = null;
    let weeklyBreak = null;
    if (fresh) {
      if (pos.timeframe === "daily") {
        stopTrigger =
          pos.direction === "long"
            ? fresh.daily.bars[fresh.daily.bars.length - 1].low
            : fresh.daily.bars[fresh.daily.bars.length - 1].high;
      } else if (fresh.weekly.bars.length) {
        const lastWeekBar = fresh.weekly.bars[fresh.weekly.bars.length - 1];
        stopTrigger = pos.direction === "long" ? lastWeekBar.low : lastWeekBar.high;
        weeklyBreak = weeklyBreakdown(lastWeekBar, fresh.daily.bars, pos.direction);
      }
    }
    const autoExit = currentExitLevel(pos, stopTrigger);
    // 無料データ(Twelve Data)とブローカーの四本値には乖離が生じうるため
    // (実例: 週足の日曜バー混入で55pipsズレたケース等)、自動計算値を
    // ユーザーがブローカーの実チャートを見て手動で上書きできるようにする。
    // 上書き中も自動計算値は併記し、いつでも解除できるようにする。
    const hasOverride = pos.exitOverride != null;
    const exit = hasOverride ? { price: pos.exitOverride, source: "手動設定" } : autoExit;

    const card = document.createElement("div");
    card.className = "pair-card";
    const badge = pos.direction === "long" ? "long" : "short";
    let html = `
      <div class="pair-head">
        <span class="pair-name">${pos.pairLabel}</span>
        <span class="badge ${badge}">${pos.timeframe === "daily" ? "日足" : "週足"} ${pos.direction === "long" ? "ロング" : "ショート"}</span>
      </div>
      <div class="pair-meta">エントリー ${pos.entryDate} @ ${fmtPrice(pos.entryPrice, pos.symbol)} / R=${fmtPrice(pos.R, pos.symbol)}</div>
      <div class="pair-meta">
        現在の撤退ライン: <strong>${fmtPrice(exit.price, pos.symbol)}</strong>(${exit.source})
        <button class="btn btn-ghost btn-small edit-exit" data-pos="${pos.id}">編集</button>
        ${hasOverride ? `<button class="btn btn-ghost btn-small clear-exit-override" data-pos="${pos.id}">自動に戻す</button>` : ""}
      </div>
      ${
        hasOverride && autoExit.price != null
          ? `<div class="pair-meta section-note">自動計算値(参考): ${fmtPrice(autoExit.price, pos.symbol)}(${autoExit.source})</div>`
          : ""
      }
      ${
        weeklyBreak
          ? `<div class="pair-meta section-note">
              根拠: ${weeklyBreak.weekKey}週(月曜始まり)の${pos.direction === "long" ? "安値" : "高値"}。日別内訳:
              ${weeklyBreak.days
                .map(
                  (d) =>
                    `${d.date}${pos.direction === "long" ? fmtPrice(d.low, pos.symbol) : fmtPrice(d.high, pos.symbol)}${d.isExtreme ? "★" : ""}`
                )
                .join(" / ")}
              (★=採用値。ブローカーの同じ日付の値と比較してズレを確認してください)
            </div>`
          : ""
      }
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
        <td>${tp != null ? fmtPrice(tp, pos.symbol) : "なし(反対ブレイクのみ)"}</td>
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
  container.querySelectorAll(".edit-exit").forEach((btn) => {
    btn.addEventListener("click", () => {
      const pos = state.positions.find((p) => p.id === btn.dataset.pos);
      const cur = pos.exitOverride != null ? pos.exitOverride : "";
      const input = prompt(
        `${pos.pairLabel} ${pos.direction === "long" ? "ロング" : "ショート"}の撤退ラインを手動で設定します。\nブローカーの実チャートで確認した値を入力してください。`,
        cur !== "" ? String(cur) : ""
      );
      if (input == null) return; // キャンセル
      const v = parseFloat(input);
      if (!v || v <= 0) {
        alert("正しい価格を入力してください");
        return;
      }
      pos.exitOverride = v;
      savePositions(state.positions);
      renderPositions(freshDataBySymbol);
    });
  });
  container.querySelectorAll(".clear-exit-override").forEach((btn) => {
    btn.addEventListener("click", () => {
      const pos = state.positions.find((p) => p.id === btn.dataset.pos);
      pos.exitOverride = null;
      savePositions(state.positions);
      renderPositions(freshDataBySymbol);
    });
  });

  renderOrderCheck();
}

// ========== 注文チェック ==========
// 記録済みポジションごとに「ブローカーの注文一覧にこう出ているはず」を並べ、
// ユーザーが目視で一致を確認してチェックを付ける(自動照合はしない、A案)。

// USDOutside(単一ユニット)用の注文チェック項目。成行1本 + 固定逆指値 + 時間切れの注記。
function satelliteOrderCheckItems(pos) {
  const exit =
    pos.exitOverride != null
      ? { price: pos.exitOverride, source: "手動設定" }
      : { price: pos.fixedStop, source: `固定 ${pos.stopMult}R` };
  const dir = pos.direction === "long" ? "ロング(買い)" : "ショート(売り)";
  const t = pos.tranches[0];
  return [
    {
      key: "entry",
      checkable: true,
      label: `USDJPY アウトサイドデイ継続: ${dir} を成行で 1 本 ${fmtMai(t.lot)}枚。約定 ≈ ${fmtPrice(pos.entryPrice, pos.symbol)}(スプレッド分ずれます)`,
    },
    {
      key: "stop",
      checkable: true,
      label:
        exit.price != null
          ? `逆指値 @ ${fmtPrice(exit.price, pos.symbol)}(${exit.source}、トレールしない=置きっぱなしでOK)`
          : "逆指値: データ不足",
    },
    {
      key: "timeexit",
      checkable: false,
      label: `時間切れ手仕舞い目安: ${pos.exitDate}(エントリーから${pos.holdDays}営業日)。利食い指値は置かない。`,
    },
  ];
}

// 1ポジションのチェック項目リスト。{ key, label, checkable } の配列を返す。
function orderCheckItems(pos) {
  if (pos.kind === "usd-outside") return satelliteOrderCheckItems(pos);
  const exit = pos.exitOverride != null
    ? { price: pos.exitOverride, source: "手動設定" }
    : currentExitLevel(pos, latestStopTriggerFor(pos));
  const tf = pos.timeframe === "daily" ? "日足" : "週足";
  const dir = pos.direction === "long" ? "ロング(買い)" : "ショート(売り)";
  const nonZero = pos.tranches.filter((t) => t.lot > 0);
  const items = [];

  items.push({
    key: "entry",
    checkable: true,
    label: `${tf} ${dir} を成行で ${nonZero.length} 本(別々の建玉)。約定 ≈ ${fmtPrice(pos.entryPrice, pos.symbol)}(スプレッド分ずれます)`,
  });

  for (const t of pos.tranches) {
    if (t.lot <= 0) {
      items.push({ key: `t:${t.name}`, checkable: false, label: `${t.name}: 枚数0 → 発注不要(資金/DD設定でこのトランシェは出ません)` });
      continue;
    }
    const tp = targetPrice(pos, t);
    const tail = tp != null
      ? `利食い指値 @ ${fmtPrice(tp, pos.symbol)}`
      : `利食い指値なし(撤退ラインまで保有 = ride)`;
    items.push({ key: `t:${t.name}`, checkable: true, label: `${t.name}: ${fmtMai(t.lot)}枚 / ${tail}` });
  }

  items.push({
    key: "stop",
    checkable: true,
    label: exit.price != null
      ? `撤退ライン @ ${fmtPrice(exit.price, pos.symbol)}(${exit.source})。逆指値を置くなら全建玉に。毎日ずれるので置いたら翌朝に更新。`
      : `撤退ライン: 「本日の判定を取得」を押すと表示されます`,
  });

  return items;
}

// renderPositions と同じ方法で、そのポジションの撤退ライン計算用トリガー値を出す。
function latestStopTriggerFor(pos) {
  const fresh = state.lastFetch ? state.lastFetch[pos.symbol] : null;
  if (!fresh) return null;
  if (pos.timeframe === "daily") {
    const b = fresh.daily.bars[fresh.daily.bars.length - 1];
    return pos.direction === "long" ? b.low : b.high;
  }
  if (fresh.weekly.bars.length) {
    const b = fresh.weekly.bars[fresh.weekly.bars.length - 1];
    return pos.direction === "long" ? b.low : b.high;
  }
  return null;
}

function renderOrderCheck() {
  const container = document.getElementById("orderCheckCards");
  const empty = document.getElementById("noOrderCheck");
  const summary = document.getElementById("orderCheckSummary");
  if (!container) return;
  container.innerHTML = "";
  const open = state.positions.filter((p) => p.tranches.some((t) => !t.closed));
  empty.classList.toggle("hidden", open.length > 0);

  let totalItems = 0;
  let totalChecked = 0;

  for (const pos of open) {
    if (!pos.orderCheck) pos.orderCheck = {};
    const items = orderCheckItems(pos);
    const checkable = items.filter((it) => it.checkable);
    const checked = checkable.filter((it) => pos.orderCheck[it.key]);
    totalItems += checkable.length;
    totalChecked += checked.length;
    const allOk = checkable.length > 0 && checked.length === checkable.length;

    const card = document.createElement("div");
    card.className = "pair-card";
    const badge = pos.direction === "long" ? "long" : "short";
    let html = `
      <div class="pair-head">
        <span class="pair-name">${pos.pairLabel}</span>
        <span class="badge ${badge}">${tfLabel(pos)} ${pos.direction === "long" ? "ロング" : "ショート"}</span>
        <span class="badge ${allOk ? "ok" : "warn"}">${allOk ? "一致確認済み" : `未確認 ${checkable.length - checked.length} 件`}</span>
      </div>
      <div class="pair-meta section-note">記録: ${pos.entryDate} @ ${fmtPrice(pos.entryPrice, pos.symbol)} / R=${fmtPrice(pos.R, pos.symbol)}</div>
      <ul class="ordercheck-list">
    `;
    const ai = pos.orderCheckAi || {};
    const AI_BADGE = {
      match: '<span class="oc-verdict v-match">AI:一致</span>',
      mismatch: '<span class="oc-verdict v-mismatch">AI:不一致</span>',
      not_found: '<span class="oc-verdict v-nf">AI:見当たらず</span>',
      unclear: '<span class="oc-verdict v-unclear">AI:判別不可</span>',
    };
    for (const it of items) {
      if (!it.checkable) {
        html += `<li class="oc-item oc-skip">${it.label}</li>`;
        continue;
      }
      const on = !!pos.orderCheck[it.key];
      const v = ai[it.key];
      html += `<li class="oc-item">
        <label>
          <input type="checkbox" class="oc-toggle" data-pos="${pos.id}" data-key="${it.key}" ${on ? "checked" : ""} />
          <span>${it.label}${v ? " " + (AI_BADGE[v.verdict] || "") : ""}</span>
        </label>
        ${v && v.detail ? `<div class="oc-ai-detail">${v.detail}</div>` : ""}
      </li>`;
    }
    html += `</ul>
      <div class="pair-actions">
        <button class="btn btn-ghost btn-small oc-all" data-pos="${pos.id}">全部チェック</button>
        <button class="btn btn-ghost btn-small oc-clear" data-pos="${pos.id}">クリア</button>
      </div>`;
    card.innerHTML = html;
    container.appendChild(card);
  }

  // AI照合の全体結果(あれば)を先頭に差し込む
  const meta = state.orderCheckAiMeta;
  if (meta && open.length) {
    const box = document.createElement("div");
    box.className = "pair-card oc-ai-meta";
    box.innerHTML =
      `<div class="pair-meta"><strong>AI照合</strong> (${meta.model} / ${meta.at})</div>` +
      (meta.overall ? `<div class="pair-meta section-note">${meta.overall}</div>` : "") +
      (meta.extra && meta.extra.length
        ? `<div class="pair-meta section-note">スクショにある記録外の注文: ${meta.extra.map((x) => `・${x}`).join("<br>")}</div>`
        : "");
    container.insertBefore(box, container.firstChild);
  }

  if (summary) {
    summary.textContent = open.length ? `確認 ${totalChecked} / ${totalItems} 項目` : "";
  }

  container.querySelectorAll(".oc-toggle").forEach((cb) => {
    cb.addEventListener("change", () => {
      const pos = state.positions.find((p) => p.id === cb.dataset.pos);
      if (!pos) return;
      if (!pos.orderCheck) pos.orderCheck = {};
      if (cb.checked) pos.orderCheck[cb.dataset.key] = true;
      else delete pos.orderCheck[cb.dataset.key];
      savePositions(state.positions);
      renderOrderCheck();
    });
  });
  container.querySelectorAll(".oc-all").forEach((btn) => {
    btn.addEventListener("click", () => {
      const pos = state.positions.find((p) => p.id === btn.dataset.pos);
      if (!pos) return;
      pos.orderCheck = {};
      for (const it of orderCheckItems(pos)) if (it.checkable) pos.orderCheck[it.key] = true;
      savePositions(state.positions);
      renderOrderCheck();
    });
  });
  container.querySelectorAll(".oc-clear").forEach((btn) => {
    btn.addEventListener("click", () => {
      const pos = state.positions.find((p) => p.id === btn.dataset.pos);
      if (!pos) return;
      pos.orderCheck = {};
      savePositions(state.positions);
      renderOrderCheck();
    });
  });
}

// スクショ(目視の参考用)。sessionStorageに1枚だけ保持(タブを閉じると消える)。
const LS_ORDERSHOT = "rbsignal_ordershot_v1";

function showOrderShot(dataUrl) {
  const img = document.getElementById("orderShotPreview");
  const clr = document.getElementById("orderShotClear");
  const aiBtn = document.getElementById("ocAiBtn");
  if (!img) return;
  state.orderShot = dataUrl || null;
  if (dataUrl) {
    img.src = dataUrl;
    img.classList.remove("hidden");
    clr.classList.remove("hidden");
    if (aiBtn) aiBtn.classList.remove("hidden");
  } else {
    img.removeAttribute("src");
    img.classList.add("hidden");
    clr.classList.add("hidden");
    if (aiBtn) aiBtn.classList.add("hidden");
  }
}

// 画像を長辺 maxEdge px 以下に縮小して data URL を返す(送信コスト・容量を抑える)。
// 縮小不要ならそのまま返す。media_type は縮小時は image/jpeg、非縮小時は元のまま。
function downscaleImage(dataUrl, maxEdge) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const long = Math.max(img.naturalWidth, img.naturalHeight);
      if (long <= maxEdge) {
        const m = /^data:(image\/[a-z+]+);base64,/.exec(dataUrl);
        resolve({ dataUrl, mediaType: m ? m[1] : "image/png" });
        return;
      }
      const scale = maxEdge / long;
      const cw = Math.round(img.naturalWidth * scale);
      const ch = Math.round(img.naturalHeight * scale);
      const cv = document.createElement("canvas");
      cv.width = cw;
      cv.height = ch;
      cv.getContext("2d").drawImage(img, 0, 0, cw, ch);
      resolve({ dataUrl: cv.toDataURL("image/jpeg", 0.85), mediaType: "image/jpeg" });
    };
    img.onerror = () => resolve({ dataUrl, mediaType: "image/png" });
    img.src = dataUrl;
  });
}

function initOrderShotUI() {
  const input = document.getElementById("orderShotInput");
  const clr = document.getElementById("orderShotClear");
  const aiBtn = document.getElementById("ocAiBtn");
  if (!input) return;
  try {
    const saved = sessionStorage.getItem(LS_ORDERSHOT);
    if (saved) showOrderShot(saved);
  } catch (e) {}
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const { dataUrl } = await downscaleImage(reader.result, 1568);
      showOrderShot(dataUrl);
      try { sessionStorage.setItem(LS_ORDERSHOT, dataUrl); } catch (e) {}
    };
    reader.readAsDataURL(file);
    input.value = "";
  });
  clr.addEventListener("click", () => {
    showOrderShot(null);
    try { sessionStorage.removeItem(LS_ORDERSHOT); } catch (e) {}
  });
  if (aiBtn) aiBtn.addEventListener("click", runAiOrderCheck);
}

// ===== AIによる自動照合(Anthropic Messages API を端末ブラウザから直接呼ぶ) =====
async function runAiOrderCheck() {
  const statusEl = document.getElementById("ocAiStatus");
  const btn = document.getElementById("ocAiBtn");
  const key = (state.settings.anthropicKey || "").trim();
  if (!key) {
    statusEl.textContent = "設定でAnthropic APIキーを入力してください。";
    statusEl.classList.add("error");
    return;
  }
  if (!state.orderShot) {
    statusEl.textContent = "先にブローカーの注文一覧スクショを貼ってください。";
    statusEl.classList.add("error");
    return;
  }
  const open = state.positions.filter((p) => p.tranches.some((t) => !t.closed));
  if (!open.length) {
    statusEl.textContent = "照合対象の記録済みポジションがありません。";
    statusEl.classList.add("error");
    return;
  }

  // 期待される注文を、AIに渡す構造化データにする。
  const expected = open.map((pos) => ({
    posId: pos.id,
    pair: pos.pairLabel,
    side: pos.direction,
    timeframe: pos.timeframe,
    items: orderCheckItems(pos)
      .filter((it) => it.checkable)
      .map((it) => ({ key: `${pos.id}::${it.key}`, label: it.label })),
  }));

  const m = /^data:(image\/[a-z+]+);base64,(.+)$/s.exec(state.orderShot);
  if (!m) {
    statusEl.textContent = "画像の形式を認識できませんでした。別のスクショで試してください。";
    statusEl.classList.add("error");
    return;
  }
  const mediaType = m[1];
  const b64 = m[2];

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["items", "extra_orders", "overall"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["key", "verdict", "detail"],
          properties: {
            key: { type: "string" },
            verdict: { type: "string", enum: ["match", "mismatch", "not_found", "unclear"] },
            detail: { type: "string", description: "短い日本語の根拠(スクショのどの行と対応するか等)" },
          },
        },
      },
      extra_orders: {
        type: "array",
        items: { type: "string", description: "スクショにあるが期待リストに対応しない注文の要約(日本語)" },
      },
      overall: { type: "string", description: "全体の一言サマリー(日本語)" },
    },
  };

  const system =
    "あなたはシステムトレードの発注チェック補助です。ユーザーがFXブローカーのスマホアプリの" +
    "「注文一覧/建玉一覧」のスクリーンショット(日本語、GMOクリック証券など)を提示します。" +
    "別途渡す『期待される注文リスト』(各項目にkeyとlabel)と、スクショに写っている実際の注文/建玉を照合してください。" +
    "照合の指針: (1)通貨ペア表記の揺れ(GBP/JPY, GBPJPY, ポンド円 等)は同一視。" +
    "(2)方向: 買い/ロング/BUY = long、売り/ショート/SELL = short。" +
    "(3)数量: 「枚」は1枚=1万通貨。「Lot/ロット/数量」列の単位はアプリにより1枚だったり1万通貨だったりするので、" +
    "labelの枚数と桁が概ね一致すれば一致とみなす(端数±1枚は許容)。" +
    "(4)価格: 指値/逆指値の価格はlabelの目標価格と数pips以内なら一致。成行/約定済み建玉はエントリー概算価格と近ければ一致。" +
    "(5)スクショから確実に読み取れない場合は unclear。対応する注文がスクショに無ければ not_found。" +
    "値は違うが対応行がある場合は mismatch。" +
    "必ず、渡された全項目のkeyについて1件ずつ判定を返してください。" +
    "スクショにあるが期待リストのどれにも対応しない注文は extra_orders に日本語で要約してください。";

  btn.disabled = true;
  statusEl.classList.remove("error");
  statusEl.textContent = "AIが照合中…(数秒〜十数秒)";

  const model = state.settings.visionModel || "claude-opus-5";
  const outputConfig = { format: { type: "json_schema", schema } };
  // effort は Opus/Sonnet 系のみ対応(Haiku 4.5 では 400 になる)。
  if (model.indexOf("haiku") === -1) outputConfig.effort = "low";

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        output_config: outputConfig,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
              {
                type: "text",
                text:
                  "期待される注文リスト(JSON):\n" +
                  JSON.stringify(expected, null, 1) +
                  "\n\n上のスクリーンショットと照合し、指定スキーマのJSONで返してください。",
              },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        if (j && j.error && j.error.message) msg = j.error.message;
      } catch (e) {}
      throw new Error(msg);
    }
    const data = await res.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    if (!textBlock) throw new Error("AIの応答を解釈できませんでした");
    const parsed = JSON.parse(textBlock.text);

    // 判定を反映: match のみ自動チェック。判定は pos.orderCheckAi[itemKey] に保存して表示。
    const byPos = {};
    for (const it of parsed.items || []) {
      const sep = it.key.indexOf("::");
      if (sep < 0) continue;
      const posId = it.key.slice(0, sep);
      const itemKey = it.key.slice(sep + 2);
      (byPos[posId] = byPos[posId] || {})[itemKey] = { verdict: it.verdict, detail: it.detail };
    }
    for (const pos of open) {
      pos.orderCheckAi = byPos[pos.id] || {};
      if (!pos.orderCheck) pos.orderCheck = {};
      for (const [k, v] of Object.entries(pos.orderCheckAi)) {
        if (v.verdict === "match") pos.orderCheck[k] = true;
      }
    }
    state.orderCheckAiMeta = {
      overall: parsed.overall || "",
      extra: parsed.extra_orders || [],
      at: new Date().toLocaleString("ja-JP"),
      model: state.settings.visionModel,
    };
    savePositions(state.positions);
    renderOrderCheck();
    const u = data.usage || {};
    statusEl.classList.remove("error");
    statusEl.textContent =
      `照合完了(${state.orderCheckAiMeta.at})。` +
      (u.input_tokens ? ` 入力${u.input_tokens}/出力${u.output_tokens || 0}トークン。` : "") +
      " match は自動チェック済み。mismatch / ? は手動で確認してください。";
  } catch (e) {
    statusEl.classList.add("error");
    statusEl.textContent = `AI照合に失敗: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

// ========== エントリー記録モーダル ==========

let pendingEntry = null;

function openEntryModal(ds) {
  pendingEntry = ds;
  const kindLabel =
    ds.layer === "usd-outside"
      ? "アウトサイドデイ継続"
      : ds.timeframe === "daily"
      ? "日足"
      : "週足";
  document.getElementById("entryModalTitle").textContent = `${ds.label} ${kindLabel} ${ds.direction === "long" ? "ロング" : "ショート"} — 約定価格を入力`;
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

  // 分散レイヤー: USDJPYアウトサイドデイ継続。コアとは建玉の形が違うので専用処理。
  if (pendingEntry.layer === "usd-outside") {
    const usd = state.lastResults && state.lastResults.find((r) => r.symbol === "USD/JPY");
    const sig = usd && usd.usdOutside;
    if (!sig || !sig.direction) {
      alert("USDJPYアウトサイドデイのシグナル情報が見つかりません。『本日の判定を取得』をやり直してください。");
      return;
    }
    state.positions.push(buildSatelliteRecord(sig, price, scale));
    savePositions(state.positions);
    closeEntryModal();
    renderPositions(state.lastFetch);
    alert("記録しました。固定逆指値と手仕舞い予定日は保有カードに表示されます。");
    return;
  }

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
      // 直近の完成日足バー(新規判定日=通常火曜なら「月曜の足」)を渡して
      // entryGuard(EAの r>0 ガードの近似判定)を計算させる。
      const latestDailyBar = bars.length ? bars[bars.length - 1] : null;
      const weeklySignal = computeWeeklySignal(weeklyBars, latestDailyBar);
      // 暦の上ではもう金曜まで終わっているがEAはまだ確定として扱っていない
      // 週がある場合(月曜〜火曜朝によくある)、参考プレビューも計算する。
      const pvWeeks = previewWeeks(allWeeklyBars);
      const previewSignal = pvWeeks ? computeWeeklySignal(pvWeeks, latestDailyBar) : null;
      const r = {
        symbol: p.symbol,
        label: p.label,
        daily: { bars, atr14, signal: dailySignal },
        weekly: { bars: weeklyBars, signal: weeklySignal, previewSignal },
      };
      results.push(r);
      freshBySymbol[p.symbol] = r;
    }
    // USD/JPY の前日終値を自動レートとして保持(ロットサイジングのJPY→USD換算用)。
    const ujFresh = freshBySymbol["USD/JPY"];
    if (ujFresh && ujFresh.daily.bars.length) {
      const b = ujFresh.daily.bars[ujFresh.daily.bars.length - 1];
      state.autoUsdJpy = { rate: b.close, date: b.date };
      if (state.settings.usdJpyAuto) {
        state.settings.usdJpyCached = b.close;
        state.settings.usdJpyCachedDate = b.date;
        saveSettings(state.settings);
      }
      if (typeof syncUsdJpyField === "function") syncUsdJpyField();
    }
    // 分散レイヤー: USDJPYアウトサイドデイ継続。3ペア平均ER(20本)を先に計算し、
    // USD/JPY のシグナルを判定して結果に添付する(ゲートは3ペア共通のため全ペア取得後に評価)。
    const barsBySymbol = {};
    for (const p of PAIRS) barsBySymbol[p.symbol] = freshBySymbol[p.symbol].daily.bars;
    const er = computeAvgER(barsBySymbol, 20);
    state.avgER = er;
    const usdResult = results.find((x) => x.symbol === "USD/JPY");
    if (usdResult) usdResult.usdOutside = computeUsdOutsideSignal(barsBySymbol["USD/JPY"], er);

    state.lastFetch = freshBySymbol;
    state.lastResults = results;
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

// USD/JPY入力欄の見た目を現在のモード(自動/手動)に合わせる。
function syncUsdJpyField() {
  const s = state.settings;
  const chk = document.getElementById("usdJpyAuto");
  const inp = document.getElementById("usdJpy");
  const note = document.getElementById("usdJpyAutoNote");
  if (!chk || !inp) return;
  chk.checked = !!s.usdJpyAuto;
  inp.disabled = !!s.usdJpyAuto;
  const r = (state.autoUsdJpy && state.autoUsdJpy.rate) || s.usdJpyCached;
  const d = (state.autoUsdJpy && state.autoUsdJpy.date) || s.usdJpyCachedDate;
  if (s.usdJpyAuto) {
    if (r) {
      inp.value = Number(r).toFixed(3);
      if (note) note.textContent = `自動: ${Number(r).toFixed(3)}(${d} 終値)。「取得」のたびに更新されます。`;
    } else if (note) {
      note.textContent = "「取得」を押すと USD/JPY の前日終値が入ります(それまでは手動値を使用)。";
    }
  } else if (note) {
    note.textContent = "手動入力値を使用します。";
  }
}

function initSettingsUI() {
  const s = state.settings;
  document.getElementById("apiKey").value = s.apiKey;
  document.getElementById("anthropicKey").value = s.anthropicKey || "";
  document.getElementById("visionModel").value = s.visionModel || "claude-opus-5";
  document.getElementById("capitalJpy").value = s.capitalJpy;
  document.getElementById("ddPct").value = s.ddPct;
  document.getElementById("usdJpy").value = s.usdJpyCached || s.usdJpy;
  syncUsdJpyField();

  document.getElementById("usdJpyAuto").addEventListener("change", (e) => {
    state.settings.usdJpyAuto = e.target.checked;
    if (!e.target.checked) {
      const r = (state.autoUsdJpy && state.autoUsdJpy.rate) || state.settings.usdJpyCached || state.settings.usdJpy;
      document.getElementById("usdJpy").value = Number(r).toFixed(2);
    }
    saveSettings(state.settings);
    syncUsdJpyField();
    if (state.lastResults) renderSignals(state.lastResults);
    if (state.lastFetch) renderPositions(state.lastFetch);
  });

  document.getElementById("settingsToggle").addEventListener("click", () => {
    const body = document.getElementById("settingsBody");
    const chevron = document.getElementById("settingsChevron");
    body.classList.toggle("hidden");
    chevron.classList.toggle("open");
  });

  document.getElementById("saveSettings").addEventListener("click", () => {
    state.settings = {
      apiKey: document.getElementById("apiKey").value.trim(),
      anthropicKey: document.getElementById("anthropicKey").value.trim(),
      visionModel: document.getElementById("visionModel").value,
      capitalJpy: parseFloat(document.getElementById("capitalJpy").value) || 0,
      ddPct: parseFloat(document.getElementById("ddPct").value) || 0,
      usdJpy: parseFloat(document.getElementById("usdJpy").value) || 150,
      usdJpyAuto: document.getElementById("usdJpyAuto").checked,
      usdJpyCached: state.settings.usdJpyCached,
      usdJpyCachedDate: state.settings.usdJpyCachedDate,
    };
    saveSettings(state.settings);
    syncUsdJpyField();
    if (state.lastResults) renderSignals(state.lastResults);
    if (state.lastFetch) renderPositions(state.lastFetch);
    const flag = document.getElementById("settingsSaved");
    flag.classList.remove("hidden");
    setTimeout(() => flag.classList.add("hidden"), 2000);
  });
}

// 通知は Cloudflare Worker(notify_worker/)が判定し Discord Webhook へ送る。
// アプリ側は通知に関与しない(旧 Web Push 実装は 2026-09-04 に撤去)。

function init() {
  applyTheme();
  document.getElementById("themeToggle").addEventListener("click", toggleTheme);
  initSettingsUI();
  document.getElementById("fetchBtn").addEventListener("click", fetchAndRender);
  document.getElementById("addPositionBtn").addEventListener("click", manualAddPosition);
  document.getElementById("entryModalCancel").addEventListener("click", closeEntryModal);
  document.getElementById("entryModalConfirm").addEventListener("click", confirmEntry);
  initOrderShotUI();
  renderPositions(null);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

document.addEventListener("DOMContentLoaded", init);
