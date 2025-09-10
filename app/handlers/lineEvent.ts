import { messagingApi, type WebhookEvent } from "@line/bot-sdk";
import { connectBing } from "@/utils/connectBing";
import {
  sendMessagesReplyThenPush,
  toTextMessages,
  buildSaveOrContinueConfirm,
} from "@/utils/lineSend";
import { fetchLineUserProfile } from "@/utils/lineProfile";
import { followUser, unfollowUser } from "@/services/users.mongo";
import { upsertThreadInst } from "@/services/threadInst.mongo";
import { getBinding } from "@/services/gptsBindings.mongo";
import { handlePostback } from "./postbacks/gpts";

// 送信先（ユーザー/グループ/ルームのID）
function getRecipientId(event: WebhookEvent): string | undefined {
  switch (event.source.type){
    case "user": return event.source.userId;
    case "group": return event.source.groupId;
    case "room": return event.source.roomId;
    default: return undefined;
  }
}

// スレッド所有者ID（user / group:xxx / room:yyy）
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

  // postback イベント（保存/続ける）
  if (event.type === "postback") {
    await handlePostback(event);
    return;
  }

  // followイベント
  if (event.type === "follow" && event.source.type === "user" && event.source.userId) {
    const uid = event.source.userId;
    const profile = await fetchLineUserProfile(uid).catch(() => null);
    await followUser({ userId: uid, profile: profile ?? undefined });
    // LINEへの応答
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken,
      to: recipientId,
      messages: toTextMessages(["友だち追加ありがとうございます！\n（使い方の説明文）\n質問をどうぞ🙌"]),
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
        await sendMessagesReplyThenPush({
          replyToken: event.replyToken,
          to: recipientId,
          messages: toTextMessages(["⚠️メッセージが空です。"]),
          delayMs: 250,
        });
        return;
      }

      // Azure OpenAI (Grounding with Bing Search) への問い合わせ
      const binding = await getBinding(threadOwnerId); 
          // GPTS利用の場合はinstpack使用
      const res = await connectBing(threadOwnerId, question, {
        instructionsOverride: binding?.instpack,
      });
      console.log("#### BING REPLY (TEXTS) ####", res.texts);
      // 本文メッセージを配列化
      const messages: messagingApi.Message[] = [...toTextMessages(res.texts)];
      // complete=true のときは Confirm を同梱
      if (res.meta?.complete === true && res.threadId) {
        messages.push(
          buildSaveOrContinueConfirm({
            text: "この内容で保存しますか？",
            saveData: `gpts:save:${res.threadId}`,
            continueData: `gpts:continue:${res.threadId}`,
          })
        );
      }
      // LINEへ本文応答
      await sendMessagesReplyThenPush({
        replyToken: event.replyToken,
        to: recipientId,
        messages,
        delayMs: 250,
      });
      
      // instpackを毎回上書き保存
      if (res.instpack && res.threadId) {
        await upsertThreadInst({
          userId: threadOwnerId,
          threadId: res.threadId,
          instpack: res.instpack,
          meta: res.meta,
        });
      }

    } catch(err) {
      console.error("[lineEvent] error:", err);
      try {
          await sendMessagesReplyThenPush({
            replyToken: event.replyToken,
            to: recipientId,
            messages: toTextMessages(["⚠️内部エラーが発生しました。時間をおいてもう一度お試しください。"]),
            delayMs: 250,
          });
      } catch {}
    }
  }
}
