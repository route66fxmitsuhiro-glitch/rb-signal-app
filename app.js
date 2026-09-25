"use strict";
/*
 * RBシグナル(コア版)
 * 日足RideThin(5トランシェ)+週足ドンチャン(3階層)のシグナル判定・
 * ロット計算・保有トランシェの目標/撤退ライン管理を行う。
 * 分散レイヤー11層(2026-09-04〜、ピンバー2層は2026-09-24〜)・衝突ゲート(2026-09-11〜)を実装済み。
 * rideサーキットブレーカーは未実装(現行ロット構成では日足/週足ともロット下限に
 * 張り付いていて実質休眠中のため、優先度低)。
 */

// ========== 共通ロジック(signal-core.js)からの読み込み ==========
// シグナル判定の純粋ロジックは signal-core.js に集約し、手動編集ページ
// (edit-bars.js)と共有している。ここでは分割代入で必要な関数・定数を
// 取り出すだけにし、二重実装によるロジックのズレを防ぐ。
const {
  PAIRS,
  ALL_PAIRS,
  SATELLITES,
  weekKeyOf,
  todayStr,
  nextBarCloseJst,
  executionWindow,
  dowOf,
  addTradingDays,
  fetchRawDailyValuesAuto,
  shiftDate,
  quoteDecimals,
  reconstructBarFromQuote,
  validateReconstructedBar,
  screenshotSessionLabel,
  lastCapturableSessionLabel,
  LS_SETTINGS,
  loadSettings,
  saveSettings,
  appendSignalLog,
  LS_BARHIST,
  SHOT_SYMBOLS,
  loadBarHistory,
  saveBarHistory,
  appendShotBars,
  acquireBars,
  computeATR14,
  computeDailySignal,
  computeAvgER,
  computeAllSatellites,
  satelliteConflictMult,
  lastCompleteBarIsMonday,
  aggregateWeekly,
  officialWeeks,
  previewWeeks,
  computeWeeklySignal,
} = SignalCore;

// ========== 設定値(EAの実装に合わせた固定値) ==========

// 日足RideThin。targetR=nullは目標なし(ride、反対ブレイクのみ+ハードストップ)。
// CoreAlloc(2026-09-13、PF構造監査ステージ4、A+確定): トランシェ配分を
// 重み比率(LotSize×weight×DailyRideLotMult)方式から、CoreT0Lot〜CoreT4Lotの
// 直接指定(T0=0.03/T1=0.03/T2=0.02/T3=0.01/T4=0.01、合計0.10は不変)に変更。
// EJF075(旧配分T0=0.02/T1=0.02/T2=0.03/T3=0.02/T4=0.01)比でprofit+0.07%・
// PF+0.0117・DD-1.07%・RDD+1.15%を実機確認済み(23本フルA+再認証も合格)。
// weightは「baseLot(0.10)に対する比率」として表現(tranchesWithLotsの既存の
// 計算式 lot=roundLot(baseLot*weight*scale) をそのまま流用するため)。
// rideはDailyRideLotMult=1.0(CoreT4Lot=0.01が既にpre-shrinkの最終値)なので
// lotMultは使わず、floorLot=0.01のみ残す(念のための安全床)。
const DAILY_TRANCHES = [
  { name: "T0", weight: 0.30, targetR: 0.1 },
  { name: "T1", weight: 0.30, targetR: 0.2 },
  { name: "T2", weight: 0.20, targetR: 0.3 },
  { name: "T3", weight: 0.10, targetR: 0.5 },
  { name: "ride", weight: 0.10, targetR: null, hardStopR: -1.0, floorLot: 0.01 },
];

// 週足ドンチャン(3階層)。Rはブレイク幅そのもの(ATRではない)。rideにハードストップなし(教訓34)。
// balanced(2026-09-10): WDT01LotMult=0.334 / WDRideLotMult=0.167。
// EAは tierLot = RoundLot(WDLotSize/3) = RoundLot(0.10/3) = 0.03 を作り、
// T0/T1 に ×0.334(→0.01)、ride に ×0.167(→0.01)を掛けて再度丸め、0.01で床止め。
const WEEKLY_TRANCHES = [
  { name: "T0", weight: 1 / 3, targetR: 0.5, lotMult: 0.334, floorLot: 0.01 },
  { name: "T1", weight: 1 / 3, targetR: 1.0, lotMult: 0.334, floorLot: 0.01 },
  { name: "ride", weight: 1 / 3, targetR: null, lotMult: 0.167, floorLot: 0.01 },
];

const BASE_LOT_DAILY = 0.10;   // バックテスト基準ロット(1ペアあたり)
const BASE_LOT_WEEKLY = 0.10;  // バックテスト基準ロット(1ペアあたり)
// 実データの最大DD(口座通貨USD想定、0.10ロット基準)。
// 【重要】このアプリはコア(日足RideThin+週足ドンチャン)のみを実装しており、
// RB_Broker_CoreAlloc_Test全体(コア+9衛星レイヤー)のDD(2,655.40)ではなく、
// コア単体のDDを使う。衛星による分散効果でDDが縮んでいるため、フル構成の
// 数値をそのまま使うとコア単体運用としてはロットを過大評価してしまう。
// 2026-09-13、CoreAlloc確定(PF構造監査ステージ4)を機に再計算(実機ログ
// `RB_Broker_CoreAlloc_Test.dll`からRTL-/RTS-/WDL-/WDS-コメントの
// トレードだけを抽出し疑似エクイティカーブでDDを算出、1,968.15)。
// 旧値3,369.33(2026-08-16算出)は、①ブローカー時間[NY17:00]日足区切りへの
// 移行前、②旧トランシェ配分(T0=0.02/T1=0.02/T2=0.03/T3=0.02/T4=0.01)、
// という2点で現行設計と条件が異なる古い値だったため差し替えた
// (同じ抽出方法でEJF075[旧配分]を計算し直すと2,229.57で、旧値3,369.33との
// 差の大半はブローカー時間移行による影響であり、トランシェ配分変更[ステージ4]
// 単体の寄与は限定的と見られる)。この更新により、同じDD許容額に対する
// 計算ロットは従来より大きくなる点に注意。
// 【2026-09-24更新】上の説明は「コア単体・6:00執行」時代のもの。アプリは今コア+衛星11層
// (EA最終版 Exec730v5 と同じ構成)を出しているので、基準も v5 全体の最大DDにする:
// 実機ログ(USDOutsideLotSize0.12 = v5相当)に実測スプレッドを課した後の最大DD 3,024 USD
// (2008-03〜2008-10、conflictaware/aplus/forward_reference_v5.py で算出)。
// 旧値1,968.15のままだと、表示ロットがDD許容額に対して約1.54倍大きく出ていた。
const REFERENCE_MAX_DD_USD = 3024;

// ========== ローカルストレージ ==========
// LS_SETTINGS / loadSettings / saveSettings は signal-core.js に集約
// (edit-bars.js も Twelve Data APIキーを読むために共有、教訓90)。

const LS_POSITIONS = "rbsignal_positions_v1";
const LS_THEME = "rbsignal_theme_v1";

function loadPositions() {
  const raw = localStorage.getItem(LS_POSITIONS);
  if (!raw) return [];
  let list;
  try { list = JSON.parse(raw); } catch { return []; }
  // 2026-09-11より前に記録された分散レイヤーのポジションは、実際のレイヤーに
  // 関わらず kind="usd-outside" 固定・isSatellite/pair/title が欠落していた
  // (教訓、全9層が同一レイヤー扱いされていたバグ)。どの具体的なレイヤーだったかは
  // 情報が失われ復元できないが、単一ユニット形状(fixedStopを持つ)を目印に
  // 最小限の補完をして、表示や再エントリー抑止判定が壊れないようにする。
  let migrated = false;
  for (const p of list) {
    if (p.fixedStop != null && !p.isSatellite) {
      p.isSatellite = true;
      if (!p.pair) p.pair = (p.symbol || "").replace("/", "");
      migrated = true;
    }
  }
  if (migrated) savePositions(list);
  return list;
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
      // EA互換の2段階: tierLot = RoundLot(baseLot*weight) を作ってから
      // lotMult を掛けて再度丸める。EAは最後に0.01で床止めする
      // (これが無いと多重適用で0.00になり発注が失敗する。教訓48の失敗パターン)。
      const tierLot = roundLot(baseLot * t.weight * scale);
      lot = roundLot(tierLot * t.lotMult);
    } else {
      lot = roundLot(baseLot * t.weight * scale);
    }
    if (t.floorLot != null && lot < t.floorLot) lot = t.floorLot;
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

