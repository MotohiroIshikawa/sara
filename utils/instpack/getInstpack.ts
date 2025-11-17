import type { AiContext, AiInstpackResult } from "@/types/gpts";
import { createAndPollRun, getOrCreateAgentIdWithTools, preflightAuth } from "@/utils/agents";
import { getInstruction } from "@/utils/prompts/getInstruction";
import { emitInstpackTool, EMIT_INSTPACK_FN } from "@/services/tools/emitInstpack.tool";
import { DEBUG } from "@/utils/env";
import { toToolCalls, isFunctionToolCall, type ToolCall } from "@/utils/types";
import { logEmitMetaSnapshot, type MetaLogPhase } from "@/utils/meta/meta";

const debugAi: boolean =
  (DEBUG.AI || process.env["DEBUG.AI"] === "true" || process.env.DEBUG_AI === "true") === true;

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

   const runInstpackOnce = async (): Promise<{ instpack?: string; runId: string }> => {
    const threadId: string = ctx.threadId;
    const phase: MetaLogPhase = "instpack";
    const runResult = await createAndPollRun<string | undefined>({
      threadId,
      agentId,
      operation: "instpack",
      toolChoice: { type: "function", function: { name: EMIT_INSTPACK_FN } },
      requiresActionHandler: async ({ state, threadId: thId, runId }) => {
        const required = state.requiredAction;
        const outputs: { toolCallId: string; output: string }[] = [];
        let captured: string | undefined;

        if (required?.type === "submit_tool_outputs") {
          const calls: ToolCall[] = toToolCalls(required.submitToolOutputs?.toolCalls);

          for (const c of calls) {
            if (isFunctionToolCall(c) && c.function?.name === EMIT_INSTPACK_FN) {
              const instpack: string | undefined = extractInstpackFromArgs(c.function?.arguments);
              if (instpack) {
                captured = instpack;
                logEmitMetaSnapshot(phase, { threadId: thId, runId }, { instpack });
              } else {
                logEmitMetaSnapshot(phase, { threadId: thId, runId }, { instpack: undefined });
              }

              outputs.push({ toolCallId: c.id, output: "ok" });
            } else {
              outputs.push({ toolCallId: c.id, output: "" });
            }
          }
        }
        return { outputs, captured };
      },
    });

    return { instpack: runResult.captured, runId: runResult.runId };
  }
  /*
  // 実行ロジック
  const runOnce = async (): Promise<{ instpack?: string; runId: string }> => {
    const threadId: string = ctx.threadId;
    const run = await withTimeout(
      agentsClient.runs.create(threadId, agentId, {
        parallelToolCalls: false,
        toolChoice: { type: "function", function: { name: EMIT_INSTPACK_FN } },
      }),
      MAIN_TIMERS.CREATE_TIMEOUT,
      "inst:create"
    );

    const phase: MetaLogPhase = "instpack";
    let captured: string | undefined;

    // ポーリング
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const safeSleep = Math.max(1, MAIN_TIMERS.POLL_SLEEP);
    const pollMaxTicks = Math.max(1, Math.ceil(MAIN_TIMERS.POLL_TIMEOUT / safeSleep)) + 10;
    const startedAt = Date.now();
    let ticks = 0;

    while (true) {
      if (Date.now() - startedAt > MAIN_TIMERS.POLL_TIMEOUT || ++ticks > pollMaxTicks) break;
      const st = (await withTimeout(
        agentsClient.runs.get(threadId, run.id),
        MAIN_TIMERS.GET_TIMEOUT,
        "inst:get"
      )) as RunState;

      if (st.status === "requires_action" && st.requiredAction?.type === "submit_tool_outputs") {
        const calls = toToolCalls(st.requiredAction?.submitToolOutputs?.toolCalls);
        const outs = calls.map((c): { toolCallId: string; output: string } => {
          if (isFunctionToolCall(c) && c.function?.name === EMIT_INSTPACK_FN) {
            const instpack = extractInstpackFromArgs(c.function?.arguments);
            if (instpack) {
              captured = instpack;
              logEmitMetaSnapshot(phase, { threadId, runId: run.id }, { instpack });
            } else {
              logEmitMetaSnapshot(phase, { threadId, runId: run.id }, { instpack: undefined });
            }
            return { toolCallId: c.id, output: "ok" };
          }
          return { toolCallId: c.id, output: "" };
        });
        await agentsClient.runs.submitToolOutputs(threadId, run.id, outs);
      } else if (["completed", "failed", "cancelled", "expired"].includes(st.status ?? "")) {
        break;
      } else {
        await sleep(safeSleep);
      }
    }

    return { instpack: captured, runId: run.id };
  };

  const result = await runOnce();
*/
  const result = await runInstpackOnce();
  
  if (debugAi) {
    console.info(
      "[ai.instpack] done: runId=%s agentId=%s threadId=%s hasInstpack=%s",
      result.runId,
      agentId,
      ctx.threadId,
      !!result.instpack
    );
  }

  const out: AiInstpackResult = {
    instpack: result.instpack,
    agentId,
    threadId: ctx.threadId,
    runId: result.runId,
  };
  return out;
}
