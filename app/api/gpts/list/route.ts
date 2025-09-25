import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { listUserGptsByUpdatedDesc } from "@/services/userGpts.mongo";
import { requireLineUser, HttpError } from "@/utils/lineAuth";

export async function GET(request: Request) {
  const rid = randomUUID().slice(0, 8);
  try {
    const userId = await requireLineUser(request);
    console.info(`[gpts.list:${rid}] auth sub=${userId.slice(0,4)}…${userId.slice(-4)}`);
    const items = await listUserGptsByUpdatedDesc(userId);
    return NextResponse.json({ items });
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