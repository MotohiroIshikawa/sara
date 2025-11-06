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
  sourceType: "user",
  sourceId: string
): Promise<void> {
  if (sourceType !== "user") return;
  if (!sourceId) return;

  // 1. 対象ユーザーの所有GPTと、適用先 group/room を事前収集
  let ownedGptsIds: string[] = [];
  let appliedTargets: Array<{ targetType: "group" | "room"; targetId: string; gptsId: string; instpack: string }> = [];
  try {
    ownedGptsIds = await listGptsIdsByUser(sourceId);
    if (ownedGptsIds.length > 0) {
      appliedTargets = await listTargetsByGptsIds(ownedGptsIds);
    }
    console.info("[unfollow] collected owned gpts and applied targets", {
      userId: sourceId,
      gptsCount: ownedGptsIds.length,
      targetsCount: appliedTargets.length,
    });
  } catch (e) {
    console.warn("[unfollow] collect targets failed (continue cleanup anyway)", { targetId: sourceId, err: String(e) });
  }

  // 2. ユーザ削除
  try {
    // 現在の user binding を確認（instpack があれば Agent を削除）
    const binding = await getBinding(sourceType, sourceId).catch(() => null);
    const instpack: string | null = binding?.instpack ?? null;

    // Thread リセット（スレッド所有スコープ = "user:..."）
    await resetThread(sourceType, sourceId).catch((e: unknown) => {
      console.warn("[unfollow] resetThread failed", { userId: sourceId, err: String(e) });
    });

    // Agent 削除
    if (instpack) {
      await delete3AgentsForInstpack(instpack).catch((e: unknown) => {
        console.warn("[unfollow] delete3AgentsForInstpack failed", { userId: sourceId, err: String(e) });
      });
    } else {
      console.info("[unfollow] no binding/instpack => skip agent deletion", { userId: sourceId });
    }

    // BASEのreplyAgent削除
    //await deleteBaseReplyAgent().catch((e) => {
    //  console.warn("[unfollow] deleteBaseReplyAgent failed", { uid, err: String(e) });
    //});
    
    // thread_inst の削除
    await purgeAllThreadInstByUser(sourceId).catch((e: unknown) => {
      console.warn("[unfollow] purgeAllThreadInstByUser failed", { userId: sourceId, err: String(e) });
    });

    // gpts_bindings の削除（user binding）
    await clearBinding(sourceType, sourceId).catch((e: unknown) => {
      console.warn("[unfollow] clearBinding failed", { userId: sourceId, err: String(e) });
    });

    // user_gpts の論理削除
    try {
      const n: number = await softDeleteAllUserGptsByUser(sourceId);
      console.info("[unfollow] user_gpts soft-deleted", { userId: sourceId, count: n });
    } catch (e) {
      console.warn("[unfollow] softDeleteAllUserGptsByUser failed", { userId: sourceId, err: String(e) });
    }

    // gpts の論理削除
    try {
      const n: number = await softDeleteAllGptsByUser(sourceId);
      console.info("[unfollow] gpts soft-deleted", { sourceId, count: n });
    } catch (e) {
      console.warn("[unfollow] softDeleteAllGptsByUser failed", { sourceId, err: String(e) });
    }

    // スケジュールの論理削除（target=user 指定で全停止）
    try {
      const m: number = await softDeleteSchedulesByTarget(sourceType, sourceId );
      console.info("[unfollow] schedules soft-deleted by target(user)", { sourceId, count: m });
    } catch (e) {
      console.warn("[unfollow] softDeleteSchedulesByTarget failed", { sourceId, err: String(e) });
    }

    console.info("[unfollow] user cleanup done", { sourceId });
  } catch (e) {
    console.error("[unfollow] user cleanup error", { sourceId, err: e });
  }

  // 3. このユーザのGPTが適用されていたgroup/roomを巡回し、通知 → 退室
  if (appliedTargets.length > 0) {
    const lineClient: messagingApi.MessagingApiClient = new messagingApi.MessagingApiClient({
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN as string,
    });

    for (const t of appliedTargets) {
      // 3-1. Agent/Thread cleanup（instpackありなら Agent を削除、スレッドは対象スコープでリセット）
      try {
        if (t.instpack && t.instpack.length > 0) {
          await delete3AgentsForInstpack(t.instpack);
        }
      } catch (e) {
        console.warn("[unfollow] target delete3AgentsForInstpack failed", { sourceId, appliedTargetId: t.targetId, err: String(e) });
      }
      try {
        await resetThread(t.targetType, t.targetId);
      } catch (e) {
        console.warn("[unfollow] target resetThread failed", { sourceId, appliedTargetId: t.targetId, err: String(e) });
      }

      // 3-2. binding を物理削除
      try {
        await clearBinding(t.targetType, t.targetId);
      } catch (e) {
        console.warn("[unfollow] target clearBinding failed", { sourceId, appliedTargetId: t.targetId, err: String(e) });
      }

      // 3-3. スケジュールを論理削除（target指定で無効化、nextRunAt:null）
      try {
        // TODO: 配列引数をやめる
        const n: number = await softDeleteSchedulesByGpts({ targetType: t.targetType, targetId: t.targetId });
        console.info("[unfollow] target schedules soft-deleted", { sourceId, targetId: t.targetId, count: n });
      } catch (e) {
        console.warn("[unfollow] target softDeleteSchedulesByGpts failed", { sourceId, appliedTargetId: t.targetId, err: String(e) });
      }

      // 3-4. 通知 → leave（replyToken は無いので push → leave）
      try {
        await pushMessages({
          to: t.targetId,
          messages: toTextMessages([getMsg("UNFOLLOW_TARGET_NOTIFY")]),
        });
        console.info("[unfollow] target notify pushed", { sourceId, appliedTargetId: t.targetId });
      } catch (e) {
        console.warn("[unfollow] target push notify failed", { sourceId, appliedTargetId: t.targetId, err: String(e) });
      }

      try {
        if (t.targetType === "group") {
          await lineClient.leaveGroup(t.targetId);
        } else {
          await lineClient.leaveRoom(t.targetId);
        }
        console.info("[unfollow] target left", { sourceId, appliedTargetId: t.targetId });
      } catch (e) {
        console.warn("[unfollow] target leave failed", { sourceId, appliedTargetId: t.targetId, err: String(e) });
      }
    }
  }

  // 4. users の unfollow 処理
  await unfollowUser(sourceId);

  return;
}
