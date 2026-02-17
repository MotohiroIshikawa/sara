import { type MessageContentUnion } from "@azure/ai-agents";
import type { AiContext, AiReplyOptions, AiReplyResult, SourceType } from "@/types/gpts";
import { agentsClient } from "@/utils/agents";
import { DEBUG } from "@/utils/env";
import { toToolCalls, isFunctionToolCall } from "@/utils/types";

// reply オプション（既定値埋め後）
export type NormalizedReplyOptions =
  Omit<Required<AiReplyOptions>, "metaNorm"> & {
    metaNorm: AiReplyOptions["metaNorm"];
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

// reply 用 requiresActionHandler（meta と同型・詳細ログ）
export function buildReplyRequiresActionHandler() {
  const phase = "reply";

  return async ({
    state
  }: {
    state: {
      requiredAction?: {
        type?: string;
        submitToolOutputs?: { toolCalls?: unknown };
      };
    };
  }): Promise<{
    outputs: { toolCallId: string; output: string }[];
  }> => {
    // requires_action の state をそのまま可視化
    console.info(`[ai.${phase}] requiresAction state =`, JSON.stringify(state, null, 2));

    const outputs: { toolCallId: string; output: string }[] = [];
    const required = state.requiredAction;

    if (required?.type === "submit_tool_outputs") {
      const toolCallsRaw = required.submitToolOutputs?.toolCalls ?? [];
      const calls = toToolCalls(toolCallsRaw);

      if (debugAi) {
        console.info(`[ai.${phase}] raw toolCalls =`, toolCallsRaw);
      }

      for (const c of calls) {
        // reply は tool の出力内容を Node 側で解釈しない。
        // meta と同様に、必ず {} を submit して run を前進させる。
        if (isFunctionToolCall(c)) {
          if (debugAi) {
            console.info(`[ai.${phase}] submit tool output`, {
              toolCallId: c.id,
              name: c.function?.name ?? null,
            });
          }
          outputs.push({
            toolCallId: c.id,
            output: "{}",
          });
        } else {
          outputs.push({
            toolCallId: c.id,
            output: "{}",
          });
        }
      }
    }

    return { outputs };
  };
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
