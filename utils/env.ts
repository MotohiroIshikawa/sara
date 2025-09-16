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

export function envFloat(
  name: string,
  def: number,
  opts: { min?: number; max?: number } = {}
): number {
  const raw = process.env[name];
  const n = raw == null ? def : Number(raw);
  if (!Number.isFinite(n)) return def;
  const min = opts.min ?? Number.NEGATIVE_INFINITY;
  const max = opts.max ?? Number.POSITIVE_INFINITY;
  const v = Math.min(max, Math.max(min, n));
  return v;
}

export function envBool(name: string, def: boolean): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return def;
  return ["1", "true", "yes", "on"].includes(raw);
}

export function envStr(name: string, def: string): string {
  const v = process.env[name];
  return v == null || v === "" ? def : v;
}

/** LINE 関連 */
export const LINE = {
  REPLY_MAX: envInt("LINE_REPLY_MAX", 5, { min: 1, max: 5 }),
  PUSH_MAX: envInt("LINE_PUSH_MAX", 5, { min: 1, max: 5 }),
  TEXT_LIMIT: envInt("LINE_TEXT_LIMIT", 2000, { min: 200, max: 5000 }),
  MAX_URLS_PER_BLOCK: envInt("LINE_MAX_URLS_PER_BLOCK", 3, { min: 0, max: 10 }),
  MIN_SECTION_LENGTH: envInt("MIN_SECTION_LENGTH", 8, { min: 0, max: 20 }),
};

/** NEWS 関連 */
export const NEWS = {
  DEFAULT_DAYS: envInt("NEWS_DEFAULT_DAYS", 7, { min: 1, max: 30 }),
};

/** メイン run のポーリング/タイムアウト設定 */
export const MAIN = {
  CREATE_TIMEOUT_MS: envInt("MAIN_CREATE_TIMEOUT_MS", 4000, { min: 100 }),
  GET_TIMEOUT_MS: envInt("MAIN_GET_TIMEOUT_MS", 3000, { min: 200 }),
  POLL_SLEEP_MS: envInt("MAIN_POLL_SLEEP_MS", 500, { min: 50 }),
  POLL_TIMEOUT_MS: envInt("MAIN_POLL_TIMEOUT_MS", 60000, { min: 1000 }),
};

/** 修復 run の有効/無効やポーリング/タイムアウト設定 */
export const REPAIR = {
  ENABLED: envBool("REPAIR_RUN_ENABLED", true),
  MODE: envStr("REPAIR_RUN_MODE", "sync"), // "sync" | "async"
  CREATE_TIMEOUT_MS: envInt("REPAIR_CREATE_TIMEOUT_MS", 4000, { min: 100 }),
  GET_TIMEOUT_MS: envInt("REPAIR_GET_TIMEOUT_MS", 3000, { min: 200 }),
  POLL_SLEEP_MS: envInt("REPAIR_POLL_SLEEP_MS", 400, { min: 50 }),
  POLL_TIMEOUT_MS: envInt("REPAIR_POLL_TIMEOUT_MS", 30000, { min: 1000 }),
};

/** デバッグ系 */
export const DEBUG = {
  BING: envBool("DEBUG_BING", false),
};
