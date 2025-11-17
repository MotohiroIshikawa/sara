import { messagingApi, type PostbackEvent } from "@line/bot-sdk";
import { createGpts, getGptsById } from "@/services/gpts.mongo";
import { setBinding, clearBinding, getBinding } from "@/services/gptsBindings.mongo";
import { getThreadInst, deleteThreadInst, purgeAllThreadInstByUser } from "@/services/threadInst.mongo";
import { resetThread } from "@/services/threadState";
import type { Meta, SourceType } from "@/types/gpts";
import { sendMessagesReplyThenPush, toTextMessages } from "@/utils/line/lineSend";
import { getSourceId, getSourceType } from "@/utils/line/lineSource";
import { setNxEx } from "@/utils/redis";
import { uiSavedAndAskSchedule } from "@/handlers/postbacks/ui";
import type { Handler } from "@/handlers/postbacks/shared";
import { delete3AgentsForInstpack } from "@/utils/agents";
import { cloneUserSchedulesToTarget, disableUserSchedulesByGpts } from "@/services/gptsSchedules.mongo";
import { envInt } from "@/utils/env";
import { getMsg, formatMsg } from "@/utils/line/msgCatalog";

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
  const domain = meta?.domain ?? null;

  switch (domain) {
    case "event":
      if (t) return sanitizeTitle(`${t}のイベント情報${p ? `（${p}）` : ""}`);
      break;
    case "news":
      if (t) return sanitizeTitle(`${t}の最新ニュース`);
      break;
    case "shopping":
      if (t) return sanitizeTitle(`${t}の購入情報${p ? `（${p}）` : ""}`);
      break;
    case "local":
      if (t || p) return sanitizeTitle(`${p || ""}${t ? (p ? `の${t}` : t) : ""}`);
      break;
    case "object":
      if (t) return sanitizeTitle(`${t}について`);
      break;
    default:
      if (t && p) return sanitizeTitle(`${t}（${p}）`);
      if (t) return sanitizeTitle(t);
      break;
  }
  return "未命名ルール";
}

// gpts:save
const save: Handler = async (event, args: Record<string, unknown> = {}) => {
  const sourceId: string | undefined = getSourceId(event);
  const sourceType: SourceType | undefined = getSourceType(event);
  const threadId: string = String(args["tid"] ?? "");
  if (!sourceId || !sourceType || !threadId) return;

  if (sourceType !== "user") {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!,
      to: sourceId,
      messages: toTextMessages([getMsg("GROUP_SAVE_DENY")]),
    });
    return;
  }

  // 重複タップ禁止
  try {
    const dedupKey = `pb:save:${sourceType}:${sourceId}:${threadId}`;
    const ok = await setNxEx(dedupKey, "1", 30);
    if (!ok) {
      await sendMessagesReplyThenPush({
        replyToken: event.replyToken!, to: sourceId,
        messages: toTextMessages([getMsg("TAP_LATER")]),
      });
      return;
    }
  } catch (e) {
    console.warn("[gpts.save] dedup check skipped (redis error):", e);
  }

  const inst = await getThreadInst(sourceId, threadId);
  if (!inst?.instpack) {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!, to: sourceId,
      messages: toTextMessages([getMsg("SAVE_TARGET_NOT_FOUND")]),
    });
    return;
  }

  const name = defaultTitleFromMeta(inst?.meta as Meta | undefined);
  const g = await createGpts(sourceId, name, inst.instpack);
  console.info("[gpts.save] saved", { gptsId: g.gptsId, name: g.name });

  await setBinding("user", sourceId, g.gptsId, inst.instpack);
  console.info("[gpts.save] bound", { user: sourceId, gptsId: g.gptsId });

  try { await deleteThreadInst(sourceId, threadId); } catch {}
  console.info("[gpts.save] tempThreadInstDeleted", { threadId });

  const schedConfirm: messagingApi.Message = uiSavedAndAskSchedule(g.gptsId, g.name);
  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!, 
    to: sourceId,
    messages: [schedConfirm],
  });
};

// gpts:continue
const cont: Handler = async (event) => {
  const sourceId: string | undefined = getSourceId(event);
  if (!sourceId) return;
  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!, 
    to: sourceId,
    messages: toTextMessages([getMsg("CONTINUE_OK")]),
  });
};

