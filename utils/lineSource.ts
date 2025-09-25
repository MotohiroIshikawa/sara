import type { WebhookEvent, PostbackEvent, MessageEvent } from "@line/bot-sdk";

type Source =
  | { type: "user";  userId: string }
  | { type: "group"; groupId: string }
  | { type: "room";  roomId: string };

type WithSource = { source: Source };

export type LineEvent = WebhookEvent | PostbackEvent | MessageEvent | WithSource;

export type SourceKind = "user" | "group" | "room" | "unknown";
export type ScopeTag = "user" | "group" | "room";

function srcOf(e: LineEvent): Source | undefined {
  const s = (e as WithSource).source as Source | undefined;
  if (!s) return undefined;
  if (s.type === "user" || s.type === "group" || s.type === "room") return s;
  return undefined;
}

/** 返信/Pushの宛先IDを返す（userId / groupId / roomId）。無ければ undefined */
export function getRecipientId(e: LineEvent): string | undefined {
  const s = srcOf(e);
  if (!s) return undefined;
  if (s.type === "user")  return s.userId;
  if (s.type === "group") return s.groupId;
  if (s.type === "room")  return s.roomId;
}

export function getThreadOwnerId(
  e: LineEvent,
  format: "plain" | "scoped" = "scoped",
): string | undefined {
  const s = srcOf(e);
  if (!s) return undefined;
  if (format === "plain") {
    if (s.type === "user")  return s.userId;
    if (s.type === "group") return s.groupId;
    if (s.type === "room")  return s.roomId;
    return undefined;
  }
  // scoped
  if (s.type === "user")  return `user:${s.userId}`;
  if (s.type === "group") return `group:${s.groupId}`;
  if (s.type === "room")  return `room:${s.roomId}`;
  return undefined;
}

export function getUserIdIfAny(e: LineEvent): string | undefined {
  const s = srcOf(e);
  return s?.type === "user" ? s.userId : undefined;
}

export function describeSource(e: LineEvent): { type: SourceKind; id?: string } {
  const s = srcOf(e);
  if (!s) return { type: "unknown" };
  if (s.type === "user")  return { type: "user",  id: s.userId };
  if (s.type === "group") return { type: "group", id: s.groupId };
  if (s.type === "room")  return { type: "room",  id: s.roomId };
  return { type: "unknown" };
}

// 任意のIDを "<scope>:<id>" に正規化
export function toScopedId(scope: ScopeTag, id: string): string {
  if (!id) throw new Error("id is empty");
  const prefix = `${scope}:`;
  return id.startsWith(prefix) ? id : `${prefix}${id}`;
}

// プレーンな LINE userId (U...) → "user:U..." へ
export function toScopedUserId(userId: string): string {
  if (!userId) throw new Error("userId is empty");
  return toScopedId("user", userId);
}

// 文字列が "<scope>:<id>" 形式か判定
export function isScopedId(v: string): boolean {
  return /^[a-z]+:.+$/i.test(v);
}

// "<scope>:<id>" を分解
export function parseScopedId(scoped: string): { scope: ScopeTag; id: string } {
  const idx = scoped.indexOf(":");
  if (idx <= 0) throw new Error("invalid scopedId");
  const scope = scoped.slice(0, idx) as ScopeTag;
  const id = scoped.slice(idx + 1);
  return { scope, id };
}