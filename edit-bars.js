"use strict";
/*
 * 4本値の手動編集ページ(edit-bars.html)
 *
 * 目的: 毎朝、日足が確定する前(朝05:30〜06:00頃)にブローカーのレート一覧
 * スクショをアップロードしているため、後から確認すると終値等が確定値と
 * ズレていることがある。このページは直近の日足をペアごとに一覧表示し、
 * 値を直接書き換えて localStorage の履歴(rb_bar_history_v1、app.js の
 * スクショ取り込みと同じ保存先)に上書き保存する。
 *
 * 判定ロジック・データ取得・保存先の関数はすべて signal-core.js に集約
 * されたものを使う(app.js と二重実装しない、教訓90)。
 */

const {
  SHOT_SYMBOLS,
  quoteDecimals,
  shiftDate,
  dowOf,
  loadSettings,
  appendShotBars,
  removeShotBar,
  validateReconstructedBar,
  computeATR14,
  lastCapturableSessionLabel,
  acquireBars,
} = SignalCore;

const N_DAYS = 10; // 「過去1週間」より少し広めに表示しておく
const PAIR_LABEL = {
  "GBP/JPY": "GBPJPY", "GBP/USD": "GBPUSD", "USD/JPY": "USDJPY",
  "AUD/JPY": "AUDJPY", "EUR/JPY": "EURJPY",
};
const FIELDS = ["open", "high", "low", "close"];
const SRC_LABEL = { ft5: "FT5", shot: "手動/スクショ", td: "TD補完" };

// symbol("GBP/JPY") -> DOM要素IDに使える文字列("GBP-JPY")
function slug(symbol) {
  return symbol.replace("/", "-");
}

// endDateから遡って、土日を除いたn営業日分の日付(昇順)を返す。
function recentTradingDates(endDate, n) {
  const dates = [];
  let d = endDate;
  while (dates.length < n) {
    const wd = dowOf(d);
    if (wd !== 0 && wd !== 6) dates.push(d);
    d = shiftDate(d, -1);
  }
  return dates.reverse();
}

// このページで保持する状態: symbol -> { rows, merged, note, gaps }
const state = {};

// acquireBars(FT5→スクショ→欠けている営業日だけTwelve Data補完)をindex.htmlと
// 共有しているため、Twelve Data APIキーが設定されていれば、このページでも
// index.html同様に自動補完される(教訓90、二重実装によるロジックのズレの防止)。
async function loadPair(symbol) {
  const apiKey = (loadSettings().apiKey || "").trim();
  const { bars: merged, note, gaps } = await acquireBars(symbol, apiKey);
  const end = lastCapturableSessionLabel();
  const dates = recentTradingDates(end, N_DAYS);
  const byDate = new Map(merged.map((b) => [b.date, b]));
  const rows = dates.map((date) => {
    const bar = byDate.get(date);
    return {
      date,
      open: bar ? bar.open : null,
      high: bar ? bar.high : null,
      low: bar ? bar.low : null,
      close: bar ? bar.close : null,
      src: bar ? bar.src : null,
    };
  });
  state[symbol] = { rows, merged, note, gaps };
  return state[symbol];
}

function fmt(v, dec) {
  return v == null ? "" : v.toFixed(dec);
}

function renderPairSection(symbol) {
  const s = state[symbol];
  const dec = quoteDecimals(symbol);
  const id = slug(symbol);

  const rowsHtml = s.rows
    .map((r, i) => {
      const missing = r.src == null;
      const cells = FIELDS.map(
        (f) =>
          `<td><input type="number" step="${Math.pow(10, -dec)}" inputmode="decimal"
            data-field="${f}" value="${fmt(r[f], dec)}" /></td>`
      ).join("");
      // ft5=最も信頼できる基準、shot/td はいずれも「一度は要確認」の値として
      // 同じ警告色で揃える(tdはFT5との既知の食い違いがあり、shotは人間の入力)。
      const srcBadge = missing
        ? '<span class="badge none">なし</span>'
        : `<span class="badge ${r.src === "ft5" ? "none" : "warn"} bar-edit-src">${SRC_LABEL[r.src] || r.src}</span>`;
      const resetBtn = `<button type="button" class="bar-edit-reset" data-date="${r.date}"
        ${r.src === "shot" ? "" : "disabled"}>FT5に戻す</button>`;
      return `<tr class="bar-edit-row${missing ? " missing" : ""}" data-index="${i}" data-date="${r.date}">
        <td class="bar-edit-date">${r.date}(${"日月火水木金土"[dowOf(r.date)]})</td>
        ${cells}
        <td>${srcBadge}</td>
        <td>${resetBtn}</td>
      </tr>`;
    })
    .join("");

  return `<section class="card pair-edit-card" id="pair-${id}">
    <div class="section-head">
      <h2>${PAIR_LABEL[symbol]}</h2>
    </div>
    <p class="pair-meta">${s.note || ""}</p>
    <div class="tablewrap"><table class="bar-edit-table">
      <thead><tr>
        <th>日付</th><th>始値</th><th>高値</th><th>安値</th><th>終値</th><th>元</th><th></th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table></div>
    <div class="btn-row">
      <button type="button" class="btn btn-primary btn-small" data-save="${symbol}">このペアを保存</button>
    </div>
    <p class="pair-edit-status" id="status-${id}"></p>
  </section>`;
}

