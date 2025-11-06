import { messagingApi, type WebhookEvent } from "@line/bot-sdk";
import { upsertDraftBinding } from "@/services/gptsBindings.mongo";
import { sendMessagesReplyThenPush, toTextMessages, buildJoinApplyTemplate } from "@/utils/lineSend";
import { encodePostback } from "@/utils/postback";
import { getMsg } from "@/utils/msgCatalog";

// joinイベント
export async function handleJoinEvent(
  event: Extract<WebhookEvent, { type: "join" }>,
  sourceType: "group" | "room",
  sourceId: string
): Promise<void> {
  // isPendingApply=true で gptsBindings に upsert
  try {
    await upsertDraftBinding(sourceType, sourceId);
  } catch (e) {
    console.warn("[join] upsertDraftBinding failed", { sourceId, sourceType, err: String(e) });
  }

  const data: string = encodePostback("gpts", "apply_owner");
  const greet: messagingApi.Message[] = [
    ...toTextMessages([getMsg("JOIN_GREETING_1"), getMsg("JOIN_GREETING_2")]),
    buildJoinApplyTemplate(data),
  ];

  await sendMessagesReplyThenPush({
    replyToken: event.replyToken,
    to: sourceId,
    messages: greet,
    delayMs: 250,
  });

  console.info("[join] greeted and queued apply_owner button", { sourceId, sourceType });
}
