import { NextResponse } from "next/server";
import { listUserGptsByUpdatedDesc } from "@/services/userGpts.mongo";
import { requireLineUser, HttpError } from "@/utils/lineAuth";

export async function GET(request: Request) {
  const rid = crypto.randomUUID().slice(0, 8);
  try {
    const sub = await requireLineUser(request);
    const msgUserIdHdr = request.headers.get("x-line-msg-user-id") || undefined;
    console.info(`[gpts.list:${rid}] auth ids`, { subPreview: `${sub.slice(0,4)}…${sub.slice(-4)}`, msgUserIdHdr });

    const items = await listUserGptsByUpdatedDesc(sub);
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