import { messagingApi } from "@line/bot-sdk";
type Message = messagingApi.Message;
type TextMessage = messagingApi.TextMessage;
type TemplateMessage = messagingApi.TemplateMessage;

const client = new messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN!,
});

const replyMax = 5;
const pushMax = 5;
const textLimit = 2000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 文字列配列 → LINE TextMessage[]（空/空白は除去、各要素2000字に丸め）
export function toTextMessages(blocks: string[], limit = textLimit): TextMessage[] {
  return blocks
    .filter(Boolean)
    .map((t) => t!.trim())
    .filter((t) => t.length > 0)
    .map((t) => ({ type: "text", text: t.slice(0, limit) }));
}

export function buildSaveOrContinueConfirm({
  text = "この内容で保存しますか？",
  saveData,
  continueData,
  saveLabel = "保存",
  continueLabel = "続ける",
}: {
  text?: string;
  saveData: string;       // 例: `gpts:save:<threadId>`
  continueData: string;   // 例: `gpts:continue:<threadId>`
  saveLabel?: string;
  continueLabel?: string;
}): TemplateMessage {
  return {
    type: "template",
    altText: "保存/続ける",
    template: {
      type: "confirm",
      text,
      actions: [
        { type: "postback", label: saveLabel, data: saveData },
        { type: "postback", label: continueLabel, data: continueData },
      ],
    },
  };
}

/**
 * 汎用送信：先頭から最大5件を reply、残りは push（5件ずつ）
 * - Text/Template/Flex など LINE の Message 型なら混在OK
 * - エラー時は reply で停止（push は試みない）
 */
export async function sendMessagesReplyThenPush({
  replyToken,
  to,
  messages,
  delayMs = 250,
  log = console,
}: {
  replyToken: string;
  to: string;
  messages: Message[];
  delayMs?: number;
  log?: Pick<typeof console, "info" | "warn" | "error">;
}) {
  if (!messages?.length) {
    // 応答は必要なので、最低限のエラーメッセージを返す
    await client.replyMessage({
      replyToken,
      messages: [{ type: "text", text: "何か途中で失敗しました。もう一度お願いします" }],
    });
    return;
  }

  // 1) reply（最大5件）
  const first = messages.slice(0, replyMax);
  try {
    await client.replyMessage({
       replyToken, 
       messages: first 
    });
  } catch (e) {
    log?.warn?.("[LINE replyMessage] failed:", e);
    return; // reply が失敗したら push はやらない（二重送信防止）
  }

  if (delayMs > 0) await sleep(delayMs);

  // 2) 6件目以降があれば push（5件ずつ）
  const rest = messages.slice(replyMax);
  for (let i = 0; i < rest.length; i += pushMax) {
    const batch = rest.slice(i, i + pushMax);
    try {
      await client.pushMessage({ 
        to, 
        messages: batch 
      });
    } catch (e) {
      log?.error?.("[LINE pushMessage] failed:", e);
      break;
    }
    if (delayMs > 0) await sleep(delayMs);
  }
}

export async function pushMessages({
  to,
  messages,
  delayMs = 150,
  log = console,
}: {
  to: string;
  messages: Message[];
  delayMs?: number;
  log?: Pick<typeof console, "info" | "warn" | "error">;
}) {
  for (let i = 0; i < messages.length; i += pushMax) {
    const batch = messages.slice(i, i + pushMax);
    try {
      await client.pushMessage({ 
        to, 
        messages: batch 
      });
    } catch (e) {
      log?.error?.("[LINE pushMessage] failed:", e);
      break;
    }
    if (delayMs > 0) await sleep(delayMs);
  }
}