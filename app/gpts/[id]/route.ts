import { createHash } from "crypto";
import { type Filter, type Document } from "mongodb";
import { NextRequest, NextResponse } from "next/server";
import type { UserGptsDoc } from "@/types/db";
import { HttpError, requireLineUser } from "@/utils/lineAuth";
import { getUserGptsCollection, idMatchers } from "@/utils/mongo";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

const projection: Document = { _id: 0 };

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = await requireLineUser(req);
    const col = await getUserGptsCollection();

    const filter: Filter<UserGptsDoc> = { 
      userId, 
      deletedAt: { $exists: false }, 
      $or: idMatchers(params.id) 
    };

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

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = await requireLineUser(req);
    const body: unknown = await req.json();

    // 入力の型絞り込み
    const name = typeof (body as { name?: unknown }).name === "string"
      ? (body as { name: string }).name
      : undefined;
    const instpack = typeof (body as { instpack?: unknown }).instpack === "string"
      ? (body as { instpack: string }).instpack
      : undefined;

    if (name === undefined && instpack === undefined) {
      return NextResponse.json({ error: "no_fields" }, { status: 400 });
    }

    const col = await getUserGptsCollection();
    const filter: Filter<UserGptsDoc> = {
      userId,
      deletedAt: { $exists: false },
      $or: idMatchers(params.id),
    };

    const $set: Partial<Pick<UserGptsDoc, "name" | "instpack" | "hash" | "updatedAt">> = {
      updatedAt: new Date(),
    };
    if (name !== undefined) $set.name = name;
    if (instpack !== undefined) {
      $set.instpack = instpack;
      $set.hash = sha256(instpack);
    }

    const res = await col.updateOne(filter, { $set });
    if (!res.modifiedCount) {
      return NextResponse.json({ error: "not_modified" }, { status: 400 });
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

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = await requireLineUser(req);
    const col = await getUserGptsCollection();

    const filter: Filter<UserGptsDoc> = {
      userId,
      deletedAt: { $exists: false },
      $or: idMatchers(params.id),
    };

    const res = await col.updateOne(filter, {
      $set: { deletedAt: new Date(), updatedAt: new Date() },
    });
    if (!res.modifiedCount) {
      return NextResponse.json({ error: "not_modified" }, { status: 400 });
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