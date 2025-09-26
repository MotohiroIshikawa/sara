import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getGptsById, updateGpts } from "@/services/gpts.mongo";
import { clearBindingIfMatches } from "@/services/gptsBindings.mongo";
import { hasUserGptsLink, softDeleteUserGpts } from "@/services/userGpts.mongo";
import { requireLineUser, HttpError } from "@/utils/lineAuth";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireLineUser(request);
    const { id } = await params;

    const linked = await hasUserGptsLink(userId, id);
    if (!linked) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const item = await getGptsById(id);
    if (!item) return NextResponse.json({ error: "not_found" }, { status: 404 });

    return NextResponse.json({
      item: {
        gptsId: item.gptsId,
        name: item.name,
        instpack: item.instpack,
        updatedAt: new Date(item.updatedAt).toISOString(),
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
  try {
    const userId = await requireLineUser(request);
    const { id } = await params;
    const body: unknown = await request.json();

    const name = 
      typeof (body as { name?: unknown }).name === "string" 
      ? (body as { name: string }).name 
      : undefined;
    const instpack = 
      typeof (body as { instpack?: unknown }).instpack === "string" 
      ? (body as { instpack: string }).instpack 
      : undefined;

    if (name === undefined && instpack === undefined) {
      return NextResponse.json({ error: "no_fields" }, { status: 400 });
    }

    const updated = await updateGpts({ gptsId: id, userId, name, instpack });
    if (!updated) {
      // 所有者でない / もしくは存在しない
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