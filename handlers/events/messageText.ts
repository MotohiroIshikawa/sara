import { messagingApi, type MessageEvent } from "@line/bot-sdk";
import { connectBing } from "@/utils/connectBing";
import { LINE, WAKE } from "@/utils/env";
import { toTextMessages, sendMessagesReplyThenPush, buildSaveOrContinueConfirm } from "@/utils/lineSend";
import { encodePostback } from "@/utils/postback";
import { getMsg } from "@/utils/msgCatalog";
import { isTrackable } from "@/utils/meta";
import { upsertThreadInst } from "@/services/threadInst.mongo";
import {
  activateReplyMode,
  consumeReplyModeIfActive,
  breakReplyModeOnInterrupt,
  isSingleWordWake,
  startsWithWake,
  DEFAULT_WAKE_SEP_RE,
} from "@/utils/wakeState";

const replyMax: number = LINE.REPLY_MAX;
const REPLY_MODE_TTL_SEC: number = WAKE.REPLY_MODE_TTL_SEC;
const WAKE_ALIASES: readonly string[] = WAKE.ALIASES as readonly string[];
const WAKE_SEP_RE: RegExp = DEFAULT_WAKE_SEP_RE;

// 確認カード表示の条件
function shouldShowConfirm(meta: unknown, instpack: string | undefined, threadId?: string): boolean {
  if (!threadId) return false;
  if (!instpack?.trim()) return false;
  const m = meta as { complete?: boolean } | undefined;
  if (!m || m.complete !== true) return false;
  if (!isTrackable(m as unknown as Record<string, unknown>)) return false;
  return true;
}

