import type { AiContext, AiMetaOptions, AiMetaResult, Meta, EmitMetaArgs } from "@/types/gpts";
import { agentsClient, getOrCreateAgentIdWithTools, preflightAuth } from "@/utils/agents";
import { getInstruction } from "@/utils/prompts/getInstruction";
import { emitMetaTool, EMIT_META_FN } from "@/services/tools/emitMeta.tool";
import { withTimeout } from "@/utils/async";
import { DEBUG, MAIN_TIMERS } from "@/utils/env";
import { toToolCalls, isFunctionToolCall, type ToolCall } from "@/utils/types";
import { logEmitMetaSnapshot, type MetaLogPhase } from "@/utils/meta/meta";

type RunState = {
  status?: "queued" | "in_progress" | "requires_action" | "completed" | "failed" | "cancelled" | "expired";
  requiredAction?: SubmitToolOutputsAction;
};

type SubmitToolOutputsAction = {
  type: "submit_tool_outputs";
  submitToolOutputs?: { toolCalls?: ToolCall[] };
};

const debugAi: boolean =
  (DEBUG.AI || process.env["DEBUG.AI"] === "true" || process.env.DEBUG_AI === "true") === true;

// emit_meta の引数を安全に取り出す（string/obj両対応）
function extractMetaFromArgs(raw: unknown): Meta | undefined {
  try {
    if (typeof raw === "string") {
      const parsed = JSON.parse(raw) as Partial<EmitMetaArgs> | unknown;
      if (parsed && typeof parsed === "object" && "meta" in (parsed as Record<string, unknown>)) {
        const meta = (parsed as { meta?: Meta }).meta;
        return meta;
      }
      // 後方互換: 直接 meta オブジェクトが来た場合
      if (parsed && typeof parsed === "object") {
        const maybeMeta = parsed as Meta;
        // intent/slots など最低限のプロパティがあれば採用
        if ("slots" in maybeMeta || "intent" in maybeMeta) return maybeMeta;
      }
      return undefined;
    }
    if (raw && typeof raw === "object") {
      // { meta: {...} } 形式
      if ("meta" in (raw as Record<string, unknown>)) {
        const meta = (raw as { meta?: Meta }).meta;
        return meta;
      }
      // 直接 meta 形式
      const maybeMeta = raw as Meta;
      if ("slots" in maybeMeta || "intent" in maybeMeta) return maybeMeta;
    }
  } catch {
    // noop
  }
  return undefined;
}

// 画像ヒントの補正（has_image / modality）
function applyImageHint(meta: Meta | undefined, hint: boolean | undefined): Meta | undefined {
  if (!meta || !hint) return meta;
  const slots = { ...(meta.slots ?? {}), has_image: true };
  const modality = meta.modality === "image" || meta.modality === "image+text" ? meta.modality : "image";
  return { ...meta, modality, slots };
}

// Meta取得
export async function getMeta(
  ctx: AiContext, 
  opts?: AiMetaOptions
): Promise<AiMetaResult> {
  const maxRetry: number = typeof opts?.maxRetry === "number" ? opts.maxRetry : 2;
  const hasImageHint: boolean = opts?.hasImageHint === true;

  if (!ctx.threadId || ctx.threadId.trim().length === 0) {
    return { meta: undefined, agentId: "", threadId: "", runId: "" };
  }

  // 認証
  await preflightAuth();

  // 指示文（BASE+META 固定）
  const { instruction } = await getInstruction(ctx.sourceType, ctx.ownerId, "meta");

  const tools: readonly unknown[] = [emitMetaTool];
  const agentId: string = await getOrCreateAgentIdWithTools(instruction, tools, "meta");

  // 1回分の実行（requires_action → submit まで面倒を見る）
  const runOnce = async (): Promise<{ meta?: Meta; runId: string }> => {
    const threadId: string = ctx.threadId;

    const run = await withTimeout(
      agentsClient.runs.create(threadId, agentId, {
        parallelToolCalls: false,
        toolChoice: { type: "function", function: { name: EMIT_META_FN } },
      }),
      MAIN_TIMERS.CREATE_TIMEOUT,
      "meta:create"
    );

    const phase: MetaLogPhase = "meta";
    let captured: Meta | undefined;

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
        "meta:get"
      )) as RunState;

      if (st.status === "requires_action" && st.requiredAction?.type === "submit_tool_outputs") {
        const calls = toToolCalls(st.requiredAction?.submitToolOutputs?.toolCalls);
        const outs = calls.map((c): { toolCallId: string; output: string } => {
          if (isFunctionToolCall(c) && c.function?.name === EMIT_META_FN) {
            const meta = extractMetaFromArgs(c.function?.arguments);
            if (meta) {
              captured = meta;
              logEmitMetaSnapshot(phase, { threadId, runId: run.id }, { meta });
            } else {
              logEmitMetaSnapshot(phase, { threadId, runId: run.id }, { meta: undefined });
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

    return { meta: captured, runId: run.id };
  };

  // 実行＆必要なら再試行
  let result = await runOnce();
  for (let i = 1; !result.meta && i <= maxRetry; i++) {
    if (debugAi) console.info("[ai.meta] retry %d (threadId=%s)", i, ctx.threadId);
    result = await runOnce();
  }

  // 画像ヒント適用
  const finalMeta: Meta | undefined = applyImageHint(result.meta, hasImageHint);

  if (debugAi) {
    console.info("[ai.meta] done: runId=%s agentId=%s threadId=%s hasMeta=%s", result.runId, agentId, ctx.threadId, !!finalMeta);
  }

  const out: AiMetaResult = {
    meta: finalMeta,
    agentId,
    threadId: ctx.threadId,
    runId: result.runId,
  };
  return out;
}
