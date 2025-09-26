import { messagingApi } from "@line/bot-sdk";
import { LINE } from "@/utils/env";

const pushMax = LINE.PUSH_MAX;
const replyMax = LINE.REPLY_MAX;
const textLimit = LINE.TEXT_LIMIT;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Message = messagingApi.Message;
type TextMessage = messagingApi.TextMessage;
type TemplateMessage = messagingApi.TemplateMessage;

const client = new messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN!,
});

// 文字列配列 → LINE TextMessage[]（空/空白は除去、各要素2000字に丸め）
export function toTextMessages(blocks: string[], limit = textLimit): TextMessage[] {
  return blocks
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => ({ type: "text", text: t.slice(0, limit) }));
}

// 「保存|続ける」のConfirm作成
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


// 任意配列をサイズごとに分割
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// LINEの reply token 無効エラー判定（型に依存しない軽量チェック）
type MaybeHttpError = { status?: number; message?: string; response?: { status?: number } };
function isInvalidReplyToken(err: unknown): boolean {
  const e = err as MaybeHttpError | undefined;
  const msg = (e?.message ?? "").toLowerCase();
  const status = e?.status ?? e?.response?.status;
  return (
    status === 400 &&
    ( msg.includes("invalid reply token") || msg.includes("may not be empty") ) // ★追加
  );
}

/**
 * 汎用送信：先頭から最大5件を reply、残りは push（5件ずつ）
 * - Text/Template/Flex など LINE の Message 型なら混在OK
 * - reply 失敗時（Invalid reply token のみ）→ push にフォールバック
 */
export async function sendMessagesReplyThenPush({
  replyToken,
  to,
  messages,
  delayMs = 250,
  log = console,
}: {
  replyToken?: string | null;
  to: string;
  messages: Message[];
  delayMs?: number;
  log?: Pick<typeof console, "info" | "warn" | "error">;
}): Promise<void> {
  if (!messages?.length) {
    const fallback: TextMessage = { type: "text", text: "何か途中で失敗しました。もう一度お願いします" };
    if (to) {
      try {
        await client.pushMessage({ to, messages: [fallback] });
        return;
      } catch (e) {
        log?.error?.("[LINE pushMessage] failed (empty messages fallback):", e);
      }
    }
    // push できない場合のみ reply を試す
    await client.replyMessage({ replyToken: String(replyToken ?? ""), messages: [fallback] });
    return;
  }

  // replyTokenが無い場合は最初からpushに切り替え
  if (!replyToken) {
    for (const batch of chunk(messages, pushMax)) {
      try {
        await client.pushMessage({ to, messages: batch });
      } catch (e) {
        log?.error?.("[LINE pushMessage] failed (no replyToken path):", e);
        break;
      }
      if (delayMs > 0) await sleep(delayMs);
    }
    return;
  }

  // 1. reply（最大5件）
  const first = messages.slice(0, replyMax);
  try {
    await client.replyMessage({ replyToken, messages: first });
  } catch (e) {
    log?.warn?.("[LINE replyMessage] failed:", e);
    // 無効トークンのみ push にフォールバック（その他エラーは上位へ）
    if (to && isInvalidReplyToken(e)) {
      log?.warn?.("[lineSend] reply failed (Invalid reply token). Fallback to push.");
      // すべて push（5件ずつ）
      for (const batch of chunk(messages, pushMax)) {
        try {
          await client.pushMessage({ to, messages: batch });
        } catch (pe) {
          log?.error?.("[LINE pushMessage] failed during fallback:", pe);
          break;
        }
        if (delayMs > 0) await sleep(delayMs);
      }
      return;
    }
    throw e;
  }

  if (delayMs > 0) await sleep(delayMs);

  // 2. 6件目以降があれば push（5件ずつ）
  const rest = messages.slice(replyMax);
  for (const batch of chunk(rest, pushMax)) {
    try {
      await client.pushMessage({ to, messages: batch });
    } catch (e) {
      log?.error?.("[LINE pushMessage] failed:", e);
      break;
    }
    if (delayMs > 0) await sleep(delayMs);
  }
}

/*
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
}) : Promise<void> {
  if (!messages?.length) return;

  for (const batch of chunk(messages, pushMax)) {
    try {
      await client.pushMessage({ to, messages: batch });
    } catch (e) {
      log?.error?.("[LINE pushMessage] failed:", e);
      break;
    }
    if (delayMs > 0) await sleep(delayMs);
  }
}
*/