import type { WebhookEvent } from "@line/bot-sdk";
import { messagingApi } from "@line/bot-sdk";
import { getGptsById } from "@/services/gpts.mongo";
import { getBinding, clearBinding } from "@/services/gptsBindings.mongo";
import { softDeleteSchedulesByTarget } from "@/services/gptsSchedules.mongo";
import { delete3AgentsForInstpack } from "@/utils/agents";
import { resetThread } from "@/services/threadState";
import { pushMessages, toTextMessages } from "@/utils/line/lineSend";
import { getMsg } from "@/utils/line/msgCatalog";

// memberLeftイベント
export async function handleMemberLeftEvent(
  event: Extract<WebhookEvent, { type: "memberLeft" }>,
  sourceType: "group" | "room",
  sourceId: string,
): Promise<void> {

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
    const binding = await getBinding(sourceType, sourceId).catch(() => null);
    const gptsId: string | undefined = binding?.gptsId ? String(binding.gptsId) : undefined;
    const instpack: string | undefined = binding?.instpack ? String(binding.instpack) : undefined;

    if (!gptsId) {
      // バインドが無ければ何もしない
      console.info("[memberLeft] no binding found. skip", { sourceType, sourceId });
      return;
    }

    const g = await getGptsById(gptsId).catch(() => null);
    const ownerUserId: string | undefined = g?.userId ? String(g.userId) : undefined;

    // 退出者の中に「作成者」が含まれていなければ何もしない
    const isOwnerLeft: boolean = !!ownerUserId && leftUserIds.includes(ownerUserId);
    if (!isOwnerLeft) {
      console.info("[memberLeft] owner not left. skip", { sourceType, sourceId, ownerUserId, leftUserIds });
      return;
    }
    console.info("[memberLeft] owner left. delete Agents", { sourceType, sourceId, ownerUserId, leftUserIds });

    // 1. Agent/Thread cleanup
    try {
      if (instpack && instpack.length > 0) {
        await delete3AgentsForInstpack(instpack);
      }
    } catch (e) {
      console.warn("[memberLeft] delete3AgentsForInstpack failed", { sourceType, sourceId, err: String(e) });
    }
    try {
      await resetThread(sourceType, sourceId);
    } catch (e) {
      console.warn("[memberLeft] resetThread failed", { sourceType, sourceId, err: String(e) });
    }

    // 2. binding を削除（hard delete）
    try {
      await clearBinding(sourceType, sourceId);
    } catch (e) {
      console.warn("[memberLeft] clearBinding failed", { sourceType, sourceId, err: String(e) });
    }

    // 3. スケジュールを soft delete（enabled=false, nextRunAt=null, deletedAt=now）
    try {
      const n: number = await softDeleteSchedulesByTarget(sourceType, sourceId);
      console.info("[memberLeft] schedules soft-deleted", { sourceType, sourceId, count: n });
    } catch (e) {
      console.warn("[memberLeft] softDeleteSchedulesByTarget failed", { sourceType, sourceId, err: String(e) });
    }

    // 4. 通知 → 退室（replyToken は無いので push → leave）
    try {
      await pushMessages({
        to: sourceId,
        messages: toTextMessages([getMsg("MEMBERLEFT_NOTIFY")]),
      });
      console.info("[memberLeft] notify pushed", { sourceType, sourceId });
    } catch (e) {
      console.warn("[memberLeft] push notify failed", { sourceType, sourceId, err: String(e) });
    }

    const lineClient: messagingApi.MessagingApiClient = new messagingApi.MessagingApiClient({
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN as string,
    });

    try {
      if (sourceType === "group") {
        await lineClient.leaveGroup(sourceId);
      } else {
        await lineClient.leaveRoom(sourceId);
      }
    } catch (e) {
      console.warn("[memberLeft] leave failed", { sourceType, sourceId, err: String(e) });
    }
    console.info("[memberLeft] left", { sourceType, sourceId });
  } catch (e) {
    console.warn("[memberLeft] handler error", { sourceType, sourceId, err: String(e) });
  }
}
