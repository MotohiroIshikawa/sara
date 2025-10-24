import { type MessageEvent } from "@line/bot-sdk";
import { sendMessagesReplyThenPush, toTextMessages } from "@/utils/lineSend";
import { getMsg } from "@/utils/msgCatalog";
import { uploadBufferAndGetSasUrl } from "@/utils/azureBlob";
import { connectBing } from "@/utils/connectBing";

// LINE画像をBuffer取得（Content-Typeも取得）
async function fetchLineImageAsBuffer(messageId: string): Promise<{ buf: Buffer; contentType: string }> {
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

  // ReadableStream → Buffer
  const reader: ReadableStreamDefaultReader<Uint8Array> = res.body.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const r: ReadableStreamReadResult<Uint8Array> = await reader.read();
    if (r.done) break;
    if (r.value) chunks.push(r.value);
  }
  const buf: Buffer = Buffer.concat(chunks);
  return { buf, contentType };
}

// messageイベント処理(image)
export async function handleMessageImage(
  event: MessageEvent,
  recipientId: string,
  _threadOwnerId: string
): Promise<void> {
  // 型ガード：image以外は無視
  if (event.type !== "message" || event.message.type !== "image") return;

  const messageId: string = event.message.id;

  try {
    const { buf, contentType } = await fetchLineImageAsBuffer(messageId);
    console.info("[messageImage] fetched image buffer", {
      messageId,
      bytes: buf.byteLength,
      contentType,
    });

    // Azure Blob へアップロード → SAS URL取得
    const sasUrl: string = await uploadBufferAndGetSasUrl(buf, contentType);
    console.info("[messageImage] uploaded to blob", { sasUrl });

    // connectBing を画像入力で実行（テキストは空）
    const result = await connectBing(recipientId, "", {
      sourceType: "user",
      imageUrls: [sasUrl],
    });

    // 成功時は reply は送らない（方針どおり）。push送信は次ステップで実装予定。
    console.info("[messageImage] connectBing done", {
      threadId: result.threadId,
      runId: result.runId,
      texts_len: result.texts?.length ?? 0,
      meta_modality: result.meta?.modality,
    });
  } catch (err) {
    console.error("[messageImage] error:", err);
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
