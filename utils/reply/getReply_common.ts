import { type MessageContentUnion } from "@azure/ai-agents";
import type { AiContext, AiReplyOptions, AiReplyResult, SourceType } from "@/types/gpts";
import { agentsClient } from "@/utils/agents";
import { withTimeout } from "@/utils/async";
import { MAIN_TIMERS, DEBUG } from "@/utils/env";

// reply オプション（既定値埋め後）
export type NormalizedReplyOptions =
  Omit<Required<AiReplyOptions>, "metaNorm"> & {
    metaNorm: AiReplyOptions["metaNorm"];
  };

// runs.get の状態確認用
type RunState = {
  status?:
    | "queued"
    | "in_progress"
    | "requires_action"
    | "completed"
    | "failed"
    | "cancelled"
    | "expired";
};

const debugAi: boolean =
  (DEBUG.AI || process.env["DEBUG.AI"] === "true" || process.env.DEBUG_AI === "true") === true;

// runId 優先で保持する assistant メッセージ
export type AssistantMessage = {
  runId?: string;
  content: MessageContentUnion[];
};

// reply オプションに既定値を埋める
export function normalizeReplyOptions(opts?: AiReplyOptions): NormalizedReplyOptions {
  return {
    question: opts?.question ?? "",
    imageUrls: opts?.imageUrls ?? [],
    missingReasons: opts?.missingReasons ?? [],
    metaNorm: opts?.metaNorm,
  };
}

// owner 単位のロックキーを生成（sourceType + ownerId）
export function createOwnerLockKey(sourceType: SourceType, ownerId: string): string {
  return `owner:${sourceType}:${ownerId}`;
}

// assistant メッセージを runId 優先で取得（なければ最新の assistant を返す）
export async function getAssistantMessageForRun(
  threadId: string,
  runId: string
): Promise<AssistantMessage | undefined> {
  let fallback: AssistantMessage | undefined;

  for await (const m of agentsClient.messages.list(threadId, { order: "desc" })) {
    if (m.role !== "assistant") continue;

    const normalized: AssistantMessage = {
      runId: m.runId ?? undefined,
      content: m.content as MessageContentUnion[],
    };

    if (!fallback) fallback = normalized;
    if (m.runId && m.runId === runId) return normalized;
  }

  return fallback;
}

// run が完了ステータスになるまでポーリングする
export async function waitForRunCompletion(
  threadId: string,
  runId: string,
  label: string
): Promise<void> {
  const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));
  const safeSleep: number = Math.max(1, MAIN_TIMERS.POLL_SLEEP);
  const pollMaxTicks: number = Math.max(1, Math.ceil(MAIN_TIMERS.POLL_TIMEOUT / safeSleep)) + 10;
  const startedAt: number = Date.now();
  let ticks = 0;
  let lastStatus: string | null = null;
  let timedOut: boolean = false;

  if (debugAi) {
    console.info("[ai.reply/wait] start", {
      label,
      threadId,
      runId,
      pollSleep: safeSleep,
      pollTimeout: MAIN_TIMERS.POLL_TIMEOUT,
      pollMaxTicks,
    });
  }
  
  while (true) {
    const elapsed: number = Date.now() - startedAt;
    ticks += 1;
    if (elapsed > MAIN_TIMERS.POLL_TIMEOUT || ticks > pollMaxTicks) {
      timedOut = true;
      break;
    }

    const st: RunState = (await withTimeout(
      agentsClient.runs.get(threadId, runId),
      MAIN_TIMERS.GET_TIMEOUT,
      `${label}:get`
    )) as RunState;

    lastStatus = st.status ?? null;

    if (debugAi) {
      console.info("[ai.reply/wait] tick", {
        label,
        threadId,
        runId,
        tick: ticks,
        elapsed,
        status: lastStatus,
      });
    }

    if (["completed", "failed", "cancelled", "expired"].includes(st.status ?? "")) break;
    await sleep(safeSleep);
  }

  if (debugAi) {
    console.info("[ai.reply/wait] done", {
      label,
      threadId,
      runId,
      ticks,
      timedOut,
      lastStatus,
    });
  }
  
}

// 入力チェック共通（メッセージ・threadId の存在を確認）
// 問題ない場合は null、エラー時は AiReplyResult を返す
export function validateReplyInputs(
  ctx: AiContext,
  options: NormalizedReplyOptions
): AiReplyResult | null {
  const hasImage: boolean = options.imageUrls.length > 0;
  const hasQuestion: boolean = options.question.trim().length > 0;

  if (!hasQuestion && !hasImage) {
    return { texts: ["⚠️メッセージが空です。"], agentId: "", threadId: ctx.threadId, runId: "" };
  }

  if (!ctx.threadId || ctx.threadId.trim().length === 0) {
    return { texts: ["⚠️threadId が未設定です。"], agentId: "", threadId: "", runId: "" };
  }

  return null;
}
