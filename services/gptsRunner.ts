import { messagingApi  } from "@line/bot-sdk";
import { getGptsById } from "@/services/gpts.mongo";
import type { SourceType } from "@/types/gpts";
import { connectBing } from "@/utils/connectBing";
import { pushMessages, toTextMessages } from "@/utils/lineSend";

export type RunOk = { ok: true };
export type RunNg = { ok: false; reason: string };
export type RunResult = RunOk | RunNg;

//type TargetType = SourceType;

export async function runGptsAndPush(input: {
  gptsId: string;
  userId: string;               // 監査用（作成者/所有者）
  targetType: SourceType;       // "user" | "group" | "room"
  targetId: string;             // Uxxxx / Cxxxx / Rxxxx
}): Promise<RunResult> {

  // 1. GPTs（instpack/name）取得
  const gpts = await getGptsById(input.gptsId);
  if (!gpts || gpts.deletedAt) {
    return { ok: false, reason: "gpts not found or deleted" };
  }
  if (!gpts.instpack || gpts.instpack.trim().length < 10) {
    return { ok: false, reason: "instpack is empty" };
  }

  // 2. スケジュール実行用の“質問”を決める
  const question = `【定期配信】${gpts.name ?? "スケジュール実行"} — 直近の推奨アップデートを1通にまとめて。必要なら簡潔に箇条書きで。`;

  // 3. 生成実行（connectBing）
  let texts: string[] = [];
  try {
    const res = await connectBing(input.targetId, question, {
      sourceType: input.targetType,
      // ここでは meta/instpack の保存は行わない（スケジュール配信なので）
      maxMetaRetry: 1,
    });

    // connectBing は LINE 用に整形済みの string[] を返す設計
    texts = Array.isArray(res.texts) ? res.texts : [];
  } catch (e) {
    return { ok: false, reason: asMsg(e) };
  }

  if (!texts.length) {
    // 応答が空でも「送信自体」は成功させず、失敗にしておくほうが監視しやすい
    return { ok: false, reason: "empty response" };
  }

  // 4. LINE Push 送信（必要なら分割は sendPushMessages 側で実施）
  const messages = toTextMessages(texts);
  try {
    await pushMessages({ 
      to: input.targetId, 
      messages: messages as messagingApi.Message[] 
    });
  } catch (e) {
    return { ok: false, reason: asMsg(e) };
  }

  // 5. 完了
  return { ok: true };
}

function asMsg(e: unknown): string {
  return (e as Error)?.message ?? String(e);
}
