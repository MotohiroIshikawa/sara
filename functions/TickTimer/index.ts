import { app, type InvocationContext, type Timer } from "@azure/functions";
import { randomUUID } from "crypto";

type HttpResponse = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
};

// 環境変数（App Settings）
//   - SCHED_TICK_URL: 叩く内部APIのURL（例 https://<your-domain>/api/jobs/scheduler/tick）
//   - INTERNAL_JOB_TOKEN: API側と一致させる内部トークン
//   - SCHED_MAX_RETRY（任意）: 失敗時の再試行回数（既定 3）
//   - SCHED_BACKOFF_MS（任意）: 初回バックオフms（指数で増加、既定 2000）
const SCHED_TICK_URL = process.env.SCHED_TICK_URL ?? "";
const INTERNAL_JOB_TOKEN = process.env.INTERNAL_JOB_TOKEN ?? "";
const SCHED_MAX_RETRY = Number(process.env.SCHED_MAX_RETRY ?? "3");
const SCHED_BACKOFF_MS = Number(process.env.SCHED_BACKOFF_MS ?? "2000");

// fetch は Node18 以降はグローバルで利用可（polyfill不要）
async function postTick(
  rid: string, 
  firedAt: string, 
  attempt: number
): Promise<HttpResponse> {
  const res = await fetch(SCHED_TICK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": INTERNAL_JOB_TOKEN,
      "x-tick-rid": rid, // ログ相関用に渡す（API側が拾えば便利）
    },
    body: JSON.stringify({
      rid,
      firedAt,
      source: "azure-functions-timer", // 呼び出し元識別
      attempt, // 再試行カウント
    }),
  });
   return res as unknown as HttpResponse;
}

async function handler(myTimer: Timer, context: InvocationContext): Promise<void> {
  const rid = randomUUID().slice(0, 8);
  const firedAt = new Date().toISOString();

  // 前提チェック
  if (!SCHED_TICK_URL || !INTERNAL_JOB_TOKEN) {
    context.error(`[tick:${rid}] missing env. SCHED_TICK_URL or INTERNAL_JOB_TOKEN not set`);
    return;
  }

  context.log(`[tick:${rid}] start -> ${SCHED_TICK_URL}`);

  let lastErr: unknown = null;

  // シンプルな指数バックオフ付きリトライ
  for (let attempt = 1; attempt <= Math.max(1, SCHED_MAX_RETRY); attempt++) {
    try {
      const res = await postTick(rid, firedAt, attempt);
      const text = await res.text(); // API側の簡易応答をログに残す

      if (res.ok) {
        context.log(`[tick:${rid}] ok (attempt=${attempt}) status=${res.status} body=${truncate(text, 300)}`);
        return;
      } else {
        context.warn(`[tick:${rid}] non-2xx (attempt=${attempt}) status=${res.status} body=${truncate(text, 300)}`);
        lastErr = new Error(`HTTP ${res.status}`);
      }
    } catch (e) {
      lastErr = e;
      context.warn(`[tick:${rid}] fetch error (attempt=${attempt}) err=${asMsg(e)}`);
    }

    // 次の試行まで待機（指数バックオフ）
    if (attempt < SCHED_MAX_RETRY) {
      const ms = backoffMs(attempt, SCHED_BACKOFF_MS);
      context.log(`[tick:${rid}] backoff ${ms}ms then retry (next attempt=${attempt + 1})`);
      await delay(ms);
    }
  }

  // すべて失敗
  context.error(`[tick:${rid}] failed after ${SCHED_MAX_RETRY} attempts: ${asMsg(lastErr)}`);
}

/**
 * タイマー バインド（cronはここで宣言。function.jsonは不要）
 * v4新モデル：function.json 不要
 */
app.timer("TickTimer", {      // 旧モデルの default export → app.timer へ変更
  schedule: "0 */5 * * * *",  // 毎5分（秒 分 時 日 月 曜）
  runOnStartup: false,
  useMonitor: true,
  handler,                    // ハンドラを直接渡す
});

// ユーティリティ
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function backoffMs(attempt: number, base: number): number {
  // 例: 2000, 4000, 8000...
  const capped = Math.max(0, Math.min(7, attempt - 1));
  return base * Math.pow(2, capped);
}
function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}
function asMsg(e: unknown): string {
  return (e as Error)?.message ?? String(e);
}