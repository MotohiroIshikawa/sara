import { NextRequest, NextResponse } from "next/server";
import type { Filter, Document } from "mongodb";
import { requireLineUser, HttpError } from "@/utils/lineAuth";
import { getUserGptsCollection, idMatchers } from "@/utils/mongo";
import { setBinding } from "@/services/gptsBindings.mongo";
import type { UserGptsDoc } from "@/types/db";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = await requireLineUser(req);
    const col = await getUserGptsCollection();

    const filter: Filter<UserGptsDoc> = {
      userId,
      deletedAt: { $exists: false },
      $or: idMatchers(params.id),
    };

    const projection: Document = { _id: 0, id: 1, name: 1, instpack: 1 };
    const item = await col.findOne(filter, { projection });
    if (!item || !item.instpack || !item.id) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    // バインド更新（旧threadは破棄しない）
    await setBinding(userId, item.id, item.instpack);

    return NextResponse.json({ ok: true, appliedId: item.id, name: item.name ?? "" });
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
