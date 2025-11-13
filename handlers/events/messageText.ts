import { messagingApi, type MessageEvent } from "@line/bot-sdk";
import { LINE, WAKE } from "@/utils/env";
import { toTextMessages, sendMessagesReplyThenPush, buildSaveOrContinueConfirm } from "@/utils/lineSend";
import { encodePostback } from "@/utils/postback";
import { getMsg } from "@/utils/msgCatalog";
import { upsertThreadInst } from "@/services/threadInst.mongo";
import {
  activateReplyMode,
  consumeReplyModeIfActive,
  breakReplyModeOnInterrupt,
  isSingleWordWake,
  startsWithWake,
  DEFAULT_WAKE_SEP_RE,
  type ReplyMode,
} from "@/utils/wakeState";
import { getMeta } from "@/utils/meta/getMeta";
import { getInstpack } from "@/utils/instpack/getInstpack";
import { computeMeta, looksLikeFollowup } from "@/utils/meta";
import type { AiContext, Meta, MetaComputeResult } from "@/types/gpts";
import { getOrCreateThreadId } from "@/services/threadState";
import { getSpeakerUserId } from "@/utils/lineSource";
import { runReply } from "@/utils/reply/selector";

const replyMax: number = LINE.REPLY_MAX;
const REPLY_MODE: ReplyMode = "session";
const REPLY_MODE_TTL_SEC: number = WAKE.REPLY_MODE_TTL_SEC;
const WAKE_ALIASES: readonly string[] = WAKE.ALIASES as readonly string[];
const WAKE_SEP_RE: RegExp = DEFAULT_WAKE_SEP_RE;

// 確認カード表示の条件（従来踏襲）
function shouldShowConfirm(meta: unknown, instpack: string | undefined, threadId?: string): boolean {
  if (!threadId) return false;
  if (!instpack?.trim()) return false;
  const m = meta as { complete?: boolean } | undefined;
  if (!m || m.complete !== true) return false;
  return true;
}

