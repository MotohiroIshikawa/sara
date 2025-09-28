import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { setBinding } from "@/services/gptsBindings.mongo";
import { hasUserGptsLink } from "@/services/userGpts.mongo";
import { getGptsById } from "@/services/gpts.mongo";
import { purgeAllThreadInstByUser } from "@/services/threadInst.mongo";
import { resetThread } from "@/services/threadState";
import { requireLineUser, HttpError } from "@/utils/lineAuth";
import { toScopedOwnerIdFromPlainId } from "@/utils/lineSource";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const rid = randomUUID().slice(0, 8);
  try {
    const userId = await requireLineUser(request);
    const { id: gptsId } = await params;
    console.info(`[gpts.use:${rid}] start`, { userId, gptsId });

    // 所有/参照リンク確認
    const linked = await hasUserGptsLink(userId, gptsId);
    if (!linked) {
      console.warn(`[gpts.use:${rid}] not_linked`, { userId, gptsId });
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    // 対象gptsの取得
    const g = await getGptsById(gptsId);
    if (!g?.instpack) {
      console.warn(`[gpts.use:${rid}] gpts_missing`, { userId, gptsId });
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const scopedOwnerId = toScopedOwnerIdFromPlainId("user", userId);

    // thread_inst（ユーザの作成中レコード）を削除
    await purgeAllThreadInstByUser(scopedOwnerId).catch((e) => {
      console.warn(`[gpts.use:${rid}] clear_thread_inst_failed`, { userId, err: String(e) });
    });

    // Redisに登録されている利用中のthreadを削除
    await resetThread(scopedOwnerId).catch((e) => {
      console.warn(`[gpts.use:${rid}] reset_thread_failed`, { userId, err: String(e) });
    });

     // gpts_bindings を上書き
    await setBinding({ type: "user", targetId: userId }, g.gptsId, g.instpack);

    console.info(`[gpts.use:${rid}] done`, {
      userId,
      gptsId: g.gptsId,
      name: g.name ?? "",
      inst_len: g.instpack.length,
    });

    return NextResponse.json({ ok: true, appliedId: g.gptsId, name: g.name ?? "" });
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error(`[gpts.use:${rid}] error`, e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