const newRule: Handler = async (event) => {
  const sourceId: string | undefined = getSourceId(event);
  const sourceType: SourceType | undefined = getSourceType(event);
  if (!sourceId || !sourceType) return;

  // 二重タップ抑止
  try {
    const ok: boolean = await setNxEx(`pb:new:${sourceType}:${sourceId}`, "1", 10);
    if (!ok) {
      await sendMessagesReplyThenPush({
        replyToken: event.replyToken!, 
        to: sourceId,
        messages: toTextMessages([getMsg("TAP_LATER")]),
      });
      return;
    }
  } catch {}

  // スレッドをリセット
  try { await resetThread(sourceType, sourceId); } catch {}

  // 一時draftは user のみ対象
  if (sourceType === "user") {
    try { await purgeAllThreadInstByUser(sourceId); } catch {}
  }

  // 現在のチャットバインディングをクリア
  try { await clearBinding(sourceType, sourceId); } catch {}

  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!, 
    to: sourceId,
    messages: toTextMessages([getMsg("NEW_INTRO_1"), getMsg("NEW_INTRO_2")]),
  });
};

// gpts:activate
const activate: Handler = async (event, args: Record<string, unknown> = {}) => {
  const sourceId: string | undefined = getSourceId(event);
  const sourceType: SourceType | undefined = getSourceType(event);
  if (!sourceId || !sourceType) return;

  const gptsId: string = String((args["gptsId"] ?? "")).trim();
  let instpack: string = String((args["instpack"] ?? "")).trim();

  if (!instpack && gptsId) {
    const doc = await getGptsById(gptsId);
    instpack = doc?.instpack?.trim() ?? "";
  }

  if (!gptsId || !instpack) {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!, 
      to: sourceId,
      messages: toTextMessages([getMsg("ACTIVATE_FAIL")]),
    });
    return;
  }

  await setBinding(sourceType, sourceId, gptsId, instpack);
  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!, 
    to: sourceId,
    messages: toTextMessages([getMsg("ACTIVATE_OK")]),
  });
};

// gpts:apply_owner
const applyOwner: Handler = async (event) => {
  const sourceId: string | undefined = getSourceId(event);
  const sourceType: SourceType | undefined = getSourceType(event);
  if (!sourceId || !sourceType) return;

  // グループ/ルームのみで受け付け
  if (sourceType === "user") {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!, 
      to: sourceId,
      messages: toTextMessages([getMsg("GROUP_SAVE_DENY")]),
    });
    return;
  }

  // クリックしたユーザー
  const pe: PostbackEvent = event as PostbackEvent;
  const clickUserId: string | undefined = pe.source?.userId;
  if (!clickUserId) {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!, 
      to: sourceId,
      messages: toTextMessages([getMsg("APPLY_OWNER_FAIL_NOUSER")]),
    });
    return;
  }

  // 二重タップ抑止
  try {
    const key = `pb:apply_owner:${sourceType}:${sourceId}`;
    const ok = await setNxEx(key, "1", 30);
    if (!ok) {
      await sendMessagesReplyThenPush({
        replyToken: event.replyToken!, 
        to: sourceId,
        messages: toTextMessages([getMsg("TAP_LATER")]),
      });
      return;
    }
  } catch {}

  // user-binding から gptsId / instpack を取得
  const userBinding = await getBinding("user", clickUserId);
  const gptsId: string = (userBinding?.gptsId ?? "").trim();
  const instpack: string = (userBinding?.instpack ?? "").trim();
  if (!gptsId || !instpack) {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!, 
      to: sourceId,
      messages: toTextMessages([getMsg("APPLY_OWNER_FAIL_NOBIND")]),
    });
    return;
  }

  // group/room に binding を確定
  await setBinding(sourceType, sourceId, gptsId, instpack);
  console.info("[gpts.apply_owner] bound", { sourceId, sourceType, gptsId });

  // スケジュール clone（GRACE は util 既定）
  try {
    const graceSec: number = envInt("APPLY_OWNER_GRACE_SEC", 120, { min: 0, max: 86400 });
    const n = await cloneUserSchedulesToTarget(
      clickUserId,
      gptsId,
      sourceType,
      sourceId,
      graceSec
    );
    console.info("[gpts.apply_owner] schedules cloned", { count: n });
  } catch (e) {
    console.warn("[gpts.apply_owner] schedules clone failed", e);
  }

  // ユーザ側スケジュール停止
  try {
    // TODO: 配列引数をやめる
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
  if (sourceType && sourceId) {
    try {
      await resetThread(sourceType, sourceId);
      console.info("[gpts.apply_owner] thread reset", { sourceType, sourceId });
    } catch (e) {
      console.warn("[gpts.apply_owner] thread reset failed", e, { sourceType, sourceId });
    }
  }

  // ルール名を付けて案内（取得できなければ既定文言）
  let name: string | null = null;
  try {
    const doc = await getGptsById(gptsId);
    name = doc?.name ?? null;
  } catch {}
  const okText: string = name
    ? formatMsg(getMsg("APPLY_OWNER_OK_NAME"), { name })
    : getMsg("APPLY_OWNER_OK");

  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!, 
    to: sourceId,
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
