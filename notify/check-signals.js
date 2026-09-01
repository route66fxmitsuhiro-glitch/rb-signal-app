"use strict";
/*
 * RBシグナル 通知バッチ(GitHub Actionsから1日複数回起動)
 *
 * rb_signal_app(ブラウザPWA)と全く同じ判定ロジック(signal-core.js)を
 * 再利用し、3ペア(GBPJPY/GBPUSD/USDJPY)の日足・週足シグナルを判定して、
 * 新規シグナルがある日だけWeb Push通知を送る。
 *
 * このスクリプトは「発注する」わけではなく、あくまで「シグナルが出た
 * ことをユーザーに知らせる」だけ。実際の発注はユーザーがGMOクリック
 * 証券のアプリで手動で行う。
 *
 * 【日足境界とサマータイム】FXの新しい取引日はニューヨーク時間17:00に始まる
 * (サマータイムでUTC 21:00 / 冬時間でUTC 22:00 = JST 6:00 / 7:00頃)。
 * 本来この15分前に1回だけ通知したいが、GitHub Actionsのscheduled実行は
 * 混雑時に数時間遅延する(実測で3時間遅延を確認)。そこで:
 *   1. ワークフロー側は UTC 20:30〜01:00 の間に30分おきで何度も起動する。
 *   2. このスクリプトは「直近に過ぎた NY 17:00 境界」を基準に、その
 *      30分前〜8時間後の間に走っていれば「対象ウィンドウ内」とみなす
 *      (遅延に強い。America/New_York のタイムゾーン変換でDSTも自動対応)。
 *   3. その取引日(境界)を一意キーにして notify/last-run.json に
 *      「処理済み」を記録・コミットする。複数回起動しても通知は1回だけ。
 * 金曜・土曜の NY 17:00 境界(直後にセッションが無い)はスキップする。
 *
 * 必要な環境変数(GitHub Actions Secretsから注入):
 *   TWELVE_DATA_API_KEY … Twelve Dataの無料APIキー
 *   VAPID_PUBLIC_KEY     … Web Push用VAPID公開鍵(raw base64url)
 *   VAPID_PRIVATE_KEY    … Web Push用VAPID秘密鍵(raw base64url)
 *   VAPID_SUBJECT        … 任意、mailto:形式の連絡先(省略時は既定値)
 *   PUSH_SUBSCRIPTION    … アプリの「通知を有効にする」で取得したJSON
 */
const WINDOW_BEFORE_MIN = 30;      // 境界の何分前から対象とみなすか
const WINDOW_AFTER_MIN = 8 * 60;   // 境界の何分後まで対象とみなすか(GitHub遅延吸収)

const fs = require("fs");
const path = require("path");
const webpush = require("web-push");
const SignalCore = require(path.join(__dirname, "..", "signal-core.js"));

const {
  PAIRS,
  fetchDailyBars,
  computeATR14,
  computeDailySignal,
  lastCompleteBarIsMonday,
  aggregateWeekly,
  officialWeeks,
  computeWeeklySignal,
} = SignalCore;

function fmtPrice(v, symbol) {
  if (v == null || Number.isNaN(v)) return "—";
  const isJpy = symbol.endsWith("JPY") || symbol.endsWith("/JPY");
  return v.toFixed(isJpy ? 3 : 5);
}

const dirLabel = (d) => (d === "long" ? "ロング" : "ショート");

const MARKER_PATH = path.join(__dirname, "last-run.json");

// 指定した「UTC暦日」の NY 17:00 を UTCのDateとして返す(EDT/ESTを両方試して
// Intlで実際にAmerica/New_Yorkの17時に一致する方を採用、DST境界でもズレない)。
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

