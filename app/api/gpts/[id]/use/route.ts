import { NextResponse } from "next/server";
import { createHash, randomUUID } from "crypto";
import { getBinding, setBinding } from "@/services/gptsBindings.mongo";
import { hasUserGptsLink } from "@/services/userGpts.mongo";
import { getGptsById } from "@/services/gpts.mongo";
import { purgeAllThreadInstByUser } from "@/services/threadInst.mongo";
import { resetThread } from "@/services/threadState";
import { requireLineUser, HttpError } from "@/utils/line/lineAuth";
import { delete3AgentsForInstpack } from "@/utils/agents";

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

    // 現在の binding を取得（旧Agent掃除のため保持）
    const prev = await getBinding("user", userId).catch(() => null);

    // thread_inst（ユーザの作成中レコード）を削除
    const scope = `user:${userId}`;
    await purgeAllThreadInstByUser(scope).catch((e) => {
      console.warn(`[gpts.use:${rid}] clear_thread_inst_failed`, { userId, err: String(e) });
    });

    // Redisに登録されている利用中のthreadを削除
    await resetThread("user", userId).catch((e) => {
      console.warn(`[gpts.use:${rid}] reset_thread_failed`, { userId, err: String(e) });
    });

     // gpts_bindings を上書き
    await setBinding("user", userId, g.gptsId, g.instpack);

    // 旧 binding と違う場合は、旧 instpack に紐づく reply/meta/inst Agent を削除（上限3体維持）
    if (prev?.instpack && prev?.gptsId !== g.gptsId) {
      const prevSha = createHash("sha256").update(prev.instpack).digest("base64url").slice(0, 12);
      const nextSha = createHash("sha256").update(g.instpack).digest("base64url").slice(0, 12);
      const changed = (prev.gptsId !== g.gptsId) || (prevSha !== nextSha);
      if (changed) {
        try {
          const del = await delete3AgentsForInstpack(prev.instpack);
          console.info(`[gpts.use:${rid}] deleted_prev_agents`, del);
        } catch (e) {
          console.warn(`[gpts.use:${rid}] delete_prev_agents_failed`, { err: String(e) });
        }
      } else {
        console.info(`[gpts.use:${rid}] agent_delete_skipped_same_instpack`, { prevSha, nextSha }); // ★
      }
    }


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
