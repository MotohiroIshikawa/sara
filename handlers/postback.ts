// postbackの共通ルータ
import { type WebhookEvent, type PostbackEvent } from "@line/bot-sdk";
import { decodePostback } from "@/utils/postback";
import * as gpts from "@/handlers/postbacks/gpts";

// ハンドラ型
type Handler = (event: PostbackEvent, args?: Record<string, string>) => Promise<void>;

// 名前空間->ハンドラ関数テーブル
const table: Record<string, Record<string, Handler>> = {
  gpts: {
    save: gpts.save,
    continue: gpts.cont,
  },
};

export async function handlePostback(event: WebhookEvent): Promise<void> {
  if (event.type !== "postback" || !event.postback?.data) return;

  const env = decodePostback(event.postback.data);
  if (!env) return;

  const mod = table[env.ns];
  const fn = mod?.[env.fn];
  if (!fn) {
    console.warn(`[postback] unknown ns/fn: ${env.ns}/${env.fn}`);
    return;
  }

  try {
    await fn(event as PostbackEvent, env.args ?? {});
  } catch (e) {
    console.error(`[postback] handler error: ${env.ns}/${env.fn}`, e);
  }
}
