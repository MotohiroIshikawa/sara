import { messagingApi, type MessageEvent } from "@line/bot-sdk";
import { sendMessagesReplyThenPush, toTextMessages } from "@/utils/line/lineSend";
import { getMsg } from "@/utils/line/msgCatalog";
import { uploadBufferAndGetSasUrl } from "@/utils/azureBlob";
import { compressIfNeeded } from "@/utils/imageProcessor";
import { IMAGE } from "@/utils/env";
import { getOrCreateThreadId } from "@/services/threadState";
import { findActiveBinding } from "@/services/gptsBindings.mongo";
import { getThreadInst } from "@/services/threadInst.mongo";
import { runReply } from "@/utils/reply/selector";

// MIME 許可
const ALLOWED_MIME: readonly string[] = [
  "image/jpeg", "image/jpg", "image/png", "image/webp",
  "image/gif", "image/heic", "image/heif",
];

// 多重防止
const IMAGE_DEDUP_TTL_MS = 5 * 60 * 1000;
const imageDedupMap = new Map<string, number>();
function isDuplicateAndMark(messageId: string): boolean {
  const now = Date.now();
  for (const [k, exp] of imageDedupMap) if (exp < now) imageDedupMap.delete(k);
  const until = imageDedupMap.get(messageId);
  if (until && until > now) return true;
  imageDedupMap.set(messageId, now + IMAGE_DEDUP_TTL_MS);
  return false;
}

