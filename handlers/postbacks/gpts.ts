import { messagingApi } from "@line/bot-sdk";
import { createGpts, getGptsById } from "@/services/gpts.mongo";
import { setBinding, clearBinding } from "@/services/gptsBindings.mongo";
import { getThreadInst, deleteThreadInst, purgeAllThreadInstByUser } from "@/services/threadInst.mongo";
import { resetThread } from "@/services/threadState";
import type { Meta } from "@/types/gpts";
import { sendMessagesReplyThenPush, toTextMessages } from "@/utils/lineSend";
import { getBindingTarget, getRecipientId, getThreadOwnerId } from "@/utils/lineSource";
import { setNxEx } from "@/utils/redis";
import { uiSavedAndAskSchedule } from "./ui";
import type { Handler } from "./shared";

// メッセージ定義
const DEFAULT_MSGS = {
  GROUP_SAVE_DENY: "グループルームではチャットルールの保存はできません。",
  TAP_LATER: "少し待ってからお試しください。",
  SAVE_TARGET_NOT_FOUND: "保存対象が見つかりませんでした。もう一度お試しください。",
  CONTINUE_OK: "了解しました。続けましょう！",
  NEW_INTRO_1: "新しいチャットルールを作りましょう。",
  NEW_INTRO_2: "ルールの内容、用途や対象をひと言で教えてください。",
  ACTIVATE_FAIL: "⚠️有効化できませんでした。対象が見つからないか内容が空です。",
  ACTIVATE_OK: "選択したチャットルールを有効化しました。",
} as const;
type MsgKey = keyof typeof DEFAULT_MSGS;
const msg = (k: MsgKey): string => process.env[`MSG_${k}`] ?? DEFAULT_MSGS[k];

// 保存名のデフォルト生成（metaを参照）
function defaultTitleFromMeta(meta?: Meta): string {
  const t = meta?.slots?.topic;
  const p = meta?.slots?.place ?? undefined;
  const d = meta?.slots?.date_range ?? undefined;
  const intent = meta?.intent;
  if (intent === "event" && t) return `イベント: ${t}${p ? ` @${p}` : ""}${d ? ` (${d})` : ""}`;
  if (intent === "news"  && t) return `ニュース: ${t}${d ? ` (${d})` : ""}`;
  if (intent === "buy"   && t) return `購入: ${t}${p ? ` @${p}` : ""}`;
  if (t && p) return `${t} @${p}`;
  if (t) return t;
  return "未命名ルール";
}

const save: Handler = async (event, args = {}) => {
  const recipientId = getRecipientId(event);
  const userId = getThreadOwnerId(event, "plain");
  const scopedId = getThreadOwnerId(event, "scoped");
  const bindingTarget = getBindingTarget(event);
  const threadId = args["tid"];
  if (!recipientId || !userId || !scopedId || !bindingTarget || !threadId) return;

  if (!userId.startsWith("U")) {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!, to: recipientId,
      messages: toTextMessages([msg("GROUP_SAVE_DENY")]),
    });
    return;
  }

  // 重複タップ禁止
  try {
    const dedupKey = `pb:save:${scopedId}:${threadId}`;
    const ok = await setNxEx(dedupKey, "1", 30);
    if (!ok) {
      await sendMessagesReplyThenPush({
        replyToken: event.replyToken!, to: recipientId,
        messages: toTextMessages([msg("TAP_LATER")]),
      });
      return;
    }
  } catch (e) {
    console.warn("[gpts.save] dedup check skipped (redis error):", e);
  }

  const inst = await getThreadInst(scopedId, threadId);
  if (!inst?.instpack) {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!, to: recipientId,
      messages: toTextMessages([msg("SAVE_TARGET_NOT_FOUND")]),
    });
    return;
  }

  const name = defaultTitleFromMeta(inst?.meta as Meta | undefined);
  const g = await createGpts({ userId, name, instpack: inst.instpack });
  console.info("[gpts.save] saved", { gptsId: g.gptsId, name: g.name });

  await setBinding(bindingTarget, g.gptsId, inst.instpack);
  console.info("[gpts.save] bound", { target: bindingTarget, gptsId: g.gptsId });

  try { await deleteThreadInst(scopedId, threadId); } catch {}
  console.info("[gpts.save] tempThreadInstDeleted", { threadId });

  const schedConfirm: messagingApi.Message = uiSavedAndAskSchedule(g.gptsId, g.name);
  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!, to: recipientId,
    messages: [schedConfirm],
  });
};

const cont: Handler = async (event) => {
  const recipientId = getRecipientId(event);
  if (!recipientId) return;
  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!, to: recipientId,
    messages: toTextMessages([msg("CONTINUE_OK")]),
  });
};

const newRule: Handler = async (event) => {
  const recipientId = getRecipientId(event);
  const threadOwnerId = getThreadOwnerId(event);
  const bindingTarget = getBindingTarget(event);
  if (!recipientId || !threadOwnerId || !bindingTarget) return;

  try {
    const ok = await setNxEx(`pb:new:${threadOwnerId}`, "1", 10);
    if (!ok) {
      await sendMessagesReplyThenPush({
        replyToken: event.replyToken!, to: recipientId,
        messages: toTextMessages([msg("TAP_LATER")]),
      });
      return;
    }
  } catch {}

  try { await resetThread(threadOwnerId); } catch {}
  try { await purgeAllThreadInstByUser(threadOwnerId); } catch {}
  try { await clearBinding(bindingTarget); } catch {}

  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!, to: recipientId,
    messages: toTextMessages([msg("NEW_INTRO_1"), msg("NEW_INTRO_2")]),
  });
};

const activate: Handler = async (event, args = {}) => {
  const recipientId = getRecipientId(event);
  const threadOwnerId = getThreadOwnerId(event);
  const bindingTarget = getBindingTarget(event);
  if (!recipientId || !threadOwnerId || !bindingTarget) return;

  const gptsId = (args["gptsId"] || "").trim();
  let instpack = (args["instpack"] || "").trim();

  if (!instpack && gptsId) {
    const doc = await getGptsById(gptsId);
    instpack = doc?.instpack?.trim() ?? "";
  }

  if (!gptsId || !instpack) {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!, to: recipientId,
      messages: toTextMessages([msg("ACTIVATE_FAIL")]),
    });
    return;
  }

  await setBinding(bindingTarget, gptsId, instpack);
  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!, to: recipientId,
    messages: toTextMessages([msg("ACTIVATE_OK")]),
  });
};

export const gptsHandlers: Record<string, Handler> = {
  save,
  continue: cont,
  new: newRule,
  activate,
};

export const chatHandlers: Record<string, Handler> = {
  new: newRule,
};
