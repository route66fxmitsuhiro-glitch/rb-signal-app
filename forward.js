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

const { loadSettings, loadSignalLog, LS_SIGNALLOG } = SignalCore;
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
    <thead><tr><th>決済日</th><th>建玉</th><th>枚数</th><th>約定</th><th>決済価格</th><th>損益</th></tr></thead><tbody>`;
  for (const x of sorted) {
    const p = x.pos;
    h += `<tr><td>${x.t.exitDate || "-"}</td>
      <td>${p.pairLabel} ${p.isSatellite ? (p.title || "") : x.t.name}
        ${p.direction === "long" ? "L" : "S"}<br><span class="section-note">${p.entryDate}建</span></td>
      <td>${(x.t.lot * 10).toFixed(1)}</td>
      <td>${p.entryPrice}</td>
      <td><input class="exit-input" type="number" step="any" inputmode="decimal" style="width:6.5em;"
        data-pos="${p.id}" data-tranche="${x.t.name}" value="${x.t.exitPrice != null ? x.t.exitPrice : ""}" /></td>
      <td>${x.pnl != null ? yen(x.pnl) : '<span class="badge warn">未入力</span>'}</td></tr>`;
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
      if (nv !== (t.exitPrice != null ? t.exitPrice : null)) { t.exitPrice = nv; changed++; }
    });
    if (!changed) return;
    if (!savePositions(positions)) { alert("保存に失敗しました"); return; }
    renderAll();
  });
}

function renderAll() {
  const positions = loadPositions();
  const signals = loadSignalLog();
  const trades = closedTrades(positions);
  renderSummary(positions, trades, signals);
  renderExecution(positions, signals);
  renderLayers(positions, trades, signals);
  renderClosed(positions, trades);
}

// ========== バックアップ ==========
function exportBackup() {
  const data = {
    app: "rb-signal", kind: "forward-backup", exportedAt: new Date().toISOString(),
    positions: loadPositions(), signalLog: loadSignalLog(),
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
    `建玉${data.positions.length}件・シグナル${data.signalLog.length}件を書き出しました。`;
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
    } catch (e) { alert("保存に失敗しました"); return; }
    document.getElementById("backupStatus").textContent = "復元しました。";
    renderAll();
  };
  reader.readAsText(file);
}

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
