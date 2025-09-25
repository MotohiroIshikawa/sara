import { NextResponse } from "next/server";
import { getBinding } from "@/services/gptsBindings.mongo";
import { requireLineUser, HttpError } from "@/utils/lineAuth";

export async function GET(request: Request) {
  try {
    const userId = await requireLineUser(request);
    const binding = await getBinding(userId);
    // 変更なしの既存APIと独立させるため、シンプルに gptsId だけ返す
    return NextResponse.json({ gptsId: binding?.gptsId ?? null });
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