// 確認カード直前の最終ガード（従来踏襲）
function finalCheckBeforeConfirm(
  meta: { complete?: boolean } | undefined,
  instpack: string | undefined
): { ok: boolean; reason?: string } {
  if (!meta) return { ok: false, reason: "meta:undefined" };
  if (meta.complete !== true) return { ok: false, reason: "meta:incomplete" };
  const s: string = instpack?.trim() ?? "";
  if (!s) return { ok: false, reason: "instpack:empty" };
  if (s.length < 80) return { ok: false, reason: "instpack:too_short" };
  if (/```/.test(s)) return { ok: false, reason: "instpack:has_fence" };
  if (/[?？]\s*$/.test(s)) return { ok: false, reason: "instpack:looks_question" };
  return { ok: true };
}

// 末尾に followup を重複なく1行追加
function appendFollowupIfNeeded(texts: string[], ask: string | undefined, meta: Meta): string[] {
  if (typeof ask !== "string") return texts;
  const t: string = ask.trim();
  if (t.length === 0) return texts;

  const last: string = texts[texts.length - 1] ?? "";
  const eqLite = (a: string, b: string): boolean =>
    a.replace(/\s+/g, "").trim() === b.replace(/\s+/g, "").trim();

  const already: boolean = eqLite(last, t) || looksLikeFollowup(last, meta);
  return already ? texts : [...texts, t];
}

// messageイベント(text)
export async function handleMessageText(
  event: MessageEvent,
  sourceType: "user" | "group" | "room",
  sourceId: string
): Promise<void> {
  if (event.message.type !== "text") return;

  const questionRaw: string =
    event.message.type === "text" ? (event.message.text ?? "") : "";
  const questionTrimmed: string = questionRaw.trim();
  const messageId = event.message.id;
  console.info("[messageText] recv", {
    sourceType, sourceId, messageId, textLen: questionTrimmed.length 
  });

  // 1対1（常時応答）
  if (sourceType === "user") {
    const question: string = questionTrimmed;
    if (!question) {
      await sendMessagesReplyThenPush({
        replyToken: event.replyToken,
        to: sourceId,
        messages: toTextMessages([getMsg("MESSAGE_EMPTY_WARN")]),
        delayMs: 250,
      });
      return;
    }
    console.info("[messageText] user: start", {
      sourceType, sourceId, messageId, textPreview: question.slice(0, 40),
    });

    // Thread確保 + AiContext 構築
    const threadId: string = await getOrCreateThreadId(sourceType, sourceId);
    const ctx: AiContext = { ownerId: sourceId, sourceType: sourceType, threadId };
    console.info("[messageText] user: ctx ready", {
      sourceType, sourceId, messageId, threadId,
    });

    // 1. reply 実行（Bingあり／なしは aiConnectReply 側で処理）
    const replyRes = await runReply(ctx, { question });
    let texts: string[] = [...replyRes.texts];
    console.info("[messageText] user: reply done", {
      sourceType, sourceId, messageId, threadId, textCount: texts.length,
    });

    // 2. meta → computeMeta（userのみ）
    const metaRes = await getMeta(ctx, { hasImageHint: false });
    let mergedMeta: Meta | undefined = metaRes.meta;
    console.info("[messageText] user: meta fetched", {
      sourceType, sourceId, messageId, threadId,
      hasMeta: mergedMeta != null, 
      intent: mergedMeta?.intent ?? null, 
      modality: mergedMeta?.modality ?? null, 
      complete: mergedMeta?.complete ?? null,
    });

    let metaEval: MetaComputeResult | undefined = undefined;
    if (mergedMeta) {
      const replyTextJoined: string = texts.join("\n\n");
      metaEval = computeMeta(mergedMeta, replyTextJoined);
      mergedMeta = metaEval.metaNorm;
      console.info("[messageText] user: meta computed", {
        sourceType, sourceId, messageId, threadId,
        completeNorm: metaEval.complete_norm,
        saveable: metaEval.saveable,
      });
    }

    // ask:image の統一（必要なら先頭に追加／metaの個別文面は除去）
    const needAskImage: boolean =
      (mergedMeta?.followups?.[0]?.ask === "image") ||
      ((mergedMeta?.modality === "image" || mergedMeta?.modality === "image+text") &&
        mergedMeta?.slots?.has_image !== true);
    if (needAskImage) {
      console.info("[messageText] user: add ASK_IMAGE_GENERIC", {
        sourceType, sourceId, messageId, threadId,
      });
      const unified: string = (getMsg("ASK_IMAGE_GENERIC") ?? "画像を送ってください。").trim();
      const metaAskText: string | undefined = mergedMeta?.followups?.[0]?.text?.trim();
      if (metaAskText && metaAskText.length > 0) {
        texts = texts.filter((t) => t.trim() !== metaAskText);
      }
      if (!texts.some((t) => t.trim() === unified)) {
        texts.unshift(unified);
      }
    }

    // complete_norm=false のときに followup を1行だけ末尾に追記
    if (metaEval && metaEval.complete_norm === false) {
      const ask: string | undefined = metaEval.metaNorm.followups?.[0]?.text;
      if (ask && ask.trim().length > 0) {
        texts = appendFollowupIfNeeded(texts, ask, metaEval.metaNorm);
        console.info("[messageText] user: followup appended", {
          sourceType, sourceId, messageId, threadId,
        });
      }
    }

    if (!texts.length) texts = ["（結果が見つかりませんでした）"];

    // 3. saveable のときだけ instpack 取得
    let mergedInst: string | undefined = undefined;
    if (metaEval?.saveable === true) {
      const instRes = await getInstpack(ctx);
      mergedInst = instRes.instpack;
      console.info("[messageText] user: instpack fetched", {
        sourceType, sourceId, messageId, threadId,
      });
    }

    // 通常の送出
    const messages: messagingApi.Message[] = [...toTextMessages(texts)];
    const show: boolean = shouldShowConfirm(mergedMeta, mergedInst, threadId);
    const guard = show ? finalCheckBeforeConfirm(mergedMeta, mergedInst) : { ok: false as boolean, reason: "skip" };
    if (!guard.ok) {
      const reason: string = guard.ok ? "ok" : (guard.reason ?? "unknown");
      console.info("[messageText] confirm skipped by finalCheck:", {
        sourceType, sourceId, messageId, threadId, reason,
      });
    }

    let confirmMsg: messagingApi.Message | null = null;
    if (show && guard.ok) {
      confirmMsg = buildSaveOrContinueConfirm({
        text: "この内容で保存しますか？",
        saveData: encodePostback("gpts", "save", { tid: threadId, label: "保存" }),
        continueData: encodePostback("gpts", "continue", { tid: threadId, label: "続ける" }),
      });
      messages.push(confirmMsg);

      const idx: number = messages.indexOf(confirmMsg);
      const willBePushedIfReplyOK: boolean = idx >= replyMax;
      console.info("[messageText] confirm queued. index=%d, willBe=%s (if reply OK). tid=%s",
        idx, willBePushedIfReplyOK ? "PUSH" : "REPLY", threadId,
      );
    }

    let replyFellBackToPush = false;
    const logProxy: Pick<typeof console, "info" | "warn" | "error"> = {
      info: (...args: Parameters<typeof console.info>) => console.info(...args),
      warn: (...args: Parameters<typeof console.warn>) => {
        try {
          const first = args[0];
          if (typeof first === "string" && first.includes("Fallback to push")) replyFellBackToPush = true;
        } catch {}
        console.warn(...args);
      },
      error: (...args: Parameters<typeof console.error>) => console.error(...args),
    };

    await sendMessagesReplyThenPush({
      replyToken: event.replyToken,
      to: sourceId,
      messages,
      delayMs: 250,
      log: logProxy,
    });

    if (confirmMsg) {
      const idx: number = messages.indexOf(confirmMsg);
      const wasPushed: boolean = replyFellBackToPush || (idx >= replyMax);
      console.info("[messageText] confirm delivered via %s. idx=%d, fallback=%s, tid=%s",
        wasPushed ? "PUSH" : "REPLY", idx, replyFellBackToPush, threadId,
      );
    }

    if (mergedInst && threadId) {
      console.info("[messageText] user: upsertThreadInst", {
        sourceType, sourceId, messageId, threadId, hasMeta: mergedMeta != null,
      });
      await upsertThreadInst(
        sourceId,
        threadId,
        mergedInst,
        mergedMeta,
      );
    }
    return;
  }

  // group/room（呼びかけ語 or 返信モード必須）
  if (sourceType === "group" || sourceType === "room") {
    const speakerUserId: string | undefined = getSpeakerUserId(event);
    console.info("[messageText] groupRoom: start", {
      sourceType, sourceId, messageId, speakerUserId: speakerUserId ?? null, textLen: questionTrimmed.length,
    });

    // 割り込みで返信モード解除（呼びかけ本人の連投は解除しない）
    if (speakerUserId) {
      await breakReplyModeOnInterrupt(sourceType, sourceId, speakerUserId);
    }

    // 単発呼びかけ → 返信モードON＋案内のみ返して終了
    if (questionTrimmed.length > 0 && isSingleWordWake(questionTrimmed, WAKE_ALIASES)) {
      if (speakerUserId) {
        await activateReplyMode(sourceType, sourceId, speakerUserId, REPLY_MODE_TTL_SEC, REPLY_MODE);
      }
      const ackText: string = getMsg("WAKE_ACK") ?? "はい！どうぞ";
      await sendMessagesReplyThenPush({
        replyToken: event.replyToken,
        to: sourceId,
        messages: toTextMessages([ackText]),
        delayMs: 200,
      });
      console.info("[messageText] groupRoom: wake-only ack", {
        sourceType, sourceId, messageId,
      });
      return;
    }

    // 文頭呼びかけ → 呼びかけ部分を除去して本文として処理
    const head = startsWithWake(questionTrimmed, WAKE_ALIASES, WAKE_SEP_RE);
    let question: string = questionTrimmed;
    if (head.matched) {
      question = (head.cleaned ?? "").trim();
      if (speakerUserId) {
        await activateReplyMode(sourceType, sourceId, speakerUserId, REPLY_MODE_TTL_SEC, REPLY_MODE);
      }
      console.info("[messageText] groupRoom: wake head", {
        sourceType, sourceId, messageId,
      });
    } else {
      // 呼びかけ無し → 返信モードを消費できれば本文処理、できなければスキップ
      const allowedByReplyMode: boolean =
        speakerUserId ? await consumeReplyModeIfActive(sourceType, sourceId, speakerUserId) : false;
      if (!allowedByReplyMode) {
        console.info("[messageText] groupRoom: ignored (no wake/replyMode)", {
          sourceType, sourceId, messageId,
        });
        return; // グループ/ルームでは無反応（通常会話とみなす）
      }
      // allowedByReplyMode === true の場合は questionTrimmed をそのまま処理
      console.info("[messageText] groupRoom: replyMode consumed", {
        sourceType, sourceId, messageId,
      });
    }

    if (!question) {
      await sendMessagesReplyThenPush({
        replyToken: event.replyToken,
        to: sourceId,
        messages: toTextMessages([getMsg("MESSAGE_EMPTY_WARN")]),
        delayMs: 200,
      });
      console.info("[messageText] groupRoom: empty question warn", {
        sourceType, sourceId, messageId,
      });
      return;
    }

    // Thread確保 + AiContext 構築
    const threadId: string = await getOrCreateThreadId(sourceType, sourceId);
    const ctx: AiContext = { ownerId: sourceId, sourceType, threadId };
    console.info("[messageText] groupRoom: ctx ready", {
      sourceType, sourceId, messageId, threadId,
    });

    // group/room は reply のみ
    const replyRes = await runReply(ctx, { question });
    let texts: string[] = [...replyRes.texts];
    console.info("[messageText] groupRoom: reply done", {
      sourceType, sourceId, messageId, threadId, textCount: texts.length,
    });
    if (!texts.length) texts = ["（結果が見つかりませんでした）"];

    const messages: messagingApi.Message[] = [...toTextMessages(texts)];

    await sendMessagesReplyThenPush({
      replyToken: event.replyToken,
      to: sourceId,
      messages,
      delayMs: 250,
    });
    return;
  }

  // その他（ここには来ない想定）
  return;
}
