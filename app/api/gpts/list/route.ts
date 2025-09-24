import { NextResponse } from "next/server";
import { listUserGptsByUpdatedDesc } from "@/services/userGpts.mongo";
import { requireLineUser, HttpError } from "@/utils/lineAuth";

export async function GET(request: Request) {
  try {
    const userId = await requireLineUser(request);
    const items = await listUserGptsByUpdatedDesc(userId);
    return NextResponse.json({ items });
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
