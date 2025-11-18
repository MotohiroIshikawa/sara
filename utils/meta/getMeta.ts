import type { AiContext, AiMetaOptions, AiMetaResult, Meta, EmitMetaArgs } from "@/types/gpts";
import { createAndPollRun, getOrCreateAgentIdWithTools, preflightAuth } from "@/utils/agents";
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

  // 1回分の実行（requires_action → submit まで面倒を見る）
  const runOnce = async (): Promise<{ meta?: Meta; runId: string }> => {
    const threadId: string = ctx.threadId;
    const phase: MetaLogPhase = "meta";

    const runResult = await createAndPollRun<Meta | undefined>({
      threadId,
      agentId,
      operation: "meta",
      toolChoice: { type: "function", function: { name: EMIT_META_FN } },
        // requiresActionHandler: runがrequires_actionを返したときに呼ばれる
      requiresActionHandler: async ({ state, threadId: thId, runId }) => {
        const required = state.requiredAction;
        const outputs: { toolCallId: string; output: string }[] = [];
        let captured: Meta | undefined;

        // submit_tool_outputsの場合に処理
        if (required?.type === "submit_tool_outputs") {
          const calls = toToolCalls(required.submitToolOutputs?.toolCalls);
          for (const c of calls) {
            if (isFunctionToolCall(c) && c.function?.name === EMIT_META_FN) {
              // emit_metaのtoolCollの場合、引数からmeta抽出
              const meta = extractMetaFromArgs(c.function?.arguments);
              if (meta) {
                // meta抽出に成功した場合
                captured = meta;
                logEmitMetaSnapshot(phase, { threadId: thId, runId }, { meta });
              } else {
                // meta抽出に失敗した場合
                logEmitMetaSnapshot(phase, { threadId: thId, runId }, { meta: undefined });
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

    if (debugAi) {
      console.info("[ai.meta] run finished", {
        threadId,
        runId: runResult.runId,
        status: runResult.finalState?.status ?? null,
        timedOut: runResult.timedOut,
        cancelled: runResult.cancelled,
        hasCaptured: runResult.captured !== undefined,
      });
    }

    // ポーリング終了。必要な情報だけ返す
    return { meta: runResult.captured, runId: runResult.runId };
  }

  // 実行＆必要なら再試行
  let result = await runOnce();
  for (let i = 1; !result.meta && i <= maxRetry; i++) {
    if (debugAi) console.info("[ai.meta] retry %d (threadId=%s)", i, ctx.threadId);
    result = await runOnce();
  }

  // 画像ヒント適用
  const finalMeta: Meta | undefined = applyImageHint(result.meta, hasImageHint);

  if (debugAi) {
    console.info("[ai.meta] done: runId=%s agentId=%s threadId=%s hasMeta=%s", 
      result.runId, 
      agentId, 
      ctx.threadId, 
      !!finalMeta
    );
  }

  const out: AiMetaResult = {
    meta: finalMeta,
    agentId,
    threadId: ctx.threadId,
    runId: result.runId,
  };
  return out;
}
