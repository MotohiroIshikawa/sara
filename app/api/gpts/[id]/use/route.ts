import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import type { Filter, Document } from "mongodb";
import { setBinding } from "@/services/gptsBindings.mongo";
import type { UserGptsDoc } from "@/types/db";
import { requireLineUser, HttpError } from "@/utils/lineAuth";
import { toScopedUserId } from "@/utils/lineSource";
import { getUserGptsCollection, idMatchers } from "@/utils/mongo";

// params が同期/Promise の両方を許容するための補助型と関数
type Ctx<P> = { params: P } | { params: Promise<P> };
async function unwrapParams<P>(p: P | Promise<P>): Promise<P> {
  return await p;
}

export async function POST(request: Request, ctx: Ctx<{ id: string }>) {
  const rid = randomUUID().slice(0, 8);
  try {
    const userId = await requireLineUser(request);
    const { id } = await unwrapParams(ctx.params);
    const scopedId = toScopedUserId(userId);
    console.info(`[gpts.use:${rid}] start`, { scopedId, gptsIdParam: id });

    const col = await getUserGptsCollection();
    const filter: Filter<UserGptsDoc> = { userId, deletedAt: { $exists: false }, $or: idMatchers<UserGptsDoc>(id) };
    const projection: Document = { _id: 0, id: 1, name: 1, instpack: 1 };

    const item = await col.findOne(filter, { projection });
    if (!item || !item.instpack || !item.id) {
      console.warn(`[gpts.use:${rid}] not_found`, { scopedId, gptsIdParam: id });
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    await setBinding(userId, item.id, item.instpack);
    console.info(`[gpts.use:${rid}] done`, { scopedId, gptsId: item.id, name: item.name ?? "", inst_len: item.instpack.length, });
    return NextResponse.json({ ok: true, appliedId: item.id, name: item.name ?? "" });
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error(`[gpts.use:${rid}] error`, e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
