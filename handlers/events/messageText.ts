import { messagingApi, type MessageEvent } from "@line/bot-sdk";
import { LINE, WAKE } from "@/utils/env";
import { toTextMessages, sendMessagesReplyThenPush, buildSaveOrContinueConfirm } from "@/utils/line/lineSend";
import { encodePostback } from "@/utils/line/postback";
import { getMsg } from "@/utils/line/msgCatalog";
import { upsertThreadInst, getMetaCarry, setMetaCarry, type MetaCarry } from "@/services/threadInst.mongo";
import {
  activateReplyMode,
  consumeReplyModeIfActive,
  breakReplyModeOnInterrupt,
  isSingleWordWake,
  startsWithWake,
  DEFAULT_WAKE_SEP_RE,
  type ReplyMode,
} from "@/utils/line/wakeState";
import { getMeta } from "@/utils/meta/getMeta";
import { getInstpack } from "@/utils/instpack/getInstpack";
import { computeMeta, extractMetaCarry } from "@/utils/meta/computeMeta";
import type { AiContext, AiReplyOptions, Meta, MetaComputeResult } from "@/types/gpts";
import { getOrCreateThreadId } from "@/services/threadState";
import { getSpeakerUserId } from "@/utils/line/lineSource";
import { runReply } from "@/utils/reply/selector";
import { agentsClient } from "@/utils/agents";

const replyMax: number = LINE.REPLY_MAX;
const REPLY_MODE: ReplyMode = "session";
const REPLY_MODE_TTL_SEC: number = WAKE.REPLY_MODE_TTL_SEC;
const WAKE_ALIASES: readonly string[] = WAKE.ALIASES as readonly string[];
const WAKE_SEP_RE: RegExp = DEFAULT_WAKE_SEP_RE;

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

    // thread に user message を追加（meta 前に1回）
    await agentsClient.messages.create(
      threadId,
      "user",
      [{ type: "text", text: question }]
    );
    console.info("[messageText] user: thread message appended", {
      sourceType, sourceId, messageId, threadId,
    });

    // 1. meta取得（先）
    const metaRes = await getMeta(ctx, { hasImageHint: false });
    const rawMeta: Meta | undefined = metaRes.meta ?? undefined;
    console.info("[messageText] user: meta fetched", {
      sourceType, sourceId, messageId, threadId,
      hasMeta: rawMeta != null,
      intent: rawMeta?.intent ?? null,
      modality: rawMeta?.modality ?? null,
      runId: metaRes.runId,
    });

    // 2. prev metaCarry 読み出し（Agentに渡さないでNodeで補完）
    const prevCarry: MetaCarry | undefined = await getMetaCarry(sourceId, threadId);
    console.info("[messageText] user: metaCarry loaded", {
      sourceType, sourceId, messageId, threadId,
      hasPrevCarry: prevCarry != null,
    });

    // 3. computeMeta(rawMeta, prevCarry) で Node 判定
    let metaEval: MetaComputeResult | undefined = undefined;
    let mergedMeta: Meta | undefined = undefined;

    if (rawMeta) {
      metaEval = computeMeta(rawMeta, prevCarry); // prevCarry を渡す
      mergedMeta = metaEval.metaNorm;

      console.info("[messageText] user: meta computed", {
        sourceType, sourceId, messageId, threadId,
        saveable: metaEval.saveable,
        missing: metaEval.missing,
      });

      // 4. 次回用 metaCarry を保存更新
      const nextCarry: MetaCarry = extractMetaCarry(mergedMeta);
      await setMetaCarry(sourceId, threadId, nextCarry);
      console.info("[messageText] user: metaCarry saved", {
        sourceType, sourceId, messageId, threadId,
      });
    } else {
      console.info("[messageText] user: meta missing (no meta extracted)", {
        sourceType, sourceId, messageId, threadId,
      });
    }

    // 5. reply 実行（missingReasons/metaNorm を渡す）
    const replyOpts: AiReplyOptions = {
      question,
      missingReasons: metaEval?.missing ?? [],
      // metaNorm: mergedMeta, // 将来用だが今は履歴汚染になるだけなので渡さない
    };
    const replyRes = await runReply(ctx, replyOpts);
    let texts: string[] = [...replyRes.texts];
    console.info("[messageText] user: reply done", {
      sourceType, sourceId, messageId, threadId, textCount: texts.length,
    });

    if (!texts.length) texts = ["（結果が見つかりませんでした）"];

    // 6. saveable のときだけ instpack 取得（判定結果に従属）
    let mergedInst: string | undefined = undefined;
    if (metaEval?.saveable === true) {
      const instRes = await getInstpack(ctx);
      mergedInst = instRes.instpack;
      console.info("[messageText] user: instpack fetched", {
        sourceType, sourceId, messageId, threadId,
        runId: instRes.runId,
      });
    }

    // 通常の送出
    const messages: messagingApi.Message[] = [...toTextMessages(texts)];

    // 保存 confirm
    const showConfirm: boolean = metaEval?.saveable === true && !!mergedInst;
    let confirmMsg: messagingApi.Message | null = null;
    if (showConfirm) {
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
    } else {
      console.info("[messageText] confirm skipped (not saveable)", {
        sourceType, sourceId, messageId, threadId,
      });
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
