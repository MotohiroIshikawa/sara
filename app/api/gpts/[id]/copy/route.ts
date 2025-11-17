import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { requireLineUser, HttpError } from "@/utils/line/lineAuth";
import { copyGpts } from "@/services/gpts.mongo";
import { isNonEmptyString } from "@/utils/types";
import { setBinding } from "@/services/gptsBindings.mongo";

type CopyRequest = { renameTo?: string; };

type CopyResponse =
  | { ok: true; gptsId: string; name: string }
  | { error: string };

export async function POST(
  request: Request, 
  { params }: { params: Promise<{ id: string }> }
) {
  const rid: string = randomUUID().slice(0, 8);
  const { id: originalGptsId } = await params;

  try {
    const userId: string = await requireLineUser(request);
    console.info(
      `[gpts.copy:${rid}] auth sub=${userId.slice(0, 4)}…${userId.slice(-4)} orig=${originalGptsId}`
    );

    // 入力（任意で名前変更）
    let renameTo: string | undefined = undefined;
    try {
      const j: unknown = await request.json();
      const body: CopyRequest =
        (j && typeof j === "object" ? (j as CopyRequest) : {}) as CopyRequest;

      if (isNonEmptyString(body.renameTo)) {
        renameTo = body.renameTo.trim();
      }
    } catch {
      // body なし（204/空）でもOKにする
    }

    // 実行：公開かつ削除されていない元だけコピー可能（services 側で検証済み）
    const cloned = await copyGpts(originalGptsId, userId, renameTo);

    if (!cloned) {
      console.warn(`[gpts.copy:${rid}] not_found_or_forbidden orig=${originalGptsId}`);
      const body: CopyResponse = { error: "not_found_or_forbidden" };
      return NextResponse.json(body, { status: 404 });
    }

    // コピーした GPTS をこのユーザに「適用」する
    await setBinding("user", userId, cloned.gptsId, cloned.instpack);

    console.info(`[gpts.copy:${rid}] done`, {
      newId: cloned.gptsId,
      name: cloned.name,
      isPublic: cloned.isPublic,
      original: cloned.originalGptsId,
      author: cloned.authorUserId,
      boundToUser: userId,
    });

    const resBody: CopyResponse = {
      ok: true,
      gptsId: cloned.gptsId,
      name: cloned.name,
    };
    return NextResponse.json(resBody);
  } catch (e) {
    const status: number = e instanceof HttpError ? e.status : 500;
    const msg: string = e instanceof HttpError ? e.message : "internal_error";
    if (status === 401 || status === 403) {
      console.warn(`[gpts.copy:${rid}] auth_fail: ${msg}`);
    } else {
      console.error(`[gpts.copy:${rid}] error`, e);
    }
    const body: CopyResponse = { error: msg };
    return NextResponse.json(body, { status });
  }
}
