import { messagingApi, WebhookEvent } from "@line/bot-sdk";
import { TalkModel } from "@/models/talk";
import connectDB from "@/utils/connectDB";

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
        const timestampStart = new Date();

        await connectDB()
        // メッセージをMongoDB記録
        await TalkModel.create({
          userId : userId,
          contents : text,
          dist : "req",
          timestamp : timestampStart
        })
        console.log("Success regist Talk request");
        // 
        const baseURL = process.env.BASE_URL;
        try{
          const aiResponse = await fetch(baseURL + 'api/getOpenAI', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', },
            body: JSON.stringify({text}),
          });
          console.log("lioneEvents->aiResponse");
          console.log(aiResponse);
          const response = await aiResponse.json();
          const title = response.content.title;
          const detail = response.content.detail;
          console.log("content");
          console.log(JSON.stringify(response));
          console.log("title:"+title);
          console.log("detail:"+detail);
        } catch {
          console.log("AI取得エラー");
        }
          /*
        const { replyToken } = event;
        await client.replyMessage({
            replyToken,
            messages: [
                {
                    "type" : "text",
                    "text" : title,
                },
                {
                    "type" : "text",
                    "text" : detail,
                }
            ],
        })
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
