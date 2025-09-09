import { type WebhookEvent } from "@line/bot-sdk";
import { connectBing } from "@/utils/connectBing";
import { replyAndPushLine } from "@/utils/replyAndPushLine";

import { followUser, unfollowUser } from "@/services/users.mongo";
import { fetchLineUserProfile } from "@/utils/lineProfile";

function getRecipientId(event: WebhookEvent): string | undefined {
  switch (event.source.type){
    case "user": return event.source.userId;
    case "group": return event.source.groupId;
    case "room": return event.source.roomId;
    default: return undefined;
  }
}

function getThreadOwnerId(event: WebhookEvent): string | undefined {
  switch (event.source.type) {
    case "user": return event.source.userId;
    case "group": return `group:${event.source.groupId}`;
    case "room": return `room:${event.source.roomId}`;
    default: return undefined;
  }
}

// main
export async function lineEvent(event: WebhookEvent) {
  const recipientId = getRecipientId(event);
  const threadOwnerId = getThreadOwnerId(event);
  if (!recipientId || !threadOwnerId) return;

  // followイベント
  if (event.type === "follow" && event.source.type === "user" && event.source.userId) {
    const uid = event.source.userId;
    const profile = await fetchLineUserProfile(uid).catch(() => null);
    await followUser({ userId: uid, profile: profile ?? undefined });
    // LINEへの応答
    await replyAndPushLine({
      replyToken: event.replyToken,
      to: recipientId,
      texts: ["友だち追加ありがとうございます！質問をどうぞ🙌"],
      delayMs: 250,
    });
    return;
  }

  // unfollowイベント
  if (event.type === "unfollow" && event.source.type === "user" && event.source.userId) {
    const uid = event.source.userId;
    await unfollowUser({ userId: uid });
    return;
  }

  // messageイベント
  if (event.type === "message" && event.message.type === "text") {
  try {
      const question = event.message.text?.trim() ?? "";
      if (!question) {
        await replyAndPushLine({
          replyToken: event.replyToken,
          to: recipientId,
          texts: ["⚠️メッセージが空です。"],
          delayMs: 250,
        });
        return;
      }
      // Azure OpenAI (Grounding with Bing Search) への問い合わせ
      const texts = await connectBing(threadOwnerId, question);
      console.log("#### BING REPLY (TEXTS) ####", texts);
      // LINEへの応答
      await replyAndPushLine({
        replyToken: event.replyToken,
        to: recipientId,
        texts,
        delayMs: 250,
      });
    } catch(err) {
      console.error("[lineEvent] error:", err);
      try {
          await replyAndPushLine({
            replyToken: event.replyToken,
            to: recipientId,
            texts: ["⚠️内部エラーが発生しました。時間をおいてもう一度お試しください。"],
            delayMs: 250,
          });
      } catch {}
    }
  }
}
