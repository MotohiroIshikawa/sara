import { 
  messagingApi, 
  type WebhookEvent, 
  type MessageEvent,
} from "@line/bot-sdk";
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

type Intent = "event" | "news" | "buy" | "generic";
type MetaForConfirm = { intent?: Intent; complete?: boolean };
/**
 * 保存しますか？を出すか判定
 * 1. threadIdが存在する
 * 2. instpackが空でない
 * 3. meta.completeがtrue
 * 4. meta.intentがgenericでない
 * -> この場合に「保存しますか？」を出す
 * 
 * @param meta 
 * @param instpack 
 * @param threadId 
 * @returns 
 */
export function shouldShowConfirm(
  meta: MetaForConfirm | undefined,
  instpack: string | undefined,
  threadId?: string
): boolean {
  // 1. 押下先の識別子がないと後続フローで困る
  if (!threadId) return false;
  // 2. 実体のない instpack では保存できない
  if (!instpack?.trim()) return false;
  // 3. meta 未確定ならまだ出さない
  if (!meta || meta.complete !== true) return false;
  // 4. generic は「保存」しない（例: 単語だけの曖昧質問）
  if (meta.intent === "generic") return false;
  return true;
}

const ellipsize = (s: string, max = 300) =>
  typeof s === "string" && s.length > max ? `${s.slice(0, max)}…` : s;
const shortId = (id?: string) =>
  id ? `${id.slice(0, 4)}…${id.slice(-4)}` : undefined;
// 
/**
 * LINE Webhookをログ向けに要約
 *   常に出す: type / source / timestamp
 *   message: type と id、text のときだけ text（長文は省略）
 *   postback: data と params（data は省略表示）
 *   replyToken は漏洩リスクがあるので true/false のみ
 * 
 * @param e 
 * @returns 
 */
export function buildLineEventLog(e: WebhookEvent) {
  const base: Record<string, unknown> = {
    type: e.type,
    source: e.source?.type,
    sourceId:
      e.source?.type === "user" ? shortId(e.source.userId)
      : e.source?.type === "group" ? shortId(e.source.groupId)
      : e.source?.type === "room" ? shortId(e.source.roomId)
      : undefined,
    hasReplyToken: (e as { replyToken?: string }).replyToken !== undefined,
    timestamp: typeof e.timestamp === "number" ? new Date(e.timestamp).toISOString() : undefined,
  };

  switch (e.type) {
    case "message": {
      const m = (e as MessageEvent).message;
      const msg: Record<string, unknown> = { id: m?.id, type: m?.type, };

      if (m?.type === "text") {
        msg.text = ellipsize(m.text, 500);
      } else if ( m?.type === "image" || m?.type === "video" || m?.type === "audio" ) {
        msg.contentProvider = m.contentProvider?.type;
      } else if (m?.type === "file") {
        msg.fileName = m.fileName;
        msg.fileSize = m.fileSize;
      } else if (m?.type === "sticker") {
        msg.packageId = m.packageId;
        msg.stickerId = m.stickerId;
      } else if (m?.type === "location") {
        msg.title = m.title;
        msg.address = m.address;
        msg.latitude = m.latitude;
        msg.longitude = m.longitude;
      }
      return { ...base, message: msg };
    }
    case "postback": {
      const p = e.postback;
      return { ...base, postback: {
          data: ellipsize(p?.data, 500),
          params: p?.params, // date, time, datetime など
        },
      };
    }
    case "follow":
    case "unfollow":
    case "join":
    case "leave": {
      return base;
    }
    case "memberJoined": {
      const members = Array.isArray(e.joined?.members)
        ? e.joined.members
            .map(m => ("userId" in m ? shortId(m.userId) : undefined))
            .filter(Boolean)
          : [];
      return { ...base, members };
    }
    case "memberLeft": {
      const members = Array.isArray(e.left?.members)
        ? e.left.members
            .map(m => ("userId" in m ? shortId(m.userId) : undefined))
            .filter(Boolean)
          : [];
      return { ...base, members };
    }
    default:
    return base;
  }
}

/**
 * MAIN
 * 
 * @param event 
 * @returns 
 */
export async function lineEvent(event: WebhookEvent) {
  console.info("[LINE webhook]", buildLineEventLog(event));

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

              // 2. 条件がそろったら「保存しますか？」の確認を push 
              const show = shouldShowConfirm(meta, instpack, threadId);
              if (show && !confirmPushed) {
                console.info("[lineEvent:onRepair] confirm will be sent via PUSH (no replyToken).", {
                  tid: threadId,
                  intent: meta?.intent,
                  complete: meta?.complete,
                  slots: meta?.slots,
                  instpack_len: typeof instpack === "string" ? instpack.length : 0,
                });
                await sendMessagesReplyThenPush({
                  replyToken: undefined,
                  to: recipientId,
                  messages: [
                    buildSaveOrContinueConfirm({
                      text: "この内容で保存しますか？",
                      saveData: encodePostback("gpts", "save", { tid: threadId, label: "保存" }),
                      continueData: encodePostback("gpts", "continue", { tid: threadId, label: "続ける" }),
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
      // 条件がそろったら「保存しますか？」の確認をpush
      const show = shouldShowConfirm(res.meta, res.instpack, res.threadId);
      if (show && !confirmPushed) { 
        confirmMsg = buildSaveOrContinueConfirm({
          text: "この内容で保存しますか？",
          saveData: encodePostback("gpts", "save", { tid: res.threadId, label: "保存" }),
          continueData: encodePostback("gpts", "continue", { tid: res.threadId, label: "続ける" }),
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
