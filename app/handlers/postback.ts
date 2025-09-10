// handlers/postback.ts
import { type WebhookEvent } from "@line/bot-sdk";
import { decodePostback } from "@/utils/postback";
import * as gpts from "@/handlers/postbacks/gpts";

// 名前空間 → ハンドラ関数テーブル
const table: Record<string, Record<string, (event: WebhookEvent, args?: Record<string,string>) => Promise<void>>> = {
  gpts: {
    save: gpts.save,
    continue: gpts.cont,  // data: fn=continue → cont() を呼ぶ
  },
};

export async function handlePostback(event: WebhookEvent): Promise<void> {
  if (event.type !== "postback" || !event.postback?.data) return;
  const env = decodePostback(event.postback.data);
  if (!env) return;

  const mod = table[env.ns];
  const fn = mod?.[env.fn];
  if (!fn) {
    // 未対応の postback は黙殺（必要ならログ/通知）
    // console.warn(`[postback] unknown ns/fn: ${env.ns}/${env.fn}`);
    return;
  }
  await fn(event, env.args ?? {});
}
