import type { WebhookEvent } from "@line/bot-sdk";
import { fetchLineUserProfile } from "@/utils/lineProfile";
import { followUser } from "@/services/users.mongo";
import { sendMessagesReplyThenPush, toTextMessages } from "@/utils/lineSend";
import { getMsg } from "@/utils/msgCatalog";

// followイベント
export async function handleFollowEvent(
  event: Extract<WebhookEvent, { type: "follow" }>,
  sourceType: "user",
  sourceId: string
): Promise<void> {
  if (sourceType !== "user") return;
  if (!sourceId) return;

  const profile = await fetchLineUserProfile(sourceId).catch(() => null);
  await followUser(sourceId, profile ?? undefined);

  // 挨拶メッセージ
  await sendMessagesReplyThenPush({
    replyToken: event.replyToken,
    to: sourceId,
    messages: toTextMessages([getMsg("FOLLOW_GREETING")]),
    delayMs: 250,
  });
}
