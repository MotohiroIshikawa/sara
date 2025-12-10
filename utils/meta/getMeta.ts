import type { AiContext, AiMetaOptions, AiMetaResult, Meta, EmitMetaArgs } from "@/types/gpts";
import { getOrCreateAgentIdWithTools, preflightAuth, runWithToolCapture } from "@/utils/agents";
import { getInstruction } from "@/utils/prompts/getInstruction";
import { emitMetaTool, EMIT_META_FN } from "@/services/tools/emitMeta.tool";
import { DEBUG } from "@/utils/env";
import { toToolCalls, isFunctionToolCall } from "@/utils/types";
import { logEmitMetaSnapshot, type MetaLogPhase } from "@/utils/meta/meta";

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

// getMeta 専用の requiresActionHandler を組み立てる
function buildMetaRequiresActionHandler() {
  const phase: MetaLogPhase = "meta";

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
    captured?: Meta;
    outputs: { toolCallId: string; output: string }[];
  }> => {
    const required = state.requiredAction;
    const outputs: { toolCallId: string; output: string }[] = [];
    let captured: Meta | undefined;

    if (required?.type === "submit_tool_outputs") {
      const calls = toToolCalls(required.submitToolOutputs?.toolCalls);

      if (debugAi) {
        // モデルが送ってきた arguments（raw）
        console.info("[ai.meta] raw toolCalls =", required.submitToolOutputs?.toolCalls);
      }

      for (const c of calls) {
        // emit_meta の ToolCall
        if (isFunctionToolCall(c) && c.function?.name === EMIT_META_FN) {
          const meta = extractMetaFromArgs(c.function?.arguments);

          if (debugAi) {
            console.info("[ai.meta] extracted meta =", meta);
          }
          
          if (meta) {
            captured = meta;
            logEmitMetaSnapshot(phase, { threadId, runId }, { meta });
          } else {
            logEmitMetaSnapshot(phase, { threadId, runId }, { meta: undefined });
          }

          outputs.push({
            toolCallId: c.id,
            output: JSON.stringify(meta ?? {}),
          });
        } else {
          // emit_meta 以外の ToolCall
          outputs.push({
            toolCallId: c.id,
            output: "",
          });
        }
      }
    }

    return { captured, outputs };
  };
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

  if (debugAi) {
    console.info("[ai.meta] start", {
      sourceType: ctx.sourceType,
      ownerId: ctx.ownerId,
      threadId: ctx.threadId,
      agentId,
      hasImageHint,
    });
  }

  const requiresActionHandler = buildMetaRequiresActionHandler();

  let finalMeta: Meta | undefined;
  let finalRunId = "";
  let blocked = false;

  const nonTerminal: readonly string[] = ["queued", "in_progress", "requires_action", "cancelling"];

  for (let attempt: number = 0; attempt <= maxRetry; attempt++) {
    const r = await runWithToolCapture<Meta | undefined>({
      threadId: ctx.threadId,
      agentId,
      operation: "meta",
      toolChoice: { type: "function", function: { name: EMIT_META_FN } },
      requiresActionHandler
    });

    finalRunId = r.runId;
    finalMeta = r.captured;

    if (debugAi) {
      console.info("[ai.meta] attempt=%s hasMeta=%s timedOut=%s status=%s",
        attempt,
        !!finalMeta,
        r.timedOut,
        r.finalState?.status ?? null
      );
    }

    // timeout + 非terminal → blocked 扱い（instpackを後で止める目的）
    const st = r.finalState?.status;
    if (r.timedOut && st && nonTerminal.includes(st)) {
      blocked = true;
      finalMeta = undefined;
      break;
    }

    if (finalMeta) break;
  }

  // 画像ヒント適用
  finalMeta = applyImageHint(finalMeta, hasImageHint);

  if (debugAi) {
    console.info("[ai.meta] done: runId=%s agentId=%s threadId=%s hasMeta=%s blocked=%s",
      finalRunId,
      agentId,
      ctx.threadId,
      !!finalMeta,
      blocked
    );
  }

  return {
    meta: finalMeta,
    agentId,
    threadId: ctx.threadId,
    runId: finalRunId
  };
}