// LINE画像取得
async function fetchLineImageAsBuffer(messageId: string): Promise<{ buf: Buffer; ctype: string }> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not set");

  const url = `https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok || !res.body) throw new Error(`Failed to fetch image content: ${res.status} ${res.statusText}`);

  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  const ctype = contentType.split(";")[0].trim().toLowerCase();

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    if (r.value) chunks.push(r.value);
  }
  const buf = Buffer.concat(chunks);
  return { buf, ctype };
}

// messageイベント(image)
export async function handleMessageImage(
  event: MessageEvent,
  sourceType: "user" | "group" | "room",
  sourceId: string
): Promise<void> {
  if (event.message.type !== "image") return;

  const messageId = event.message.id;
  console.info("[messageImage] recv", {
    sourceType, sourceId, messageId,
  });

  if (isDuplicateAndMark(messageId)) {
    console.info("[messageImage] duplicate suppressed", { messageId, sourceType, sourceId });
    return;
  }

  let notifyTimer: NodeJS.Timeout | undefined;
  let processingNotified = false;

  try {
    // 画像取得
    console.info("[messageImage] fetchLineImageAsBuffer start", {
      sourceType, sourceId, messageId,
    });
    const { buf, ctype } = await fetchLineImageAsBuffer(messageId);
    console.info("[messageImage] fetchLineImageAsBuffer done", {
      sourceType, sourceId, messageId, ctype,
    });

    if (!ALLOWED_MIME.includes(ctype)) {
      console.info("[messageImage] unsupported mime", {
        sourceType, sourceId, messageId, ctype,
      });
      await sendMessagesReplyThenPush({
        replyToken: event.replyToken,
        to: sourceId,
        messages: toTextMessages([getMsg("IMAGE_UNSUPPORTED")]),
      });
      return;
    }

    // 圧縮 / リサイズ（必要時）
    console.info("[messageImage] compressIfNeeded start", {
      sourceType, sourceId, messageId,
    });
    const processed = await compressIfNeeded(buf, ctype, {
      maxBytes: 4 * 1024 * 1024,
      maxWidth: 4096,
      maxHeight: 4096,
    });
    console.info("[messageImage] compressIfNeeded done", {
      sourceType, sourceId, messageId, resized: processed.resized,
    });

    // アップロード → SAS URL
    console.info("[messageImage] uploadBufferAndGetSasUrl start", {
      sourceType, sourceId, messageId,
    });
    const sasUrl = await uploadBufferAndGetSasUrl(processed.buffer, processed.contentType);
    console.info("[messageImage] uploadBufferAndGetSasUrl done", {
      sourceType, sourceId, messageId, hasUrl: !!sasUrl,
    });

    // Thread 確保
    const threadId = await getOrCreateThreadId(sourceType, sourceId);
    console.info("[messageImage] thread ready", {
      sourceType, sourceId, messageId, threadId,
    });

    // 処理中通知（閾値超過で一回だけ）
    const thresholdMs = IMAGE.PROCESSING_NOTIFY_THRESHOLD_SEC * 1000;
    notifyTimer = setTimeout(() => {
      sendMessagesReplyThenPush({
        replyToken: event.replyToken,
        to: sourceId,
        messages: toTextMessages([getMsg("IMAGE_PROCESSING_WAIT")]),
      }).catch(() => {});
      processingNotified = true;
      console.info("[messageImage] processing notify sent", {
        sourceType, sourceId, messageId, threadId,
      });
    }, thresholdMs);

    // group/room は常に getReply(image) のみ
    if (sourceType === "group" || sourceType === "room") {
      console.info("[messageImage] groupRoom: runReply start", {
        sourceType, sourceId, messageId, threadId,
      });
      const replyRes = await runReply(
        { ownerId: sourceId, sourceType, threadId }, 
        { imageUrls: [sasUrl] }
      );
      let texts: string[] = [...replyRes.texts];
      console.info("[messageImage] groupRoom: runReply done", {
        sourceType, sourceId, messageId, threadId, textCount: texts.length,
      });
      if (!texts.length) texts = ["（結果が見つかりませんでした）"];
      
      // meta/instpack は取得しない

      const messages: messagingApi.Message[] = [...toTextMessages(texts)];
      
      if (notifyTimer) clearTimeout(notifyTimer);
      await sendMessagesReplyThenPush({
        replyToken: processingNotified ? undefined : event.replyToken,
        to: sourceId,
        messages,
      });
      console.info("[messageImage] groupRoom: sendMessagesReplyThenPush done", {
        sourceType, sourceId, messageId, threadId,
      });
      return;
    }

    // user: binding or draft の有無で出し分け
    if (sourceType === "user") {
      console.info("[messageImage] user: binding/draft lookup", {
        sourceType, sourceId, messageId, threadId,
      });
      const binding = await findActiveBinding(sourceType, sourceId);
      const draft = await getThreadInst(sourceId, threadId);
      console.info("[messageImage] user: binding/draft result", {
        sourceType, sourceId, messageId, threadId,
        hasBinding: !!binding, hasDraft: !!draft,
      });

      if (binding || draft) {
        // 既存ルール or 進行中ドラフト → getReply のみ
        console.info("[messageImage] user: runReply with binding/draft", {
          sourceType, sourceId, messageId, threadId,
        });
        const replyRes = await runReply(
          { ownerId: sourceId, sourceType, threadId }, 
          { imageUrls: [sasUrl] }
        );
        const texts = replyRes.texts.length ? replyRes.texts : ["（結果が見つかりませんでした）"];
        console.info("[messageImage] user: runReply done", {
          sourceType, sourceId, messageId, threadId, textCount: replyRes.texts.length,
        });

        if (notifyTimer) clearTimeout(notifyTimer);
        await sendMessagesReplyThenPush({
          replyToken: processingNotified ? undefined : event.replyToken,
          to: sourceId,
          messages: toTextMessages([...texts]),
        });
        console.info("[messageImage] user: sendMessagesReplyThenPush done (binding/draft)", {
          sourceType, sourceId, messageId, threadId,
        });
        return;
      }

      // 何もない → 一般リアクション + 用途確認（getReply も呼ばない）
      if (notifyTimer) clearTimeout(notifyTimer);
      const texts: string[] = [
        getMsg("IMAGE_GENERIC_REACT") ?? "素敵な写真ですね。",
        getMsg("ASK_IMAGE_PURPOSE") ?? "この画像から何を答えればよいですか？（例：文字起こし／花の名前 など）",
      ];
      await sendMessagesReplyThenPush({
        replyToken: event.replyToken,
        to: sourceId,
        messages: toTextMessages([...texts]),
      });
      console.info("[messageImage] user: generic react sent", {
        sourceType, sourceId, messageId, threadId,
      });
      return;
    }
  } catch (err) {
    if (notifyTimer) try { clearTimeout(notifyTimer); } catch {}
    const errText = getMsg("INTERNAL_ERROR") ?? "画像の処理中にエラーが発生しました。";
    try {
      await sendMessagesReplyThenPush({
        replyToken: event.replyToken,
        to: sourceId,
        messages: toTextMessages([errText]),
      });
      console.info("[messageImage] error reply sent", {
        sourceType, sourceId, messageId,
      });
    } catch {}
    console.error("[messageImage] error:", {
      sourceType, sourceId, messageId, err,
    });
  }
}
