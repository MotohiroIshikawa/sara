import type { WebhookEvent } from "@line/bot-sdk";
import { messagingApi } from "@line/bot-sdk";
import { getGptsById } from "@/services/gpts.mongo";
import { getBinding, clearBinding } from "@/services/gptsBindings.mongo";
import { softDeleteSchedulesByTarget } from "@/services/gptsSchedules.mongo";
import { delete3AgentsForInstpack } from "@/utils/agents";
import { resetThread } from "@/services/threadState";
import { pushMessages, toTextMessages } from "@/utils/lineSend";
import { getMsg } from "@/utils/msgCatalog";

// memberLeftイベント
export async function handleMemberLeftEvent(
  event: Extract<WebhookEvent, { type: "memberLeft" }>,
  recipientId: string,
  bindingTarget: { type: "group" | "room"; targetId: string }
): Promise<void> {
  const targetType: "group" | "room" = bindingTarget.type;
  const targetId: string = bindingTarget.targetId;

  // 去ったユーザーID群（友だち関係なら取得可能）
  const leftUserIds: string[] = Array.isArray(event.left?.members)
    ? (event.left!.members
        .map((m: unknown) => {
          const u = m as { userId?: string };
          return typeof u.userId === "string" ? u.userId : undefined;
        })
        .filter((u: string | undefined): u is string => typeof u === "string"))
    : [];

  try {
    // 現在の group/room の binding → gptsId → gpts.userId（作成者）
    const binding = await getBinding({ type: targetType, targetId }).catch(() => null);
    const gptsId: string | undefined = binding?.gptsId ? String(binding.gptsId) : undefined;
    const instpack: string | undefined = binding?.instpack ? String(binding.instpack) : undefined;

    if (!gptsId) {
      // バインドが無ければ何もしない
      console.info("[memberLeft] no binding found. skip", { targetType, targetId });
      return;
    }

    const g = await getGptsById(gptsId).catch(() => null);
    const ownerUserId: string | undefined = g?.userId ? String(g.userId) : undefined;

    // 退出者の中に「作成者」が含まれていなければ何もしない
    const isOwnerLeft: boolean = !!ownerUserId && leftUserIds.includes(ownerUserId);
    if (!isOwnerLeft) {
      console.info("[memberLeft] owner not left. skip", { targetType, targetId, ownerUserId, leftUserIds });
      return;
    }
    console.info("[memberLeft] owner left. delete Agents", { targetType, targetId, ownerUserId, leftUserIds });

    // 1. Agent/Thread cleanup
    try {
      if (instpack && instpack.length > 0) {
        await delete3AgentsForInstpack(instpack);
      }
    } catch (e) {
      console.warn("[memberLeft] delete3AgentsForInstpack failed", { targetType, targetId, err: String(e) });
    }
    try {
      const ownerScope: string = `${targetType}:${targetId}`;
      await resetThread(ownerScope);
    } catch (e) {
      console.warn("[memberLeft] resetThread failed", { targetType, targetId, err: String(e) });
    }

    // 2. binding を削除（hard delete）
    try {
      await clearBinding({ type: targetType, targetId });
    } catch (e) {
      console.warn("[memberLeft] clearBinding failed", { targetType, targetId, err: String(e) });
    }

    // 3. スケジュールを soft delete（enabled=false, nextRunAt=null, deletedAt=now）
    try {
      const n: number = await softDeleteSchedulesByTarget({ targetType, targetId });
      console.info("[memberLeft] schedules soft-deleted", { targetType, targetId, count: n });
    } catch (e) {
      console.warn("[memberLeft] softDeleteSchedulesByTarget failed", { targetType, targetId, err: String(e) });
    }

    // 4. 通知 → 退室（replyToken は無いので push → leave）
    try {
      await pushMessages({
        to: recipientId,
        messages: toTextMessages([getMsg("MEMBERLEFT_NOTIFY")]),
      });
      console.info("[memberLeft] notify pushed", { targetType, targetId });
    } catch (e) {
      console.warn("[memberLeft] push notify failed", { targetType, targetId, err: String(e) });
    }

    const lineClient: messagingApi.MessagingApiClient = new messagingApi.MessagingApiClient({
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN as string,
    });

    try {
      if (targetType === "group") {
        await lineClient.leaveGroup(targetId);
      } else {
        await lineClient.leaveRoom(targetId);
      }
    } catch (e) {
      console.warn("[memberLeft] leave failed", { targetType, targetId, err: String(e) });
    }
    console.info("[memberLeft] left", { targetType, targetId });
  } catch (e) {
    console.warn("[memberLeft] handler error", { targetType, targetId, err: String(e) });
  }
}
