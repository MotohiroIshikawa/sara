import { type WebhookEvent, type MessageEvent } from "@line/bot-sdk";
import { handleFollowEvent } from "@/handlers/events/follow";
import { handleJoinEvent } from "@/handlers/events/join";
import { handleLeaveEvent } from "@/handlers/events/leave";
import { handleMessageText } from "@/handlers/events/messageText";
import { handleMemberLeftEvent } from "@/handlers/events/memberLeft";
import { handleUnfollowEvent } from "@/handlers/events/unfollow";
import { handlePostback } from "@/handlers/postbacks/route";
import { buildLineEventLog } from "@/utils/lineEventLog";
import { sendMessagesReplyThenPush, toTextMessages } from "@/utils/lineSend";
import { getBindingTarget, getRecipientId, getThreadOwnerId } from "@/utils/lineSource";
import { getMsg } from "@/utils/msgCatalog";

// LINEイベント処理
export async function lineEvent(event: WebhookEvent): Promise<void> {
  console.info("[LINE webhook]", buildLineEventLog(event));

  const recipientId = getRecipientId(event);
  const threadOwnerId = getThreadOwnerId(event);
  const bindingTarget = getBindingTarget(event);
  if (!recipientId || !threadOwnerId || !bindingTarget) return;

  //　postbackイベント 共通ルータへ
  if (event.type === "postback") {
    await handlePostback(event);
    return;
  }

  // followイベント
  if (event.type === "follow" && event.source.type === "user" && event.source.userId) {
    try {
      await handleFollowEvent(event as Extract<WebhookEvent, { type: "follow" }>, recipientId);
    } catch (e) {
      console.warn("[lineEvent] follow handler error", { err: String(e) });
    }
    return;
  }

  // unfollowイベント
  if (event.type === "unfollow" && event.source.type === "user" && event.source.userId) {
    try {
      await handleUnfollowEvent(
        event as Extract<WebhookEvent, { type: "unfollow" }>,
        recipientId,
        threadOwnerId
      );
    } catch (e) {
      console.warn("[lineEvent] unfollow handler error", { err: String(e) });
    }
    return;
  }

  // joinイベント
  if (event.type === "join") {
    try {
      if (bindingTarget.type === "group" || bindingTarget.type === "room") {
        await handleJoinEvent(
        event as Extract<WebhookEvent, { type: "join" }>,
        recipientId,
        { type: bindingTarget.type, targetId: bindingTarget.targetId }
      );
      }
    } catch (e) {
      console.warn("[lineEvent] join handler error", { err: String(e) });
    }
    return;
  }

  // leaveイベント（BOTが退出させられた）
  if (event.type === "leave" && (bindingTarget.type === "group" || bindingTarget.type === "room")) {
    try {
      await handleLeaveEvent(
        event as Extract<WebhookEvent, { type: "leave" }>,
        { type: bindingTarget.type, targetId: bindingTarget.targetId }
      );
    } catch (e) {
      console.warn("[lineEvent] leave handler error", { err: String(e) });
    }
    return;
  }

  // memberJoined
  if (event.type === "memberJoined" && (bindingTarget.type === "group" || bindingTarget.type === "room")) {
    /** 何もしない */
    return;
  }

  // memberLeft（オーナー退出時の後片付け＋通知→退室）
  if (event.type === "memberLeft" && (bindingTarget.type === "group" || bindingTarget.type === "room")) {
    try {
      await handleMemberLeftEvent(
        event as Extract<WebhookEvent, { type: "memberLeft" }>,
        recipientId,
        { type: bindingTarget.type, targetId: bindingTarget.targetId }
      );
    } catch (e) {
      console.warn("[lineEvent] memberLeft handler error", { err: String(e) });
    }
    return;
  }

  // messageイベント(text)
  if (event.type === "message" && event.message.type === "text") {
    try {
      await handleMessageText(
        event as Extract<WebhookEvent, { type: "message" }>,
        recipientId,
        threadOwnerId
      );
    } catch(err) {
      console.error("[lineEvent] error:", err);
      try {
          await sendMessagesReplyThenPush({
            replyToken: event.replyToken,
            to: recipientId,
            messages: toTextMessages([getMsg("INTERNAL_ERROR")]),
            delayMs: 250,
          });
      } catch {}
    }
  }
}
