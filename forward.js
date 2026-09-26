"use strict";
/*
 * フォワード記録ページ(forward.html)
 *
 * 2026-09-24導入。実運用(またはデモ)で実際に建てた・決済したトレードを、
 * バックテスト(v5実機ログ+実測スプレッド、forward-ref.js)の想定と並べる。
 *
 * 使うデータ(すべてこの端末の localStorage):
 *   rbsignal_positions_v1  … app.js が記録する建玉(決済時に exitPrice/exitDate が入る)
 *   rbsignal_signal_log_v1 … app.js が「このシグナルを記録」ボタンを出した日の記録
 * 損益はユーザーが入力した実際の約定価格・決済価格から計算するので、
 * スプレッド・スリッページはすべて込みの値になる。
 */

const { loadSettings, loadSignalLog, LS_SIGNALLOG, readFileAsDataUrl, downscaleImage, callClaudeJson } = SignalCore;
// 約定履歴スクショ(この画面を開いている間だけ保持。保存しない)とAIの読み取り結果
const execState = { shots: [], ai: {} }; // ai[key] = { found, exitPrice, exitDate, confidence, detail }
const REF = window.FORWARD_REF;
const LS_POSITIONS = "rbsignal_positions_v1";
const UNITS_PER_LOT = 100000; // FT5の1ロット=10万通貨(アプリの1枚=1万通貨=0.1ロット)

// レイヤーの表示名。コアは timeframe、衛星はレイヤーID(SATELLITES[].id)
const LAYER_NAME = {
  daily: "コア日足(5トランシェ)", weekly: "コア週足(3階層)",
  "gbp-outside": "GBPJPY アウトサイドデイ継続", "gbp-fade": "GBPJPY レンジフェード",
  "gbp-streak": "GBPJPY ストリーク逆張り", "gj-pinbar": "GBPJPY ピンバー反転",
  "gu-pinbar": "GBPUSD ピンバー反転",
  "usd-outside": "USDJPY アウトサイドデイ継続", "usd-streak": "USDJPY ストリーク逆張り",
  "usd-wstreak": "USDJPY 週足ストリーク逆張り",
  "aud-outside": "AUDJPY アウトサイドデイ継続", "aud-day2": "AUDJPY day-2ブレイク失敗",
  "ej-fadeout": "EURJPY アウトサイドデイ・フェード",
};
// 1シグナルあたりのトランシェ数(バックテストの件数はトランシェ単位なので、シグナル数に直す)
const TRANCHES_PER_SIGNAL = { daily: 5, weekly: 3 };

