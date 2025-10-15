// app/api/gpts/search/route.ts
import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { searchPublicGpts, type PublicGptsSort } from "@/services/gpts.mongo";
import { requireLineUser, HttpError } from "@/utils/lineAuth";

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
};

type PublicSearchResponse = {
  items: PublicSearchItem[];
};

function parseQuery(url: string): Query {
  const sp: URLSearchParams = new URL(url).searchParams;

  const qRaw: string | null = sp.get("q");
  const q: string | undefined = qRaw !== null && qRaw.trim().length > 0 ? qRaw.trim() : undefined;

  const sortRaw: string = sp.get("sort") ?? "latest";
  const sort: PublicGptsSort = (sortRaw === "popular") ? "popular" : "latest";

  const limitNum: number = Number(sp.get("limit") ?? "20");
  const limit: number = Math.min(Math.max(Number.isFinite(limitNum) ? Math.trunc(limitNum) : 20, 1), 50);

  const offsetNum: number = Number(sp.get("offset") ?? "0");
  const offset: number = Math.max(Number.isFinite(offsetNum) ? Math.trunc(offsetNum) : 0, 0);

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

    const results = await searchPublicGpts(q);

    const items: PublicSearchItem[] = results.map((r) => ({
      id: r.gptsId,
      name: r.name,
      updatedAt: (r.updatedAt instanceof Date ? r.updatedAt : new Date(r.updatedAt)).toISOString(),
      isPublic: r.isPublic,
      usageCount: r.usageCount,
    }));

    console.info(`[gpts.search:${rid}] done`, {
      count: items.length,
      firstId: items[0]?.id ?? null,
      sort: q.sort,
    });

    const body: PublicSearchResponse = { items };
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