async function renderAll() {
  const statusEl = document.getElementById("loadStatus");
  statusEl.textContent = "読み込み中…";
  const container = document.getElementById("pairSections");
  try {
    for (const symbol of SHOT_SYMBOLS) {
      await loadPair(symbol);
    }
    container.innerHTML = SHOT_SYMBOLS.map(renderPairSection).join("");
    container.querySelectorAll(".pair-edit-card").forEach(attachHandlersFor);
    statusEl.textContent = `直近${N_DAYS}営業日分を表示しています(値を書き換えて「このペアを保存」を押してください)。`;
  } catch (e) {
    statusEl.textContent = `読み込みエラー: ${e.message}`;
    statusEl.classList.add("error");
  }
}

// カード単位でだけリスナーを付ける。document全体に対して付けると、
// refreshPair() で1ペアだけ再描画した際に他のペアへも重複登録されてしまう
// (input1回で保存2回走る等の不具合になる)ため、範囲を必ずcard要素に絞る。
function attachHandlersFor(card) {
  card.querySelectorAll(".bar-edit-table input").forEach((inp) => {
    inp.addEventListener("input", () => markRowChanged(inp.closest("tr")));
  });
  card.querySelectorAll(".bar-edit-reset").forEach((btn) => {
    if (btn.disabled) return;
    btn.addEventListener("click", () => onReset(btn));
  });
  card.querySelectorAll("[data-save]").forEach((btn) => {
    btn.addEventListener("click", () => onSave(btn.dataset.save));
  });
}

function symbolOfCard(el) {
  return el.closest(".pair-edit-card").id.replace("pair-", "").replace("-", "/");
}

function markRowChanged(tr) {
  const symbol = symbolOfCard(tr);
  const idx = parseInt(tr.dataset.index, 10);
  const orig = state[symbol].rows[idx];
  const cur = readRow(tr);
  const changed = FIELDS.some((f) => cur[f] !== orig[f] && !(cur[f] == null && orig[f] == null));
  tr.classList.toggle("changed", changed);
}

function readRow(tr) {
  const out = { date: tr.dataset.date };
  tr.querySelectorAll("input").forEach((inp) => {
    const v = inp.value.trim() === "" ? null : parseFloat(inp.value);
    out[inp.dataset.field] = Number.isFinite(v) ? v : null;
  });
  return out;
}

async function onReset(btn) {
  const tr = btn.closest("tr");
  const symbol = symbolOfCard(tr);
  const date = tr.dataset.date;
  if (!confirm(`${date} の手動/スクショ上書きを削除し、FT5の値に戻します。よろしいですか?`)) return;
  removeShotBar(symbol, date);
  await refreshPair(symbol);
}

async function refreshPair(symbol) {
  await loadPair(symbol);
  const id = slug(symbol);
  document.getElementById(`pair-${id}`).outerHTML = renderPairSection(symbol);
  attachHandlersFor(document.getElementById(`pair-${id}`));
}

function setStatus(symbol, text, cls) {
  const el = document.getElementById(`status-${slug(symbol)}`);
  if (!el) return;
  el.textContent = text;
  el.className = "pair-edit-status" + (cls ? " " + cls : "");
}

async function onSave(symbol) {
  const s = state[symbol];
  const table = document.getElementById(`pair-${slug(symbol)}`).querySelector("tbody");
  const trs = [...table.querySelectorAll("tr")];
  const atr = computeATR14(s.merged);
  const sortedMerged = [...s.merged].sort((a, b) => (a.date < b.date ? -1 : 1));

  const changed = [];
  for (const tr of trs) {
    const idx = parseInt(tr.dataset.index, 10);
    const orig = s.rows[idx];
    const cur = readRow(tr);
    const anyMissing = FIELDS.some((f) => cur[f] == null);
    if (anyMissing) continue; // 未入力の行は無視(空欄のまま保存はしない)
    const isChanged = FIELDS.some((f) => cur[f] !== orig[f]);
    if (isChanged) changed.push(cur);
  }

  if (!changed.length) {
    setStatus(symbol, "変更がありません(未入力の行はスキップされます)");
    return;
  }

  const messages = [];
  let hasError = false;
  for (const c of changed) {
    const prevCandidates = sortedMerged.filter((b) => b.date < c.date);
    const prev = prevCandidates.length ? prevCandidates[prevCandidates.length - 1] : null;
    const bar = { date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, src: "shot" };
    const check = validateReconstructedBar(symbol, bar, prev, atr);
    if (check.errors.length) {
      hasError = true;
      messages.push(`${c.date}: ${check.errors.join(" / ")}`);
    } else if (check.warnings.length) {
      messages.push(`${c.date}: ⚠${check.warnings.join(" / ")}`);
    }
  }

  if (hasError) {
    setStatus(symbol, "エラーがあるため保存できません:\n" + messages.join("\n"), "error");
    return;
  }
  if (messages.length && !confirm("以下の点が気になります。このまま保存しますか?\n\n" + messages.join("\n"))) {
    return;
  }

  for (const c of changed) {
    const ok = appendShotBars({
      [symbol]: { date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, src: "shot" },
    });
    if (!ok) {
      setStatus(symbol, "履歴の保存に失敗しました(localStorageが一杯の可能性があります)", "error");
      return;
    }
  }
  // refreshPair() はカード全体のHTMLを作り直すため、先にメッセージを出しても
  // 再描画で消えてしまう。再描画してから表示する。
  await refreshPair(symbol);
  setStatus(symbol, `${changed.length}件を保存しました。`, "ok");
}

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
renderAll();
