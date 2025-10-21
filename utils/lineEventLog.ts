import type { WebhookEvent, MessageEvent } from "@line/bot-sdk";

// 文字列を省略（maxを超えたら末尾に…）
function ellipsize(s: unknown, max: number = 300): string | unknown {
  if (typeof s !== "string") return s;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// IDを短縮表示用に加工
function shortId(id?: string): string | undefined {
  return id ? `${id.slice(0, 4)}…${id.slice(-4)}` : undefined;
}

// LINE Webhook をログ向けに要約
export function buildLineEventLog(e: WebhookEvent): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type: e.type,
    source: e.source?.type,
    sourceId:
      e.source?.type === "user" ? shortId(e.source.userId)
      : e.source?.type === "group" ? shortId(e.source.groupId)
      : e.source?.type === "room" ? shortId(e.source.roomId)
      : undefined,
    hasReplyToken: (e as { replyToken?: string }).replyToken !== undefined,
    timestamp: typeof e.timestamp === "number" ? new Date(e.timestamp).toISOString() : undefined,
  };

  switch (e.type) {
    case "message": {
      const m = (e as MessageEvent).message;
      const msg: Record<string, unknown> = { id: (m as { id?: string }).id, type: m?.type };

      if (m?.type === "text") {
        msg.text = ellipsize(m.text, 500);
      } else if (m?.type === "image" || m?.type === "video" || m?.type === "audio") {
        msg.contentProvider = m.contentProvider?.type;
      } else if (m?.type === "file") {
        msg.fileName = m.fileName;
        msg.fileSize = m.fileSize;
      } else if (m?.type === "sticker") {
        msg.packageId = m.packageId;
        msg.stickerId = m.stickerId;
      } else if (m?.type === "location") {
        msg.title = m.title;
        msg.address = m.address;
        msg.latitude = m.latitude;
        msg.longitude = m.longitude;
      }
      return { ...base, message: msg };
    }

    case "postback": {
      const p = e.postback;
      return {
        ...base,
        postback: {
          data: ellipsize(p?.data, 500),
          params: p?.params, // date, time, datetime など
        },
      };
    }

    case "follow":
    case "unfollow":
    case "join":
    case "leave":
      return base;

    case "memberJoined": {
      const members: string[] = Array.isArray(e.joined?.members)
        ? e.joined.members
            .map((m: unknown) => ("userId" in (m as object) ? shortId((m as { userId?: string }).userId) : undefined))
            .filter((v: string | undefined): v is string => typeof v === "string")
        : [];
      return { ...base, members };
    }

    case "memberLeft": {
      const members: string[] = Array.isArray(e.left?.members)
        ? e.left.members
            .map((m: unknown) => ("userId" in (m as object) ? shortId((m as { userId?: string }).userId) : undefined))
            .filter((v: string | undefined): v is string => typeof v === "string")
        : [];
      return { ...base, members };
    }

    default:
      return base;
  }
}
