// app/api/gpts/search/route.ts
import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { searchPublicGptsWithAuthor, type PublicGptsSort } from "@/services/gpts.mongo";
import { requireLineUser, HttpError } from "@/utils/line/lineAuth";
import { envInt } from "@/utils/env";

// ページング既定値と上限
const ENV_DEFAULT_LIMIT: number = envInt("SEARCH_PAGE_LIMIT", 20, { min: 1, max: 1000 });
const ENV_MAX_LIMIT_RAW: number = envInt("SEARCH_PAGE_LIMIT_MAX", 50, { min: 1, max: 1000 });
const PAGE_MAX_LIMIT: number = Math.max(ENV_MAX_LIMIT_RAW, ENV_DEFAULT_LIMIT);

type Query = {
  q?: string;
  sort: PublicGptsSort;   // "latest" | "popular"
  limit: number;          // 1..50
  offset: number;         // >= 0
};

type PublicSearchItem = {
  id: string;
  name: string;
  updatedAt: string;      // ISO8601
  isPublic: boolean;
  usageCount: number;
  authorName: string;
  isPopular: boolean;
  isNew: boolean;
};

type PublicSearchResponse = {
  items: PublicSearchItem[];
  hasMore: boolean;
};

function parseQuery(url: string): Query {
  const sp: URLSearchParams = new URL(url).searchParams;

  const qRaw: string | null = sp.get("q");
  const q: string | undefined = qRaw !== null && qRaw.trim().length > 0 ? qRaw.trim() : undefined;

  const sortRaw: string = sp.get("sort") ?? "latest";
  const sort: PublicGptsSort = (sortRaw === "popular") ? "popular" : "latest";

  const limitRaw: string | null = sp.get("limit");
  const limitParsed: number = limitRaw !== null ? Number(limitRaw) : ENV_DEFAULT_LIMIT;
  const limitInt: number = Number.isFinite(limitParsed) ? Math.trunc(limitParsed) : ENV_DEFAULT_LIMIT;
  const limit: number = Math.min(Math.max(limitInt, 1), PAGE_MAX_LIMIT);

  const offsetNum: number = Number(sp.get("offset") ?? "0");
  const offsetClamped: number = Number.isFinite(offsetNum) ? Math.trunc(offsetNum) : 0;
  const offset: number = Math.max(offsetClamped, 0);

  return { q, sort, limit, offset };
}

export async function GET(request: Request) {
  const rid: string = randomUUID().slice(0, 8);
  try {
    // 認証は既存APIの流儀に合わせて必須
    const userId: string = await requireLineUser(request);
    console.info(`[gpts.search:${rid}] auth sub=${userId.slice(0,4)}…${userId.slice(-4)}`);

    const q: Query = parseQuery(request.url);
    console.info(`[gpts.search:${rid}] query`, q);

    const limitForHasMore: number = Math.min(q.limit + 1, PAGE_MAX_LIMIT + 1);

    const results = await searchPublicGptsWithAuthor(
      q.q ?? undefined,
      q.sort ?? undefined,
      limitForHasMore,
      q.offset ?? 0,
      userId
    );

    const hasMore: boolean = results.length > q.limit;
    const sliced = hasMore ? results.slice(0, q.limit) : results;

    const items: PublicSearchItem[] = sliced.map((r) => ({
      id: r.gptsId,
      name: r.name,
      updatedAt: (r.updatedAt instanceof Date ? r.updatedAt : new Date(r.updatedAt)).toISOString(),
      isPublic: r.isPublic,
      usageCount: r.usageCount,
      authorName: r.authorName,
      isPopular: r.isPopular,
      isNew: r.isNew,
    }));

    console.info(`[gpts.search:${rid}] done`, {
      count: items.length,
      hasMore,
      firstId: items[0]?.id ?? null,
      sort: q.sort,
      offset: q.offset,
      limit: q.limit,
      defaultLimit: ENV_DEFAULT_LIMIT,
      pageMaxLimit: PAGE_MAX_LIMIT,
    });

    const body: PublicSearchResponse = { items, hasMore };
    return NextResponse.json(body);
  } catch (e) {
    const status: number = e instanceof HttpError ? e.status : 500;
    const msg: string = e instanceof HttpError ? e.message : "internal_error";
    if (status === 401 || status === 403) {
      console.warn(`[gpts.search:${rid}] auth_fail: ${msg}`);
    } else {
      console.error(`[gpts.search:${rid}] error`, e);
    }
    return NextResponse.json({ error: msg }, { status });
  }
}
