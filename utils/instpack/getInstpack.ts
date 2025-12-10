import type { AiContext, AiInstpackResult } from "@/types/gpts";
import { getOrCreateAgentIdWithTools, preflightAuth, runWithToolCapture } from "@/utils/agents";
import { getInstruction } from "@/utils/prompts/getInstruction";
import { emitInstpackTool, EMIT_INSTPACK_FN } from "@/services/tools/emitInstpack.tool";
import { DEBUG } from "@/utils/env";
import { toToolCalls, isFunctionToolCall, type ToolCall } from "@/utils/types";
import { logEmitMetaSnapshot, type MetaLogPhase } from "@/utils/meta/meta";

const debugAi: boolean =
  (DEBUG.AI ||
    process.env["DEBUG.AI"] === "true" ||
    process.env.DEBUG_AI === "true") === true;

// Instpack の引数を安全に抽出（string/object 両対応）
function extractInstpackFromArgs(raw: unknown): string | undefined {
  try {
    if (typeof raw === "string") {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "instpack" in (parsed as Record<string, unknown>)
      ) {
        const v = (parsed as { instpack?: unknown }).instpack;
        return typeof v === "string" ? v : undefined;
      }
      // fallback: string そのままのケース
      if (typeof parsed === "string") return parsed;
      return undefined;
    }

    if (raw && typeof raw === "object") {
      const obj = raw as { instpack?: unknown };
      if (typeof obj.instpack === "string") return obj.instpack;
    }
  } catch {
    /* no-op */
  }
  return undefined;
}

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
    console.info(
      "[ai.instpack] requiresAction state =",
      JSON.stringify(state, null, 2)
    );

    const required = state.requiredAction;
    const outputs: { toolCallId: string; output: string }[] = [];
    let captured: string | undefined;

    if (required?.type === "submit_tool_outputs") {
      const calls: ToolCall[] = toToolCalls(
        required.submitToolOutputs?.toolCalls
      );

      if (debugAi) {
        console.info(
          "[ai.instpack] raw toolCalls =",
          required.submitToolOutputs?.toolCalls
        );
      }

      for (const c of calls) {
        if (
          isFunctionToolCall(c) &&
          c.function?.name === EMIT_INSTPACK_FN
        ) {
          const rawArgs = c.function.arguments;

          console.info("[ai.instpack] RAW arguments =", rawArgs);

          let instpack: string | undefined = undefined;
          try {
            instpack =
              extractInstpackFromArgs(rawArgs);
          } catch (e) {
            console.info("[ai.instpack] extract error =", e);
          }

          if (instpack) {
            logEmitMetaSnapshot(phase, { threadId, runId }, { instpack });
            captured = instpack;
          } else {
            logEmitMetaSnapshot(phase, { threadId, runId }, { instpack: undefined });
          }

          // submit output は {} に統一
          const out: string = "{}";
          console.info("[ai.instpack] submit output =", out);

          outputs.push({
            toolCallId: c.id,
            output: out,
          });
        } else {
          outputs.push({
            toolCallId: c.id,
            output: "{}",
          });
        }
      }
    }

    return { captured, outputs };
  };
}

// Instpack 取得
export async function getInstpack(
  ctx: AiContext
): Promise<AiInstpackResult> {
  const maxRetry = 2;
  const nonTerminal: readonly string[] = [
    "queued",
    "in_progress",
    "requires_action",
    "cancelling",
  ];

  if (!ctx.threadId || ctx.threadId.trim().length === 0) {
    return { instpack: undefined, agentId: "", threadId: "", runId: "" };
  }

  // 認証
  await preflightAuth();

  // 指示文（INST 固定）
  const { instruction } = await getInstruction(
    ctx.sourceType,
    ctx.ownerId,
    "instpack"
  );

  const tools: readonly unknown[] = [emitInstpackTool];

  // Agent 作成
  const agentId: string = await getOrCreateAgentIdWithTools(
    instruction,
    tools,
    "instpack"
  );

  if (debugAi) {
    console.info("[ai.instpack] start", {
      sourceType: ctx.sourceType,
      ownerId: ctx.ownerId,
      threadId: ctx.threadId,
      agentId,
    });
  }

  const requiresActionHandler =
    buildInstpackRequiresActionHandler();

  let finalInstpack: string | undefined = undefined;
  let finalRunId: string = "";
  let blocked = false;

  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    console.info("[ai.instpack] runWithToolCapture attempt =", attempt);

    const r = await runWithToolCapture<string | undefined>({
      threadId: ctx.threadId,
      agentId,
      operation: "instpack",
      // toolChoice: { type: "function", function: { name: EMIT_INSTPACK_FN } },
      requiresActionHandler,
    });

    console.info("[ai.instpack] run delta =", JSON.stringify(r, null, 2));

    finalRunId = r.runId;
    finalInstpack = r.captured;

    if (debugAi) {
      console.info(
        "[ai.instpack] attempt=%s hasInstpack=%s timedOut=%s status=%s",
        attempt,
        !!finalInstpack,
        r.timedOut,
        r.finalState?.status ?? null
      );
    }

    const st = r.finalState?.status;
    if (r.timedOut && st && nonTerminal.includes(st)) {
      blocked = true;
      finalInstpack = undefined;
      break;
    }

    if (finalInstpack) break;
  }

  if (debugAi) {
    console.info("[ai.instpack] done", {
      runId: finalRunId,
      agentId,
      threadId: ctx.threadId,
      hasInstpack: !!finalInstpack,
      blocked,
    });
  }

  return {
    instpack: finalInstpack,
    agentId,
    threadId: ctx.threadId,
    runId: finalRunId,
  };
}
