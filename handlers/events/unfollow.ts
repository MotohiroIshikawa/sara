import type { WebhookEvent } from "@line/bot-sdk";
import { messagingApi } from "@line/bot-sdk";
import { listGptsIdsByUser, softDeleteAllGptsByUser } from "@/services/gpts.mongo";
import { getBinding, listTargetsByGptsIds, clearBinding } from "@/services/gptsBindings.mongo";
import { softDeleteSchedulesByTarget, softDeleteSchedulesByGpts } from "@/services/gptsSchedules.mongo";
import { softDeleteAllUserGptsByUser } from "@/services/userGpts.mongo";
import { purgeAllThreadInstByUser } from "@/services/threadInst.mongo";
import { unfollowUser } from "@/services/users.mongo";
import { delete3AgentsForInstpack } from "@/utils/agents";
import { resetThread } from "@/services/threadState";
import { pushMessages, toTextMessages } from "@/utils/lineSend";
import { getMsg } from "@/utils/msgCatalog";

// unfollowイベント
export async function handleUnfollowEvent(
  event: Extract<WebhookEvent, { type: "unfollow" }>,
  recipientId: string,
  threadOwnerId: string
): Promise<void> {
  const uid: string | undefined = event.source.type === "user" ? event.source.userId : undefined;
  if (!uid) return;

  // 1. 対象ユーザーの所有GPTと、適用先 group/room を事前収集
  let ownedGptsIds: string[] = [];
  let appliedTargets: Array<{ targetType: "group" | "room"; targetId: string; gptsId: string; instpack: string }> = [];
  try {
    ownedGptsIds = await listGptsIdsByUser(uid);
    if (ownedGptsIds.length > 0) {
      appliedTargets = await listTargetsByGptsIds(ownedGptsIds);
    }
    console.info("[unfollow] collected owned gpts and applied targets", {
      uid,
      gptsCount: ownedGptsIds.length,
      targetsCount: appliedTargets.length,
    });
  } catch (e) {
    console.warn("[unfollow] collect targets failed (continue cleanup anyway)", { uid, err: String(e) });
  }

  // 2. ユーザ削除
  try {
    // 現在の user binding を確認（instpack があれば Agent を削除）
    const binding = await getBinding({ type: "user", targetId: uid }).catch(() => null);
    const instpack: string | null = binding?.instpack ?? null;

    // Thread リセット（スレッド所有スコープ = "user:..."）
    await resetThread(threadOwnerId).catch((e: unknown) => {
      console.warn("[unfollow] resetThread failed", { uid, err: String(e) });
    });

    // Agent 削除
    if (instpack) {
      await delete3AgentsForInstpack(instpack).catch((e: unknown) => {
        console.warn("[unfollow] delete3AgentsForInstpack failed", { uid, err: String(e) });
      });
    } else {
      console.info("[unfollow] no binding/instpack => skip agent deletion", { uid });
    }

    // BASEのreplyAgent削除
    //await deleteBaseReplyAgent().catch((e) => {
    //  console.warn("[unfollow] deleteBaseReplyAgent failed", { uid, err: String(e) });
    //});
    
    // thread_inst の削除
    await purgeAllThreadInstByUser(threadOwnerId).catch((e: unknown) => {
      console.warn("[unfollow] purgeAllThreadInstByUser failed", { uid, err: String(e) });
    });

    // gpts_bindings の削除（user binding）
    await clearBinding({ type: "user", targetId: uid }).catch((e: unknown) => {
      console.warn("[unfollow] clearBinding failed", { uid, err: String(e) });
    });

    // user_gpts の論理削除
    try {
      const n: number = await softDeleteAllUserGptsByUser(uid);
      console.info("[unfollow] user_gpts soft-deleted", { uid, count: n });
    } catch (e) {
      console.warn("[unfollow] softDeleteAllUserGptsByUser failed", { uid, err: String(e) });
    }

    // gpts の論理削除
    try {
      const n: number = await softDeleteAllGptsByUser(uid);
      console.info("[unfollow] gpts soft-deleted", { uid, count: n });
    } catch (e) {
      console.warn("[unfollow] softDeleteAllGptsByUser failed", { uid, err: String(e) });
    }

    // スケジュールの論理削除（target=user 指定で全停止）
    try {
      const m: number = await softDeleteSchedulesByTarget({ targetType: "user", targetId: uid });
      console.info("[unfollow] schedules soft-deleted by target(user)", { uid, count: m });
    } catch (e) {
      console.warn("[unfollow] softDeleteSchedulesByTarget failed", { uid, err: String(e) });
    }

    console.info("[unfollow] user cleanup done", { uid });
  } catch (e) {
    console.error("[unfollow] user cleanup error", { uid, err: e });
  }

  // 3. このユーザのGPTが適用されていたgroup/roomを巡回し、通知 → 退室
  if (appliedTargets.length > 0) {
    const lineClient: messagingApi.MessagingApiClient = new messagingApi.MessagingApiClient({
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN as string,
    });

    for (const t of appliedTargets) {
      const ownerScope: string = `${t.targetType}:${t.targetId}`;

      // 3-1. Agent/Thread cleanup（instpackありなら Agent を削除、スレッドは対象スコープでリセット）
      try {
        if (t.instpack && t.instpack.length > 0) {
          await delete3AgentsForInstpack(t.instpack);
        }
      } catch (e) {
        console.warn("[unfollow] target delete3AgentsForInstpack failed", { uid, ownerScope, err: String(e) });
      }
      try {
        await resetThread(ownerScope);
      } catch (e) {
        console.warn("[unfollow] target resetThread failed", { uid, ownerScope, err: String(e) });
      }

      // 3-2. binding を物理削除
      try {
        await clearBinding({ type: t.targetType, targetId: t.targetId });
      } catch (e) {
        console.warn("[unfollow] target clearBinding failed", { uid, ownerScope, err: String(e) });
      }

      // 3-3. スケジュールを論理削除（target指定で無効化、nextRunAt:null）
      try {
        const n: number = await softDeleteSchedulesByGpts({ targetType: t.targetType, targetId: t.targetId });
        console.info("[unfollow] target schedules soft-deleted", { uid, ownerScope, count: n });
      } catch (e) {
        console.warn("[unfollow] target softDeleteSchedulesByGpts failed", { uid, ownerScope, err: String(e) });
      }

      // 3-4. 通知 → leave（replyToken は無いので push → leave）
      try {
        await pushMessages({
          to: t.targetId,
          messages: toTextMessages([getMsg("UNFOLLOW_TARGET_NOTIFY")]),
        });
        console.info("[unfollow] target notify pushed", { uid, ownerScope });
      } catch (e) {
        console.warn("[unfollow] target push notify failed", { uid, ownerScope, err: String(e) });
      }

      try {
        if (t.targetType === "group") {
          await lineClient.leaveGroup(t.targetId);
        } else {
          await lineClient.leaveRoom(t.targetId);
        }
        console.info("[unfollow] target left", { uid, ownerScope });
      } catch (e) {
        console.warn("[unfollow] target leave failed", { uid, ownerScope, err: String(e) });
      }
    }
  }

  // 4. users の unfollow 処理
  await unfollowUser({ userId: uid });

  return;
}