// now(またはWINDOW_BEFORE_MIN分先)以前で直近の NY 17:00 境界を返す。
function mostRecentNyBoundary(now) {
  const horizon = new Date(now.getTime() + WINDOW_BEFORE_MIN * 60000);
  for (let back = 0; back <= 2; back++) {
    const probe = new Date(Date.UTC(horizon.getUTCFullYear(), horizon.getUTCMonth(), horizon.getUTCDate() - back));
    const b = nyFivePmUtcForUtcDate(probe.getUTCFullYear(), probe.getUTCMonth(), probe.getUTCDate());
    if (b && b.getTime() <= horizon.getTime()) return b;
  }
  return null;
}

// 対象ウィンドウ判定 + その取引日の一意キー。
// { inWindow, boundary, key, tradingDay, reason } を返す。
function evaluateWindow(now) {
  const boundary = mostRecentNyBoundary(now);
  if (!boundary) return { inWindow: false, reason: "NY境界の算出に失敗" };
  const from = boundary.getTime() - WINDOW_BEFORE_MIN * 60000;
  const to = boundary.getTime() + WINDOW_AFTER_MIN * 60000;
  const inWindow = now.getTime() >= from && now.getTime() <= to;
  const key = boundary.toISOString().slice(0, 10); // 境界のUTC日付を一意キーに
  // 境界のNY曜日。Sun/Mon/Tue/Wed/Thu の17:00 = 直後に実セッションあり。Fri/Sat はスキップ。
  const nyWd = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(boundary);
  const tradingDay = ["Sun", "Mon", "Tue", "Wed", "Thu"].includes(nyWd);
  const offsetMin = (now.getTime() - boundary.getTime()) / 60000;
  const reason = `now=${now.toISOString()} 直近境界=${boundary.toISOString()}(NY ${nyWd}) 境界からの経過=${offsetMin.toFixed(0)}分 inWindow=${inWindow} tradingDay=${tradingDay}`;
  return { inWindow, boundary, key, tradingDay, reason };
}

function readMarker() {
  try { return JSON.parse(fs.readFileSync(MARKER_PATH, "utf8")); } catch { return {}; }
}
function writeMarker(obj) {
  fs.writeFileSync(MARKER_PATH, JSON.stringify(obj, null, 2) + "\n");
}

async function checkPair(pair, apiKey) {
  const bars = await fetchDailyBars(pair.symbol, apiKey);
  const atr14 = computeATR14(bars);
  const dailySignal = computeDailySignal(bars);

  const allWeeklyBars = aggregateWeekly(bars);
  const weeklyBars = officialWeeks(allWeeklyBars);
  const weeklySignal = computeWeeklySignal(weeklyBars, bars.length ? bars[bars.length - 1] : null);
  // 週足シグナルは「本日が新規判定日(直前の完成日足バーが月曜)」の時だけ
  // 通知対象にする。そうしないと、同じ週足シグナルが確定してから次の
  // 月曜の足が閉じるまで(最大1週間)毎回同じ内容を通知し続けてしまう。
  const weeklyIsNewToday = lastCompleteBarIsMonday(bars);

  const lines = [];
  if (dailySignal && dailySignal.direction) {
    lines.push(
      `${pair.label} 日足${dirLabel(dailySignal.direction)}` +
        (dailySignal.outside ? "(アウトサイド)" : "") +
        ` [前日高${fmtPrice(dailySignal.prevBar.high, pair.symbol)}/安${fmtPrice(dailySignal.prevBar.low, pair.symbol)} ATR14=${fmtPrice(atr14, pair.symbol)}]`
    );
  }
  // entryGuard.vetoed(直近日足の終値が撤退ラインの向こう側 = EAの r>0 ガードで
  // 新規建てが見送られる見込み)の時は通知しない。
  const weeklyVetoed = weeklySignal && weeklySignal.entryGuard && weeklySignal.entryGuard.vetoed;
  if (weeklyIsNewToday && weeklySignal && weeklySignal.direction && !weeklyVetoed) {
    lines.push(
      `${pair.label} 週足${dirLabel(weeklySignal.direction)}` +
        (weeklySignal.outside ? "(アウトサイド週)" : "") +
        (weeklySignal.entryGuard ? "(撤退ライン一時越え・要注意)" : "") +
        ` [前週高${fmtPrice(weeklySignal.prevWeek.high, pair.symbol)}/安${fmtPrice(weeklySignal.prevWeek.low, pair.symbol)}]`
    );
  } else if (weeklyIsNewToday && weeklyVetoed) {
    console.log(
      `${pair.label} 週足${dirLabel(weeklySignal.direction)}シグナルは entryGuard で通知抑制(` +
        `直近日足${weeklySignal.entryGuard.barDate}の終値が前週` +
        `${weeklySignal.entryGuard.direction === "long" ? "安値" : "高値"}を越え、EAは新規建て見送り見込み)`
    );
  }
  return lines;
}

