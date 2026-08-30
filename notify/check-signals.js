"use strict";
/*
 * RBシグナル 通知バッチ(GitHub Actionsから1日2回起動)
 *
 * rb_signal_app(ブラウザPWA)と全く同じ判定ロジック(signal-core.js)を
 * 再利用し、3ペア(GBPJPY/GBPUSD/USDJPY)の日足・週足シグナルを判定して、
 * 新規シグナルがある日だけWeb Push通知を送る。
 *
 * このスクリプトは「発注する」わけではなく、あくまで「シグナルが出た
 * ことをユーザーに知らせる」だけ。実際の発注はユーザーがGMOクリック
 * 証券のアプリで手動で行う。
 *
 * 【日足境界とサマータイム】FXの新しい取引日はニューヨーク時間17:00に
 * 始まる。これはサマータイム(3月〜11月、America/New_YorkがUTC-4)で
 * JST 6:00頃、冬時間(UTC-5)でJST 7:00頃にずれる。この境界の15分前に
 * 通知したいが、GitHub Actionsのcronはサマータイムに連動しないため、
 * ワークフロー側は「夏時間用」「冬時間用」の2つの固定UTC時刻で1日2回
 * このスクリプトを起動し、このスクリプト自身が「今日、実際に対象時刻
 * かどうか」をAmerica/New_Yorkのタイムゾーン変換で判定してから処理する
 * (該当しない方の起動は数秒で終了するだけで実害はない)。
 *
 * 必要な環境変数(GitHub Actions Secretsから注入):
 *   TWELVE_DATA_API_KEY … Twelve Dataの無料APIキー
 *   VAPID_PUBLIC_KEY     … Web Push用VAPID公開鍵(raw base64url)
 *   VAPID_PRIVATE_KEY    … Web Push用VAPID秘密鍵(raw base64url)
 *   VAPID_SUBJECT        … 任意、mailto:形式の連絡先(省略時は既定値)
 *   PUSH_SUBSCRIPTION    … アプリの「通知を有効にする」で取得したJSON
 *
 * 対象時刻の許容誤差(分)。GitHub Actionsのcronは負荷次第で数分遅延する
 * ことがあるため、余裕を持たせる。60分離れたもう一方の起動時刻とは
 * 重ならない範囲。
 */
const TOLERANCE_MINUTES = 20;

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

// 「今日のNY時間17:00」をUTCのDateとして返す(サマータイム自動対応)。
// EDT(UTC-4)とEST(UTC-5)の両方を候補として作り、Intlで実際にAmerica/New_York
// の17時に一致する方を選ぶ(DST切り替え境界日でもズレない)。
function nyFivePmTodayUTC(nowUtc) {
  const y = nowUtc.getUTCFullYear();
  const m = nowUtc.getUTCMonth();
  const d = nowUtc.getUTCDate();
  for (const offsetHours of [4, 5]) {
    const candidate = new Date(Date.UTC(y, m, d, 17 + offsetHours, 0, 0));
    const nyHourStr = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      hour12: false,
    }).format(candidate);
    const nyDayStr = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(candidate);
    const todayUtcStr = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (parseInt(nyHourStr, 10) % 24 === 17 && nyDayStr === todayUtcStr) {
      return candidate;
    }
  }
  throw new Error("NY 17:00のUTC変換に失敗しました");
}

function isNowTargetTime() {
  const now = new Date();
  const boundary = nyFivePmTodayUTC(now);
  const target = new Date(boundary.getTime() - 15 * 60 * 1000);
  const diffMin = Math.abs(now.getTime() - target.getTime()) / 60000;
  console.log(
    `現在時刻(UTC)=${now.toISOString()}  今日の対象時刻(UTC)=${target.toISOString()}  差=${diffMin.toFixed(1)}分`
  );
  return diffMin <= TOLERANCE_MINUTES;
}

async function checkPair(pair, apiKey) {
  const bars = await fetchDailyBars(pair.symbol, apiKey);
  const atr14 = computeATR14(bars);
  const dailySignal = computeDailySignal(bars);

  const allWeeklyBars = aggregateWeekly(bars);
  const weeklyBars = officialWeeks(allWeeklyBars);
  const weeklySignal = computeWeeklySignal(weeklyBars);
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
  if (weeklyIsNewToday && weeklySignal && weeklySignal.direction) {
    lines.push(
      `${pair.label} 週足${dirLabel(weeklySignal.direction)}` +
        (weeklySignal.outside ? "(アウトサイド週)" : "") +
        ` [前週高${fmtPrice(weeklySignal.prevWeek.high, pair.symbol)}/安${fmtPrice(weeklySignal.prevWeek.low, pair.symbol)}]`
    );
  }
  return lines;
}

async function main() {
  // 手動実行(workflow_dispatch)時にskip_time_check入力がtrueなら時刻判定を
  // 飛ばせる(動作確認用)。スケジュール実行では常にfalseのため通常の挙動は変わらない。
  if (process.env.SKIP_TIME_CHECK === "true") {
    console.log("SKIP_TIME_CHECK=true のため時刻判定をスキップします(テスト実行)。");
  } else if (!isNowTargetTime()) {
    console.log("本日の対象時刻(日足境界15分前)ではありません。何もせず終了します。");
    return;
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
  for (const pair of PAIRS) {
    try {
      const lines = await checkPair(pair, apiKey);
      allLines.push(...lines);
    } catch (e) {
      // 1ペアの取得失敗で全体を止めず、エラー内容だけ記録して残りを続行する。
      console.error(`${pair.label} の判定でエラー: ${e.message}`);
    }
  }

  if (allLines.length === 0) {
    console.log("本日は新規シグナルなし(通知は送信しません)");
    return;
  }

  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
  const subscription = JSON.parse(subscriptionJson);
  const payload = JSON.stringify({
    title: "📈 RBシグナル",
    body: allLines.join(" / ") + "\n※自動発注はしません。手動で発注してください。",
  });

  await webpush.sendNotification(subscription, payload);
  console.log("通知を送信しました:\n" + allLines.join("\n"));
}

main().catch((e) => {
  console.error("通知バッチでエラーが発生しました:", e);
  process.exit(1);
});