// 確認カード直前の最終ガード
function finalCheckBeforeConfirm(
  meta: { complete?: boolean } | undefined,
  instpack: string | undefined
): { ok: boolean; reason?: string } {
  if (!meta) return { ok: false, reason: "meta:undefined" };
  if (!isTrackable(meta as unknown as Record<string, unknown>)) return { ok: false, reason: "meta:not_trackable" };
  if (meta.complete !== true) return { ok: false, reason: "meta:incomplete" };
  const s: string = instpack?.trim() ?? "";
  if (!s) return { ok: false, reason: "instpack:empty" };
  if (s.length < 80) return { ok: false, reason: "instpack:too_short" };
  if (/```/.test(s)) return { ok: false, reason: "instpack:has_fence" };
  if (/[?？]\s*$/.test(s)) return { ok: false, reason: "instpack:looks_question" };
  return { ok: true };
}

// messageイベント処理(text)
export async function handleMessageText(
  event: MessageEvent,
  recipientId: string,
  threadOwnerId: string
): Promise<void> {
  const questionRaw: string = (event.message.type === "text" ? event.message.text ?? "" : "");
  const questionTrimmed: string = questionRaw.trim();
  const srcType: "user" | "group" | "room" = event.source.type;

  // 1対1（常時応答）
  if (srcType === "user") {
    const question: string = questionTrimmed;
    if (!question) {
      await sendMessagesReplyThenPush({
        replyToken: event.replyToken,
        to: recipientId,
        messages: toTextMessages([getMsg("MESSAGE_EMPTY_WARN")]),
        delayMs: 250,
      });
      return;
    }

    const res = await connectBing(threadOwnerId, question, { sourceType: srcType });

    const messages: messagingApi.Message[] = [...toTextMessages(res.texts)];
    const show: boolean = shouldShowConfirm(res.meta, res.instpack, res.threadId);
    const guard = show ? finalCheckBeforeConfirm(res.meta, res.instpack) : { ok: false as boolean, reason: "skip" };
    if (!guard.ok) {
      console.info("[messageText] confirm skipped by finalCheck:", { tid: res.threadId, reason: guard.reason });
    }

    let confirmMsg: messagingApi.Message | null = null;
    if (show && guard.ok) {
      confirmMsg = buildSaveOrContinueConfirm({
        text: "この内容で保存しますか？",
        saveData: encodePostback("gpts", "save", { tid: res.threadId, label: "保存" }),
        continueData: encodePostback("gpts", "continue", { tid: res.threadId, label: "続ける" }),
      });
      messages.push(confirmMsg);

      const idx: number = messages.indexOf(confirmMsg);
      const willBePushedIfReplyOK: boolean = idx >= replyMax;
      console.info(
        "[messageText] confirm queued. index=%d, willBe=%s (if reply OK). tid=%s",
        idx,
        willBePushedIfReplyOK ? "PUSH" : "REPLY",
        res.threadId
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
      to: recipientId,
      messages,
      delayMs: 250,
      log: logProxy,
    });

    if (confirmMsg) {
      const idx: number = messages.indexOf(confirmMsg);
      const wasPushed: boolean = replyFellBackToPush || (idx >= replyMax);
      console.info(
        "[messageText] confirm delivered via %s. idx=%d, fallback=%s, tid=%s",
        wasPushed ? "PUSH" : "REPLY",
        idx,
        replyFellBackToPush,
        res.threadId
      );
    }

    if (res.instpack && res.threadId) {
      await upsertThreadInst({
        userId: threadOwnerId,
        threadId: res.threadId,
        instpack: res.instpack,
        meta: res.meta,
      });
    }
    return;
  }

  // group/room（呼びかけ語 or 返信モード必須）
  if (srcType === "group" || srcType === "room") {
    const scopeId: string = threadOwnerId;
    const speakerUserId: string | undefined = event.source.userId ?? undefined;

    // 割り込みで返信モード解除（呼びかけ本人の連投は解除しない）
    if (scopeId && speakerUserId) {
      await breakReplyModeOnInterrupt(scopeId, speakerUserId);
    }

    // 呼びかけ判定
    // 単発呼びかけ → 返信モードON＋案内のみ返して終了
    if (questionTrimmed.length > 0 && isSingleWordWake(questionTrimmed, WAKE_ALIASES)) {
      if (scopeId && speakerUserId) {
        await activateReplyMode(scopeId, speakerUserId, REPLY_MODE_TTL_SEC);
      }
      const ackText: string = getMsg("WAKE_ACK") ?? "はい！どうぞ";
      await sendMessagesReplyThenPush({
        replyToken: event.replyToken,
        to: recipientId,
        messages: toTextMessages([ackText]),
        delayMs: 200,
      });
      return;
    }

    // 文頭呼びかけ → 呼びかけ部分を除去して本文として処理
    const head = startsWithWake(questionTrimmed, WAKE_ALIASES, WAKE_SEP_RE);
    let question: string = questionTrimmed;
    if (head.matched) {
      question = (head.cleaned ?? "").trim();
    } else {
      //  呼びかけ無し → 返信モードを消費できれば本文処理、できなければスキップ
      const allowedByReplyMode: boolean =
        scopeId && speakerUserId ? await consumeReplyModeIfActive(scopeId, speakerUserId) : false;
      if (!allowedByReplyMode) {
        return; // グループ/ルームでは無反応（通常会話とみなす）
      }
      // allowedByReplyMode === true の場合は questionTrimmed をそのまま処理
    }

    if (!question) {
      await sendMessagesReplyThenPush({
        replyToken: event.replyToken,
        to: recipientId,
        messages: toTextMessages([getMsg("MESSAGE_EMPTY_WARN")]),
        delayMs: 200,
      });
      return;
    }

    const res = await connectBing(threadOwnerId, question, { sourceType: srcType });

    const messages: messagingApi.Message[] = [...toTextMessages(res.texts)];
    const show: boolean = shouldShowConfirm(res.meta, res.instpack, res.threadId);
    const guard = show ? finalCheckBeforeConfirm(res.meta, res.instpack) : { ok: false as boolean, reason: "skip" };
    if (!guard.ok) {
      console.info("[messageText] confirm skipped by finalCheck:", { tid: res.threadId, reason: guard.reason });
    }

    let confirmMsg: messagingApi.Message | null = null;
    if (show && guard.ok) {
      confirmMsg = buildSaveOrContinueConfirm({
        text: "この内容で保存しますか？",
        saveData: encodePostback("gpts", "save", { tid: res.threadId, label: "保存" }),
        continueData: encodePostback("gpts", "continue", { tid: res.threadId, label: "続ける" }),
      });
      messages.push(confirmMsg);

      const idx: number = messages.indexOf(confirmMsg);
      const willBePushedIfReplyOK: boolean = idx >= replyMax;
      console.info(
        "[messageText] confirm queued. index=%d, willBe=%s (if reply OK). tid=%s",
        idx,
        willBePushedIfReplyOK ? "PUSH" : "REPLY",
        res.threadId
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
      to: recipientId,
      messages,
      delayMs: 250,
      log: logProxy,
    });

    if (confirmMsg) {
      const idx: number = messages.indexOf(confirmMsg);
      const wasPushed: boolean = replyFellBackToPush || (idx >= replyMax);
      console.info(
        "[messageText] confirm delivered via %s. idx=%d, fallback=%s, tid=%s",
        wasPushed ? "PUSH" : "REPLY",
        idx,
        replyFellBackToPush,
        res.threadId
      );
    }

    if (res.instpack && res.threadId) {
      await upsertThreadInst({
        userId: threadOwnerId,
        threadId: res.threadId,
        instpack: res.instpack,
        meta: res.meta,
      });
    }
    return;
  }

  // その他（ここには来ない想定）
  return;
}
