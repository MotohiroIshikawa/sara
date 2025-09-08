import { messagingApi, type TextMessage } from "@line/bot-sdk";

const client = new messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN!,
});

const replyMax = 5;
const pushMax = 5;
const textLimit = 2000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toTextMessages(blocks: string[]): TextMessage[] {
  return blocks
    .filter((t) => t && t.trim().length > 0)
    .map((t) => ({ type: "text", text: t.slice(0, textLimit) }));
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * 返信トークンで最初の最大5件をreply。
 * 6件目以降は pushMessage で 5件ずつ送る。
 *
 * - 追加の状態管理は不要
 * - push の間に短い待機を入れてレートを穏やかに
 */
export async function replyAndPushLine(
  {
    replyToken,
    userId,
    texts,
    delayMs = 250,  // push間インターバル（0で無効）
    log = console,  // ログ出力先（任意）
  }: {
    replyToken: string;
    userId: string;
    texts: string[];
    delayMs?: number;
    log?: Pick<typeof console, "info" | "warn" | "error">;
  }
) {
  const msgs = toTextMessages(texts);
  if (msgs.length === 0) {
    await client.replyMessage({
      replyToken, 
      messages: [{ type: "text", text: "何か途中で失敗しました。もう一度お願いします" }]
    });
    return;
  }

  // 1. replyMessageとして送信 (最初の5件)
  const first = msgs.slice(0, replyMax);
  try {
    await client.replyMessage({
      replyToken, 
      messages: first
    });
  } catch (e) {
    log?.warn?.("[LINE replyMessage] failed, fallback to push:", e);
    return;
  }
  await sleep(delayMs); 

  // 2. 6件目以降ある場合は残りを5件ずつpushMessageとして送信
  const rest = msgs.slice(replyMax);
  if (rest.length === 0) return;

  for (const batch of chunk(rest, pushMax)) {
    try {
      await client.pushMessage({
        to: userId, 
        messages: batch
      });
    } catch (e) {
      log?.error?.("[LINE pushMessage] failed:", e);
      break;
    }
    if (delayMs > 0) await sleep(delayMs);
  }
}
