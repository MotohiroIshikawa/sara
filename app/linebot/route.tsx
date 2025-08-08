'use client';

import { NextRequest, NextResponse } from "next/server";
import { validateSignature, WebhookEvent} from "@line/bot-sdk";
import { lineEvent } from "../actions/lineEvent";

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
        if (!validateSignature(body, config.channelSecret, signature)) {
            return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
        }
        const events: WebhookEvent[] = JSON.parse(body).events;
        for (const event of events) {
            await lineEvent(event);
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