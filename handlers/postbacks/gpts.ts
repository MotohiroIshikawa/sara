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

// タイトル体裁の軽い整形（空白正規化・末尾句読点除去・最大40字）
function sanitizeTitle(raw: string): string {
  const collapsed = raw.replace(/[\u3000\s]+/g, " ").trim(); // 全角/半角空白を単一空白へ正規化
  const trimmed = collapsed.replace(/[、。．,.・･…\u3001\u3002]+$/u, "").trim(); // 末尾の句読点・記号を除去
  if (trimmed.length <= 40) return trimmed;
  const cutAt = trimmed.lastIndexOf(" ", 39); // 語中でなるべく切る
  return (cutAt > 10 ? trimmed.slice(0, cutAt) : trimmed.slice(0, 39)).trim() + "…";
}

// 保存名のデフォルト生成（metaを参照）
function defaultTitleFromMeta(meta?: Meta): string {
  // reply/META側で生成されたタイトルがあれば最優先で使う
  const slots = meta?.slots as Record<string, unknown> | undefined;
  const slotTitle = typeof slots?.title === "string" ? slots.title.trim() : undefined;
  if (slotTitle && slotTitle.length > 0) return slotTitle.trim();

  const t = meta?.slots?.topic;
  const p = meta?.slots?.place ?? undefined;
  const intent = meta?.intent;
  if (intent === "event" && t) return sanitizeTitle(`${t}のイベント情報${p ? `（${p}）` : ""}`);
  if (intent === "news"  && t) return sanitizeTitle(`${t}の最新ニュース`);
  if (intent === "buy"   && t) return sanitizeTitle(`${t}の購入情報${p ? `（${p}）` : ""}`);
  if (t && p) return sanitizeTitle(`${t}（${p}）`);
  if (t) return sanitizeTitle(t);
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
