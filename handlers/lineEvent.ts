import { messagingApi, type WebhookEvent, type MessageEvent } from "@line/bot-sdk";
import { handlePostback } from "@/handlers/postbacks/route";
import { getGptsById, listGptsIdsByUser, softDeleteAllGptsByUser } from "@/services/gpts.mongo";
import { clearBinding, getBinding, listTargetsByGptsIds, upsertDraftBinding } from "@/services/gptsBindings.mongo";
import { softDeleteAllSchedulesByUser, softDeleteSchedulesByGpts } from "@/services/gptsSchedules.mongo";
import { softDeleteAllUserGptsByUser } from "@/services/userGpts.mongo";
import { followUser, unfollowUser } from "@/services/users.mongo";
import { purgeAllThreadInstByUser, upsertThreadInst } from "@/services/threadInst.mongo";
import type { MetaForConfirm } from "@/types/gpts";
import { delete3AgentsForInstpack } from "@/utils/agents";
import { connectBing } from "@/utils/connectBing";
import { LINE } from "@/utils/env";
import { fetchLineUserProfile } from "@/utils/lineProfile";
import { sendMessagesReplyThenPush, toTextMessages, buildSaveOrContinueConfirm, buildJoinApplyTemplate, pushMessages } from "@/utils/lineSend";
import { getBindingTarget, getRecipientId, getThreadOwnerId } from "@/utils/lineSource";
import { isTrackable } from "@/utils/meta";
import { encodePostback } from "@/utils/postback";
import { resetThread } from "@/services/threadState";
import { getMsg } from "@/utils/msgCatalog";

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
      messages: toTextMessages([getMsg("FOLLOW_GREETING")]),
      delayMs: 250,
    });
    return;
  }

  // unfollowイベント
  if (event.type === "unfollow" && event.source.type === "user" && event.source.userId) {
    const uid = event.source.userId;

    // このユーザのGPTと、そのGPTが適用されているgroup/roomターゲットを事前収集
    let ownedGptsIds: string[] = [];
    let appliedTargets: Array<{ targetType: "group" | "room"; targetId: string; gptsId: string; instpack: string }> = [];
    try {
      ownedGptsIds = await listGptsIdsByUser(uid);
      if (ownedGptsIds.length > 0) {
        appliedTargets = await listTargetsByGptsIds(ownedGptsIds);
      }
      console.info("[unfollow] collected owned gpts and applied targets", {
        uid,
        gptsCount: ownedGptsIds.length,
        targetsCount: appliedTargets.length,
      });
    } catch (e) {
      console.warn("[unfollow] collect targets failed (continue cleanup anyway)", { uid, err: String(e) });
    }

    // ユーザに対する削除
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

      // スケジュールの削除（userIdで走査する。targetId/targetTypeは見ないので、該当ユーザが作成したものはすべて削除される）
      try {
        const m = await softDeleteAllSchedulesByUser({ userId: uid });
        console.info("[unfollow] schedules soft-deleted (user target)", { uid, count: m });
      } catch (e) {
        console.warn("[unfollow] softDeleteAllSchedulesByUser failed", { uid, err: String(e) });
      }

      console.info("[unfollow] cleanup done", { uid });
    } catch (e) {
      console.error("[unfollow] cleanup error", { uid, err: e });
    }

    // このユーザのGPTが適用されていたgroup/roomを巡回し、通知 → 退室
    if (appliedTargets.length > 0) {
      const lineClient: messagingApi.MessagingApiClient = new messagingApi.MessagingApiClient({
        channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN as string,
      });

      for (const t of appliedTargets) {
        const ownerScope: string = `${t.targetType}:${t.targetId}`;

        // 1. Agent/Thread cleanup（instpackありならAgentを削除、スレッドは対象スコープでリセット）
        try {
          if (t.instpack && t.instpack.length > 0) {
            await delete3AgentsForInstpack(t.instpack);
          }
        } catch (e) {
          console.warn("[unfollow] target delete3AgentsForInstpack failed", { uid, ownerScope, err: String(e) });
        }
        try {
          await resetThread(ownerScope);
        } catch (e) {
          console.warn("[unfollow] target resetThread failed", { uid, ownerScope, err: String(e) });
        }

        // 2. binding を物理削除
        try {
          await clearBinding({ type: t.targetType, targetId: t.targetId });
        } catch (e) {
          console.warn("[unfollow] target clearBinding failed", { uid, ownerScope, err: String(e) });
        }

        // 3. スケジュールを論理削除（target指定で無効化、nextRunAt:null）
        try {
          const n: number = await softDeleteSchedulesByGpts({ targetType: t.targetType, targetId: t.targetId });
          console.info("[unfollow] target schedules soft-deleted", { uid, ownerScope, count: n });
        } catch (e) {
          console.warn("[unfollow] target softDeleteSchedulesByGpts failed", { uid, ownerScope, err: String(e) });
        }

        // 4. 通知 → leave（replyToken は無いので push → leave）
        try {
          await pushMessages({
            to: t.targetId,
            messages: toTextMessages([getMsg("UNFOLLOW_TARGET_NOTIFY")]),
          });
          console.info("[unfollow] target notify pushed", { uid, ownerScope });
        } catch (e) {
          console.warn("[unfollow] target push notify failed", { uid, ownerScope, err: String(e) });
        }

        try {
          if (t.targetType === "group") {
            await lineClient.leaveGroup(t.targetId);
          } else {
            await lineClient.leaveRoom(t.targetId);
          }
          console.info("[unfollow] target left", { uid, ownerScope });
        } catch (e) {
          console.warn("[unfollow] target leave failed", { uid, ownerScope, err: String(e) });
        }
      }
    }

    await unfollowUser({ userId: uid });

    return;
  }

  // joinイベント
  if (event.type === "join") {
    try {
      // isPendingApply=trueでgptsBindingsにupsert
      await upsertDraftBinding(bindingTarget);
    } catch (e) {
      console.warn("[join] upsertDraftBinding failed", { target: bindingTarget, err: String(e) });
    }

    const data: string = encodePostback("gpts", "apply_owner");
    const greet: messagingApi.Message[] = [
      ...toTextMessages([getMsg("JOIN_GREETING_1"), getMsg("JOIN_GREETING_2")]),
      buildJoinApplyTemplate(data),
    ];

    await sendMessagesReplyThenPush({
      replyToken: event.replyToken,
      to: recipientId,
      messages: greet,
      delayMs: 250,
    });

    console.info("[join] greeted and queued apply_owner button", {
      type: event.source.type,
      groupId: (event.source.type === "group") ? event.source.groupId : undefined,
      roomId: (event.source.type === "room") ? event.source.roomId : undefined,
    });
    return;
  }

  // memberLeft（オーナー退出時の後片付け＋通知→退室）
  if (event.type === "memberLeft" && (bindingTarget.type === "group" || bindingTarget.type === "room")) {
    const targetType: "group" | "room" = bindingTarget.type;
    const targetId: string = bindingTarget.targetId;

    // 去ったユーザの userId 群（友だち関係なら取得可）
    const leftUserIds: string[] = Array.isArray(event.left?.members)
      ? (event.left!.members
          .map((m: unknown) => (typeof (m as { userId?: string }).userId === "string" ? (m as { userId: string }).userId : undefined))
          .filter((u: string | undefined): u is string => typeof u === "string"))
      : [];

    try {
      // 現在の group/room の binding → gptsId → gpts.userId（作成者）
      const binding = await getBinding({ type: targetType, targetId }).catch(() => null);
      const gptsId: string | undefined = binding?.gptsId ? String(binding.gptsId) : undefined;
      const instpack: string | undefined = binding?.instpack ? String(binding.instpack) : undefined;

      if (!gptsId) {
        console.info("[memberLeft] no binding found. skip", { targetType, targetId });
        // バインドが無ければ何もしない
        return;
      }

      const g = await getGptsById(gptsId).catch(() => null);
      const ownerUserId: string | undefined = g?.userId ? String(g.userId) : undefined;

      // 退出者の中に「作成者」が含まれていなければ何もしない
      const isOwnerLeft: boolean = !!ownerUserId && leftUserIds.includes(ownerUserId);
      if (!isOwnerLeft) {
        console.info("[memberLeft] owner not left. skip", { targetType, targetId, ownerUserId, leftUserIds });
        return;
      }
      console.info("[memberLeft] owner left. delete Agents", { targetType, targetId, ownerUserId, leftUserIds });

      // 1. Agent/Thread cleanup
      try {
        if (instpack && instpack.length > 0) {
          await delete3AgentsForInstpack(instpack);
        }
      } catch (e) {
        console.warn("[memberLeft] delete3AgentsForInstpack failed", { targetType, targetId, err: String(e) });
      }
      try {
        await resetThread(threadOwnerId);
      } catch (e) {
        console.warn("[memberLeft] resetThread failed", { targetType, targetId, err: String(e) });
      }

      // 2. binding を削除（hard delete）
      try {
        await clearBinding({ type: targetType, targetId });
      } catch (e) {
        console.warn("[memberLeft] clearBinding failed", { targetType, targetId, err: String(e) });
      }

      // 3. スケジュールを soft delete（enabled=false, nextRunAt=null, deletedAt=now）
      try {
        const n: number = await softDeleteSchedulesByGpts({ targetType, targetId });
        console.info("[memberLeft] schedules soft-deleted", { targetType, targetId, count: n });
      } catch (e) {
        console.warn("[memberLeft] softDeleteSchedulesByGpts failed", { targetType, targetId, err: String(e) });
      }

      // 4. 通知 → 退室（replyToken は無いので push → leave）
      try {
        await pushMessages({
          to: recipientId,
          messages: toTextMessages([getMsg("MEMBERLEFT_NOTIFY")]),
        });
        console.info("[memberLeft] notify pushed", { targetType, targetId });
      } catch (e) {
        console.warn("[memberLeft] push notify failed", { targetType, targetId, err: String(e) });
      }

      const lineClient: messagingApi.MessagingApiClient = new messagingApi.MessagingApiClient({
        channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN as string,
      });

      try {
        if (targetType === "group") {
          await lineClient.leaveGroup(targetId);
        } else {
          await lineClient.leaveRoom(targetId);
        }
      } catch (e) {
        console.warn("[memberLeft] leave failed", { targetType, targetId, err: String(e) });
      }
      console.info("[memberLeft] left", { targetType, targetId });
      return;
    } catch (e) {
      console.warn("[memberLeft] handler error", { targetType, targetId, err: String(e) });
      return;
    }
  }

  // messageイベント
  if (event.type === "message" && event.message.type === "text") {
    try {
      const question = event.message.text?.trim() ?? "";
      if (!question) {
        await sendMessagesReplyThenPush({
          replyToken: event.replyToken,
          to: recipientId,
          messages: toTextMessages([getMsg("MESSAGE_EMPTY_WARN")]),
          delayMs: 250,
        });
        return;
      }

      const res = await connectBing(threadOwnerId, question, {
        sourceType: event.source.type,
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

      let confirmMsg: messagingApi.Message | null = null;
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
            messages: toTextMessages([getMsg("INTERNAL_ERROR")]),
            delayMs: 250,
          });
      } catch {}
    }
  }
}
