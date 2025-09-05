import { messagingApi, type WebhookEvent } from "@line/bot-sdk";
import { TalkModel } from "@/models/talk";
//import connectDB from "@/utils/connectDB";
import { connectBing } from "@/utils/connectBing";

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || "",
  channelSecret: process.env.LINE_CHANNEL_SECRET || "",
};

const client = new messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

export async function lineEvent(event: WebhookEvent) {
  if (event.type == "message"){
    if (event.message.type == "text") {
      const { userId } = event.source;
      const { text } = event.message;
      // const timestampStart = new Date();

      /*
      await connectDB()
      // メッセージをDBに記録
      await TalkModel.create({
        userId : userId,
        contents : text,
        dist : "req",
        timestamp : timestampStart
      })
      console.log("Success regist Talk request");
      */

      // Azure OpenAI (Grounding with Bing Search) への問い合わせ
      const res = await connectBing(userId, text);
      console.log("#### CONNECT BING RESPONSE####");
      console.log(res);

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
