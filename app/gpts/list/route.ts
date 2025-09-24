import type { Filter } from "mongodb";
import { NextRequest, NextResponse } from "next/server";
import type { UserGptsDoc } from "@/types/db";
import { HttpError, requireLineUser } from "@/utils/lineAuth";
import { getUserGptsCollection } from "@/utils/mongo";

export async function GET(req: NextRequest) {
  try {
    const userId = await requireLineUser(req);
    const col = await getUserGptsCollection();
    const query: Filter<UserGptsDoc> = { userId, deletedAt: { $exists: false } };
    const items = await col
      .find(query)
      .project({ _id: 0 })
      .sort({ updatedAt: -1 })
      .toArray();
    return NextResponse.json({ items });
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