function loadPositions() {
  try {
    const raw = localStorage.getItem(LS_POSITIONS);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function savePositions(list) {
  try {
    localStorage.setItem(LS_POSITIONS, JSON.stringify(list));
    return true;
  } catch (e) {
    return false;
  }
}

function layerOf(pos) {
  return pos.isSatellite ? pos.kind : pos.timeframe;
}

function currentUsdJpy() {
  const s = loadSettings();
  return (s.usdJpyAuto && s.usdJpyCached) || s.usdJpy || 150;
}

function yen(v) {
  if (v == null || !isFinite(v)) return "-";
  const sign = v < 0 ? "−" : v > 0 ? "+" : "";
  return `${sign}¥${Math.round(Math.abs(v)).toLocaleString("ja-JP")}`;
}

function pct(v) {
  return v == null || !isFinite(v) ? "-" : `${(v * 100).toFixed(0)}%`;
}

function daysBetween(a, b) {
  return Math.round((new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / 86400000);
}

function todayJst() {
  return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
}

// 1トランシェの実現損益(円)。価格差×通貨量。ドルストレートは記録時のUSD/JPYで円に直す。
function tranchePnlJpy(pos, t) {
  if (t.exitPrice == null || !(t.exitPrice > 0) || !(pos.entryPrice > 0)) return null;
  const sign = pos.direction === "long" ? 1 : -1;
  const diff = (t.exitPrice - pos.entryPrice) * sign;
  const quote = diff * t.lot * UNITS_PER_LOT;
  return pos.symbol.endsWith("/JPY") ? quote : quote * (pos.usdJpyAtEntry || currentUsdJpy());
}

// 決済済みトランシェを平らに並べる
function closedTrades(positions) {
  const out = [];
  for (const pos of positions) {
    for (const t of pos.tranches || []) {
      if (!t.closed) continue;
      out.push({ pos, t, layer: layerOf(pos), pnl: tranchePnlJpy(pos, t) });
    }
  }
  return out;
}

// バックテストの期間別損益(USD、EAロット)を経過月数 m に内挿する
function bandAt(m) {
  const hs = REF.horizons;
  const pts = [{ months: 0, p10: 0, p50: 0, p90: 0, loss_prob: null }].concat(hs);
  if (m >= hs[hs.length - 1].months) {
    // 最長の期間を超えたら中央値は年平均で延長、上下幅は最長期間のものを比例で広げる
    const last = hs[hs.length - 1];
    const k = m / last.months;
    return { p10: last.p10 * k, p50: (REF.annual_usd * m) / 12, p90: last.p90 * k, loss_prob: last.loss_prob };
  }
  for (let i = 1; i < pts.length; i++) {
    if (m <= pts[i].months) {
      const a = pts[i - 1], b = pts[i];
      const w = (m - a.months) / (b.months - a.months);
      const f = (k) => a[k] + (b[k] - a[k]) * w;
      return { p10: f("p10"), p50: f("p50"), p90: f("p90"), loss_prob: b.loss_prob };
    }
  }
  return null;
}

function median(xs) {
  const v = xs.filter((x) => x > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = Math.floor(v.length / 2);
  return v.length % 2 ? v[i] : (v[i - 1] + v[i]) / 2;
}

// ========== 描画 ==========

function renderSummary(positions, trades, signals) {
  const el = document.getElementById("summary");
  const dates = positions.map((p) => p.entryDate).concat(signals.map((s) => s.date)).filter(Boolean).sort();
  if (!dates.length) {
    el.innerHTML = `<p class="section-note">まだ記録がありません。メイン画面でシグナルを記録し、
      決済したらトランシェにチェックを入れて決済価格を入力すると、ここに集計されます。</p>`;
    return;
  }
  const start = dates[0];
  const today = todayJst();
  const days = Math.max(daysBetween(start, today), 0);
  const months = days / 30.44;
  const realized = trades.reduce((s, x) => s + (x.pnl || 0), 0);
  const missingPrice = trades.filter((x) => x.pnl == null).length;
  const scale = median(positions.map((p) => p.scaleAtEntry));
  const uj = currentUsdJpy();

  let h = `<div class="pair-meta">記録開始 ${start} / 経過 ${days}日(約${months.toFixed(1)}か月)</div>
    <div class="pair-meta" style="font-size:1.1rem;">実現損益 <b>${yen(realized)}</b>
    ${missingPrice ? `<span class="badge warn">決済価格が未入力 ${missingPrice}件(損益に未反映)</span>` : ""}</div>`;

  if (!scale) {
    h += `<p class="section-note">ロット倍率の記録がある建玉がまだないため、バックテストとの比較は表示できません
      (この機能を入れた2026-09-24以降に記録した建玉から比較できます)。</p>`;
    el.innerHTML = h;
    return;
  }
  const b = bandAt(months);
  const toJpy = (usd) => usd * scale * uj;
  const lo = toJpy(b.p10), mid = toJpy(b.p50), hi = toJpy(b.p90);
  let verdict, cls;
  if (realized < lo) { verdict = "想定の下位10%より下(下振れ)"; cls = "short"; }
  else if (realized > hi) { verdict = "想定の上位10%より上(上振れ)"; cls = "long"; }
  else { verdict = "想定の範囲内(10〜90%)"; cls = "ok"; }

  h += `<table class="tranche-table">
      <thead><tr><th>同じ期間のバックテスト</th><th>損益(円)</th></tr></thead>
      <tbody>
        <tr><td>下位10%</td><td>${yen(lo)}</td></tr>
        <tr><td>中央値</td><td>${yen(mid)}</td></tr>
        <tr><td>上位10%</td><td>${yen(hi)}</td></tr>
        ${b.loss_prob != null ? `<tr><td>この長さで赤字になる確率</td><td>${pct(b.loss_prob)}</td></tr>` : ""}
      </tbody>
    </table>
    <div class="pair-meta"><span class="badge ${cls}">${verdict}</span></div>
    <p class="section-note">バックテストは23年分の「同じ長さの期間」を1日ずつずらして集めた分布です
      (ロットは記録時の倍率の中央値 ×${scale.toFixed(2)}、USD/JPY ${uj.toFixed(1)}円で換算)。
      <b>出たシグナルをすべて実行した前提</b>なので、下の実行率が低いほど実績は中央値より下に出ます。
      数か月ぶんの記録では上下に大きく振れるのが普通で、1〜3か月で赤字になる確率はバックテストでも3割前後あります。
      判断は半年〜1年たってから、下位10%を割り続けていないかで見てください。</p>`;
  el.innerHTML = h;
}

function renderExecution(positions, signals) {
  const el = document.getElementById("execution");
  if (!signals.length) {
    el.innerHTML = `<p class="section-note">メイン画面で「本日の判定を取得」を押すと、記録ボタンが出たシグナルがここに残ります。</p>`;
    return;
  }
  // シグナルと建玉の突き合わせ: 同じレイヤー・ペア・方向で、シグナル日〜2日後までに記録した建玉があれば実行済み
  const used = new Set();
  const rows = signals.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).map((s) => {
    const hit = positions.find((p) => !used.has(p.id) && layerOf(p) === s.layer && p.symbol === s.symbol &&
      p.direction === s.direction && p.entryDate >= s.date && daysBetween(s.date, p.entryDate) <= 2);
    if (hit) used.add(hit.id);
    return { s, taken: !!hit };
  });
  const taken = rows.filter((r) => r.taken).length;
  let h = `<div class="pair-meta" style="font-size:1.05rem;">出たシグナル ${rows.length}件 / 実行 ${taken}件
    / 実行率 <b>${pct(taken / rows.length)}</b></div>
    <p class="section-note">画面に「このシグナルを記録」ボタンが出たもの(EAなら建てる場面)を数えています。
      記録し忘れも「未実行」に数えるので、実際に建てたものは必ず記録してください。</p>
    <table class="tranche-table">
      <thead><tr><th>日付</th><th>シグナル</th><th>方向</th><th>実行</th></tr></thead><tbody>`;
  for (const r of rows.slice(0, 40)) {
    h += `<tr><td>${r.s.date}</td><td>${LAYER_NAME[r.s.layer] || r.s.layer}(${r.s.symbol})</td>
      <td>${r.s.direction === "long" ? "ロング" : "ショート"}</td>
      <td>${r.taken ? '<span class="badge ok">済</span>' : '<span class="badge warn">未</span>'}</td></tr>`;
  }
  h += `</tbody></table>`;
  if (rows.length > 40) h += `<p class="section-note">直近40件を表示しています(全${rows.length}件)。</p>`;
  el.innerHTML = h;
}

function renderLayers(positions, trades, signals) {
  const el = document.getElementById("layers");
  const uj = currentUsdJpy();
  const dates = positions.map((p) => p.entryDate).concat(signals.map((s) => s.date)).filter(Boolean).sort();
  const years = dates.length ? Math.max(daysBetween(dates[0], todayJst()), 1) / 365.25 : 0;
  let h = `<div style="overflow-x:auto;"><table class="tranche-table">
    <thead><tr><th>レイヤー</th><th>シグナル数<br>(実績/想定)</th><th>決済数</th>
      <th>勝率<br>(実績/BT)</th><th>0.01ロットあたり平均<br>(実績/BT)</th></tr></thead><tbody>`;
  for (const id of Object.keys(LAYER_NAME)) {
    const ref = REF.layers[id];
    const sigN = signals.filter((s) => s.layer === id).length;
    const expN = ref ? (ref.n_per_year / (TRANCHES_PER_SIGNAL[id] || 1)) * years : null;
    const ts = trades.filter((x) => x.layer === id && x.pnl != null);
    const win = ts.length ? ts.filter((x) => x.pnl > 0).length / ts.length : null;
    const per001 = ts.length ? ts.reduce((s, x) => s + x.pnl / (x.t.lot / 0.01), 0) / ts.length : null;
    if (!sigN && !ts.length && !ref) continue;
    h += `<tr><td>${LAYER_NAME[id]}</td>
      <td>${sigN} / ${expN != null ? expN.toFixed(1) : "-"}</td>
      <td>${ts.length}</td>
      <td>${pct(win)} / ${ref ? pct(ref.win) : "-"}</td>
      <td>${per001 != null ? yen(per001) : "-"} / ${ref ? yen(ref.avg_usd_per_001 * uj) : "-"}</td></tr>`;
  }
  h += `</tbody></table></div>
    <p class="section-note">BT = バックテスト(${REF.version}、${REF.years}年)。
      「シグナル数の想定」はバックテストの年間件数×経過年数で、ここが実績と大きく違う場合は
      アプリの判定かデータの取り込みを疑ってください。勝率・平均損益は件数が数十件たまるまで大きくぶれます。
      コア日足・週足の勝率と平均はトランシェ単位です。</p>`;
  el.innerHTML = h;
}

function renderClosed(positions, trades) {
  const el = document.getElementById("closedList");
  if (!trades.length) {
    el.innerHTML = `<p class="section-note">まだ決済済みのトランシェはありません。</p>`;
    return;
  }
  const sorted = trades.slice().sort((a, b) => ((a.t.exitDate || "") < (b.t.exitDate || "") ? 1 : -1));
  let h = `<div style="overflow-x:auto;"><table class="tranche-table">
    <thead><tr><th>決済日</th><th>建玉</th><th>枚数</th><th>約定</th><th>決済価格</th><th>損益</th><th>AI</th></tr></thead><tbody>`;
  for (const x of sorted) {
    const p = x.pos;
    const key = `${p.id}::${x.t.name}`;
    const ai = execState.ai[key];
    // AIの読み取り値は、未入力の欄にだけ下書きとして入れる(既存の値は上書きしない)
    const shown = x.t.exitPrice != null ? x.t.exitPrice : ai && ai.found ? ai.exitPrice : "";
    const aiCell = !ai ? "" : !ai.found
      ? `<span class="badge none">見当たらず</span>`
      : `<span class="badge ${ai.confidence === "high" ? "ok" : "warn"}">${ai.confidence === "high" ? "読取" : "要確認"}</span>`
        + (x.t.exitPrice != null && Math.abs(x.t.exitPrice - ai.exitPrice) > 1e-9
          ? `<br><span class="section-note">入力済み ${x.t.exitPrice} と違う: ${ai.exitPrice}</span>` : "")
        + (ai.detail ? `<br><span class="section-note">${ai.detail}</span>` : "");
    h += `<tr><td>${x.t.exitDate || "-"}</td>
      <td>${p.pairLabel} ${p.isSatellite ? (p.title || "") : x.t.name}
        ${p.direction === "long" ? "L" : "S"}<br><span class="section-note">${p.entryDate}建</span></td>
      <td>${(x.t.lot * 10).toFixed(1)}</td>
      <td>${p.entryPrice}</td>
      <td><input class="exit-input" type="number" step="any" inputmode="decimal" style="width:6.5em;"
        data-pos="${p.id}" data-tranche="${x.t.name}" data-aidate="${ai && ai.found && x.t.exitPrice == null ? ai.exitDate || "" : ""}"
        value="${shown}" /></td>
      <td>${x.pnl != null ? yen(x.pnl) : '<span class="badge warn">未入力</span>'}</td>
      <td>${aiCell}</td></tr>`;
  }
  h += `</tbody></table></div>
    <div class="btn-row"><button id="saveExits" class="btn btn-primary btn-small" type="button">決済価格を保存</button></div>`;
  el.innerHTML = h;
  document.getElementById("saveExits").addEventListener("click", () => {
    let changed = 0;
    el.querySelectorAll(".exit-input").forEach((inp) => {
      const pos = positions.find((p) => p.id === inp.dataset.pos);
      const t = pos && pos.tranches.find((q) => q.name === inp.dataset.tranche);
      if (!t) return;
      const v = parseFloat(inp.value);
      const nv = v > 0 ? v : null;
      if (nv !== (t.exitPrice != null ? t.exitPrice : null)) {
        t.exitPrice = nv;
        // AIがブローカーの約定日を読めていれば、決済日もそちらに合わせる
        if (nv != null && /^\d{4}-\d{2}-\d{2}$/.test(inp.dataset.aidate || "")) t.exitDate = inp.dataset.aidate;
        changed++;
      }
    });
    if (!changed) return;
    if (!savePositions(positions)) { alert("保存に失敗しました"); return; }
    renderAll();
  });
}

// ========== フォワード検証プロトコル(2026-09-26 確定) ==========
// 外部監査の Forward Validation Protocol v1.0 を、v5 の実機ログで偽陽性率を校正したもの。
// 根拠: docs/history/13_forward_protocol_2026-09-26.md / conflictaware/aplus/forward_threshold_check_v5.py
// 件数はトランシェ単位(バックテストの 43,960件と同じ数え方)。STOP の PF 閾値は、
// v5 がバックテストどおりの実力でも誤って当たる確率が約5%になる値。
const PROTOCOL = {
  refDdUsd: 3026,          // 確定損益ベースの過去最大DD(実測スプレッド後)
  equityDdRatio: 1.68,     // 含み損込みの最大DDは確定損益ベースの1.68倍(equity_dd_v5.py)
  pfExUws: 1.197,          // USDWeeklyStreak を除いたバックテストのPF(全層込みは1.236)
  checkpoints: [           // n: 件数、watchPf/stopPf: これ未満で WATCH/STOP候補
    { n: 500, watchPf: 1.00, stopPf: 0.75 },
    { n: 1000, watchPf: 1.05, stopPf: 0.85 },
    { n: 2000, watchPf: 1.08, stopPf: 0.95 },
    { n: 4000, watchPf: 1.10, stopPf: 1.02 },
  ],
  earlyWatchPf: 0.90,      // 500件未満: PF<0.90 または DD≥1.0倍で WATCH(性能では止めない)
  ddWatch: 1.25, ddStop: 1.50,
};

function pfOf(xs) {
  const pos = xs.filter((v) => v > 0).reduce((s, v) => s + v, 0);
  const neg = -xs.filter((v) => v < 0).reduce((s, v) => s + v, 0);
  return neg > 0 ? pos / neg : pos > 0 ? Infinity : null;
}

// 決済日順の確定損益カーブから最大DD(円)
function maxDdOf(xs) {
  let cum = 0, peak = 0, dd = 0;
  for (const v of xs) { cum += v; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  return dd;
}

function fmtPf(v) {
  return v == null ? "-" : v === Infinity ? "∞" : v.toFixed(2);
}

function renderProtocol(positions, trades, signals) {
  const el = document.getElementById("protocol");
  const done = trades.filter((x) => x.pnl != null)
    .sort((a, b) => ((a.t.exitDate || "") < (b.t.exitDate || "") ? -1 : 1));
  const n = done.length;
  const pnl = done.map((x) => x.pnl);
  const pf = pfOf(pnl);
  const dd = maxDdOf(pnl);
  const exUws = done.filter((x) => x.layer !== "usd-wstreak").map((x) => x.pnl);
  const scale = median(positions.map((p) => p.scaleAtEntry));
  const uj = currentUsdJpy();
  const refDdJpy = scale ? PROTOCOL.refDdUsd * scale * uj : null;
  const ddX = refDdJpy ? dd / refDdJpy : null;

  // 到達済みの最大のチェックポイントで判定。500件未満は早期ルール。
  const cp = PROTOCOL.checkpoints.filter((c) => n >= c.n).pop();
  const next = PROTOCOL.checkpoints.find((c) => n < c.n);
  let status = "PASS", cls = "ok", why = [];
  if (!n) { status = "記録待ち"; cls = "none"; }
  else if (!cp) {
    if (pf != null && pf < PROTOCOL.earlyWatchPf) why.push(`PF ${fmtPf(pf)} < ${PROTOCOL.earlyWatchPf}`);
    if (ddX != null && ddX >= 1.0) why.push(`DD ${ddX.toFixed(2)}倍 ≥ 1.0倍`);
    if (why.length) { status = "WATCH"; cls = "warn"; } else { status = "判定前(500件未満)"; cls = "none"; }
  } else {
    const stop = [], watch = [];
    if (pf != null && pf < cp.stopPf) stop.push(`PF ${fmtPf(pf)} < ${cp.stopPf}`);
    else if (pf != null && pf < cp.watchPf) watch.push(`PF ${fmtPf(pf)} < ${cp.watchPf}`);
    if (ddX != null && ddX >= PROTOCOL.ddStop) stop.push(`DD ${ddX.toFixed(2)}倍 ≥ ${PROTOCOL.ddStop}倍`);
    else if (ddX != null && ddX >= PROTOCOL.ddWatch) watch.push(`DD ${ddX.toFixed(2)}倍 ≥ ${PROTOCOL.ddWatch}倍`);
    if (stop.length) { status = "STOP-AND-AUDIT候補"; cls = "short"; why = stop.concat(watch); }
    else if (watch.length) { status = "WATCH"; cls = "warn"; why = watch; }
  }
  const pfEx = pfOf(exUws);

  let h = `<div class="pair-meta" style="font-size:1.1rem;"><span class="badge ${cls}">${status}</span>
      ${why.length ? `— ${why.join(" / ")}` : ""}</div>
    <table class="tranche-table"><tbody>
      <tr><td>決済済み件数(トランシェ単位)</td><td><b>${n}</b>${next ? ` / 次の判定 ${next.n}件(あと${next.n - n}件)` : ""}</td></tr>
      <tr><td>PF(実約定)</td><td>${fmtPf(pf)}</td></tr>
      <tr><td>確定損益の最大DD</td><td>${yen(-dd)}${ddX != null ? `(基準の ${ddX.toFixed(2)}倍)` : ""}</td></tr>
      <tr><td>USDWeeklyStreak を除いた PF</td><td>${fmtPf(pfEx)}(バックテスト ${PROTOCOL.pfExUws})</td></tr>
    </tbody></table>
    <div style="overflow-x:auto;"><table class="tranche-table">
      <thead><tr><th>件数</th><th>目安</th><th>WATCH</th><th>STOP候補</th></tr></thead><tbody>
      <tr><td>〜499</td><td>〜3か月</td><td>PF&lt;${PROTOCOL.earlyWatchPf} / DD≥1.0倍</td><td>性能では止めない</td></tr>`;
  for (const c of PROTOCOL.checkpoints) {
    const mark = cp === c ? " ◀" : "";
    h += `<tr><td>${c.n.toLocaleString()}${mark}</td><td>約${(c.n / 1888 * 12).toFixed(0)}か月</td>
      <td>PF&lt;${c.watchPf} / DD≥${PROTOCOL.ddWatch}倍</td><td>PF&lt;${c.stopPf} / DD≥${PROTOCOL.ddStop}倍</td></tr>`;
  }
  h += `</tbody></table></div>`;
  if (refDdJpy) {
    h += `<p class="section-note">DDの基準(1.0倍)= バックテストの確定損益ベースの最大DD ${PROTOCOL.refDdUsd.toLocaleString()} USD
      × ロット倍率 ${scale.toFixed(2)} × ${uj.toFixed(1)}円 = <b>${yen(-refDdJpy)}</b>。
      <b>含み損込みでは、その約${PROTOCOL.equityDdRatio}倍(${yen(-refDdJpy * PROTOCOL.equityDdRatio)})まで沈んだことがあります</b>
      (2008年)。口座の評価額がこの程度まで下がるのは、バックテストの範囲内です。</p>`;
  }
  h += `<p class="section-note"><b>v5 はフォワード中は変更しません</b>(パラメータ・層・ロット比・執行時刻。不調な層だけ止めるのも禁止)。
      STOP候補は「すぐ止める」ではなく「新規を止めて原因を精査する」合図です。
      2,000件以降は、PF・DD・衛星の過半数がPF&lt;1・コアPF&lt;1・スプレッドの恒常的な超過のうち、2つ以上が重なったときに強く検討します。
      シグナル・方向・ロットがアプリの仕様と食い違う、データ異常、注文異常は件数を待たずに精査してください。
      PF の STOP 閾値は、v5 がバックテストどおりの実力でも誤って当たる確率が約5%になるように決めてあります。
      USDWeeklyStreak は107件で全利益の約2割を占める層なので、除いた系列も並べて見ます。</p>`;
  el.innerHTML = h;
}

// ========== 執行時スプレッドの記録 ==========
// Exec730 が唯一頼っている前提(+90分でロールオーバーの広がりが解消している)を実地で確かめる。
// 特に荒れた日(雇用統計の週明け等)の 7:00〜8:30 を記録する。
const LS_SPREADLOG = "rbsignal_spread_log_v1";
const SPREAD_PAIRS = ["GBP/JPY", "GBP/USD", "USD/JPY", "AUD/JPY", "EUR/JPY"];
const NORMAL_SPREAD = { "GBP/JPY": 0.9, "GBP/USD": 1.0, "USD/JPY": 0.2, "AUD/JPY": 0.5, "EUR/JPY": 0.4 };

function loadSpreadLog() {
  try { return JSON.parse(localStorage.getItem(LS_SPREADLOG) || "[]"); } catch (e) { return []; }
}

function renderSpreadLog() {
  const el = document.getElementById("spreadLog");
  const log = loadSpreadLog();
  const now = new Date(Date.now() + 9 * 3600000).toISOString();
  let h = `<div class="spread-form">
      <label>日付 <input id="spDate" type="date" value="${now.slice(0, 10)}" /></label>
      <label>時刻 <input id="spTime" type="time" value="${now.slice(11, 16)}" /></label>`;
  for (const s of SPREAD_PAIRS) {
    h += `<label>${s} <input class="sp-in" data-pair="${s}" type="number" step="0.1" inputmode="decimal"
      placeholder="${NORMAL_SPREAD[s]}" style="width:5em;" /></label>`;
  }
  h += `<label>メモ <input id="spNote" type="text" placeholder="例: 雇用統計の週明け" style="width:12em;" /></label>
    </div>
    <div class="btn-row"><button id="spSave" class="btn btn-primary btn-small" type="button">記録する</button></div>`;
  if (log.length) {
    h += `<div style="overflow-x:auto;"><table class="tranche-table"><thead><tr><th>日時</th>`
      + SPREAD_PAIRS.map((s) => `<th>${s.replace("/", "")}</th>`).join("") + `<th>メモ</th><th></th></tr></thead><tbody>`;
    const rows = log.slice().sort((a, b) => (a.at < b.at ? 1 : -1));
    for (const r of rows.slice(0, 30)) {
      h += `<tr><td>${r.at.replace("T", " ")}</td>` + SPREAD_PAIRS.map((s) => {
        const v = r.pips[s];
        if (v == null) return "<td>-</td>";
        const wide = v > NORMAL_SPREAD[s] * 2;   // 通常の2倍超は目立たせる
        return `<td>${wide ? `<span class="badge warn">${v}</span>` : v}</td>`;
      }).join("") + `<td>${r.note || ""}</td><td><button class="btn btn-ghost btn-small sp-del" data-at="${r.at}" type="button">×</button></td></tr>`;
    }
    h += `</tbody></table></div>`;
  }
  el.innerHTML = h;
  document.getElementById("spSave").addEventListener("click", () => {
    const pips = {};
    el.querySelectorAll(".sp-in").forEach((i) => { const v = parseFloat(i.value); if (v >= 0) pips[i.dataset.pair] = v; });
    if (!Object.keys(pips).length) { alert("スプレッドを1つ以上入力してください"); return; }
    const at = `${document.getElementById("spDate").value}T${document.getElementById("spTime").value}`;
    const all = loadSpreadLog().filter((r) => r.at !== at);
    all.push({ at, pips, note: document.getElementById("spNote").value.trim() });
    try { localStorage.setItem(LS_SPREADLOG, JSON.stringify(all)); } catch (e) { alert("保存に失敗しました"); return; }
    renderSpreadLog();
  });
  el.querySelectorAll(".sp-del").forEach((b) => b.addEventListener("click", () => {
    if (!confirm(`${b.dataset.at.replace("T", " ")} の記録を削除しますか?`)) return;
    try { localStorage.setItem(LS_SPREADLOG, JSON.stringify(loadSpreadLog().filter((r) => r.at !== b.dataset.at))); } catch (e) { return; }
    renderSpreadLog();
  }));
}

function renderAll() {
  const positions = loadPositions();
  const signals = loadSignalLog();
  const trades = closedTrades(positions);
  renderProtocol(positions, trades, signals);
  renderSpreadLog();
  renderSummary(positions, trades, signals);
  renderExecution(positions, signals);
  renderLayers(positions, trades, signals);
  renderClosed(positions, trades);
}

// ========== バックアップ ==========
function exportBackup() {
  const data = {
    app: "rb-signal", kind: "forward-backup", exportedAt: new Date().toISOString(),
    positions: loadPositions(), signalLog: loadSignalLog(), spreadLog: loadSpreadLog(),
  };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `rb-forward-${todayJst()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  document.getElementById("backupStatus").textContent =
    `建玉${data.positions.length}件・シグナル${data.signalLog.length}件・スプレッド${data.spreadLog.length}件を書き出しました。`;
}

function importBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try { data = JSON.parse(reader.result); } catch (e) { alert("JSONとして読めませんでした"); return; }
    if (!data || data.kind !== "forward-backup" || !Array.isArray(data.positions)) {
      alert("このアプリのバックアップファイルではないようです"); return;
    }
    if (!confirm(`建玉${data.positions.length}件・シグナル${(data.signalLog || []).length}件で、`
      + "この端末の記録を置き換えます。よろしいですか?")) return;
    try {
      localStorage.setItem(LS_POSITIONS, JSON.stringify(data.positions));
      localStorage.setItem(LS_SIGNALLOG, JSON.stringify(data.signalLog || []));
      // スプレッド記録は 2026-09-26 以降のバックアップにだけある。無い古いバックアップでは今の記録を残す
      if (Array.isArray(data.spreadLog)) localStorage.setItem(LS_SPREADLOG, JSON.stringify(data.spreadLog));
    } catch (e) { alert("保存に失敗しました"); return; }
    document.getElementById("backupStatus").textContent = "復元しました。";
    renderAll();
  };
  reader.readAsText(file);
}

// ========== 約定履歴スクショ → 決済価格(AI読み取り) ==========
// 決済済みトランシェの一覧(ペア・方向・枚数・約定価格・想定の決済水準)を手がかりとして渡し、
// スクショの約定行と1件ずつ対応付けさせる。同じ建玉の T0〜T3 は枚数・方向が同じで見分けにくいので、
// 各トランシェの利食い目標(約定±R×目標R)や固定逆指値を「どのあたりで決済されたはずか」として渡す。
function trancheHint(pos, t) {
  const sgn = pos.direction === "long" ? 1 : -1;
  if (t.targetR != null && pos.R > 0) return { kind: "利食い目標", price: pos.entryPrice + sgn * pos.R * t.targetR };
  if (pos.fixedStop != null) return { kind: "固定逆指値(または時間切れで成行)", price: pos.fixedStop };
  return { kind: "撤退ライン(トレール)または時間切れ", price: null };
}

function renderExecThumbs() {
  const el = document.getElementById("execShotThumbs");
  el.innerHTML = execState.shots.map((s, i) =>
    `<img src="${s}" alt="約定履歴 ${i + 1}" style="height:64px;border:1px solid var(--border);border-radius:6px;" />`).join("");
}

async function runExecAi() {
  const status = document.getElementById("execAiStatus");
  const btn = document.getElementById("execAiBtn");
  const settings = loadSettings();
  const apiKey = (settings.anthropicKey || "").trim();
  status.classList.remove("error");
  if (!apiKey) { status.textContent = "メイン画面の設定で Anthropic APIキーを入力してください。"; return; }
  if (!execState.shots.length) { status.textContent = "先に約定履歴のスクショを選んでください。"; return; }
  const positions = loadPositions();
  const trades = closedTrades(positions);
  if (!trades.length) { status.textContent = "決済済みのトランシェがありません。"; return; }

  const items = trades.map((x) => {
    const p = x.pos;
    const h = trancheHint(p, x.t);
    return {
      key: `${p.id}::${x.t.name}`,
      pair: p.symbol,
      entry_side: p.direction === "long" ? "買い(ロング)" : "売り(ショート)",
      closing_side: p.direction === "long" ? "売り決済" : "買い決済",
      size_mai: Math.round(x.t.lot * 100) / 10, // 1枚=1万通貨
      size_units: Math.round(x.t.lot * UNITS_PER_LOT),
      entry_price: p.entryPrice,
      entry_date: p.entryDate,
      marked_closed_on: x.t.exitDate || null, // アプリで決済チェックを入れた日(約定日の目安)
      expected_exit: h.kind,
      expected_exit_price: h.price != null ? Number(h.price.toFixed(5)) : null,
      already_entered_price: x.t.exitPrice != null ? x.t.exitPrice : null,
    };
  });

  const schema = {
    type: "object", additionalProperties: false, required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object", additionalProperties: false,
          required: ["key", "found", "exitPrice", "exitDate", "confidence", "detail"],
          properties: {
            key: { type: "string" },
            found: { type: "boolean" },
            exitPrice: { type: "number", description: "決済の約定価格。見つからなければ0" },
            exitDate: { type: "string", description: "決済の約定日 YYYY-MM-DD。読めなければ空文字" },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
            detail: { type: "string", description: "どの行と対応させたか・迷った点(短い日本語)" },
          },
        },
      },
    },
  };
  const system =
    "あなたはFXの約定履歴の読み取り補助です。ユーザーがブローカー(GMOクリック証券など)のスマホアプリの" +
    "「約定履歴/決済済み」画面のスクリーンショットを1枚以上渡します(スクロールして分けて撮った場合は1つの一覧として扱う)。" +
    "別途渡す『決済済みトランシェの一覧』の各項目(key)について、スクショの中の対応する決済の約定行を探し、その約定価格を返してください。" +
    "対応付けの指針: (1)通貨ペアの表記揺れ(GBP/JPY・GBPJPY・ポンド円)は同一視。" +
    "(2)決済行の売買は建玉と逆(ロングの決済は売り)。新規(エントリー)の行は対象外。" +
    "(3)数量: 1枚=1万通貨。画面の数量単位が枚か通貨かはアプリによるので桁で判断。" +
    "(4)同じ建玉から同じ数量のトランシェが複数あるときは、expected_exit_price(利食い目標や逆指値)に最も近い価格の行を割り当て、" +
    "1つの約定行を2つのkeyに使い回さない。(5)日付は marked_closed_on・entry_date の前後で探す。" +
    "(6)確実に対応付けられないものは found=false。迷いがあれば confidence を medium か low にして detail に理由を書く。" +
    "価格は画面の表示どおりの桁で返す(丸めない)。渡された全keyについて1件ずつ返すこと。";

  btn.disabled = true;
  status.textContent = `AIが読み取り中…(スクショ${execState.shots.length}枚・対象${items.length}件)`;
  try {
    const out = await callClaudeJson({
      apiKey, model: settings.visionModel, system, schema, maxTokens: 8192,
      dataUrls: execState.shots,
      text: "決済済みトランシェの一覧(JSON):\n" + JSON.stringify(items, null, 1) +
        "\n\n上のスクリーンショットから各keyの決済価格を読み取り、指定スキーマのJSONで返してください。",
    });
    execState.ai = {};
    let found = 0;
    let filled = 0;
    for (const it of out.items || []) {
      if (!it || !it.key) continue;
      if (it.found && !(it.exitPrice > 0)) it.found = false;
      execState.ai[it.key] = it;
      if (it.found) {
        found++;
        const tr = trades.find((x) => `${x.pos.id}::${x.t.name}` === it.key);
        if (tr && tr.t.exitPrice == null) filled++;
      }
    }
    renderAll();
    status.textContent = `読み取り完了: ${items.length}件中 ${found}件を対応付け、未入力の${filled}件に下書きを入れました。` +
      "値を確認して「決済価格を保存」を押してください(「要確認」の行は特に)。";
  } catch (e) {
    status.textContent = `読み取りに失敗しました: ${e.message}`;
    status.classList.add("error");
  } finally {
    btn.disabled = false;
  }
}

document.getElementById("execShotFile").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  for (const f of files) {
    const raw = await readFileAsDataUrl(f);
    const small = await downscaleImage(raw, 1568);
    execState.shots.push(small.dataUrl);
  }
  e.target.value = "";
  renderExecThumbs();
  document.getElementById("execAiStatus").textContent = `スクショ ${execState.shots.length}枚を選択中。`;
});
document.getElementById("execAiBtn").addEventListener("click", runExecAi);
document.getElementById("execShotClear").addEventListener("click", () => {
  execState.shots = [];
  execState.ai = {};
  renderExecThumbs();
  renderAll();
  document.getElementById("execAiStatus").textContent = "";
});

// ========== テーマ(edit-bars.js と同じ) ==========
function applyTheme() {
  const saved = localStorage.getItem("rbsignal_theme_v1");
  if (saved) document.documentElement.setAttribute("data-theme", saved);
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("rbsignal_theme_v1", next);
}

applyTheme();
document.getElementById("themeToggle").addEventListener("click", toggleTheme);
document.getElementById("exportBtn").addEventListener("click", exportBackup);
document.getElementById("importFile").addEventListener("change", (e) => {
  if (e.target.files && e.target.files[0]) importBackup(e.target.files[0]);
  e.target.value = "";
});
renderAll();
