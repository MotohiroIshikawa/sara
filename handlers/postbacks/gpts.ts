import { type PostbackEvent } from "@line/bot-sdk";
import { sendMessagesReplyThenPush, toTextMessages } from "@/utils/lineSend";
import { getThreadInst, deleteThreadInst } from "@/services/threadInst.mongo";
import { createUserGpts } from "@/services/userGpts.mongo";
import { setBinding } from "@/services/gptsBindings.mongo";
import { AgentsClient } from "@azure/ai-agents";
import { DefaultAzureCredential } from "@azure/identity";
import { setNxEx } from "@/utils/redis";
import { AZURE } from "@/utils/env";

const endpoint = AZURE.AI_PRJ_ENDPOINT;

function getRecipientId(event: PostbackEvent): string | undefined {
  switch (event.source.type) {
    case "user": return event.source.userId;
    case "group": return event.source.groupId;
    case "room": return event.source.roomId;
    default: return undefined;
  }
}
function getThreadOwnerId(event: PostbackEvent): string | undefined {
  switch (event.source.type) {
    case "user": return event.source.userId;
    case "group": return `group:${event.source.groupId}`;
    case "room": return `room:${event.source.roomId}`;
    default: return undefined;
  }
}

// 保存
export async function save(event: PostbackEvent, args: Record<string, string> = {}) {
  const recipientId = getRecipientId(event);
  const threadOwnerId = getThreadOwnerId(event);
  const threadId = args["tid"];
  if (!recipientId || !threadOwnerId || !threadId) return;

  try {
    const dedupKey = `pb:save:${threadOwnerId}:${threadId}`;
    const ok = await setNxEx(dedupKey, "1", 30);
    if (!ok) {
      await sendMessagesReplyThenPush({
        replyToken: event.replyToken!,
        to: recipientId,
        messages: toTextMessages(["少し待ってからお試しください。"]),
      });
      return;
    }
  } catch (e) {
      console.warn("[gpts.save] dedup check skipped (redis error):", e);
  }

  const inst = await getThreadInst(threadOwnerId, threadId);
  if (!inst?.instpack) {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!,
      to: recipientId,
      messages: toTextMessages(["保存対象が見つかりませんでした。もう一度お試しください。"]),
    });
    return;
  }

  const g = await createUserGpts({
    userId: threadOwnerId,
    instpack: inst.instpack,
    fromThreadId: threadId,
    name: "My GPTS",
  });

  await setBinding(threadOwnerId, g.id, inst.instpack);

  try {
    const agents = new AgentsClient(endpoint, new DefaultAzureCredential());
    await agents.threads.delete(threadId);
  } catch { /* ignore */ }

  try { await deleteThreadInst(threadOwnerId, threadId); } catch {}

  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!,
    to: recipientId,
    messages: toTextMessages([`保存しました：${g.name}\nこのトークではこの設定を使います。`]),
  });
}

// 続ける
export async function cont(event: PostbackEvent) {
  const recipientId =
    event.source.type === "user" ? event.source.userId :
    event.source.type === "group" ? event.source.groupId :
    event.source.type === "room" ? event.source.roomId : undefined;
  if (!recipientId) return;

  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!,
    to: recipientId,
    messages: toTextMessages(["了解しました。続けましょう！"]),
  });
}
