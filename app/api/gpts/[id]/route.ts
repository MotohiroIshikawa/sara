import { NextResponse } from "next/server";
import { createHash, randomUUID } from "crypto";
import type { Filter, Document } from "mongodb";
import { clearBindingIfMatches, softDeleteUserGpts } from "@/services/userGpts.mongo";
import type { UserGptsDoc } from "@/types/db";
import { requireLineUser, HttpError } from "@/utils/lineAuth";
import { toScopedUserId } from "@/utils/lineSource";
import { getUserGptsCollection, idMatchers } from "@/utils/mongo";

// params が同期/Promise の両方を許容するための補助型と関数
type Ctx<P> = { params: P } | { params: Promise<P> };
async function unwrapParams<P>(p: P | Promise<P>): Promise<P> {
  return await p;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export async function GET(request: Request, ctx: Ctx<{ id: string }>) {
  try {
    const userId = await requireLineUser(request);
    const { id } = await unwrapParams(ctx.params);

    const col = await getUserGptsCollection();
    const filter: Filter<UserGptsDoc> = { userId, deletedAt: { $exists: false }, $or: idMatchers<UserGptsDoc>(id) };
    const projection: Document = { _id: 0 };
    const item = await col.findOne(filter, { projection });

    if (!item) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ item });
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

export async function POST(request: Request, ctx: Ctx<{ id: string }>) {
  try {
    const userId = await requireLineUser(request);
    const { id } = await unwrapParams(ctx.params);
    const body: unknown = await request.json();

    const name = typeof (body as { name?: unknown }).name === "string" ? (body as { name: string }).name : undefined;
    const instpack = typeof (body as { instpack?: unknown }).instpack === "string" ? (body as { instpack: string }).instpack : undefined;
    if (name === undefined && instpack === undefined) {
      return NextResponse.json({ error: "no_fields" }, { status: 400 });
    }

    const col = await getUserGptsCollection();
    const filter: Filter<UserGptsDoc> = { userId, deletedAt: { $exists: false }, $or: idMatchers<UserGptsDoc>(id) };

    const $set: Partial<Pick<UserGptsDoc, "name" | "instpack" | "hash" | "updatedAt">> = { updatedAt: new Date() };
    if (name !== undefined) $set.name = name;
    if (instpack !== undefined) { $set.instpack = instpack; $set.hash = sha256(instpack); }

    const res = await col.updateOne(filter, { $set });
    if (!res.modifiedCount) return NextResponse.json({ error: "not_modified" }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

export async function DELETE(request: Request, ctx: Ctx<{ id: string }>) {
  const rid = randomUUID().slice(0, 8);
  try {
    const userId = await requireLineUser(request);
    const { id } = await unwrapParams(ctx.params);
    const scopedId = toScopedUserId(userId);

    const ok = await softDeleteUserGpts(userId, id);
    if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });

    await clearBindingIfMatches(scopedId, id, { rid });
    console.info(`[gpts.delete:${rid}] soft_deleted_and_unbound`, { sub: `${userId.slice(0,4)}…`, gptsId: id, });

    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error(`[gpts.delete:${rid}] error`, e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