// 同一シンボル(cfg.pair)上で現在保有中の「他の」衛星レイヤーの方向一覧を返す。
// EAの ConflictLotMult() は同一ティック内で既存ハンドルの方向を直接見るが、
// このアプリはEAの内部状態を持たないため、ユーザーが記録済みの未決済ポジション
// (isSatellite=true のもの)で代用判定する。excludeLayer は今まさに判定中の
// レイヤー自身(hasOpenSatellite()により通常は未保有のはずだが念のため除外)。
// ピンバー反転(noConflict)の層は衝突ゲートに参加しないので、数える対象から外す。
const NO_CONFLICT_LAYERS = new Set(SATELLITES.filter((s) => s.noConflict).map((s) => s.id));

function openSatelliteDirections(pair, excludeLayer) {
  return state.positions
    .filter(
      (p) =>
        p.isSatellite &&
        !NO_CONFLICT_LAYERS.has(p.kind) &&
        p.pair === pair &&
        p.kind !== excludeLayer &&
        p.tranches.some((t) => !t.closed)
    )
    .map((p) => p.direction);
}

// 衝突ゲート(教訓、2026-09-11確定)適用後の実発注ロットを計算する。
// シグナルのプレビュー(renderSatelliteBlock)と実際の記録(buildSatelliteRecord)が
// 必ず同じ値を使うよう、ここに1箇所だけ実装する(教訓: 実装が2箇所に分散すると
// 必ずどちらかが腐る)。
function satelliteLot(sig, scale) {
  // noConflict の層(ピンバー)は衝突ゲートを使わない(EAと同じ)
  const openDirs = sig.noConflict ? [] : openSatelliteDirections(sig.pair, sig.layer);
  const mult = sig.noConflict ? 1.0 : satelliteConflictMult(sig.pair, sig.direction, openDirs);
  return { lot: roundLot(sig.lot * scale * mult), mult, openDirs };
}

