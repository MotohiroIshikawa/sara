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
        await connectDB()
        await TalkModel.create({
          userId : event.source.userId,
          contents : event.message.text,
          dist : "req",
          timestamp : new Date()
        })
        console.log("Success regist Talk");

        const { replyToken } = event;
        await client.replyMessage({
            replyToken,
            messages: [
                {
                    "type" : "text",
                    "text" : `${event.message.text}\nメッセージを受け取りました！`,
                },
                {
                    "type" : "text",
                    "text" : `UserId: ${event.source.userId}`
                }
            ],
        })
      }
    }
    return;
}