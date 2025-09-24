import { createHash } from "crypto";
import { NextResponse } from "next/server";
import type { Filter, Document } from "mongodb";
import { requireLineUser, HttpError } from "@/utils/lineAuth";
import { getUserGptsCollection } from "@/utils/mongo";
import type { UserGptsDoc } from "@/types/db";
import { idMatchers } from "@/utils/mongo";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireLineUser(request);
    const { id } = await params;

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

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireLineUser(request);
    const { id } = await params;
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

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireLineUser(request);
    const { id } = await params;

    const col = await getUserGptsCollection();
    const filter: Filter<UserGptsDoc> = { userId, deletedAt: { $exists: false }, $or: idMatchers<UserGptsDoc>(id) };

    const res = await col.updateOne(filter, { $set: { deletedAt: new Date(), updatedAt: new Date() } });
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