// 分散レイヤー(衛星)9層共通の建玉レコード。コアの5トランシェ/週足3階層とは
// 形が違う: 単一ユニット・利食い目標なし・固定逆指値(トレールしない)・
// 時間切れ手仕舞い。既存の renderPositions / orderCheckItems / close-toggle
// 配線をそのまま流用できるよう、tranches は1要素(name:"unit")で表現する。
// isSatellite フラグでコアと区別し、kind にはレイヤーID(SATELLITES[].id、
// 例"gbp-fade")を入れる(以前はここが "usd-outside" に固定されており、
// 全9層が同一レイヤーとして扱われるバグがあった。2026-09-11修正)。
function buildSatelliteRecord(sig, entryPrice, scale) {
  const { lot, mult, openDirs } = satelliteLot(sig, scale);
  const R = sig.atr14;
  const fixedStop =
    sig.direction === "long"
      ? entryPrice - sig.stopMult * R
      : entryPrice + sig.stopMult * R;
  const entryDate = todayStr();
  return {
    id: `${sig.symbol}-${sig.layer}-${Date.now()}`,
    kind: sig.layer,
    isSatellite: true,
    pair: sig.pair,
    title: sig.title,
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
    conflictMult: mult,
    conflictOpenDirections: openDirs.slice(),
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
  // 分散レイヤー(衛星)は9層すべて固定逆指値(約定 ∓ StopMult×ATR14)。
  // トレールも反対ブレイクも使わない。
  if (pos.isSatellite) {
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

const state = { settings: loadSettings(), positions: loadPositions(), lastFetch: null, lastResults: null, autoUsdJpy: null, avgER: null, orderShots: [], orderCheckAiMeta: null };

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
// コア(日足RideThin・週足ドンチャン)の保有判定。衛星も timeframe:"daily" で記録されるので、
// isSatellite を除外しないと「同じペアの衛星ショート」をコアの日足ショート保有と誤認する
// (2026-09-25、コアを全決済した後も「既に保有中」が消えなかったバグの原因)。
function hasOpenPosition(symbol, timeframe, direction) {
  return state.positions.some(
    (p) =>
      !p.isSatellite &&
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

// 保有カード等に出す時間軸ラベル。分散レイヤーはメカニズム名を返す
// (以前は全レイヤーが "アウトサイドデイ継続" 固定だった。2026-09-11修正)。
function tfLabel(pos) {
  if (pos.isSatellite) return pos.title || pos.pairLabel || "分散レイヤー";
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

// 2026-09-14発見: 前々日・前日として使われた2本が実際には連続した営業日では
// ない(間の平日が丸ごと欠落している)場合の強い警告。missingTradingDaysの
// バグ(先頭ではなく末尾バーの日付を起点に走査していたため、FT5とスクショの
// 間に空いた"内部の穴"を検出できていなかった)により、GBPJPYで木曜のデータが
// 丸ごと欠落したまま水曜と金曜を比較し、本来アウトサイド継続=ショートのはずが
// 「シグナルなし」と誤表示される事例が実際に発生した。missingTradingDays自体は
// 修正済みだが(Twelve Dataキー未設定時など)なお穴が残る場合に備え、
// computeDailySignalの結果を表示する時点でも二重に警告する。
// 日付(YYYY-MM-DD)を画面表示用の mm/dd(曜) にする。
// 「前日」「前々日」だとどの日が起点か分かりにくいため(2026-09-24、ユーザー要望)。
const DOW_JA = ["日", "月", "火", "水", "木", "金", "土"];
function fmtDay(dateStr) {
  if (!dateStr) return "-";
  const [, m, d] = dateStr.split("-");
  return `${m}/${d}(${DOW_JA[dowOf(dateStr)]})`;
}

function dateGapNote(dsig) {
  if (!dsig || !dsig.dateGap || !dsig.prevBar || !dsig.prevPrevBar) return "";
  return `<p class="section-note" style="color:#c00;font-weight:bold;">
    ⚠️ ${fmtDay(dsig.prevPrevBar.date)}と${fmtDay(dsig.prevBar.date)}の間の営業日のデータが
    欠落しており、抜けた日の値動きを見ずに判定しています。この日足判定(シグナルの
    有無・方向とも)は信用できません。ブローカーのレート一覧スクショで抜けている日を
    取り込んでから、「本日の判定を取得」を押し直してください。</p>`;
}

// 日足RideThinの判定根拠に日曜の立ち上がりバー(通常のブローカーのチャートには
// 表示されない)が使われている場合の注記。2026-09-05の紙トレード照合・1分足試算
// (sim_sunday_bar_ablation.py)で判明した実績を踏まえた文言:
//   月曜のエントリー: 全体pipsへの寄与3.8%・勝率43.4%(全曜日中最弱) → 見送っても影響小
//   火曜のエントリー: 全体pipsへの寄与32%(最大)・勝率62.2% → 必ず拾うべき
// 2026-09-06追記: Twelve DataとFT5の日曜薄商いバーのOHLCが数〜十数pips食い違い、
// このTwelve Data由来の火曜判定は実測でFT5と29〜60%しか一致しないと判明
// (水木金は88〜90%で問題なし)。このためデータソースがFT5(EAと同一データ)か
// Twelve Data(フォールバック中)かで、火曜の注記の確度を出し分ける。
function sundayNote(dsig, dataSourceNote) {
  if (!dsig || !dsig.prevBar || !dsig.prevPrevBar) return "";
  const isFT5 = !!(dataSourceNote && dataSourceNote.startsWith("FT5"));
  const prevIsSun = dowOf(dsig.prevBar.date) === 0;
  const prevPrevIsSun = dowOf(dsig.prevPrevBar.date) === 0;
  if (prevIsSun) {
    return `<p class="section-note">⚠️ 月曜のエントリー候補です。判定に使う${fmtDay(dsig.prevBar.date)}の足は
      市場再開直後の薄商いバーで、通常のブローカーのチャートには表示されません。ただし月曜エントリーは
      実績上、全体成績への寄与が小さく(過去統計で全体pipsの約4%)、勝率も全曜日中最弱(約43%)です。
      この時間帯に対応できないなら見送っても大きな機会損失にはなりません。</p>`;
  }
  if (prevPrevIsSun) {
    if (isFT5) {
      return `<p class="section-note">⚠️ 火曜のエントリー候補です。判定に使う${fmtDay(dsig.prevPrevBar.date)}の足が
        市場再開直後の薄商いバーのため、ご自身のブローカーのチャートで2日分を見比べても再現できません。
        チャートの見た目と食い違って見えても、このアプリの判定を採用してください
        (過去統計でこの曜日のエントリーが全曜日中最大の寄与・良好な勝率を記録しています。
        データソースはFT5=EAの実機検証と同一データのため、この判定の信頼度は高いです)。</p>`;
    }
    return `<p class="section-note">🔴 火曜のエントリー候補です。ただし現在の判定は<strong>Twelve Data(フォールバック中)</strong>
      によるもので、判定根拠(${fmtDay(dsig.prevPrevBar.date)}=市場再開直後の薄商いバー)はTwelve DataとFT5(EAの実機データ)で
      数〜十数pips食い違いやすく、この曜日の判定一致率は実測で約3〜6割にとどまります(水木金は問題ありません)。
      火曜は全曜日中最大の寄与(約32%)がある反面、今この判定はいつもより不確実です。
      可能ならFT5のデータを更新・エクスポートしてから確認するか、ブローカーの短い時間軸チャートで
      市場再開直後の値動きをご自身の目で確認してください。</p>`;
  }
  return "";
}

// USDJPYアウトサイドデイ継続レイヤーの表示ブロック。シグナルの有無にかかわらず
// 判定根拠(アウトサイドデイ成否・ER・ゲート状態)を必ず出す。
// 衛星9層の共通描画。メカニズムごとに「判定根拠」と「出ていない理由」を出し分ける。
function satelliteEvidence(sig, symbol) {
  const p = (v) => fmtPrice(v, symbol);
  const b1 = sig.prevBar, b2 = sig.prevPrevBar;
  const body = b1
    ? (b1.close > b1.open ? "陽線" : b1.close < b1.open ? "陰線" : "同値")
    : "";

  if (sig.kind === "outside_cont" || sig.kind === "outside_fade") {
    return `${fmtDay(b2.date)} 高${p(b2.high)}/安${p(b2.low)} → ${fmtDay(b1.date)} 高${p(b1.high)}/安${p(b1.low)}
      (${body}) / アウトサイドデイ: ${sig.outside ? "○(高安とも更新)" : "×"}`;
  }
  if (sig.kind === "streak_rev") {
    return `直近${sig.streakN}日: ${sig.allUp ? "全て陽線 → フェードでショート" :
      sig.allDown ? "全て陰線 → フェードでロング" : "連続していない"}
      (直近 ${fmtDay(b1.date)}、${body})`;
  }
  if (sig.kind === "range_fade") {
    return `直近レンジ 高${p(sig.rollHigh)}/安${p(sig.rollLow)} に対し
      ${fmtDay(b1.date)} 高${p(b1.high)}/安${p(b1.low)}/終${p(b1.close)} /
      失敗ブレイク: ${sig.failedUp ? "上抜け失敗 → ショート" :
        sig.failedDown ? "下抜け失敗 → ロング" : "なし"}`;
  }
  if (sig.kind === "day2_fail") {
    const d1 = sig.day1Up ? "上抜け" : sig.day1Down ? "下抜け" : "なし";
    return `${fmtDay(b2.date)}が直近レンジ 高${p(sig.rollHigh)}/安${p(sig.rollLow)} を
      終値${p(b2.close)}で確定ブレイク: ${d1} /
      ${fmtDay(b1.date)}が極値${sig.day1Extreme != null ? p(sig.day1Extreme) : "-"}を
      ${sig.extended ? "更新した(伸びた → 見送り)" : "更新できなかった(伸び悩み → フェード)"}`;
  }
  if (sig.kind === "pinbar") {
    if (sig.pinTooNarrow) {
      return `${fmtDay(b1.date)} 高${p(b1.high)}/安${p(b1.low)} — 値幅がATR14の25%未満で対象外`;
    }
    const pc = (v) => (v * 100).toFixed(0) + "%";
    return `${fmtDay(b1.date)}(${body}) 上ヒゲ${pc(sig.upWick)} / 下ヒゲ${pc(sig.dnWick)} /
      終値の位置 ${pc(sig.closePosRatio)}(下端0%〜上端100%) —
      条件: ヒゲ${pc(sig.wickTh)}以上かつ終値がヒゲと反対側の${pc(sig.closePosTh)}以内`;
  }
  if (sig.kind === "weekly_streak_rev") {
    return `直近${sig.streakN}週: ${sig.allUp ? "全て陽線 → フェードでショート" :
      sig.allDown ? "全て陰線 → フェードでロング" : "連続していない"}
      (直近確定週 ${sig.referenceWeek}) / 新しい週の確定: ${sig.newWeek ? "○" : "×(判定日ではない)"}`;
  }
  return "";
}

function satelliteNoSignalReason(sig) {
  const d1 = sig.prevBar ? fmtDay(sig.prevBar.date) : "直近の足";
  if (!sig.rawDirection) {
    if (sig.kind === "outside_cont" || sig.kind === "outside_fade") {
      return sig.outside ? `${d1}の実体がない(始値=終値)` : `${d1}がアウトサイドデイではない`;
    }
    if (sig.kind === "streak_rev") return `直近${sig.streakN}日が同じ向きに連続していない`;
    if (sig.kind === "weekly_streak_rev") return `直近${sig.streakN}週が同じ向きに連続していない`;
    if (sig.kind === "range_fade") return "失敗ブレイクが成立していない";
    if (sig.kind === "day2_fail") return "day-1の確定ブレイク or day-2の伸び悩みが成立していない";
    if (sig.kind === "pinbar") return sig.pinTooNarrow ? `${d1}の値幅が小さすぎる` : `${d1}がピンバーではない`;
    return "条件が成立していない";
  }
  if (sig.weekly && !sig.newWeek) return "新しい週の確定日ではない(EAは週の変わり目だけ新規判定する)";
  if (!sig.gateOpen) {
    if (!sig.gateReady) return "効率比を算出できない(確定日足が不足)";
    return sig.gate === "high"
      ? "効率比が閾値以下(もみ合い)でゲート閉"
      : "効率比が閾値超(トレンド)でゲート閉";
  }
  return "ATRを算出できない";
}

function renderSatelliteBlock(sig, symbol) {
  let h = `<div class="pair-meta" style="margin-top:10px;">
    <span class="badge none">分散レイヤー: ${sig.title}(${sig.label})</span></div>`;

  if (sig.insufficientData) {
    h += `<div class="pair-meta">データ不足(確定バーが足りません)</div>`;
    return h;
  }

  if (sig.gate === "none") {
    h += `<div class="pair-meta">効率比ゲート: なし(この層は常時有効)</div>`;
  } else {
    const dir = sig.gate === "high" ? "高ERで有効" : "低ERで有効";
    const gateTxt = !sig.gateReady
      ? "ER算出に必要な確定日足(21本)が不足"
      : `avgER=${sig.avgER.toFixed(3)}(閾値 ${sig.erThreshold} ${sig.gateOpen ? "→ ゲート開" : "→ ゲート閉"})`;
    const lagNote = ""; // 旧: AUDJPY/EURJPYは前日ER。+90分執行では全層が当日ERを見る(2026-09-24)
    h += `<div class="pair-meta">効率比ゲート(3ペア平均、${dir}): ${gateTxt} ${lagNote}</div>`;
  }

  h += `<div class="pair-meta">判定根拠: ${satelliteEvidence(sig, symbol)}</div>`;

  if (!sig.direction) {
    h += `<div class="pair-meta"><span class="badge none">本日シグナルなし</span> — ${satelliteNoSignalReason(sig)}</div>`;
    return h;
  }

  const scale = lotScaleFactor(state.settings);
  const { lot, mult, openDirs } = satelliteLot(sig, scale);
  const stopPips = fmtPips(sig.atr14 * sig.stopMult, symbol);
  const badge = sig.direction === "long" ? "long" : "short";
  const alreadyOpen = hasOpenSatellite(sig.layer);
  const rName = sig.weekly ? "週足ATR14" : "ATR14";
  const timeout = sig.weekly ? `${sig.holdWeeks}週で手仕舞い` : `${sig.holdDays}営業日で手仕舞い`;
  const conflictNote =
    mult !== 1
      ? `<div class="pair-meta section-note">衝突ゲート: 同一ペアの他レイヤーが${
          openDirs.length > 1 && new Set(openDirs).size > 1 ? "混在方向に建玉中" : "逆方向に建玉中"
        }のためロット×${mult.toFixed(2)}(下表に反映済み)</div>`
      : "";
  h += `
    <div class="pair-meta">
      <span class="badge ${badge}">${sig.direction === "long" ? "ロング" : "ショート"}</span>
      ${alreadyOpen ? '<span class="badge warn">既に保有中(EAは1本しか持たない)</span>' : ""}
      ${rName}=${fmtPrice(sig.atr14, symbol)}(R)
    </div>
    ${conflictNote}
    <table class="tranche-table">
      <thead><tr><th>枚数</th><th>利食い</th><th>逆指値(固定)</th><th>時間切れ</th></tr></thead>
      <tbody>
        <tr>
          <td>${fmtMai(lot)}枚</td>
          <td>なし(目標なし)</td>
          <td>約定 ${sig.direction === "long" ? "−" : "+"} ${stopPips}pips(${sig.stopMult}×${rName}、トレールなし)</td>
          <td>${timeout}</td>
        </tr>
      </tbody>
    </table>
    ${
      alreadyOpen
        ? `<p class="section-note">${sig.label} レイヤーの建玉を既に保有中です。EAはこのレイヤーの
           建玉スロットを1つしか持たず、埋まっている間は方向を問わず新規を取りません。ここで記録しないでください。</p>`
        : `<p class="section-note">今日の始値でエントリー後、実際の約定価格を記録してください
           (固定逆指値と手仕舞い予定日が計算されます)。</p>
           <button class="btn btn-primary btn-small record-entry" data-symbol="${sig.symbol}" data-label="${sig.label}"
             data-timeframe="daily" data-direction="${sig.direction}" data-layer="${sig.layer}" data-title="${sig.title}"
             data-ref="${sig.referenceDate || sig.referenceWeek || ""}">
             このシグナルを記録
           </button>`
    }
  `;
  return h;
}

// ========== 執行タイミングのバナー ==========
// 日足の区切り(NY17:00 = JST 6:00[夏]/7:00[冬])はロールオーバーで、1日で
// 最もスプレッドが広がる瞬間。実測で GBPJPY 20〜30pips・USDJPY 約10pips。
// ここで成行を出すと23年分の利益が丸ごと消える計算なので、確定から90分待つ。
function renderExecBanner() {
  const el = document.getElementById("preCloseWarn");
  if (!el) return;
  const w = executionWindow();
  if (!w) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden", "ready", "late");

  const mins = Math.abs(w.minsFromExec);
  const hm = (m) => (m >= 60 ? `${Math.floor(m / 60)}時間${m % 60}分` : `${m}分`);

  if (!w.tradingDay) {
    el.textContent = `いまは週末(直近の区切りの後にセッションがありません)。次の取引日の ${w.execJst} が執行時刻です。`;
    return;
  }
  if (w.state === "waiting") {
    el.innerHTML = `<strong>まだ発注しないでください。</strong>`
      + ` 日足は ${w.closeJst} に確定済みですが、いまはロールオーバー直後で`
      + `スプレッドが最も広がっている時間帯です(GBPJPY 20〜30pips)。`
      + `<br>執行推奨は <strong>${w.execJst}</strong> — あと ${hm(mins)}。`;
  } else if (w.state === "ready") {
    el.classList.add("ready");
    el.innerHTML = `<strong>いま執行してよい時間帯です</strong>(推奨 ${w.execJst}、`
      + `確定から ${hm(Math.abs(w.minsFromClose))}経過)。スプレッドは通常幅に戻っています。`;
  } else {
    el.classList.add("late");
    el.innerHTML = `<strong>執行推奨時刻から ${hm(mins)} 経過しています。</strong>`
      + ` 推奨は ${w.execJst}。遅れるほど初動を取り逃します(90分の遅れで約-25%)。`;
  }
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

    // 取得元(FT5○本/スクショ○本…)のバッジは表示しない(2026-09-24、ユーザー要望)。
    // r.dataSourceNote は火曜の注記の出し分けに内部で使うので保持している。
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
          ${dsig.outside ? '<span class="badge warn">アウトサイド(終値の陽線/陰線で一本化)</span>' : ""}
          ${alreadyOpen ? '<span class="badge warn">既に保有中(EAは新規建てしない)</span>' : ""}
          ATR14=${fmtPrice(r.daily.atr14, r.symbol)} (R)
        </div>
        <div class="pair-meta">
          判定根拠: ${fmtDay(dsig.prevPrevBar.date)} 高${fmtPrice(dsig.prevPrevBar.high, r.symbol)}/安${fmtPrice(dsig.prevPrevBar.low, r.symbol)}
          → ${fmtDay(dsig.prevBar.date)} 高${fmtPrice(dsig.prevBar.high, r.symbol)}/安${fmtPrice(dsig.prevBar.low, r.symbol)}(
          ${dsig.prevBar.close >= dsig.prevBar.open ? "陽線" : "陰線"})
        </div>
        ${dateGapNote(dsig)}
        ${sundayNote(dsig, r.dataSourceNote)}
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
                 data-timeframe="daily" data-direction="${dsig.direction}" data-atr="${r.daily.atr14}"
                 data-ref="${dsig.prevBar.date}">
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
          判定根拠: ${fmtDay(dsig.prevPrevBar.date)} 高${fmtPrice(dsig.prevPrevBar.high, r.symbol)}/安${fmtPrice(dsig.prevPrevBar.low, r.symbol)}
          → ${fmtDay(dsig.prevBar.date)} 高${fmtPrice(dsig.prevBar.high, r.symbol)}/安${fmtPrice(dsig.prevBar.low, r.symbol)}(
          高値更新: ${dsig.brokeHigh ? "○" : "×"} / 安値更新: ${dsig.brokeLow ? "○" : "×"})
        </div>
        ${dateGapNote(dsig)}
        ${sundayNote(dsig, r.dataSourceNote)}
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
      const isNewToday = lastCompleteBarIsMonday(r.weeklySourceBars); // 週足の判定日は日曜足なしの系列で(daily.barsは日曜足ありに変更済み)
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
                 data-prevweekhigh="${lastWeek.high}" data-prevweeklow="${lastWeek.low}" data-ref="${lastWeek.weekKey}">
                 このシグナルを記録
               </button>`
            : `<p class="section-note">本日は新規判定日ではありません。既にエントリー済みなら記録不要、
               まだなら次の月曜明け(通常火曜)を待ってください。</p>`
        }
      `;
      html += renderWeeklyPreview(r.weekly.previewSignal, r.symbol);
    } else if (wsig) {
      const isNewToday = lastCompleteBarIsMonday(r.weeklySourceBars); // 週足の判定日は日曜足なしの系列で(daily.barsは日曜足ありに変更済み)
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


    card.innerHTML = html;
    container.appendChild(card);
  }

  // --- 分散レイヤー9層(ペアごとにまとめて1枚のカードにする) ---
  // AUDJPY・EURJPY はコアのペアカードを持たないため、コアとは別セクションに出す。
  const sats = state.satellites || [];
  if (sats.length) {
    const byPair = {};
    for (const sig of sats) (byPair[sig.symbol] = byPair[sig.symbol] || []).push(sig);
    for (const symbol of Object.keys(byPair)) {
      const card = document.createElement("div");
      card.className = "card";
      const label = (byPair[symbol][0] || {}).pair || symbol;
      const fired = byPair[symbol].filter((x) => x.direction).length;
      let html = `<h2>${label} <span class="section-note">分散レイヤー ${byPair[symbol].length}層`
        + `${fired ? ` / 本日シグナル ${fired}件` : ""}</span></h2>`;
      for (const sig of byPair[symbol]) html += renderSatelliteBlock(sig, symbol);
      card.innerHTML = html;
      container.appendChild(card);
    }
  }

  container.querySelectorAll(".record-entry").forEach((btn) => {
    btn.addEventListener("click", () => openEntryModal(btn.dataset));
  });
  logShownSignals(container);
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

  const mult = pos.conflictMult;
  const conflictNote =
    mult != null && mult !== 1
      ? `<div class="pair-meta section-note">衝突ゲート適用: ロット×${mult.toFixed(2)}
         (エントリー時点で同一ペアの他レイヤーが${pos.conflictOpenDirections && pos.conflictOpenDirections.length > 1 ? "混在方向" : "逆方向"}に建玉中)</div>`
      : "";

  card.innerHTML = `
    <div class="pair-head">
      <span class="pair-name">${pos.pairLabel}</span>
      <span class="badge ${badge}">${pos.title || "分散レイヤー"} ${pos.direction === "long" ? "ロング" : "ショート"}</span>
      ${dueToday ? `<span class="badge warn">${overdue ? "手仕舞い予定日を経過" : "本日が手仕舞い予定日"}</span>` : ""}
    </div>
    <div class="pair-meta">エントリー ${pos.entryDate} @ ${fmtPrice(pos.entryPrice, pos.symbol)} / R(ATR14)=${fmtPrice(pos.R, pos.symbol)}</div>
    ${conflictNote}
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

// 保有状況が変わったら、保有カードだけでなく「本日の新規シグナル」欄も描き直す。
// シグナル欄の「既に保有中(EAは新規建てしない)」表示は保有記録から判定しているため、
// 片方だけ描き直すと、削除・決済した直後も古い表示が残る(2026-09-25のバグ)。
function refreshAfterPositionChange(freshDataBySymbol) {
  renderPositions(freshDataBySymbol);
  if (state.lastResults) renderSignals(state.lastResults);
}

function renderPositions(freshDataBySymbol) {
  const container = document.getElementById("positionCards");
  const empty = document.getElementById("noPositions");
  container.innerHTML = "";
  const openPositions = state.positions.filter((p) => p.tranches.some((t) => !t.closed));
  empty.classList.toggle("hidden", openPositions.length > 0);

  for (const pos of openPositions) {
    // 分散レイヤー(衛星9層)はコアと形が違うので専用カードで描画する。
    if (pos.isSatellite) {
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
        weeklyBreak = weeklyBreakdown(lastWeekBar, fresh.weeklySourceBars, pos.direction);
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
      if (cb.checked) {
        // フォワード記録用に実際の決済価格を残す(空欄なら「未入力」として後で forward.html で入れられる)
        const input = prompt(
          `${pos.pairLabel} ${t.name} の決済価格(ブローカーの約定値)\n分からなければ空欄のまま OK`, "");
        if (input === null) { cb.checked = false; return; } // キャンセルなら決済にしない
        const v = parseFloat(input);
        t.exitPrice = v > 0 ? v : null;
        t.exitDate = todayStr();
      } else {
        delete t.exitPrice;
        delete t.exitDate;
      }
      t.closed = cb.checked;
      savePositions(state.positions);
      refreshAfterPositionChange(freshDataBySymbol);
    });
  });
  container.querySelectorAll(".delete-position").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = state.positions.find((p) => p.id === btn.dataset.pos);
      const closedN = target ? target.tranches.filter((q) => q.closed).length : 0;
      const msg = closedN
        ? `このポジション記録を削除しますか?\n\n決済済みのトランシェ${closedN}件の記録も一緒に消え、フォワード記録の損益・決済済みトレードから外れます。\n\n` +
          "全部決済しただけなら、削除ではなく残りのトランシェの「決済」にチェックを入れてください(保有中の一覧からは自動で消えます)。\n削除は、記録を間違えた場合だけにしてください。"
        : "このポジション記録を削除しますか?\n(決済した場合は削除ではなく「決済」にチェックを入れてください。フォワード記録に残ります)";
      if (!confirm(msg)) return;
      state.positions = state.positions.filter((p) => p.id !== btn.dataset.pos);
      savePositions(state.positions);
      refreshAfterPositionChange(freshDataBySymbol);
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
      refreshAfterPositionChange(freshDataBySymbol);
    });
  });
  container.querySelectorAll(".clear-exit-override").forEach((btn) => {
    btn.addEventListener("click", () => {
      const pos = state.positions.find((p) => p.id === btn.dataset.pos);
      pos.exitOverride = null;
      savePositions(state.positions);
      refreshAfterPositionChange(freshDataBySymbol);
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
      label: `${pos.pairLabel} ${pos.title || "分散レイヤー"}: ${dir} を成行で 1 本 ${fmtMai(t.lot)}枚${pos.conflictMult != null && pos.conflictMult !== 1 ? `(衝突ゲート×${pos.conflictMult.toFixed(2)}適用済み)` : ""}。約定 ≈ ${fmtPrice(pos.entryPrice, pos.symbol)}(スプレッド分ずれます)`,
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
  if (pos.isSatellite) return satelliteOrderCheckItems(pos);
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

// スクショ(目視の参考用+AI照合の入力)。sessionStorageに配列で保持(タブを閉じると消える)。
// 2026-09-14発見: 注文一覧が長くて1枚のスクショに収まらない(スクロールしながら
// 複数枚撮る)実例が見つかった。旧実装は画像を1枚しか保持できず、AI照合には
// 最後に貼った1枚しか渡っていなかったため、そこに写っていないペアが全部
// 「見当たらず」と誤診断される事例が発生した(実際にはバグではなく、写っている
// ペアについては正しく判定できていた)。複数枚を保持・全部AIに渡せるよう変更。
const LS_ORDERSHOT = "rbsignal_ordershots_v2";

function renderOrderShots() {
  const list = document.getElementById("orderShotPreviewList");
  const clr = document.getElementById("orderShotClear");
  const aiBtn = document.getElementById("ocAiBtn");
  if (!list) return;
  const shots = state.orderShots || [];
  list.innerHTML = shots
    .map(
      (url, i) => `
      <div class="order-shot-item">
        <img src="${url}" alt="注文一覧スクショ ${i + 1}" />
        <span class="order-shot-index">${i + 1}</span>
        <button type="button" class="order-shot-remove" data-idx="${i}" aria-label="このスクショを消す">×</button>
      </div>`
    )
    .join("");
  list.querySelectorAll(".order-shot-remove").forEach((btn) => {
    btn.addEventListener("click", () => removeOrderShot(Number(btn.dataset.idx)));
  });
  const has = shots.length > 0;
  if (clr) clr.classList.toggle("hidden", !has);
  if (aiBtn) aiBtn.classList.toggle("hidden", !has);
}

function persistOrderShots() {
  try {
    if (state.orderShots.length) sessionStorage.setItem(LS_ORDERSHOT, JSON.stringify(state.orderShots));
    else sessionStorage.removeItem(LS_ORDERSHOT);
  } catch (e) {}
}

function addOrderShots(dataUrls) {
  state.orderShots = [...(state.orderShots || []), ...dataUrls];
  renderOrderShots();
  persistOrderShots();
}

function removeOrderShot(idx) {
  state.orderShots = (state.orderShots || []).filter((_, i) => i !== idx);
  renderOrderShots();
  persistOrderShots();
}

function clearOrderShots() {
  state.orderShots = [];
  renderOrderShots();
  persistOrderShots();
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

function readFileAsDataUrl(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
}

function initOrderShotUI() {
  const input = document.getElementById("orderShotInput");
  const clr = document.getElementById("orderShotClear");
  const aiBtn = document.getElementById("ocAiBtn");
  if (!input) return;
  try {
    const saved = sessionStorage.getItem(LS_ORDERSHOT);
    if (saved) {
      state.orderShots = JSON.parse(saved);
      renderOrderShots();
    }
  } catch (e) {}
  input.addEventListener("change", async () => {
    const files = input.files ? Array.from(input.files) : [];
    input.value = "";
    if (!files.length) return;
    // 選んだ枚数だけ順番に縮小してまとめて追加(スクロールしながら撮った
    // 複数枚をそのまま続けて貼れるように)。
    const added = [];
    for (const file of files) {
      const raw = await readFileAsDataUrl(file);
      const { dataUrl } = await downscaleImage(raw, 1568);
      added.push(dataUrl);
    }
    addOrderShots(added);
  });
  clr.addEventListener("click", clearOrderShots);
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
  const shots = state.orderShots || [];
  if (!shots.length) {
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

  // 複数枚に分けて撮ったスクショ(スクロール違い)をそれぞれ画像ブロックにする。
  // 1枚でも形式を認識できないものがあれば送信前に止める(不完全なリストで
  // 「見当たらず」と誤診断されるのを防ぐ)。
  const imageBlocks = [];
  for (const shot of shots) {
    const m = /^data:(image\/[a-z+]+);base64,(.+)$/s.exec(shot);
    if (!m) {
      statusEl.textContent = "画像の形式を認識できないスクショが含まれています。貼り直してください。";
      statusEl.classList.add("error");
      return;
    }
    imageBlocks.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
  }

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
    "「注文一覧/建玉一覧」のスクリーンショット(日本語、GMOクリック証券など)を1枚以上提示します" +
    "(一覧が長い場合、スクロールしながら分けて撮った複数枚が渡されることがあります。" +
    "その場合は全部を1つの一覧とみなして照合してください。重複行があっても構いません)。" +
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
              ...imageBlocks,
              {
                type: "text",
                text:
                  (imageBlocks.length > 1
                    ? `上の${imageBlocks.length}枚は同じ注文一覧をスクロールしながら分けて撮ったものです(順不同・重複あり得ます)。すべて合わせて1つの一覧として照合してください。\n\n`
                    : "") +
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

// フォワード記録: 画面に出ている「このシグナルを記録」ボタン(=EAなら建てる場面)を
// その日のシグナルとして残す。ボタンを基準にするので、既に保有中・R≦0で見送り等、
// EAが建てない場面は自然に除外される。
function logShownSignals(container) {
  const day = todayStr();
  const entries = [];
  container.querySelectorAll(".record-entry").forEach((btn) => {
    const ds = btn.dataset;
    const layer = ds.layer || ds.timeframe; // 衛星はレイヤーID、コアは daily/weekly
    // key は判定に使った足(ref)で作る。週末や同じ日に何度取得しても同じシグナルは1件。
    entries.push({
      key: `${ds.ref || day}|${layer}|${ds.symbol}|${ds.direction}`, ref: ds.ref || null,
      date: day, layer, symbol: ds.symbol, label: ds.label,
      direction: ds.direction, title: ds.title || null,
    });
  });
  if (entries.length) appendSignalLog(entries);
}

function openEntryModal(ds) {
  pendingEntry = ds;
  const kindLabel = ds.layer
    ? ds.title || "分散レイヤー"
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

  // 分散レイヤー9層。コアとは建玉の形(単一ポジション・目標なし・固定逆指値)が
  // 違うので専用処理。pendingEntry.layer にレイヤーID(SATELLITES[].id)が入る。
  if (pendingEntry.layer) {
    const sig = (state.satellites || []).find((x) => x.layer === pendingEntry.layer);
    if (!sig || !sig.direction) {
      alert("そのレイヤーのシグナル情報が見つかりません。『本日の判定を取得』をやり直してください。");
      return;
    }
    const srec = buildSatelliteRecord(sig, price, scale);
    srec.scaleAtEntry = scale;
    srec.usdJpyAtEntry = effectiveUsdJpy(state.settings);
    state.positions.push(srec);
    savePositions(state.positions);
    closeEntryModal();
    refreshAfterPositionChange(state.lastFetch);
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
  rec.scaleAtEntry = scale;
  rec.usdJpyAtEntry = effectiveUsdJpy(state.settings);
  state.positions.push(rec);
  savePositions(state.positions);
  closeEntryModal();
  refreshAfterPositionChange(state.lastFetch);
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
  const dateIn = prompt("エントリー日(YYYY-MM-DD)。今日なら空欄のまま:", "");
  if (dateIn === null) return;
  const entryDate = dateIn.trim();
  if (entryDate && !/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) { alert("日付は YYYY-MM-DD で入力してください"); return; }
  const scale = lotScaleFactor(state.settings);
  const baseLot = timeframe === "daily" ? BASE_LOT_DAILY : BASE_LOT_WEEKLY;
  const rec = buildPositionRecord(pairInfo.label, pairInfo.symbol, timeframe, direction, price, R, baseLot, scale);
  if (entryDate) rec.entryDate = entryDate;
  rec.scaleAtEntry = scale;
  rec.usdJpyAtEntry = effectiveUsdJpy(state.settings);
  state.positions.push(rec);
  savePositions(state.positions);
  refreshAfterPositionChange(state.lastFetch);
}

// ========== ブローカーのレート一覧スクショから日足を取り込む ==========
// 2026-09-10導入。FT5の毎日更新が負担なため、GMOクリック証券のレート一覧を
// 撮って前日バーの入力にする。詳細は signal-core.js の
// reconstructBarFromQuote / screenshotSessionLabel のコメントを参照。
//
// 保存するのは**スクショ由来のバーだけ**。FT5エクスポート(120本)は毎回
// 取得して土台にし、その上にスクショ由来を重ねる(mergeBarSeries の優先度は
// shot > ft5 > td)。こうすると localStorage が小さいまま保て、FT5を久しぶりに
// 更新したときもその結果が自然に反映される。
// LS_BARHIST / SHOT_SYMBOLS / loadBarHistory / saveBarHistory / appendShotBars は
// signal-core.js に集約(edit-bars.js と共有するため、ファイル冒頭の分割代入を参照)。
const LS_RATESHOT = "rb_rate_shot"; // 直近のスクショ(sessionStorage、目視用)

const RATE_SHOT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    pairs: {
      type: "array",
      description: "画面に写っている通貨ペアすべて",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          symbol: { type: "string", description: "GBP/JPY のようなスラッシュ区切りの表記" },
          bid: { type: "number", description: "BID欄の値。大きい数字と右肩の小さい数字を連結した完全な値" },
          high: { type: "number", description: "H: の右の値" },
          low: { type: "number", description: "L: の右の値" },
          change: { type: "number", description: "前日比の整数値。符号も含める" },
        },
        required: ["symbol", "bid", "high", "low", "change"],
      },
    },
  },
  required: ["pairs"],
};

const RATE_SHOT_PROMPT =
  "これはFXブローカーのレート一覧画面です。各通貨ペアについて次の4つを読み取ってください。\n" +
  "1) BID: 「1.16」「208.」のような通常サイズの部分、その次の大きい2桁、" +
  "さらに右肩の小さい1桁を、すべて連結した完全な数値。" +
  "例: 「1.16」+大きい「38」+小さい「6」→ 1.16386、「208.」+大きい「12」+小さい「3」→ 208.123\n" +
  "2) H: の右の値(その日の高値)\n" +
  "3) L: の右の値(その日の安値)\n" +
  "4) 前日比の整数値(マイナスならマイナスを付ける)\n\n" +
  "通貨ペア名の下にある小さい数字はスプレッドなので読み取り不要です。" +
  "ASK欄も不要です。写っているペアはすべて返してください。" +
  "数字が読み取れないペアは配列に含めないでください。";

// スクショをAIに読ませて、5ペア分のバーを再構成する。
async function readRateShot(dataUrl, mediaType) {
  const key = (state.settings.anthropicKey || "").trim();
  if (!key) throw new Error("設定でAnthropic APIキーを入力してください");
  const b64 = dataUrl.split(",")[1];
  const model = state.settings.visionModel || "claude-opus-5";
  const outputConfig = { format: { type: "json_schema", schema: RATE_SHOT_SCHEMA } };
  if (model.indexOf("haiku") === -1) outputConfig.effort = "low";

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
      max_tokens: 2048,
      output_config: outputConfig,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
            { type: "text", text: RATE_SHOT_PROMPT },
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
  const json = await res.json();
  const block = (json.content || []).find((c) => c.type === "text");
  if (!block) throw new Error("AIの応答を解釈できませんでした");
  let parsed;
  try {
    parsed = JSON.parse(block.text);
  } catch (e) {
    throw new Error("AIの応答がJSONではありません");
  }
  return parsed.pairs || [];
}

// 読み取り結果 → 再構成 + 検査。表示用の行配列を返す。
function buildShotRows(pairs, label) {
  const hist = loadBarHistory();
  const rows = [];
  for (const symbol of SHOT_SYMBOLS) {
    const q = pairs.find(
      (p) => (p.symbol || "").replace(/\s/g, "").toUpperCase() === symbol.replace("/", "/").toUpperCase()
    );
    if (!q) {
      rows.push({ symbol, missing: true });
      continue;
    }
    const bar = reconstructBarFromQuote(symbol, q, label);
    const fresh = state.lastFetch && state.lastFetch[symbol];
    const prevBars = (fresh && fresh.daily && fresh.daily.bars) || hist[symbol] || [];
    const prev = prevBars.length ? prevBars[prevBars.length - 1] : null;
    const atr = fresh && fresh.daily ? fresh.daily.atr14 : null;
    const check = validateReconstructedBar(symbol, bar, prev, atr);
    rows.push({ symbol, quote: q, bar, prev, check });
  }
  return rows;
}

function renderShotReview(rows, session) {
  const el = document.getElementById("rateShotReview");
  if (!el) return;
  const stateLabel = {
    ok: '<span class="badge long">○ 使えます(セッション終了10分前)</span>',
    frozen: '<span class="badge long">◎ 使えます(市場が閉じていて確定値)</span>',
    early: '<span class="badge warn">△ まだ値が動きます</span>',
    late: '<span class="badge short">× 撮影時刻が遅すぎます</span>',
  }[session.state];

  let h = `<div class="pair-meta">${stateLabel}
    対象バー: <b>${session.label}</b>(${"日月火水木金土"[dowOf(session.label)]}曜)</div>`;
  if (session.note) h += `<p class="section-note">${session.note}</p>`;

  h += `<div class="tablewrap"><table class="tranche-table">
    <thead><tr><th>ペア</th><th>始値</th><th>高値</th><th>安値</th><th>終値</th><th>検査</th></tr></thead><tbody>`;
  // 2026-09-18発見のバグ修正: 以前は5ペア中1ペアでもエラーになると、正しく
  // 読めていた残り4ペアまで含めて「取り込む」ボタン自体が消え、その日は全ペアが
  // 未保存のままTwelve Dataフォールバックに落ちていた(GBPJPY 2026-09-17の
  // 高値が209.245[TD]のまま209.103[真の値]に更新されなかった実例で発覚)。
  // 修正: エラーのないペアだけを個別に取り込み対象にする(全滅している時だけ
  // ボタンを出さない)。
  let okCount = 0;
  for (const r of rows) {
    if (r.missing) {
      h += `<tr><td>${r.symbol}</td><td colspan="4">読み取れませんでした</td>
        <td><span class="badge short">NG(この行だけ保存されません)</span></td></tr>`;
      continue;
    }
    const d = quoteDecimals(r.symbol);
    const bad = r.check.errors.length > 0;
    if (!bad) okCount++;
    const tag = bad
      ? `<span class="badge short">NG(この行だけ保存されません)</span> ${r.check.errors.join(" / ")}`
      : r.check.warnings.length
      ? `<span class="badge warn">要確認</span> ${r.check.warnings.join(" / ")}`
      : '<span class="badge long">OK</span>';
    h += `<tr><td>${r.symbol}</td>
      <td>${r.bar.open.toFixed(d)}</td><td>${r.bar.high.toFixed(d)}</td>
      <td>${r.bar.low.toFixed(d)}</td><td>${r.bar.close.toFixed(d)}</td>
      <td>${tag}</td></tr>`;
  }
  h += "</tbody></table></div>";
  h += `<p class="section-note">
    <b>画面の数字と1桁ずつ見比べてください。</b>誤った値を取り込むと履歴が汚染され、
    以後の判定がずっとずれます。違っていたら取り込まずに撮り直すか、
    設定でモデルを変えて再読み取りしてください。</p>`;
  // 2026-09-18(教訓100): 以前はNG行があっても淡いグレー文字の注記1行だけで、
  // 見た目上は成功時と大差なく見落とされやすかった。エラーがある時は目立つ
  // 赤帯(shot-warn)で「保存されないペアがある」ことを明示する。
  const badCount = rows.length - okCount;
  if (badCount > 0) {
    h += `<p class="section-note shot-warn">⚠ ${badCount}ペアで読み取り・検査エラーがあります。
      このペアは履歴に保存されません(下の表でNGの行)。</p>`;
  }
  h += okCount > 0
    ? `<button class="btn btn-primary btn-small" id="rateShotCommit">OKの${okCount}ペアだけ履歴に取り込む</button>`
    : '<p class="section-note shot-warn">OKのペアが1つもないため取り込めません。</p>';
  el.innerHTML = h;
  el.classList.remove("hidden");

  const commit = document.getElementById("rateShotCommit");
  if (commit) {
    commit.addEventListener("click", () => {
      const bars = {};
      const skipped = [];
      for (const r of rows) {
        if (r.missing || r.check.errors.length > 0) {
          skipped.push(r.symbol);
          continue;
        }
        bars[r.symbol] = r.bar;
      }
      if (!Object.keys(bars).length) return;
      if (!appendShotBars(bars)) {
        alert("履歴の保存に失敗しました(localStorageが一杯の可能性があります)");
        return;
      }
      const savedNote = `${session.label} のバーを取り込みました(${Object.keys(bars).join("・")})。`;
      if (skipped.length) {
        // 「保存されなかったペアがある」ことは黙って通知バーに流さず、
        // 必ずクリックで消す一手間を挟む(見落とし防止、教訓100)。
        alert(`⚠ ${skipped.join("・")}は保存されませんでした。\n` +
          `この日だけTwelve Data等で自動補完されます。必要なら「過去1週間分を` +
          `手動編集」ページで後から手入力してください。`);
      }
      const skipNote = skipped.length
        ? `<p class="section-note shot-warn">⚠ ${skipped.join("・")}は保存されていません。
           この日だけTwelve Data等で補完されるので、必要ならこのページの上にある
           「過去1週間分を手動編集」で後から手入力してください。</p>`
        : "";
      el.innerHTML = `<p class="section-note">${savedNote}
        「本日の判定を取得」を押すと、この値で判定します。</p>${skipNote}`;
    });
  }
}

// acquireBars(symbol, apiKey) は signal-core.js に集約(edit-bars.js も
// 共有、教訓90)。FT5→スクショ→欠けている営業日だけTwelve Dataで補完、の3段構成。

function describeShotWindow() {
  const el = document.getElementById("rateShotWindow");
  if (!el) return;
  const s = screenshotSessionLabel();
  const dow = "日月火水木金土"[dowOf(s.label)];
  const tag = {
    ok: '<span class="badge long">○ いま撮れば使えます</span>',
    frozen: '<span class="badge long">◎ 市場が閉じています(確定値)</span>',
    early: '<span class="badge warn">△ まだ値が動きます</span>',
    late: '<span class="badge short">× いま撮っても使えません</span>',
  }[s.state];
  el.innerHTML =
    `${tag} いま撮ると <b>${s.label}(${dow})</b> のバーとして取り込みます。` +
    (s.note ? `<br>${s.note}` : "");
}

function initRateShotUI() {
  const input = document.getElementById("rateShotInput");
  const readBtn = document.getElementById("rateShotRead");
  const clearBtn = document.getElementById("rateShotClear");
  const prev = document.getElementById("rateShotPreview");
  const statusEl = document.getElementById("rateShotStatus");
  const review = document.getElementById("rateShotReview");
  if (!input) return;
  describeShotWindow();

  let current = null; // { dataUrl, mediaType }

  function show(dataUrl, mediaType) {
    current = dataUrl ? { dataUrl: dataUrl, mediaType: mediaType } : null;
    if (dataUrl) {
      prev.src = dataUrl;
      prev.classList.remove("hidden");
      readBtn.disabled = false;
    } else {
      prev.removeAttribute("src");
      prev.classList.add("hidden");
      readBtn.disabled = true;
    }
    review.classList.add("hidden");
    review.innerHTML = "";
    statusEl.textContent = "";
    statusEl.classList.remove("error");
  }

  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const r = await downscaleImage(reader.result, 1568);
      show(r.dataUrl, r.mediaType);
      try { sessionStorage.setItem(LS_RATESHOT, r.dataUrl); } catch (e) {}
      describeShotWindow();
    };
    reader.readAsDataURL(file);
    input.value = "";
  });

  clearBtn.addEventListener("click", () => {
    show(null);
    try { sessionStorage.removeItem(LS_RATESHOT); } catch (e) {}
  });

  readBtn.addEventListener("click", async () => {
    if (!current) return;
    readBtn.disabled = true;
    statusEl.classList.remove("error");
    statusEl.textContent = "AIが読み取り中…(数秒〜十数秒)";
    try {
      const session = screenshotSessionLabel();
      const pairs = await readRateShot(current.dataUrl, current.mediaType);
      const rows = buildShotRows(pairs, session.label);
      const badCount = rows.filter((r) => r.missing || r.check.errors.length > 0).length;
      if (badCount > 0) {
        statusEl.textContent = `⚠ 読み取り完了、うち${badCount}ペアでエラー。下の表を確認してください。`;
        statusEl.classList.add("error");
      } else {
        statusEl.textContent = `読み取り完了(${pairs.length}ペアを検出)。内容を確認してください。`;
      }
      renderShotReview(rows, session);
    } catch (e) {
      statusEl.textContent = `エラー: ${e.message}`;
      statusEl.classList.add("error");
    } finally {
      readBtn.disabled = false;
    }
  });

  try {
    const saved = sessionStorage.getItem(LS_RATESHOT);
    if (saved) show(saved, saved.indexOf("image/png") >= 0 ? "image/png" : "image/jpeg");
  } catch (e) {}
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
  const rawBySymbol = {}; // 生日足(1シンボル1取得)
  const dropFormingBySymbol = {};
  const sourceNotes = []; // どのペアがFT5/Twelve Dataどちらから来たかの一覧(取得ステータス表示用)
  const barsBySymbol = {}; // 衛星9層・ERゲート用(コア3 + AUDJPY/EURJPY)
  try {
    // 1) データ取得は5ペア(コア3 + 衛星専用のAUDJPY/EURJPY)。
    //    FT5エクスポートを土台に、スクショ由来の履歴を重ね、欠けた営業日だけ
    //    Twelve Dataで埋める(acquireBars 参照)。
    for (const p of ALL_PAIRS) {
      const got = await acquireBars(p.symbol, s.apiKey);
      barsBySymbol[p.symbol] = got.bars;
      sourceNotes.push(`${p.label}: ${got.note}`);
    }
    // 2) コア(日足RideThin・週足ドンチャン)の解析は3ペアだけ
    for (const p of PAIRS) {
      // 【2026-09-10、ブローカー時間へ移行】日足の区切りがNY17:00になり、
      // 日曜の立ち上がり足は月曜に吸収されて土日ラベルのバーが存在しなくなった
      // (FT5のD1キャッシュで実測: 月〜金のみ)。このため旧版の「コア用(日曜足
      // 破棄)/USDOutside用(日曜足あり)」という2系列の作り分けは不要になり、
      // 単一の系列でコア日足・週足集計・ERゲートすべてを賄う。
      // FT5経路のバーは確定済みなので形成中バーの除外も不要(fetched.dropForming)。
      const bars = barsBySymbol[p.symbol];
      const weeklySourceBars = bars;
      const atr14 = computeATR14(bars);
      const dailySignal = computeDailySignal(bars);
      const allWeeklyBars = aggregateWeekly(weeklySourceBars);
      const weeklyBars = officialWeeks(allWeeklyBars);
      // 直近の完成日足バー(新規判定日=通常火曜なら「月曜の足」)を渡して
      // entryGuard(EAの r>0 ガードの近似判定)を計算させる。週足と同じ系列(日曜足なし)を使う。
      const latestDailyBar = weeklySourceBars.length ? weeklySourceBars[weeklySourceBars.length - 1] : null;
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
        weeklySourceBars, // weeklyBreakdown(日別内訳の診断表示)用。週足H/Lの計算根拠と同じ系列。
        dataSourceNote: sourceNotes.find((n) => n.startsWith(p.label + ":")) || "",
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
    // 分散レイヤー: USDJPYアウトサイドデイ継続。ERゲートはコアと同じ日足系列
    // (日曜足を残した3ペア日足)から計算する(EAも RunDailySignals 内の同じ系列で
    // erValue[p] を更新しているため)。
    const er = computeAvgER(barsBySymbol, 20, 0);       // ERペア上の層が見る現在のER
    const erPrev = computeAvgER(barsBySymbol, 20, 1);   // AUDJPY/EURJPY上の層が見る前日のER
    state.avgER = er;
    // 週足ストリーク(USDWeeklyStreak)用の確定週足と、新しい週の確定判定
    const usdWeeks = officialWeeks(aggregateWeekly(barsBySymbol["USD/JPY"] || []));
    const newWeek = lastCompleteBarIsMonday(barsBySymbol["USD/JPY"] || []);
    state.satellites = computeAllSatellites(
      barsBySymbol, er, erPrev, { "USD/JPY": usdWeeks }, newWeek);

    state.lastFetch = freshBySymbol;
    state.lastResults = results;
    renderSignals(results);
    renderPositions(freshBySymbol);
    // ブローカー時間(NY17:00 = 日本時間 夏6:00 / 冬7:00)が日足の切り替わり。
    // FT5エクスポートのバーは常に確定済みなので「形成中バーを完成扱いする」
    // 旧バグの余地は無い。代わりに、次の確定時刻を案内として出す。
    statusEl.textContent =
      `取得完了(${new Date().toLocaleString("ja-JP")}) — 次の日足確定 ${nextBarCloseJst()} JST`;
    renderExecBanner();
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

// 自動通知は持たない(2026-09-23に廃止)。Web Push → GitHub Actions →
// Cloudflare Worker + Discord と3度作り替えたが、どれも「判定に使うデータが
// アプリ側(端末のlocalStorage)にしか無い」という構造上、通知とアプリの判定が
// 食い違う問題を解決できなかった。執行時刻は画面上部のバナーが常時示す。

function init() {
  applyTheme();
  document.getElementById("themeToggle").addEventListener("click", toggleTheme);
  initSettingsUI();
  document.getElementById("fetchBtn").addEventListener("click", fetchAndRender);
  document.getElementById("addPositionBtn").addEventListener("click", manualAddPosition);
  document.getElementById("entryModalCancel").addEventListener("click", closeEntryModal);
  document.getElementById("entryModalConfirm").addEventListener("click", confirmEntry);
  initOrderShotUI();
  initRateShotUI();
  renderPositions(null);
  renderExecBanner();
  setInterval(renderExecBanner, 60000);   // 執行時刻までの残り時間を毎分更新

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

document.addEventListener("DOMContentLoaded", init);
