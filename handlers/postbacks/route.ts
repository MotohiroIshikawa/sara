import type { WebhookEvent, PostbackEvent } from "@line/bot-sdk";
import { CorrContext } from "@/logging/corr";
import { describeSource } from "@/utils/lineSource";
import { decodePostback } from "@/utils/postback";
import { gptsHandlers, chatHandlers } from "@/handlers/postbacks/gpts";
import { schedHandlers } from "@/handlers/postbacks/sched";
import { isNs, type Handler, type Namespace } from "@/handlers/postbacks/shared";

/** ルーティングテーブル（nsごとにサブモジュールへ委譲） */
const TABLE: Record<Namespace, Record<string, Handler>> = {
  gpts: gptsHandlers,
  chat: chatHandlers,
  sched: schedHandlers,
};

export async function handlePostback(event: WebhookEvent): Promise<void> {
  if (event.type !== "postback" || !event.postback?.data) return;

  const pe = event as PostbackEvent;
  const src = describeSource(pe);
  const corr = CorrContext.get();
  const rawData = pe.postback.data;
  const decoded = decodePostback(rawData);

  const ctx = {
    requestId: corr?.requestId,
    threadId: decoded?.args?.tid ?? corr?.threadId,
    runId: decoded?.args?.rid ?? corr?.runId,
    userId: src.id,
  };

  console.info("[postback] received", {
    src,
    rawData,
    params: pe.postback.params ?? null,
    action: decoded ? `${decoded.ns}/${decoded.fn}` : "unknown",
    args: decoded?.args ?? null,
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
    await fn(pe, decoded.args ?? {});
    console.info("[postback] handled", {
      action: `${decoded.ns}/${decoded.fn}`,
      args: decoded.args ?? null,
      src,
      ctx,
    });
  } catch (e) {
    console.error(`[postback] handler error: ${decoded.ns}/${decoded.fn}`, e, { ctx });
  }
}
