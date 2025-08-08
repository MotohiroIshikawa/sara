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
        const userId = event.source.userId;
        const contents = event.message.text;
        const timestampStart = new Date();
        await connectDB()
        await TalkModel.create({
          userId : userId,
          contents : contents,
          dist : "req",
          timestamp : timestampStart
        })
        console.log("Success regist Talk request");

        const aiResponce = await getOpenAi(contents);
        const { title, detail } = JSON.parse(aiResponce.data[0].message.content);
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
      }
    }
    return;
}

function azopenaichat(contents: any) {
  throw new Error("Function not implemented.");
}
function getOpenAi(contents: any) {
  throw new Error("Function not implemented.");
}

