import { messagingApi, type WebhookEvent } from "@line/bot-sdk";
import { connectBing } from "@/utils/connectBing";
import {
  sendMessagesReplyThenPush,
  toTextMessages,
  buildSaveOrContinueConfirm,
} from "@/utils/lineSend";
import { fetchLineUserProfile } from "@/utils/lineProfile";
import { encodePostback } from "@/utils/postback";
import { handlePostback } from "@/handlers/postback";
import { followUser, unfollowUser } from "@/services/users.mongo";
import { upsertThreadInst } from "@/services/threadInst.mongo";
import { getBinding } from "@/services/gptsBindings.mongo";
import { LINE } from "@/utils/env";

const replyMax = LINE.REPLY_MAX;

function getRecipientId(event: WebhookEvent): string | undefined {
  switch (event.source.type){
    case "user": return event.source.userId;
    case "group": return event.source.groupId;
    case "room": return event.source.roomId;
    default: return undefined;
  }
}

function getThreadOwnerId(event: WebhookEvent): string | undefined {
  switch (event.source.type) {
    case "user": return event.source.userId;
    case "group": return `group:${event.source.groupId}`;
    case "room": return `room:${event.source.roomId}`;
    default: return undefined;
  }
}

/**
 * MAIN
 * 
 * @param event 
 * @returns 
 */
export async function lineEvent(event: WebhookEvent) {
  const recipientId = getRecipientId(event);
  const threadOwnerId = getThreadOwnerId(event);
  if (!recipientId || !threadOwnerId) return;

  //　postback を共通ルータへ
  if (event.type === "postback") {
    await handlePostback(event);
    return;
  }

  // followイベント
  if (event.type === "follow" && event.source.type === "user" && event.source.userId) {
    const uid = event.source.userId;
    const profile = await fetchLineUserProfile(uid).catch(() => null);
    await followUser({ userId: uid, profile: profile ?? undefined });
    // LINEへの応答
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken,
      to: recipientId,
      messages: toTextMessages(["友だち追加ありがとうございます！\n（使い方の説明文）\n質問をどうぞ🙌"]),
      delayMs: 250,
    });
    return;
  }

  // unfollowイベント
  if (event.type === "unfollow" && event.source.type === "user" && event.source.userId) {
    const uid = event.source.userId;
    await unfollowUser({ userId: uid });
    return;
  }

  // messageイベント
  if (event.type === "message" && event.message.type === "text") {
    try {
      const question = event.message.text?.trim() ?? "";
      if (!question) {
        await sendMessagesReplyThenPush({
          replyToken: event.replyToken,
          to: recipientId,
          messages: toTextMessages(["⚠️メッセージが空です。"]),
          delayMs: 250,
        });
        return;
      }

      // Azure OpenAI (Grounding with Bing Search) への問い合わせ
      const binding = await getBinding(threadOwnerId); 
      let confirmPushed = false;
      let confirmMsg: messagingApi.TemplateMessage | null = null;

      // 非同期対応
      const res = await connectBing(threadOwnerId, question, {
        instructionsOverride: binding?.instpack,
        onRepair: async ({ threadId, meta, instpack }) => {
          try {
            if (threadId && instpack) {
              // 1. DBへ保存
              await upsertThreadInst({
                userId: threadOwnerId,
                threadId,
                instpack,
                meta,
              });

              const shouldShowConfirm =
                !!threadId &&
                !!instpack &&
                meta?.complete === true &&
                meta?.intent !== "generic";
              // 2. 条件がそろったら「保存しますか？」の確認を push 
              if (shouldShowConfirm && !confirmPushed) {
                console.info("[lineEvent:onRepair] confirm will be sent via PUSH (no replyToken). tid=%s", threadId);
                await sendMessagesReplyThenPush({
                  replyToken: undefined,
                  to: recipientId,
                  messages: [
                    buildSaveOrContinueConfirm({
                      text: "この内容で保存しますか？",
                      saveData: encodePostback("gpts", "save", { tid: threadId }),
                      continueData: encodePostback("gpts", "continue", { tid: threadId }),
                    }),
                  ],
                  delayMs: 250,
                });
                console.info("[lineEvent:onRepair] confirm PUSH done. tid=%s", threadId);
                confirmPushed = true;
              }
            }
          } catch (e) {
            console.warn("[onRepair] failed:", e);
          }
        },
      }); // ここまで非同期対応

      console.log("#### BING REPLY (TEXTS) ####", res.texts);
      // 本文メッセージを配列化
      const messages: messagingApi.Message[] = [...toTextMessages(res.texts)];
      // 「保存しますか？」を出力する条件
      const shouldShowConfirm =
        !!res.threadId &&
        !!res.instpack &&
        res.meta?.complete === true &&
        res.meta?.intent !== "generic";

      if (shouldShowConfirm && !confirmPushed) { 
        confirmMsg = buildSaveOrContinueConfirm({
          text: "この内容で保存しますか？",
          saveData: encodePostback("gpts", "save", { tid: res.threadId }),
          continueData: encodePostback("gpts", "continue", { tid: res.threadId }),
        });
        messages.push(confirmMsg);
        // 送信前に「push になる位置か」を予告ログ
        const idx = messages.indexOf(confirmMsg);
        const willBePushedIfReplyOK = idx >= replyMax;
        console.info(
          "[lineEvent] confirm queued. index=%d, willBe=%s (if reply OK). tid=%s",
          idx,
          willBePushedIfReplyOK ? "PUSH" : "REPLY",
          res.threadId
        );
      }

      // 返信→push のフォールバック検出用のロガー（no-explicit-any を回避）
      let replyFellBackToPush = false;
      const logProxy: Pick<typeof console, "info" | "warn" | "error"> = {
        info: (...args: Parameters<typeof console.info>) => console.info(...args),
        warn: (...args: Parameters<typeof console.warn>) => {
          try {
            const first = args[0];
            if (typeof first === "string" && first.includes("Fallback to push")) {
              replyFellBackToPush = true;
            }
          } catch {}
          console.warn(...args);
        },
        error: (...args: Parameters<typeof console.error>) => console.error(...args),
      };

      // LINEへ本文応答
      await sendMessagesReplyThenPush({
        replyToken: event.replyToken,
        to: recipientId,
        messages,
        delayMs: 250,
        log: logProxy,
      });

      // 実際に confirm が PUSH で出たかの最終ログ
      if (confirmMsg) {
        const idx = messages.indexOf(confirmMsg);
        const wasPushed = replyFellBackToPush || (idx >= replyMax); // 5 は replyMax と合わせる
        console.info(
          "[lineEvent] confirm delivered via %s. idx=%d, fallback=%s, tid=%s",
          wasPushed ? "PUSH" : "REPLY",
          idx,
          replyFellBackToPush,
          res.threadId
        );
      }
      
      // instpackを毎回上書き保存
      if (res.instpack && res.threadId) {
        await upsertThreadInst({
          userId: threadOwnerId,
          threadId: res.threadId,
          instpack: res.instpack,
          meta: res.meta,
        });
      }

    } catch(err) {
      console.error("[lineEvent] error:", err);
      try {
          await sendMessagesReplyThenPush({
            replyToken: event.replyToken,
            to: recipientId,
            messages: toTextMessages(["⚠️内部エラーが発生しました。時間をおいてもう一度お試しください。"]),
            delayMs: 250,
          });
      } catch {}
    }
  }
}
