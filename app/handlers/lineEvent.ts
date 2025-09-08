import { type WebhookEvent } from "@line/bot-sdk";
//import { TalkModel } from "@/models/talk";
//import connectDB from "@/utils/connectDB";
import { connectBing } from "@/utils/connectBing";
import { replyAndPushLine } from "@/utils/replyAndPushLine";

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

  if (event.type === "message"){
    if (event.message.type === "text") {
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

        /*
        const timestampStart = new Date();
        await connectDB()
        // メッセージをDBに記録
        await TalkModel.create({
          userId : threadOwnerId,
          contents : question,
          dist : "req",
          timestamp : timestampStart
        })
        console.log("Success regist Talk request");
        */

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

        /*
        // 応答をDBに記録
        const timestampEnd = new Date();
        await TalkModel.create({
          userId : threadOwnerId,
          contents : JSON.stringify(texts),
          dist : "res",
          timestamp : timestampEnd
        })
        console.log("Success regist OpenAI response");
        */
      } catch(err) {
        console.error("[lineEvent] error:", err);
        try {
            await replyAndPushLine({
              replyToken: event.replyToken,
              to: recipientId,
              texts: ["⚠️内部エラーが発生しました。時間をおいてもう一度お試しください。"],
              delayMs: 250,
            });
        } catch {
        }
      }
    } // endif (event.message.type == "text")
  } // endif (event.type == "message")
}
