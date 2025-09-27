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

    const itemsCompat = items.map((it) => ({
      id: it.gptsId,
      name: it.name,
      updatedAt: it.updatedAt.toISOString(),
    }));
    
    console.info(`[gpts.list:${rid}] done`, {
      userId,
      count: itemsCompat.length,
      appliedId,
      firstId: itemsCompat[0]?.id ?? null,
    });
    return NextResponse.json({ items: itemsCompat, appliedId });
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