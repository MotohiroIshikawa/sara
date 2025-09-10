import { type WebhookEvent } from "@line/bot-sdk";
import { toTextMessages, sendMessagesReplyThenPush } from "@/utils/lineSend";
import { listUserGpts, getUserGptsById } from "@/services/userGpts.mongo";
import { setBinding, clearBinding } from "@/services/gptsBindings.mongo";

// /gpts コマンド群（最小）
//   /gpts list               : ユーザーの保存済みGPTSを一覧表示
//   /gpts use <id>           : 現在のトークに <id> をバインド
//   /gpts unset              : 現在のトークのバインドを解除
//
// 返り値: true = このハンドラが処理した（上位は以降の処理をしないでOK）
//         false = /gpts でない（上位に処理を回す）

function getRecipientId(event: WebhookEvent): string | undefined {
  switch (event.source.type) {
    case "user":  return event.source.userId;
    case "group": return event.source.groupId;
    case "room":  return event.source.roomId;
    default:      return undefined;
  }
}
function getThreadOwnerId(event: WebhookEvent): string | undefined {
  switch (event.source.type) {
    case "user":  return event.source.userId;
    case "group": return `group:${event.source.groupId}`;
    case "room":  return `room:${event.source.roomId}`;
    default:      return undefined;
  }
}

// コマンド文字列を簡易に分解
function parse(text: string): { cmd: string; args: string[] } {
  const parts = text.trim().split(/\s+/);
  const cmd = (parts.shift() || "").toLowerCase();
  return { cmd, args: parts };
}

export async function handleGptsCommand(event: WebhookEvent): Promise<boolean> {
  if (event.type !== "message" || event.message.type !== "text") return false;

  const text = event.message.text?.trim() ?? "";
  if (!text.startsWith("/gpts")) return false;

  const recipientId = getRecipientId(event);
  const threadOwnerId = getThreadOwnerId(event);
  if (!recipientId || !threadOwnerId) return true; // 形式上は処理済みにする

  const { args } = parse(text); // "/gpts" の後ろ
  const sub = (args[0] || "list").toLowerCase(); // 省略時は list

  try {
    if (sub === "list") {
      const items = await listUserGpts(threadOwnerId);
      if (!items.length) {
        await sendMessagesReplyThenPush({
          replyToken: event.replyToken!,
          to: recipientId,
          messages: toTextMessages([
            "保存済みのGPTSはまだありません。\nまずは通常の質問→保存ボタンから作成してください。",
          ]),
        });
        return true;
      }
      const lines = items.map(
        it => `• ${it.name}  (id: ${it.id})`
      );
      await sendMessagesReplyThenPush({
        replyToken: event.replyToken!,
        to: recipientId,
        messages: toTextMessages([
          "保存済みGPTS一覧：",
          ...lines,
          "",
          "使うときは：/gpts use <id>\n解除：/gpts unset",
        ]),
      });
      return true;
    }

    if (sub === "use") {
      const id = args[1];
      if (!id) {
        await sendMessagesReplyThenPush({
          replyToken: event.replyToken!,
          to: recipientId,
          messages: toTextMessages(["使い方：/gpts use <id>"]),
        });
        return true;
      }
      const g = await getUserGptsById(threadOwnerId, id);
      if (!g) {
        await sendMessagesReplyThenPush({
          replyToken: event.replyToken!,
          to: recipientId,
          messages: toTextMessages([`指定のGPTSが見つかりません: ${id}`]),
        });
        return true;
      }
      await setBinding(threadOwnerId, id, g.instpack);
      await sendMessagesReplyThenPush({
        replyToken: event.replyToken!,
        to: recipientId,
        messages: toTextMessages([`このトークにバインドしました：${g.name} (id: ${id})`]),
      });
      return true;
    }

    if (sub === "unset") {
      await clearBinding(threadOwnerId);
      await sendMessagesReplyThenPush({
        replyToken: event.replyToken!,
        to: recipientId,
        messages: toTextMessages(["このトークのGPTSバインドを解除しました。"]),
      });
      return true;
    }

    // 未知サブコマンド
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!,
      to: recipientId,
      messages: toTextMessages([
        "使い方：\n/gpts list\n/gpts use <id>\n/gpts unset",
      ]),
    });
    return true;

  } catch (e) {
    console.error("[/gpts] error:", e);
    try {
      await sendMessagesReplyThenPush({
        replyToken: event.replyToken!,
        to: recipientId,
        messages: toTextMessages(["内部エラーが発生しました。後でもう一度お試しください。"]),
      });
    } catch {}
    return true;
  }
}
