export function envInt(
  name: string,
  def: number,
  opts: { min?: number; max?: number } = {}
): number {
  const raw = process.env[name];
  const n = raw == null ? def : Number(raw);
  if (!Number.isFinite(n)) return def;
  const min = opts.min ?? Number.NEGATIVE_INFINITY;
  const max = opts.max ?? Number.POSITIVE_INFINITY;
  return Math.floor(Math.min(max, Math.max(min, n)));
}

export function envBool(name: string, def: boolean): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return def;
  return ["1", "true", "yes", "on"].includes(raw);
}

function envStr(name: string, def: string): string {
  const v = process.env[name];
  return v == null || v === "" ? def : v;
}

function envReqStr(name: string): string {
  const v = process.env[name];
  if (v == null || v === "") throw new Error(`ENV ${name} is required`);
  return v;
}

export function envCsv(name: string, defCsv: string): string[] {
  const raw: string = process.env[name] ?? defCsv;
  // カンマ（, ／ 全角，）、改行、全角読点（、）を区切りとして分割
  const parts: string[] = raw.split(/[,\n，、]+/);
  const out: string[] = [];
  const seen: Set<string> = new Set();
  for (const p of parts) {
    const v: string = p.trim();
    if (v.length === 0) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** REDIS 接続設定（ioredis想定） */
export const REDIS = {
  HOST: envReqStr("REDIS_HOSTNAME"),
  PORT: envInt("REDIS_PORT", 6380, { min: 1, max: 65535 }),
  USERNAME: envStr("REDIS_USERNAME", "default"),
  // パスワードは REDIS_PASSWORD 優先、無ければ REDIS_KEY
  PASSWORD: process.env.REDIS_PASSWORD ?? envReqStr("REDIS_KEY"),
  TLS: envBool("REDIS_TLS", true),
  TLS_SERVERNAME: envStr("REDIS_TLS_SERVERNAME", process.env.REDIS_HOSTNAME ?? ""),
};

/** AZURE / AGENTS 関連 */
export const AZURE = {
  AI_PRJ_ENDPOINT: envStr("AZURE_AI_PRJ_ENDPOINT", ""),
  BING_CONNECTION_ID: envStr("AZURE_BING_CONNECTION_ID", ""),
  AI_MODEL_DEPLOYMENT: envStr("AZURE_AI_MODEL_DEPLOYMENT", ""),
  API_TIMEOUT_MS: envInt("API_TIMEOUT_MS", 20_000, { min: 1_000 }),
  AGENT_NAME_PREFIX: envStr("AZURE_AI_PRJ_AGENT_NAME", "lineai-bing-agent"),
  // imageアップロード関係
  BLOB_CONNECTION_STRING: envStr("AZURE_BLOB_CONNECTION_STRING", ""),
  BLOB_CONTAINER: envStr("AZURE_BLOB_CONTAINER", "images"),
  BLOB_SAS_TTL_SEC: envInt("AZURE_BLOB_SAS_TTL_SEC", 600, {min: 60, max: 7 * 24 * 60 * 60,}),
  BLOB_UPLOAD_PREFIX: envStr("AZURE_BLOB_UPLOAD_PREFIX", "line-images"),
};

/** Thread TTL */
export const THREAD = {
  TTL_HOURS: envInt("THREAD_TTL", 168, { min: 1, max: 24 * 30 }),
};

/** LINE 関連 */
export const LINE = {
  REPLY_MAX: envInt("LINE_REPLY_MAX", 5, { min: 1, max: 5 }),
  PUSH_MAX: envInt("LINE_PUSH_MAX", 5, { min: 1, max: 5 }),
  TEXT_LIMIT: envInt("LINE_TEXT_LIMIT", 2000, { min: 200, max: 5000 }),
  MAX_URLS_PER_BLOCK: envInt("LINE_MAX_URLS_PER_BLOCK", 3, { min: 0, max: 10 }),
  MIN_SECTION_LENGTH: envInt("MIN_SECTION_LENGTH", 8, { min: 0, max: 20 }),
};

// 画像処理の通知しきい値（秒）
export const IMAGE = {
  PROCESSING_NOTIFY_THRESHOLD_SEC: envInt(
    "IMAGE_PROCESSING_NOTIFY_THRESHOLD_SEC",
    60,
    { min: 5, max: 600 }
  ),
};

/** NEWS 関連 */
export const NEWS = {
  DEFAULT_DAYS: envInt("NEWS_DEFAULT_DAYS", 7, { min: 1, max: 30 }),
};

/** メイン run のポーリング/タイムアウト設定 */
export const MAIN_TIMERS = {
  CREATE_TIMEOUT: envInt("MAIN_CREATE_TIMEOUT_MS", 4000, { min: 100 }),
  GET_TIMEOUT:    envInt("MAIN_GET_TIMEOUT_MS",    3000, { min: 200 }),
  POLL_SLEEP:     envInt("MAIN_POLL_SLEEP_MS",      500, { min: 50  }),
  POLL_TIMEOUT:   envInt("MAIN_POLL_TIMEOUT_MS",  60000, { min: 1000 }),
};

/** デバッグ系 */
export const DEBUG = {
  AI: envBool("DEBUG_AI", false),
};

export const WAKE = {
  REPLY_MODE_TTL_SEC: envInt("WAKE_REPLY_MODE_TTL_SEC", 120),
  ALIASES: envCsv("WAKE_ALIASES", "さら,サラ,sara,Sara"),
};