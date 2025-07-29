import { NextRequest, NextResponse } from "next/server";
import { 
    messagingApi, 
    validateSignature, 
    WebhookEvent} from "@line/bot-sdk";

const config = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || "",
    channelSecret: process.env.LINE_CHANNEL_SECRET || "",
};

const client = new messagingApi.MessagingApiClient({
    channelAccessToken: config.channelAccessToken,
});

export async function GET() {
        return NextResponse.json(
            { status: 200 }
        );
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.text();
        const signature = req.headers.get("x-line-signature") || "";

        if (!validateSignature(body, config.channelSecret, signature)) {
            return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
        }

        const events: WebhookEvent[] = JSON.parse(body).events;

        for (const event of events) {
            await handleEvent(event);
        }

        return NextResponse.json({ status: "ok" });
    }catch (error) {
        console.error("Webhook error:", error);
        return NextResponse.json(
            { error: "Internal server error" },
            { status: 500 }
        );
    }
}

// イベント処理
async function handleEvent(event: WebhookEvent) {
    if (event.type !== "message" || event.message.type !== "text") {
        return;
    }

    const { text } = event.message;
    const { replyToken } = event;
    const { userId } = event.source;

    await client.replyMessage({
        replyToken,
        messages: [
            {
                "type" : "text",
                "text" : `${text}\nメッセージを受け取りました！`,
            },
            {
                "type" : "text",
                "text" : `UserId: ${userId}`
            }
        ],
    })
}
 