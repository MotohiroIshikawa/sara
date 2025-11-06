import type { SourceType } from "@/types/gpts";
import type { WebhookEvent, PostbackEvent, MessageEvent } from "@line/bot-sdk";

type SourceUser  = { type: "user";  userId: string };
type SourceGroup = { type: "group"; groupId: string; userId?: string };
type SourceRoom  = { type: "room";  roomId: string;  userId?: string };
type Source = SourceUser | SourceGroup | SourceRoom;
type WithSource = { source: Source };

type LineEvent = (WebhookEvent | PostbackEvent | MessageEvent) & WithSource;

// source.type を返す（"user" | "group" | "room"）。無ければ undefined
export function getSourceType(e: LineEvent): SourceType | undefined {
  const s: Source | undefined = e.source as Source | undefined;
  if (!s) return undefined;
  if (s.type === "user" || s.type === "group" || s.type === "room") return s.type;
  return undefined;
}

// 返信/Pushの宛先IDを返す（userId / groupId / roomId）。無ければ undefined
export function getSourceId(e: LineEvent): string | undefined {
  const s: Source | undefined = e.source as Source | undefined;
  if (!s) return undefined;
  if (s.type === "user") return s.userId;
  if (s.type === "group") return s.groupId;
  if (s.type === "room") return s.roomId;
  return undefined;
}

export function getSpeakerUserId(e: LineEvent): string | undefined {
  const s: Source | undefined = e.source as Source | undefined;
  if (!s) return undefined;
  if (s.type === "user") return s.userId;
  if ("userId" in s && typeof s.userId === "string" && s.userId.length > 0) {
    return s.userId;
  }
  return undefined;
}