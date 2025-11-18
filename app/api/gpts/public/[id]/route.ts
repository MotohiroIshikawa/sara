import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { requireLineUser, HttpError } from "@/utils/line/lineAuth";
import { getPublicGptsDetail } from "@/services/gpts.mongo";

type PublicDetailItem = {
  id: string;
  name: string;
  instpack: string;
  updatedAt: string;   // ISO8601
  isPublic: boolean;
};

type PublicDetailResponse =
  | { item: PublicDetailItem }
  | { error: string };

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const rid: string = randomUUID().slice(0, 8);
  const { id: gptsId } = await params;

  try {
    // 既存APIに合わせて要ログイン
    const userId: string = await requireLineUser(request);
    console.info(`[gpts.public.detail:${rid}] auth sub=${userId.slice(0,4)}…${userId.slice(-4)} id=${gptsId}`);

    const d = await getPublicGptsDetail(gptsId);
    if (!d) {
      console.warn(`[gpts.public.detail:${rid}] not_found id=${gptsId}`);
      const body: PublicDetailResponse = { error: "not_found" };
      return NextResponse.json(body, { status: 404 });
    }

    const item: PublicDetailItem = {
      id: d.gptsId,
      name: d.name,
      instpack: d.instpack,
      updatedAt: (d.updatedAt instanceof Date ? d.updatedAt : new Date(d.updatedAt)).toISOString(),
      isPublic: d.isPublic,
    };

    console.info(`[gpts.public.detail:${rid}] done`, { id: item.id, name: item.name });

    const body: PublicDetailResponse = { item };
    return NextResponse.json(body);
  } catch (e) {
    const status: number = e instanceof HttpError ? e.status : 500;
    const msg: string = e instanceof HttpError ? e.message : "internal_error";
    if (status === 401 || status === 403) {
      console.warn(`[gpts.public.detail:${rid}] auth_fail: ${msg}`);
    } else {
      console.error(`[gpts.public.detail:${rid}] error`, e);
    }
    const body: PublicDetailResponse = { error: msg };
    return NextResponse.json(body, { status });
  }
}
