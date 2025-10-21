import type { WebhookEvent } from "@line/bot-sdk";
import { fetchLineUserProfile } from "@/utils/lineProfile";
import { followUser } from "@/services/users.mongo";
import { sendMessagesReplyThenPush, toTextMessages } from "@/utils/lineSend";
import { getMsg } from "@/utils/msgCatalog";

// followイベント
export async function handleFollowEvent(
  event: Extract<WebhookEvent, { type: "follow" }>,
  recipientId: string
): Promise<void> {
  // LINE Platform 仕様上、follow は user のみ
  const uid: string | undefined = event.source.type === "user" ? event.source.userId : undefined;
  if (!uid) return;

  const profile = await fetchLineUserProfile(uid).catch(() => null);
  await followUser({ userId: uid, profile: profile ?? undefined });

  // 挨拶メッセージ
  await sendMessagesReplyThenPush({
    replyToken: event.replyToken,
    to: recipientId,
    messages: toTextMessages([getMsg("FOLLOW_GREETING")]),
    delayMs: 250,
  });
}
