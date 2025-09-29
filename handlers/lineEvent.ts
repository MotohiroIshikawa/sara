import { messagingApi, type WebhookEvent, type MessageEvent } from "@line/bot-sdk";
import { handlePostback } from "@/handlers/postbacks/router";
import { clearBinding, getBinding } from "@/services/gptsBindings.mongo";
import { purgeAllThreadInstByUser, upsertThreadInst } from "@/services/threadInst.mongo";
import { followUser, unfollowUser } from "@/services/users.mongo";
import type { MetaForConfirm } from "@/types/gpts";
import { buildReplyWithUserInstpack } from "@/utils/agentPrompts";
import { connectBing } from "@/utils/connectBing";
import { LINE } from "@/utils/env";
import { fetchLineUserProfile } from "@/utils/lineProfile";
import { sendMessagesReplyThenPush, toTextMessages, buildSaveOrContinueConfirm } from "@/utils/lineSend";
import { getBindingTarget, getRecipientId, getThreadOwnerId } from "@/utils/lineSource";
import { isTrackable } from "@/utils/meta";
import { encodePostback } from "@/utils/postback";
import { resetThread } from "@/services/threadState";
import { delete3AgentsForInstpack } from "@/utils/agents";
import { softDeleteAllUserGptsByUser } from "@/services/userGpts.mongo";
import { softDeleteAllGptsByUser } from "@/services/gpts.mongo";

const replyMax = LINE.REPLY_MAX;

// 保存しますか？を出すか判定
function shouldShowConfirm( meta: MetaForConfirm | undefined, instpack: string | undefined, threadId?: string ): boolean {
  if (!threadId) return false;
  if (!instpack?.trim()) return false;
  if (!meta || meta.complete !== true) return false;
  if (!isTrackable(meta)) return false;
  return true;
}

// 確認ダイアログ前の最終チェック
function finalCheckBeforeConfirm(meta: MetaForConfirm | undefined, instpack: string | undefined): { ok: boolean; reason?: string } {
  if (!meta) return { ok: false, reason: "meta:undefined" };
  if (!isTrackable(meta)) return { ok: false, reason: "meta:not_trackable" };
  if (meta.complete !== true) return { ok: false, reason: "meta:incomplete" };
  const s = instpack?.trim() ?? "";
  if (!s) return { ok: false, reason: "instpack:empty" };
  if (s.length < 80) return { ok: false, reason: "instpack:too_short" };
  if (/```/.test(s)) return { ok: false, reason: "instpack:has_fence" };
  if (/[?？]\s*$/.test(s)) return { ok: false, reason: "instpack:looks_question" };
  return { ok: true };
}

const ellipsize = (s: string, max = 300) =>
  typeof s === "string" && s.length > max ? `${s.slice(0, max)}…` : s;
const shortId = (id?: string) =>
  id ? `${id.slice(0, 4)}…${id.slice(-4)}` : undefined;

// LINE Webhookをログ向けに要約
function buildLineEventLog(e: WebhookEvent) {
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

// MAIN
export async function lineEvent(event: WebhookEvent) {
  console.info("[LINE webhook]", buildLineEventLog(event));

  const recipientId = getRecipientId(event);
  const threadOwnerId = getThreadOwnerId(event);
  const bindingTarget = getBindingTarget(event);
  if (!recipientId || !threadOwnerId || !bindingTarget) return;

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
    try {
      // Redisのthread,Agentを削除
      const binding = await getBinding({ type: "user", targetId: uid }).catch(() => null);
      const instpack = binding?.instpack ?? null;

      await resetThread(threadOwnerId).catch((e) => {
        console.warn("[unfollow] resetThread failed", { uid, err: String(e) });
      });

      // agent削除
      if (instpack) {
        await delete3AgentsForInstpack(instpack).catch((e) => {
          console.warn("[unfollow] delete3AgentsForInstpack failed", { uid, err: String(e) });
        });
      } else {
        console.info("[unfollow] no binding/instpack => skip agent deletion", { uid });
      }

      // BASEのreplyAgentを消す
      //await deleteBaseReplyAgent().catch((e) => {
      //  console.warn("[unfollow] deleteBaseReplyAgent failed", { uid, err: String(e) });
      //});
      
      // thread_inst から該当ユーザのレコードを削除
      await purgeAllThreadInstByUser(threadOwnerId).catch((e) => {
        console.warn("[unfollow] purgeAllThreadInstByUser failed", { uid, err: String(e) });
      });

      // gpts_bindings から該当ユーザのレコードを削除
      await clearBinding({ type: "user", targetId: uid }).catch((e) => {
        console.warn("[unfollow] clearBinding failed", { uid, err: String(e) });
      });

      // user_gpts から該当ユーザのレコードを削除
      try {
        const n = await softDeleteAllUserGptsByUser(uid);
        console.info("[unfollow] user_gpts soft-deleted", { uid, count: n });
      } catch (e) {
        console.warn("[unfollow] softDeleteAllUserGptsByUser failed", { uid, err: String(e) });
      }

      // gpts から該当ユーザのレコードを削除
      try {
        const n = await softDeleteAllGptsByUser(uid);
        console.info("[unfollow] gpts soft-deleted", { uid, count: n });
      } catch (e) {
        console.warn("[unfollow] softDeleteAllGptsByUser failed", { uid, err: String(e) });
      }

      console.info("[unfollow] cleanup done", { uid });
    } catch (e) {
      console.error("[unfollow] cleanup error", { uid, err: e });
    }

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
      const binding = await getBinding(bindingTarget); 

      const replyOverride = binding?.instpack
        ? buildReplyWithUserInstpack(binding.instpack)
        : undefined;

      const res = await connectBing(threadOwnerId, question, {
        instructionsOverride: replyOverride,
      });

      console.log("#### BING REPLY (TEXTS) ####", res.texts);
      // 本文メッセージを配列化
      const messages: messagingApi.Message[] = [...toTextMessages(res.texts)];
      // 条件がそろったら「保存しますか？」の確認をpush
      const show = shouldShowConfirm(res.meta, res.instpack, res.threadId);
      const guard = show
        ? finalCheckBeforeConfirm(res.meta, res.instpack)
        : { ok: false, reason: "shouldShowConfirm:false" };
      if (!guard.ok) {
        console.info("[lineEvent] confirm skipped by finalCheck:", { tid: res.threadId, reason: guard.reason });
      }

      let confirmMsg: messagingApi.TemplateMessage | null = null;
      if (show && guard.ok) { 
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
        const wasPushed = replyFellBackToPush || (idx >= replyMax);
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
