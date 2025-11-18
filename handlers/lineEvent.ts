import { type WebhookEvent } from "@line/bot-sdk";
import { handleFollowEvent } from "@/handlers/events/follow";
import { handleJoinEvent } from "@/handlers/events/join";
import { handleLeaveEvent } from "@/handlers/events/leave";
import { handleMessageText } from "@/handlers/events/messageText";
import { handleMessageImage } from "@/handlers/events/messageImage";
import { handleMemberLeftEvent } from "@/handlers/events/memberLeft";
import { handleUnfollowEvent } from "@/handlers/events/unfollow";
import { handlePostback } from "@/handlers/postbacks/route";
import { buildLineEventLog } from "@/utils/line/lineEventLog";
import { sendMessagesReplyThenPush, toTextMessages } from "@/utils/line/lineSend";
import { getSourceId, getSourceType } from "@/utils/line/lineSource";
import { getMsg } from "@/utils/line/msgCatalog";
import type { SourceType } from "@/types/gpts";


// LINEイベント処理
export async function lineEvent(event: WebhookEvent): Promise<void> {
  console.info("[LINE webhook]", buildLineEventLog(event));

  const sourceId: string | undefined = getSourceId(event);
  const sourceType: SourceType | undefined = getSourceType(event);

  if (!sourceId || !sourceType) {
    console.warn("[lineEvent] skip: no source resolved", { type: event.type });
    return;
  }

  //　postbackイベント 共通ルータへ
  if (event.type === "postback") {
    try {
      await handlePostback(event);
    } catch (e) {
      console.warn("[lineEvent] postback handler error", { err: String(e) });
    }
    return;
  }

  // followイベント
  if (event.type === "follow" && sourceType === "user") {
    try {
      await handleFollowEvent(
        event as Extract<WebhookEvent, { type: "follow" }>,
        sourceType,
        sourceId
      );
    } catch (e) {
      console.warn("[lineEvent] follow handler error", { err: String(e) });
    }
    return;
  }

  // unfollowイベント
  if (event.type === "unfollow" && sourceType === "user" && sourceId) {
    try {
      await handleUnfollowEvent(
        event as Extract<WebhookEvent, { type: "unfollow" }>,
        sourceType,
        sourceId
      );
    } catch (e) {
      console.warn("[lineEvent] unfollow handler error", { err: String(e) });
    }
    return;
  }

  // joinイベント
  if (event.type === "join" && (sourceType === "group" || sourceType === "room")) {
    try {
      await handleJoinEvent(
        event as Extract<WebhookEvent, { type: "join" }>,
        sourceType,
        sourceId
      );
    } catch (e) {
      console.warn("[lineEvent] join handler error", { err: String(e) });
    }
    return;
  }

  // leaveイベント（BOTが退出させられた）
  if (event.type === "leave" && (sourceType === "group" || sourceType === "room")) {
    try {
      await handleLeaveEvent(
        event as Extract<WebhookEvent, { type: "leave" }>,
        sourceType,
        sourceId
      );
    } catch (e) {
      console.warn("[lineEvent] leave handler error", { err: String(e) });
    }
    return;
  }

  // memberJoined
  if (event.type === "memberJoined" && (sourceType === "group" || sourceType === "room")) {
        /** 何もしない */
    return;
  }

  // memberLeft（オーナー退出時の後片付け＋通知→退室）
  if (event.type === "memberLeft" && (sourceType === "group" || sourceType === "room")) {
    try {
      await handleMemberLeftEvent(
        event as Extract<WebhookEvent, { type: "memberLeft" }>,
        sourceType,
        sourceId
      );
    } catch (e) {
      console.warn("[lineEvent] memberLeft handler error", { err: String(e) });
    }
    return;
  }

  // messageイベント(text)
  if (event.type === "message" && event.message.type === "text" && (sourceType === "user" || sourceType === "group" || sourceType === "room")) {
    try {
      await handleMessageText(
        event as Extract<WebhookEvent, { type: "message"; message: { type: "text" } }>,
        sourceType,
        sourceId
      );
    } catch(err) {
      console.error("[lineEvent] error:", err);
      try {
          await sendMessagesReplyThenPush({
            replyToken: event.replyToken,
            to: sourceId,
            messages: toTextMessages([getMsg("INTERNAL_ERROR")]),
            delayMs: 250,
          });
      } catch(e) {
        console.warn("[lineEvent] message handler (Text) error", { err: String(e) });
      }
    }
    return;
  }

  // messageイベント(image)
  if (event.type === "message" && event.message.type === "image"
      && (sourceType === "user" || sourceType === "group" || sourceType === "room")) {
    try {
      await handleMessageImage(
        event as Extract<WebhookEvent, { type: "message"; message: { type: "image" } }>,
        sourceType,
        sourceId
      );
    } catch (err) {
      console.error("[lineEvent] image handler error:", err);
      try {
        await sendMessagesReplyThenPush({
            replyToken: event.replyToken,
            to: sourceId,
            messages: toTextMessages([getMsg("INTERNAL_ERROR")]),
            delayMs: 250,
          });
      } catch(e) {
          console.warn("[lineEvent] message handler (Image) error", { err: String(e) });
      }
    }
    return;
  }
  console.info("[lineEvent] ignored event", { type: event.type });
}
