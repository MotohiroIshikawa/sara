import { messagingApi, type PostbackEvent } from "@line/bot-sdk";
import { createGpts, getGptsById } from "@/services/gpts.mongo";
import { setBinding, clearBinding, getBinding } from "@/services/gptsBindings.mongo";
import { getThreadInst, deleteThreadInst, purgeAllThreadInstByUser } from "@/services/threadInst.mongo";
import { resetThread } from "@/services/threadState";
import type { Meta } from "@/types/gpts";
import { sendMessagesReplyThenPush, toTextMessages } from "@/utils/lineSend";
import { getBindingTarget, getRecipientId, getThreadOwnerId } from "@/utils/lineSource";
import { setNxEx } from "@/utils/redis";
import { uiSavedAndAskSchedule } from "@/handlers/postbacks/ui";
import type { Handler } from "@/handlers/postbacks/shared";
import { delete3AgentsForInstpack } from "@/utils/agents";
import { cloneUserSchedulesToTarget, disableUserSchedulesByGpts } from "@/services/gptsSchedules.mongo";
import { envInt } from "@/utils/env";

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
  APPLY_OWNER_FAIL_NOUSER: "操作したユーザーが特定できませんでした。もう一度お試しください。",
  APPLY_OWNER_FAIL_NOBIND: "適用できるルールが見つかりませんでした。まずは自分のトークでルールを保存してください。",
  APPLY_OWNER_OK: "このトークルームにルールを適用しました。スケジュールに沿って配信します！",
  APPLY_OWNER_OK_NAME: "「{name}」を適用しました。スケジュールに沿って配信します！",
} as const;
type MsgKey = keyof typeof DEFAULT_MSGS;
const msg = (k: MsgKey): string => process.env[`MSG_${k}`] ?? DEFAULT_MSGS[k];

// メッセージ整形
function fmt(template: string, vars: Readonly<Record<string, string>>): string {
  let out: string = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{${k}}`, v);
  }
  return out;
}

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

// 変更ブロック 開始：gpts:apply_owner 追加
const applyOwner: Handler = async (event) => {
  const recipientId = getRecipientId(event);
  const bindingTarget = getBindingTarget(event);
  if (!recipientId || !bindingTarget) return;

  // グループ/ルームのみで受け付け
  if (bindingTarget.type === "user") {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!, to: recipientId,
      messages: toTextMessages([msg("GROUP_SAVE_DENY")]),
    });
    return;
  }

  // クリックしたユーザー
  const pe: PostbackEvent = event as PostbackEvent;
  const clickUserId: string | undefined = pe.source?.userId;
  if (!clickUserId) {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!, to: recipientId,
      messages: toTextMessages([msg("APPLY_OWNER_FAIL_NOUSER")]),
    });
    return;
  }

  // 二重タップ抑止
  try {
    const key = `pb:apply_owner:${bindingTarget.type}:${bindingTarget.targetId}`;
    const ok = await setNxEx(key, "1", 30);
    if (!ok) {
      await sendMessagesReplyThenPush({
        replyToken: event.replyToken!, to: recipientId,
        messages: toTextMessages([msg("TAP_LATER")]),
      });
      return;
    }
  } catch {}

  // user-binding から gptsId / instpack を取得
  const userBinding = await getBinding({ type: "user", targetId: clickUserId });
  const gptsId: string = (userBinding?.gptsId ?? "").trim();
  const instpack: string = (userBinding?.instpack ?? "").trim();
  if (!gptsId || !instpack) {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!, to: recipientId,
      messages: toTextMessages([msg("APPLY_OWNER_FAIL_NOBIND")]),
    });
    return;
  }

  // group/room に binding を確定
  await setBinding(bindingTarget, gptsId, instpack);
  console.info("[gpts.apply_owner] bound", { target: bindingTarget, gptsId });

  // スケジュール clone（GRACE は util 既定）
  try {
    const graceSec: number = envInt("APPLY_OWNER_GRACE_SEC", 120, { min: 0, max: 86400 });
    const n = await cloneUserSchedulesToTarget({
      userId: clickUserId,
      gptsId,
      targetType: bindingTarget.type,
      targetId: bindingTarget.targetId,
      graceSec,
    });
    console.info("[gpts.apply_owner] schedules cloned", { count: n });
  } catch (e) {
    console.warn("[gpts.apply_owner] schedules clone failed", e);
  }

  // ユーザ側スケジュール停止
  try {
    const m = await disableUserSchedulesByGpts({ userId: clickUserId, gptsId });
    console.info("[gpts.apply_owner] user schedules disabled", { count: m });
  } catch (e) {
    console.warn("[gpts.apply_owner] disable user schedules failed", e);
  }

  // 既存エージェントキャッシュ掃除
  try {
    await delete3AgentsForInstpack(instpack);
  } catch (e) {
    console.warn("[gpts.apply_owner] delete agents failed", e);
  }

  // 適用後にスレッドをリセット
  const threadOwnerId: string | null = getThreadOwnerId(event) ?? null;
  if (threadOwnerId) {
    try {
      await resetThread(threadOwnerId);
      console.info("[gpts.apply_owner] thread reset", { threadOwnerId });
    } catch (e) {
      console.warn("[gpts.apply_owner] thread reset failed", e, { threadOwnerId });
    }
  }

  // ルール名を付けて案内（取得できなければ既定文言）
  let name: string | null = null;
  try {
    const doc = await getGptsById(gptsId);
    name = doc?.name ?? null;
  } catch {}
  const okText: string = name
    ? fmt(msg("APPLY_OWNER_OK_NAME"), { name })
    : msg("APPLY_OWNER_OK");

  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!, to: recipientId,
    messages: toTextMessages([okText]),
  });
};

export const gptsHandlers: Record<string, Handler> = {
  save,
  continue: cont,
  new: newRule,
  activate,
  apply_owner: applyOwner,
};

export const chatHandlers: Record<string, Handler> = {
  new: newRule,
};
