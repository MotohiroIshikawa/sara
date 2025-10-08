import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { requireLineUser, HttpError } from "@/utils/lineAuth";

type HelpOkResponse = {
  ok: true;
  // 認証トレース用。画面で使わないならフロントでは参照不要
  rid: string;
  // マスク済みのユーザID（必要なければフロントで無視）
  subMasked: string;
  now: string;
};

type HelpErrorResponse = {
  error: string;
  rid: string;
};

export async function GET(request: Request): Promise<NextResponse> {

  const rid: string = randomUUID().slice(0, 8);
  try {
    const userId: string = await requireLineUser(request);
    const subMasked: string = `${userId.slice(0, 4)}…${userId.slice(-4)}`;
    console.info(`[help:${rid}] auth sub=${subMasked}`);

    const body: HelpOkResponse = {
      ok: true,
      rid,
      subMasked,
      now: new Date().toISOString(),
    };
    return NextResponse.json(body);
  } catch (e: unknown) {
    const isHttp: boolean = e instanceof HttpError;
    const status: number = isHttp ? (e as HttpError).status : 500;
    const msg: string = isHttp ? (e as HttpError).message : "internal_error";

    if (status === 401 || status === 403) {
      console.warn(`[help:${rid}] auth_fail: ${msg}`);
    } else {
      console.error(`[help:${rid}] error`, e);
    }

    const body: HelpErrorResponse = { error: msg, rid };
    return NextResponse.json(body, { status });
  }
}
