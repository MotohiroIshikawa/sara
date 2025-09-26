import { type PostbackEvent, type WebhookEvent } from "@line/bot-sdk";
import { CorrContext } from "@/logging/corr";
import { createGpts, getGptsById } from "@/services/gpts.mongo";
import { setBinding, clearBinding } from "@/services/gptsBindings.mongo";
import { getThreadInst, deleteThreadInst, purgeAllThreadInstByUser } from "@/services/threadInst.mongo";
import { resetThread } from "@/services/threadState";
import type { Meta } from "@/types/gpts";
import { sendMessagesReplyThenPush, toTextMessages } from "@/utils/lineSend";
import { describeSource, getBindingTarget, getRecipientId, getThreadOwnerId } from "@/utils/lineSource";
import { decodePostback } from "@/utils/postback";
import { setNxEx } from "@/utils/redis";

const TABLE: Record<"gpts", Record<string, Handler>> = {
  gpts: {
    save,
    continue: cont,
    new: newRule,
    activate,
  },
};

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

// 保存
async function save(event: PostbackEvent, args: Record<string, string> = {}) {
  const recipientId = getRecipientId(event);
  const userId = getThreadOwnerId(event, "plain");
  const scopedId = getThreadOwnerId(event, "scoped");
  const bindingTarget = getBindingTarget(event);
  const threadId = args["tid"];
  if (!recipientId || !userId || !scopedId || !bindingTarget || !threadId) return;

  if (!userId.startsWith("U")) {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!,
      to: recipientId,
      messages: toTextMessages(["グループルームではチャットルールの保存はできません。"]),
    });
    return;
  }

  // 重複タップ禁止
  try {
    const dedupKey = `pb:save:${scopedId}:${threadId}`;
    const ok = await setNxEx(dedupKey, "1", 30);
    if (!ok) {
      await sendMessagesReplyThenPush({
        replyToken: event.replyToken!,
        to: recipientId,
        messages: toTextMessages(["少し待ってからお試しください。"]),
      });
      return;
    }
  } catch (e) {
      console.warn("[gpts.save] dedup check skipped (redis error):", e);
  }

  const inst = await getThreadInst(scopedId, threadId);
  if (!inst?.instpack) {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!,
      to: recipientId,
      messages: toTextMessages(["保存対象が見つかりませんでした。もう一度お試しください。"]),
    });
    return;
  }

  const name = defaultTitleFromMeta(inst?.meta as Meta | undefined);
  const g = await createGpts({
    userId,
    name,
    instpack: inst.instpack,
  });
  console.info("[gpts.save] saved", { gptsId: g.gptsId, name: g.name });

  await setBinding(bindingTarget, g.gptsId, inst.instpack);
  console.info("[gpts.save] bound", { target: bindingTarget, gptsId: g.gptsId });

  // 一時保存レコードは削除する
  try { await deleteThreadInst(scopedId, threadId); } catch {}
  console.info("[gpts.save] tempThreadInstDeleted", { threadId });

  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!,
    to: recipientId,
    messages: toTextMessages([`保存しました：${g.name}\nこのトークではこの設定を使います。`]),
  });
}

// 続ける
async function cont(event: PostbackEvent) {
  const recipientId = getRecipientId(event);
  if (!recipientId) return;

  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!,
    to: recipientId,
    messages: toTextMessages(["了解しました。続けましょう！"]),
  });
}

// 新規作成（既存スレッド破棄＋バインディング解除）
async function newRule(event: PostbackEvent) {
  const recipientId = getRecipientId(event);
  const threadOwnerId = getThreadOwnerId(event);
  const bindingTarget = getBindingTarget(event);
  if (!recipientId || !threadOwnerId || !bindingTarget) return;

  // 現在の会話は破棄し、既存の有効化ルールも解除
  try { await resetThread(threadOwnerId); } catch {}
  try { await clearBinding(bindingTarget); } catch {}
  try { await purgeAllThreadInstByUser(recipientId); } catch{};

  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!,
    to: recipientId,
    messages: toTextMessages([
      "新しいチャットルールを作りましょう。",
      "ルールの内容、用途や対象をひと言で教えてください。",
    ]),
  });
}

// 既存チャットルールを有効化
async function activate(event: PostbackEvent, args: Record<string, string> = {}) {
  const recipientId = getRecipientId(event);
  const threadOwnerId = getThreadOwnerId(event);
  const bindingTarget = getBindingTarget(event);
  if (!recipientId || !threadOwnerId || !bindingTarget) return;

  const gptsId = (args["gptsId"] || "").trim();
  let instpack = (args["instpack"] || "").trim();

  // instpack未同梱ならDBから取得
  if (!instpack && gptsId) {
    const doc = await getGptsById(gptsId);
    instpack = doc?.instpack?.trim() ?? "";
  }

  if (!gptsId || !instpack) {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!,
      to: recipientId,
      messages: toTextMessages(["⚠️有効化できませんでした。対象が見つからないか内容が空です。"]),
    });
    return;
  }

  await setBinding(bindingTarget, gptsId, instpack);

  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!,
    to: recipientId,
    messages: toTextMessages(["選択したチャットルールを有効化しました。"]),
  });
}

type Handler = (event: PostbackEvent, args?: Record<string, string>) => Promise<void>;

// MAIN router: postback共通ルータ
export async function handlePostback(event: WebhookEvent): Promise<void> {
  if (event.type !== "postback" || !event.postback?.data) return;

  const pe = event as PostbackEvent;
  const src = describeSource(pe);
  const corr = CorrContext.get();
  const rawData = pe.postback.data;
  const decoded = decodePostback(rawData);

  const ctx = {
    requestId: corr?.requestId,
    threadId: decoded?.args?.tid ?? corr?.threadId,
    runId: decoded?.args?.rid ?? corr?.runId,
    userId: src.id,
  };

  console.info("[postback] received", {
    src,
    rawData,
    params: pe.postback.params ?? null,
    action: decoded ? `${decoded.ns}/${decoded.fn}` : "unknown",
    args: decoded?.args ?? null,
    ctx,
  });

  if (!decoded) return;

  const mod = TABLE[decoded.ns as keyof typeof TABLE];
  const fn = mod?.[decoded.fn];
  if (!fn) {
    console.warn(`[postback] unknown ns/fn: ${decoded.ns}/${decoded.fn}`, { ctx });
    return;
  }

  try {
    await fn(pe, decoded.args ?? {});
    console.info("[postback] handled", {
      action: `${decoded.ns}/${decoded.fn}`,
      args: decoded.args ?? null,
      src,
      ctx,
    });
  } catch (e) {
    console.error(`[postback] handler error: ${decoded.ns}/${decoded.fn}`, e, { ctx });
  }
}