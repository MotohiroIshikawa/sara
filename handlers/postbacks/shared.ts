import type { PostbackEvent } from "@line/bot-sdk";

export type Handler = (event: PostbackEvent, args?: Record<string, string>) => Promise<void>;
export type Namespace = "gpts" | "chat" | "sched";

export function isNs(x: string): x is Namespace {
  return x === "gpts" || x === "chat" || x === "sched";
}
