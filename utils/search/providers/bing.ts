// utils/bingSearch.ts
import axios, { AxiosError } from "axios";

export type BingFreshness = "Day" | "Week" | "Month";
export type BingSafeSearch = "Off" | "Moderate" | "Strict";

export type BingWebPage = {
  name: string;
  url: string;
  displayUrl?: string;
  snippet: string;
  dateLastCrawled?: string;
};

type BingWebSearchApiWebPages = {
  value: ReadonlyArray<{
    name: string;
    url: string;
    displayUrl?: string;
    snippet: string;
    dateLastCrawled?: string;
  }>;
};

type BingWebSearchApiResponse = {
  webPages?: BingWebSearchApiWebPages;
  queryContext?: unknown;
  _type?: string;
};

// オプション型（キーは省略可。未指定なら環境変数・既定値を利用）
export type BingWebSearchOptions = {
  subscriptionKey?: string;       // 未指定なら env を使用
  endpointBaseUrl?: string;       // 例: https://api.bing.microsoft.com （未指定なら既定）
  mkt?: string;                   // 例: "ja-JP"
  count?: number;                 // 取得件数（Bing 既定は 10）
  freshness?: BingFreshness;      // "Day" | "Week" | "Month"
  safeSearch?: BingSafeSearch;    // "Off" | "Moderate" | "Strict"
  timeoutMs?: number;             // 個別タイムアウト
  maxRetries?: number;            // リトライ回数（429/5xx/ネットワーク系で）
  baseDelayMs?: number;           // バックオフ基点
};

// 既定値
const DEFAULT_ENDPOINT_BASE = "https://api.bing.microsoft.com"; // REST のベース
const DEFAULT_PATH = "/v7.0/search";
const DEFAULT_MKT = "ja-JP";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 300;

// 環境変数からキー/エンドポイントを取得（env.ts へは“次のステップ”で寄せてもOK）
function resolveSubscriptionKey(explicit?: string): string {
  const k: string | undefined = explicit ?? process.env.BING_V7_SUBSCRIPTION_KEY;
  if (!k || !k.trim()) {
    throw new Error("BING_V7_SUBSCRIPTION_KEY is not set (and subscriptionKey option not provided).");
  }
  return k.trim();
}

function resolveEndpointBase(explicit?: string): string {
  const b: string = (explicit ?? process.env.BING_V7_ENDPOINT ?? DEFAULT_ENDPOINT_BASE).trim();
  return b.replace(/\/+$/, ""); // 末尾スラッシュ除去
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

function shouldRetry(e: unknown): boolean {
  const err = e as AxiosError;
  const status: number | undefined = err.response?.status;
  if (status === 429) return true;
  if (status && status >= 500) return true;
  if (!status) {
    // ネットワーク系（ECONNRESET, ETIMEDOUT など）
    return true;
  }
  return false;
}

// エラーメッセージ整形
function formatAxiosError(e: unknown): string {
  const err = e as AxiosError;
  const status = err.response?.status;
  const data = err.response?.data;
  const code = (err as { code?: string }).code;
  return `status=${status ?? "n/a"} code=${code ?? "n/a"} message=${err.message} data=${JSON.stringify(data ?? {})}`;
}

// main：Web 検索（スニペットだけでなく主要フィールドを返す）
export async function bingWebSearch(
  query: string,
  options: BingWebSearchOptions = {}
): Promise<BingWebPage[]> {
  const subscriptionKey: string = resolveSubscriptionKey(options.subscriptionKey);
  const baseUrl: string = resolveEndpointBase(options.endpointBaseUrl);

  const timeoutMs: number = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries: number = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
  const baseDelayMs: number = Math.max(0, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);

  // パラメータ整備
  const params: Record<string, string | number> = {
    q: query,
    mkt: options.mkt ?? DEFAULT_MKT,
  };
  if (typeof options.count === "number") params.count = options.count;
  if (options.freshness) params.freshness = options.freshness;
  if (options.safeSearch) params.safeSearch = options.safeSearch;

  let attempt = 0;
  // リトライ付き実行ループ（429/5xx/ネットワーク系でバックオフ）
  while (true) {
    try {
      const url = `${baseUrl}${DEFAULT_PATH}`;
      const res = await axios.get<BingWebSearchApiResponse>(url, {
        params,
        headers: { "Ocp-Apim-Subscription-Key": subscriptionKey },
        timeout: timeoutMs,
        // 2xx / 4xx（除く429）を許可、429/5xx は例外で拾う
        validateStatus: (s: number) => (s >= 200 && s < 400) || s === 404,
      });

      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }

      const list = res.data?.webPages?.value ?? [];
      const pages: BingWebPage[] = list.map((p) => ({
        name: p.name,
        url: p.url,
        displayUrl: p.displayUrl,
        snippet: p.snippet,
        dateLastCrawled: p.dateLastCrawled,
      }));

      return pages;
    } catch (e) {
      attempt += 1;
      if (!shouldRetry(e) || attempt > maxRetries) {
        // 打ち切り
        const msg = formatAxiosError(e);
        throw new Error(`[bingWebSearch] failed after ${attempt} attempt(s): ${msg}`);
      }
      const jitter = Math.floor(Math.random() * 150);
      const backoff = baseDelayMs * Math.pow(2, attempt - 1) + jitter;
      await sleep(backoff);
    }
  }
}
