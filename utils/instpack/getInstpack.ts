import type { AiContext, AiInstpackResult } from "@/types/gpts";
import { getOrCreateAgentIdWithTools, preflightAuth, runWithToolCapture } from "@/utils/agents";
import { getInstruction } from "@/utils/prompts/getInstruction";
import { emitInstpackTool, EMIT_INSTPACK_FN } from "@/services/tools/emitInstpack.tool";
import { DEBUG } from "@/utils/env";
import { toToolCalls, isFunctionToolCall, type ToolCall } from "@/utils/types";
import { logEmitMetaSnapshot, type MetaLogPhase } from "@/utils/meta/meta";

const debugAi: boolean =
  (DEBUG.AI || process.env["DEBUG.AI"] === "true" || process.env.DEBUG_AI === "true") === true;

// Instpack 専用 requiresActionHandler
function buildInstpackRequiresActionHandler() {
  const phase: MetaLogPhase = "instpack";

  return async ({
    state,
    threadId,
    runId,
  }: {
    state: {
      requiredAction?: {
        type?: string;
        submitToolOutputs?: { toolCalls?: unknown };
      };
    };
    threadId: string;
    runId: string;
  }): Promise<{
    captured?: string;
    outputs: { toolCallId: string; output: string }[];
  }> => {
    const required = state.requiredAction;
    const outputs: { toolCallId: string; output: string }[] = [];
    let captured: string | undefined = undefined;

    if (required?.type === "submit_tool_outputs") {
      const calls: ToolCall[] = toToolCalls(required.submitToolOutputs?.toolCalls);

      for (const c of calls) {
        if (isFunctionToolCall(c) && c.function?.name === EMIT_INSTPACK_FN) {
          const instpack = extractInstpackFromArgs(c.function?.arguments);

          if (instpack) {
            captured = instpack;
            logEmitMetaSnapshot(phase, { threadId, runId }, { instpack });
          } else {
            logEmitMetaSnapshot(phase, { threadId, runId }, { instpack: undefined });
          }

          outputs.push({ toolCallId: c.id, output: "ok" });
        } else {
          outputs.push({ toolCallId: c.id, output: "" });
        }
      }
    }

    return { outputs, captured };
  };
}

// emit_instpack の引数から文字列を安全に抽出
function extractInstpackFromArgs(raw: unknown): string | undefined {
  try {
    if (typeof raw === "string") {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === "object" && parsed !== null && "instpack" in (parsed as Record<string, unknown>)) {
        const val = (parsed as { instpack?: unknown }).instpack;
        return typeof val === "string" ? val : undefined;
      }
      // 直接stringを返すケース（旧仕様互換）
      if (typeof parsed === "string") return parsed;
      return undefined;
    }
    if (raw && typeof raw === "object") {
      const obj = raw as { instpack?: unknown };
      if (typeof obj.instpack === "string") return obj.instpack;
    }
  } catch {
    // noop
  }
  return undefined;
}

// instpack取得
export async function getInstpack(
  ctx: AiContext, 
): Promise<AiInstpackResult> {

  if (!ctx.threadId || ctx.threadId.trim().length === 0) {
    return { instpack: undefined, agentId: "", threadId: "", runId: "" };
  }

  // 認証
  await preflightAuth();

  // 指示文（INST 固定）
  const { instruction } = await getInstruction(ctx.sourceType, ctx.ownerId, "instpack");

  // Agent取得
  const tools: readonly unknown[] = [emitInstpackTool];
  const agentId: string = await getOrCreateAgentIdWithTools(instruction, tools, "instpack");

  if (debugAi) {
    console.info("[ai.instpack] start", {
      sourceType: ctx.sourceType,
      ownerId: ctx.ownerId,
      threadId: ctx.threadId,
      agentId,
    });
  }

  const requiresActionHandler = buildInstpackRequiresActionHandler();

  const result = await runWithToolCapture<string | undefined>({
    threadId: ctx.threadId,
    agentId,
    operation: "instpack",
    toolChoice: { type: "function", function: { name: EMIT_INSTPACK_FN } },
    requiresActionHandler,
  });
  
  if (debugAi) {
    console.info("[ai.instpack] done", {
      threadId: ctx.threadId,
      runId: result.runId,
      agentId,
      instpack: result.captured,
    });
  }

  return {
    instpack: result.captured,
    agentId,
    threadId: ctx.threadId,
    runId: result.runId,
  };
}
