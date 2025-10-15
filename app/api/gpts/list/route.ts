import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getBinding } from "@/services/gptsBindings.mongo";
import { listUserGptsByUpdatedDesc } from "@/services/userGpts.mongo";
import { requireLineUser, HttpError } from "@/utils/lineAuth";

export async function GET(request: Request) {
  const rid = randomUUID().slice(0, 8);
  try {
    const userId = await requireLineUser(request);
    console.info(`[gpts.list:${rid}] auth sub=${userId.slice(0,4)}…${userId.slice(-4)}`);

    const [items, binding] = await Promise.all([
      listUserGptsByUpdatedDesc(userId),
      getBinding({ type: "user", targetId: userId }), // 適用中のbinding取得
    ]);
    const appliedId = binding?.gptsId ?? null;

    type SvcItem = { gptsId: string; name?: string; updatedAt: Date; isPublic: boolean };

    const itemsCompat = (items as SvcItem[]).map((it) => ({
      id: it.gptsId,
      name: it.name,
      updatedAt: it.updatedAt.toISOString(),
      isPublic: it.isPublic,
    }));
    
    // 「適用中」を先頭に、それ以外は既存（更新降順）を維持
    const sorted = (() => {
      if (!appliedId) return itemsCompat;
      const head = itemsCompat.find((x) => x.id === appliedId);
      const tail = itemsCompat.filter((x) => x.id !== appliedId);
      return head ? [head, ...tail] : itemsCompat;
    })();

    console.info(`[gpts.list:${rid}] done`, {
      userId,
      count: sorted.length,
      appliedId,
      firstId: sorted[0]?.id ?? null,
      pubStats: {
        public: sorted.filter(i => i.isPublic).length,
        private: sorted.filter(i => !i.isPublic).length,
      },
    });
    return NextResponse.json({ items: sorted, appliedId });
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