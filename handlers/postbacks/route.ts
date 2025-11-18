import type { WebhookEvent, PostbackEvent } from "@line/bot-sdk";
import { CorrContext } from "@/logging/corr";
import { getSourceId, getSourceType } from "@/utils/line/lineSource";
import { decodePostback } from "@/utils/line/postback";
import { gptsHandlers, chatHandlers } from "@/handlers/postbacks/gpts";
import { schedHandlers } from "@/handlers/postbacks/sched";
import { isNs, type Handler, type Namespace } from "@/handlers/postbacks/shared";

function normalizeArgs(obj: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[String(k)] = String(v ?? "");
    }
  }
  return out;
}

// ルーティングテーブル（nsごとにサブモジュールへ委譲）
const TABLE: Record<Namespace, Record<string, Handler>> = {
  gpts: gptsHandlers,
  chat: chatHandlers,
  sched: schedHandlers,
};

type SourceType = "user" | "group" | "room";
type Src = { type: SourceType | undefined; id: string | undefined };

export async function handlePostback(event: WebhookEvent): Promise<void> {
  if (event.type !== "postback" || !event.postback?.data) return;

  const pe: PostbackEvent = event as PostbackEvent;
  const src: Src = {
    type: getSourceType(pe),
    id: getSourceId(pe),
  };
  const corr = CorrContext.get();
  const rawData: string = pe.postback.data;
  const decoded = decodePostback(rawData);
  const decodedArgs: Record<string, string> = normalizeArgs(decoded?.args);

  const ctx = {
    requestId: corr?.requestId,
    threadId: decodedArgs["tid"] ?? corr?.threadId,
    runId: decodedArgs["rid"] ?? corr?.runId,
    userId: src.type === "user" ? src.id : undefined,
  };

  console.info("[postback] received", {
    src,
    rawData,
    params: pe.postback.params ?? null,
    action: decoded ? `${decoded.ns}/${decoded.fn}` : "unknown",
    args: decodedArgs, // ★ ログも統一
    ctx,
  });

  if (!decoded) return;
  if (!isNs(decoded.ns)) {
    console.warn(`[postback] unknown ns: ${decoded.ns}`, { ctx });
    return;
  }

  const mod = TABLE[decoded.ns];
  const fn: Handler | undefined = mod?.[decoded.fn];
  if (!fn) {
    console.warn(`[postback] unknown ns/fn: ${decoded.ns}/${decoded.fn}`, { ctx });
    return;
  }

  try {
    await fn(pe, decodedArgs);
    console.info("[postback] handled", {
      action: `${decoded.ns}/${decoded.fn}`,
      args: decodedArgs,
      src,
      ctx,
    });
  } catch (e) {
    console.error(`[postback] handler error: ${decoded.ns}/${decoded.fn}`, e, { ctx });
  }
}