async function main() {
  // 手動実行(workflow_dispatch)で skip_time_check=true なら、ウィンドウ判定と
  // 処理済みフラグを無視して即座に判定・送信を試す(動作確認用、フラグ更新もしない)。
  const skip = process.env.SKIP_TIME_CHECK === "true";
  const win = evaluateWindow(new Date());
  console.log(win.reason);
  const markerKey = win.key;

  if (!skip) {
    if (!win.inWindow) {
      console.log("対象ウィンドウ外(直近NY境界の-30分〜+8時間の外)。何もせず終了します。");
      return;
    }
    if (!win.tradingDay) {
      console.log("金曜/土曜のNY 17:00境界(直後に実セッション無し)。スキップします。");
      return;
    }
    const marker = readMarker();
    if (marker.key === markerKey && marker.done) {
      console.log(`このトレード日(${markerKey})は処理済み(${marker.at})。スキップします。`);
      return;
    }
  } else {
    console.log("SKIP_TIME_CHECK=true: ウィンドウ判定・処理済みフラグを無視(フラグ更新もしません)。");
  }

  const apiKey = process.env.TWELVE_DATA_API_KEY;
  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT || "mailto:rbsignal@example.com";
  const subscriptionJson = process.env.PUSH_SUBSCRIPTION;

  if (!apiKey) throw new Error("環境変数 TWELVE_DATA_API_KEY が設定されていません");
  if (!vapidPublic || !vapidPrivate) throw new Error("VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY が設定されていません");
  if (!subscriptionJson) {
    console.log("PUSH_SUBSCRIPTION が未設定です(アプリで「通知を有効にする」を実行し、GitHub Secretsに登録してください)。終了します。");
    return;
  }

  const allLines = [];
  let anyOk = false;
  for (const pair of PAIRS) {
    try {
      const lines = await checkPair(pair, apiKey);
      anyOk = true;
      allLines.push(...lines);
    } catch (e) {
      // 1ペアの取得失敗で全体を止めず、エラー内容だけ記録して残りを続行する。
      console.error(`${pair.label} の判定でエラー: ${e.message}`);
    }
  }

  let sent = false;
  if (allLines.length === 0) {
    console.log("新規シグナルなし(通知は送信しません)");
  } else {
    webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
    const subscription = JSON.parse(subscriptionJson);
    const payload = JSON.stringify({
      title: "📈 RBシグナル",
      body: allLines.join(" / ") + "\n※自動発注はしません。手動で発注してください。",
    });
    await webpush.sendNotification(subscription, payload);
    sent = true;
    console.log("通知を送信しました:\n" + allLines.join("\n"));
  }

  // 処理済みフラグを更新(このトレード日は以後の起動でスキップされる)。
  // 全ペアの取得に失敗した場合は更新せず、次の起動で再試行させる。
  if (!skip) {
    if (anyOk) {
      writeMarker({ key: markerKey, done: true, at: new Date().toISOString(), sent, lines: allLines });
      console.log(`処理済みフラグを更新: key=${markerKey} sent=${sent}`);
    } else {
      console.log("全ペアの取得に失敗。処理済みフラグは更新しません(次回の起動で再試行)。");
    }
  }
}

main().catch((e) => {
  console.error("通知バッチでエラーが発生しました:", e);
  process.exit(1);
});
