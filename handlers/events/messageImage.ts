import { type MessageEvent } from "@line/bot-sdk";
import { sendMessagesReplyThenPush, toTextMessages } from "@/utils/lineSend";
import { getMsg } from "@/utils/msgCatalog";
import { uploadBufferAndGetSasUrl } from "@/utils/azureBlob";
import { connectBing } from "@/utils/connectBing";
import { compressIfNeeded } from "@/utils/imageProcessor";
import { IMAGE } from "@/utils/env";

const imageDedupMap: Map<string, number> = new Map();
const IMAGE_DEDUP_TTL_MS: number = 5 * 60 * 1000;

function isDuplicateAndMark(messageId: string): boolean {
  const now: number = Date.now();
  // 期限切れ掃除（軽量）
  for (const [k, exp] of imageDedupMap) {
    if (exp < now) imageDedupMap.delete(k);
  }
  const existsUntil: number | undefined = imageDedupMap.get(messageId);
  if (typeof existsUntil === "number" && existsUntil > now) {
    return true; // 直近で処理中/処理済み
  }
  imageDedupMap.set(messageId, now + IMAGE_DEDUP_TTL_MS);
  return false;
}

// バリデーション
const ALLOWED_MIME: readonly string[] = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
];

// LINE画像をBuffer取得（Content-Typeも取得）
async function fetchLineImageAsBuffer(messageId: string): Promise<{ buf: Buffer; ctype: string }> {
  const token: string | undefined = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not set");

  const url: string = `https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`;
  const res: Response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok || !res.body) {
    throw new Error(`Failed to fetch image content: ${res.status} ${res.statusText}`);
  }

  const contentType: string = res.headers.get("content-type") ?? "application/octet-stream";
  const ctype: string = contentType.split(";")[0].trim().toLowerCase();

  // ReadableStream → Buffer
  const reader: ReadableStreamDefaultReader<Uint8Array> = res.body.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const r: ReadableStreamReadResult<Uint8Array> = await reader.read();
    if (r.done) break;
    if (r.value) chunks.push(r.value);
  }
  const buf: Buffer = Buffer.concat(chunks);
  return { buf, ctype };
}

// messageイベント処理(image)
export async function handleMessageImage(
  event: MessageEvent,
  recipientId: string,
  threadOwnerId: string
): Promise<void> {
  // 型ガード：image以外は無視
  if (event.type !== "message" || event.message.type !== "image") return;

  const messageId: string = event.message.id;
  const srcType: "user" | "group" | "room" = event.source.type;

  // 同一 messageId の多重実行を抑止（TTL内は即return）
  if (isDuplicateAndMark(messageId)) {
    console.info?.("[messageImage] duplicate suppressed", { messageId, recipientId });
    return;
  }

  let notifyTimer: NodeJS.Timeout | undefined;
  let processingNotified = false;
  const startedAt: number = Date.now();

  try {
    const { buf, ctype } = await fetchLineImageAsBuffer(messageId);
    console.info("[messageImage] fetched image buffer", {
      messageId,
      recipientId,
      bytes: buf.byteLength,
      ctype,
    });

    // バリデーション：形式
    if (!ALLOWED_MIME.includes(ctype)) {
      const warnText: string = getMsg("IMAGE_UNSUPPORTED");
      await sendMessagesReplyThenPush({
        replyToken: event.replyToken,
        to: recipientId,
        messages: toTextMessages([warnText]),
        delayMs: 0,
      });
      console.warn("[messageImage] unsupported MIME", { messageId, ctype });
      return;
    }

    // Azure/Bing 側の制約を考慮し、必要時のみ圧縮/リサイズ（目安: 4MB・4096px）
    const processed = await compressIfNeeded(buf, ctype, {
      maxBytes: 4 * 1024 * 1024,
      maxWidth: 4096,
      maxHeight: 4096,
    });
    console.info("[messageImage] image processed", {
      messageId,
      recipientId,
      before_bytes: buf.byteLength,
      before_type: ctype,
      after_bytes: processed.buffer.byteLength,
      after_type: processed.contentType,
      resized: processed.resized,
    });

    // Azure Blob へアップロード → SAS URL取得
    const sasUrl: string = await uploadBufferAndGetSasUrl(processed.buffer, processed.contentType);
    console.info("[messageImage] uploaded to blob", { messageId, recipientId, sasUrl });

    // 処理中通知（閾値超過で一度だけ reply 送信）
    const thresholdMs: number = IMAGE.PROCESSING_NOTIFY_THRESHOLD_SEC * 1000;
    notifyTimer = setTimeout(() => {
      sendMessagesReplyThenPush({
        replyToken: event.replyToken,
        to: recipientId,
        messages: toTextMessages([getMsg("IMAGE_PROCESSING_WAIT")]),
        delayMs: 0,
      }).catch((e) => {
        console.warn("[messageImage] processing notify failed", { messageId, recipientId, err: String(e) });
      });
      processingNotified = true;
      console.info("[messageImage] processing notification sent", {
        messageId,
        recipientId,
        thresholdMs,
      });
    }, thresholdMs);

    // connectBing を画像入力で実行（テキストは空）
    const result = await connectBing(threadOwnerId, "", {
      sourceType: srcType,
      imageUrls: [sasUrl],
    });

    if (notifyTimer) clearTimeout(notifyTimer);

    const elapsedMs: number = Date.now() - startedAt;
    console.info("[messageImage] connectBing done", {
      messageId,
      recipientId,
      threadId: result.threadId,
      runId: result.runId,
      texts_len: result.texts?.length ?? 0,
      meta_modality: result.meta?.modality,
      elapsedMs,
    });

    if (result.texts?.length) {
      // 処理中の通知済みの場合push、未通知の場合reply
      await sendMessagesReplyThenPush({
        replyToken: processingNotified ? undefined : event.replyToken, 
        to: recipientId,
        messages: toTextMessages(result.texts),
        delayMs: 0,
      });
      console.info(
        "[messageImage] %s sent",
        processingNotified ? "push" : "reply",
        { messageId, recipientId, texts_len: result.texts.length }
      );
    }

  } catch (err) {
    const elapsedMsOnError: number = Date.now() - startedAt;
    console.error("[messageImage] error:", err, { messageId, recipientId, elapsedMs: elapsedMsOnError });
    if (notifyTimer) {
      try { clearTimeout(notifyTimer); } catch {}
    }

    // エラー返信（reply→push）
    const errText: string =
      getMsg?.("INTERNAL_ERROR") ?? "画像の処理でエラーが発生しました。しばらくしてから再度お試しください。";
    try {
      await sendMessagesReplyThenPush({
        replyToken: event.replyToken,
        to: recipientId,
        messages: toTextMessages([errText]),
        delayMs: 0,
      });
    } catch {
      // 二次エラーは握りつぶす
    }
  }
}
