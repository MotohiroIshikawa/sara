import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { validateSignature, type WebhookEvent} from "@line/bot-sdk";
import { lineEvent } from "@/handlers/lineEvent";
import { CorrContext } from "@/logging/corr";
import { getSourceId } from "@/utils/line/lineSource";

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || "",
  channelSecret: process.env.LINE_CHANNEL_SECRET || "",
};

export async function GET() {
        return NextResponse.json(
            { status: 200 }
        );
}

export async function POST(req: NextRequest) {
    try {
      const body = await req.text();
      const signature = req.headers.get("x-line-signature") || "";
      // シグネチャ検証
      if (!validateSignature(body, config.channelSecret, signature)) {
          return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
      }
      const events: WebhookEvent[] = JSON.parse(body).events;
      const requestId = nanoid(); 

      for (const event of events) {
        const recipientId = getSourceId(event);
          // LINEイベントハンドラ
        await CorrContext.run({ requestId, userId: recipientId }, async () => {
          await lineEvent(event);
        });
      }
      return NextResponse.json({ status: "ok" });
    
    }catch (error) {
      console.error("Webhook error:", error, { ctx: CorrContext.get() });
      return NextResponse.json(
          { error: "Internal server error" },
          { status: 500 }
      );
    }
}