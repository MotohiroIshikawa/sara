import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getBinding } from "@/services/gptsBindings.mongo";
import { listUserGptsByUpdatedDesc } from "@/services/userGpts.mongo";
import { requireLineUser, HttpError } from "@/utils/line/lineAuth";
import { envInt } from "@/utils/env";

// ページサイズ
const PAGE_DEFAULT_LIMIT: number = envInt("LIST_PAGE_LIMIT", 20, { min: 1, max: 1000 });
const PAGE_MAX_LIMIT_ENV: number = envInt("LIST_PAGE_LIMIT_MAX", 50, { min: 1, max: 1000 });
const PAGE_MAX_LIMIT: number = Math.max(PAGE_MAX_LIMIT_ENV, PAGE_DEFAULT_LIMIT);

type Query = {
  limit: number;
  offset: number;
};

function parseQuery(url: string): Query {
  const sp: URLSearchParams = new URL(url).searchParams;
  const limitRaw: string | null = sp.get("limit");
  const limitParsed: number = limitRaw !== null ? Number(limitRaw) : PAGE_DEFAULT_LIMIT;
  const limitInt: number = Number.isFinite(limitParsed) ? Math.trunc(limitParsed) : PAGE_DEFAULT_LIMIT;
  const limit: number = Math.min(Math.max(limitInt, 1), PAGE_MAX_LIMIT);

  const offsetRaw: string | null = sp.get("offset");
  const offsetParsed: number = offsetRaw !== null ? Number(offsetRaw) : 0;
  const offsetInt: number = Number.isFinite(offsetParsed) ? Math.trunc(offsetParsed) : 0;
  const offset: number = Math.max(offsetInt, 0);

  return { limit, offset };
}

export async function GET(request: Request) {
  const rid = randomUUID().slice(0, 8);
  try {
    const userId = await requireLineUser(request);
    console.info(`[gpts.list:${rid}] auth sub=${userId.slice(0,4)}…${userId.slice(-4)}`);

    const { limit, offset } = parseQuery(request.url);
    console.info(`[gpts.list:${rid}] query { limit:${limit}, offset:${offset} }`);

    const [items, binding] = await Promise.all([
      listUserGptsByUpdatedDesc(userId),
      getBinding("user", userId), // 適用中のbinding取得
    ]);
    const appliedId = binding?.gptsId ?? null;

    type SvcItem = { gptsId: string; name?: string; updatedAt: Date; isPublic: boolean };

    const itemsCompat = (items as SvcItem[]).map((it) => ({
      id: it.gptsId,
      name: it.name,
      updatedAt: it.updatedAt.toISOString(),
      isPublic: it.isPublic,
    }));
    
    // 「適用中」を先頭（先頭ページのみ）。それ以外は既存（更新降順）を維持
    const arranged = (() => {
      if (!appliedId) return itemsCompat;
      if (offset > 0) return itemsCompat;
      const head = itemsCompat.find((x) => x.id === appliedId);
      const tail = itemsCompat.filter((x) => x.id !== appliedId);
      return head ? [head, ...tail] : itemsCompat;
    })();

    // ページ分割
    const total: number = arranged.length;
    const start: number = Math.min(offset, total);
    const end: number = Math.min(offset + limit, total);
    const pageItems = arranged.slice(start, end);
    const hasMore: boolean = end < total;

    console.info(`[gpts.list:${rid}] done`, {
      userId,
      count: pageItems.length,
      total,
      hasMore,
      appliedId,
      firstId: pageItems[0]?.id ?? null,
      pubStats: {
        public: pageItems.filter(i => i.isPublic).length,
        private: pageItems.filter(i => !i.isPublic).length,
      },
      page: { offset, limit },
      env: { defaultLimit: PAGE_DEFAULT_LIMIT, maxLimit: PAGE_MAX_LIMIT },
    });

    return NextResponse.json({ items: pageItems, appliedId, hasMore });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    const msg = e instanceof HttpError ? e.message : "internal_error";
    if (status === 401 || status === 403) {
      console.warn(`[gpts.list:${rid}] auth_fail: ${msg}`);
    } else {
      console.error(`[gpts.list:${rid}] error`, e);
    }
    return NextResponse.json({ error: msg }, { status });
  }
}