// postbackの共通ルータ
import { type WebhookEvent, type PostbackEvent } from "@line/bot-sdk";
import { decodePostback } from "@/utils/postback";
import * as gpts from "@/handlers/postbacks/gpts";
import { CorrContext } from "@/logging/corr";

// ハンドラ型
type Handler = (event: PostbackEvent, args?: Record<string, string>) => Promise<void>;

// 名前空間->ハンドラ関数テーブル
const table: Record<string, Record<string, Handler>> = {
  gpts: {
    save: gpts.save,
    continue: gpts.cont,
  },
};

//  ログ用にsourceを取り出す
function getSourceId(e: PostbackEvent): { type: string; id?: string } {
  switch (e.source.type) {
    case "user":  return { type: "user",  id: e.source.userId };
    case "group": return { type: "group", id: e.source.groupId };
    case "room":  return { type: "room",  id: e.source.roomId };
    default:      return { type: "unknown" };
  }
}

/**
 * MAIN
 * 
 * @param event 
 * @returns 
 */
export async function handlePostback(event: WebhookEvent): Promise<void> {
  if (event.type !== "postback" || !event.postback?.data) return;

  const pe = event as PostbackEvent;
  const src = getSourceId(pe);
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
    src,                               // { type: "user"|"group"|"room", id }
    rawData,                           // エンコードされた data 文字列
    params: pe.postback.params ?? null, // datetime picker 等
    action: decoded ? `${decoded.ns}/${decoded.fn}` : "unknown",
    args: decoded?.args ?? null,       // { tid: "...", ... }
    ctx,
  });

  if (!decoded) return;
  
  const mod = table[decoded.ns];
  const fn = mod?.[decoded.fn];
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
