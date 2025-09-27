import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getGptsById, updateGpts } from "@/services/gpts.mongo";
import { clearBindingIfMatches } from "@/services/gptsBindings.mongo";
import { hasUserGptsLink, softDeleteUserGpts } from "@/services/userGpts.mongo";
import { requireLineUser, HttpError } from "@/utils/lineAuth";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const rid = randomUUID().slice(0, 8);
  try {
    const userId = await requireLineUser(request);
    const { id: gptsId } = await params;
    console.info(`[gpts.get:${rid}] start`, { userId, gptsId });

    const linked = await hasUserGptsLink(userId, gptsId);
    if (!linked){
      console.warn(`[gpts.get:${rid}] not_linked`, { userId, gptsId });
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const g = await getGptsById(gptsId);
    if (!g){
      console.warn(`[gpts.get:${rid}] gpts_missing`, { userId, gptsId });
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    console.info(`[gpts.get:${rid}] done`, {
      userId,
      gptsId: g.gptsId,
      name: g.name ?? "",
      inst_len: g.instpack.length,
    });

    return NextResponse.json({
      item: {
        gptsId: g.gptsId,
        name: g.name,
        instpack: g.instpack,
        updatedAt: new Date(g.updatedAt).toISOString(),
      },
    });
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const rid = randomUUID().slice(0, 8);
  try {
    const userId = await requireLineUser(request);
    const { id: gptsId } = await params;
    const body: unknown = await request.json();

    //// for debug
    console.info(`[gpts.update:${rid}] pre-check`, {
      userIdPreview: `${userId.slice(0, 4)}…${userId.slice(-4)}`,
      gptsId: gptsId,
    });
    ////

    const name = 
      typeof (body as { name?: unknown }).name === "string" 
      ? (body as { name: string }).name 
      : undefined;
    const instpack = 
      typeof (body as { instpack?: unknown }).instpack === "string" 
      ? (body as { instpack: string }).instpack 
      : undefined;

    if (name === undefined && instpack === undefined) {
      console.warn(`[gpts.update:${rid}] no_fields`, { userId, gptsId });
      return NextResponse.json({ error: "no_fields" }, { status: 400 });
    }

    const updated = await updateGpts({ gptsId, userId, name, instpack });
    if (!updated) {
      // 所有者でない / もしくは存在しない
      console.warn(`[gpts.update:${rid}] forbidden_or_not_found`, { userId, gptsId });
      return NextResponse.json({ error: "forbidden_or_not_found" }, { status: 403 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const rid = randomUUID().slice(0, 8);
  try {
    const userId = await requireLineUser(request);
    const { id } = await params;

    await softDeleteUserGpts({ userId, gptsId: id });
    await clearBindingIfMatches({ type: "user", targetId: userId }, id);

    console.info(`[gpts.delete:${rid}] soft_deleted_and_unbound`, { userId, gptsId: id });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error(`[gpts.delete:${rid}] error`, e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}