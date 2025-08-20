import { messagingApi, WebhookEvent } from "@line/bot-sdk";
import { TalkModel } from "@/models/talk";
import connectDB from "@/utils/connectDB";
import { connectOpenAI } from "@/utils/connectOpenAI";
import connectBing from "@/utils/connectBing";
import connectBing2 from "@/utils/connectBing2";

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || "",
  channelSecret: process.env.LINE_CHANNEL_SECRET || "",
};

const client = new messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

export async function lineEvent(event: WebhookEvent) {
  let aiResponse = "";
  if (event.type == "message"){
    if (event.message.type == "text") {
      const { userId } = event.source;
      const { text } = event.message;
      const timestampStart = new Date();

      await connectDB()
      // メッセージをDBに記録
      await TalkModel.create({
        userId : userId,
        contents : text,
        dist : "req",
        timestamp : timestampStart
      })
      console.log("Success regist Talk request");

      // Azure OpenAIへの問い合わせ
      const res = await connectBing(text);
      console.log(res);
/*
      const baseURL = process.env.BASE_URL;
      try{
        const res = await fetch(baseURL + 'api/getOpenAI', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', },
          body: JSON.stringify({text}),
        });
        aiResponse = await res.json();
        console.log("aiResponse: " + aiResponse);
      } catch {
        console.log("AI取得エラー");
        }
*/
/*
      // LINEへの応答
      const { replyToken } = event;
      await client.replyMessage({
          replyToken,
          messages: [
              {
                  "type" : "text",
                  "text" : aiResponse,
              }
          ],
      })

      // 応答をDBに記録
      const timestampEnd = new Date();
      await TalkModel.create({
        userId : userId,
        contents : detail,
        dist : "res",
        timestamp : timestampEnd
      })
      console.log("Success regist OpenAI response");
*/
    }
  }
  return;
}
