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

type BingWebSearchApiWebPageItem = {
  name: string;
  url: string;
  displayUrl?: string;
  snippet: string;
  dateLastCrawled?: string;
};

type BingWebSearchApiNewsItem = {
  name: string;
  url: string;
  description?: string;
  datePublished?: string;
};

type BingWebSearchApiWebPages = {
  value: ReadonlyArray<BingWebSearchApiWebPageItem>;
};

type BingWebSearchApiNews = {
  value: ReadonlyArray<BingWebSearchApiNewsItem>;
};

type BingWebSearchApiResponse = {
  webPages?: BingWebSearchApiWebPages;
  news?: BingWebSearchApiNews;
  queryContext?: unknown;
  _type?: string;
};

// 型ガード（webPages / news 判別用）
function isWebPage(
  p: BingWebSearchApiWebPageItem | BingWebSearchApiNewsItem
): p is BingWebSearchApiWebPageItem {
  return "snippet" in p;
}

// オプション型
export type BingWebSearchOptions = {
  subscriptionKey?: string;
  endpointBaseUrl?: string;
  mkt?: string;
  count?: number;
  freshness?: BingFreshness;
  safeSearch?: BingSafeSearch;
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
};

// 既定値
const DEFAULT_ENDPOINT_BASE = "https://api.bing.microsoft.com";
const DEFAULT_PATH = "/v7.0/search";
const DEFAULT_MKT = "ja-JP";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 300;

function resolveSubscriptionKey(explicit?: string): string {
  const k: string | undefined = explicit ?? process.env.BING_V7_SUBSCRIPTION_KEY;
  if (!k || !k.trim()) {
    throw new Error("BING_V7_SUBSCRIPTION_KEY is not set.");
  }
  return k.trim();
}

function resolveEndpointBase(explicit?: string): string {
  const b: string = (explicit ?? process.env.BING_V7_ENDPOINT ?? DEFAULT_ENDPOINT_BASE).trim();
  return b.replace(/\/+$/, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

function shouldRetry(e: unknown): boolean {
  const err = e as AxiosError;
  const status: number | undefined = err.response?.status;
  if (status === 429) return true;
  if (status && status >= 500) return true;
  if (!status) return true; // network error
  return false;
}

function formatAxiosError(e: unknown): string {
  const err = e as AxiosError;
  const status = err.response?.status;
  const data = err.response?.data;
  const code = (err as { code?: string }).code;
  return `status=${status ?? "n/a"} code=${code ?? "n/a"} message=${err.message} data=${JSON.stringify(data ?? {})}`;
}

// main
export async function bingWebSearch(
  query: string,
  options: BingWebSearchOptions = {}
): Promise<BingWebPage[]> {
  const subscriptionKey: string = resolveSubscriptionKey(options.subscriptionKey);
  const baseUrl: string = resolveEndpointBase(options.endpointBaseUrl);

  const timeoutMs: number = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries: number = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
  const baseDelayMs: number = Math.max(0, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);

  const params: Record<string, string | number> = {
    q: query,
    mkt: options.mkt ?? DEFAULT_MKT,
  };
  if (typeof options.count === "number") params.count = options.count;
  if (options.freshness) params.freshness = options.freshness;
  if (options.safeSearch) params.safeSearch = options.safeSearch;

  let attempt = 0;

  while (true) {
    try {
      const url = `${baseUrl}${DEFAULT_PATH}`;
      const res = await axios.get<BingWebSearchApiResponse>(url, {
        params,
        headers: { "Ocp-Apim-Subscription-Key": subscriptionKey },
        timeout: timeoutMs,
        validateStatus: (s: number) => (s >= 200 && s < 400) || s === 404,
      });

      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }

      // webPages → news フォールバック
      const list: ReadonlyArray<BingWebSearchApiWebPageItem | BingWebSearchApiNewsItem> =
        res.data?.webPages?.value ??
        res.data?.news?.value ??
        [];

      if (process.env.DEBUG_BING === "true") {
        console.info("[bing.raw] keys=", Object.keys(res.data ?? {}));
        console.info("[bing.raw] webPages.count=", res.data?.webPages?.value.length ?? 0);
        console.info("[bing.raw] news.count=", res.data?.news?.value.length ?? 0);
        console.info("[bing.raw] data=", JSON.stringify(res.data, null, 2));
      }

      const pages: BingWebPage[] = list.map((p) => {
        if (isWebPage(p)) {
          return {
            name: p.name,
            url: p.url,
            displayUrl: p.displayUrl,
            snippet: p.snippet,
            dateLastCrawled: p.dateLastCrawled,
          };
        }
        return {
          name: p.name,
          url: p.url,
          snippet: p.description ?? "",
        };
      });

      return pages;
    } catch (e) {
      attempt += 1;
      if (!shouldRetry(e) || attempt > maxRetries) {
        const msg = formatAxiosError(e);
        throw new Error(`[bingWebSearch] failed after ${attempt} attempt(s): ${msg}`);
      }
      const jitter = Math.floor(Math.random() * 150);
      const backoff = baseDelayMs * Math.pow(2, attempt - 1) + jitter;
      await sleep(backoff);
    }
  }
}
