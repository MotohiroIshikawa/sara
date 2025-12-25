import type { AiContext, AiMetaOptions, AiMetaResult, Meta } from "@/types/gpts";
import { getOrCreateAgentIdWithTools, preflightAuth, runWithToolCapture } from "@/utils/agents";
import { getInstruction } from "@/utils/prompts/getInstruction";
import { emitMetaTool, EMIT_META_FN } from "@/services/tools/emitMeta.tool";
import { DEBUG } from "@/utils/env";
import { toToolCalls, isFunctionToolCall } from "@/utils/types";
import { logEmitMetaSnapshot, type MetaLogPhase } from "@/utils/meta/computeMeta";

const debugAi: boolean =
  (DEBUG.AI || process.env["DEBUG.AI"] === "true" || process.env.DEBUG_AI === "true") === true;

// 差分ユーティリティ
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function diffMeta(prev: Meta | undefined, curr: Meta | undefined): Record<string, unknown> {
  if (!prev) return { added: curr };
  if (!curr) return { removed: prev };
  const diff: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(prev), ...Object.keys(curr)]);
  for (const k of keys) {
    const pv = (prev as Record<string, unknown>)[k];
    const cv = (curr as Record<string, unknown>)[k];
    if (JSON.stringify(pv) !== JSON.stringify(cv)) {
      diff[k] = { before: pv, after: cv };
    }
  }
  return diff;
}

// emit_meta の引数を安全に取り出す（string/obj両対応）
function extractMetaFromArgs(raw: unknown): Meta | undefined {
  try {
    if (typeof raw === "string") {
      console.info("[ai.meta] extract raw(string) =", raw);

      const parsed: unknown = JSON.parse(raw);

      if (isRecord(parsed) && "meta" in parsed) {
        const metaCandidate = (parsed as Record<string, unknown>)["meta"];
        if (isRecord(metaCandidate)) return metaCandidate as Meta;
      }

      // fallback: parsed が直接 Meta 形式
      if (isRecord(parsed)) {
        if (
          typeof parsed.intent === "string" && 
          typeof parsed.modality === "string"
        ) {
          return parsed as Meta;
        }
      }
      return undefined;
    }
    if (isRecord(raw)) {
      console.info("[ai.meta] extract raw(object) =", raw);

      if ("meta" in raw) {
        const metaCandidate = (raw as Record<string, unknown>)["meta"];
        if (isRecord(metaCandidate)) return metaCandidate as Meta;
      }

      if (
        typeof (raw as Record<string, unknown>).intent === "string" &&
        typeof (raw as Record<string, unknown>).modality === "string"
      ) {
        return raw as Meta;
      }

    }
  } catch (e) {
    // パースエラー
    console.info("[ai.meta] extract parse error =", e);
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

  // 前回 meta 保存（diff用）
  let lastCaptured: Meta | undefined = undefined;

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
    console.info("[ai.meta] requiresAction state =", JSON.stringify(state, null, 2));

    const required = state.requiredAction;
    const outputs: { toolCallId: string; output: string }[] = [];
    let captured: Meta | undefined;

    if (required?.type === "submit_tool_outputs") {
      const toolCallsRaw = required.submitToolOutputs?.toolCalls ?? [];
      const calls = toToolCalls(toolCallsRaw);

      if (debugAi) {
        console.info("[ai.meta] raw toolCalls =", required.submitToolOutputs?.toolCalls);
      }

      for (const c of calls) {
        if (isFunctionToolCall(c) && c.function?.name === EMIT_META_FN) {

          const rawArgs = c.function.arguments;

          console.info("[ai.meta] RAW arguments string =", rawArgs);
          try {
            const parsed = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
            console.info("[ai.meta] RAW parsed =", parsed);
          } catch (e) {
            console.info("[ai.meta] RAW parse error =", e);
          }

          console.info("[ai.meta] extract start raw =", rawArgs);
          const meta = extractMetaFromArgs(rawArgs);
          console.info("[ai.meta] extract result =", meta);

          if (meta) {
            // diff
            const d = diffMeta(lastCaptured, meta);
            console.info("[ai.meta] meta diff =", d);

            lastCaptured = meta;
            captured = meta;
            logEmitMetaSnapshot(phase, { threadId, runId }, { meta });
          } else {
            logEmitMetaSnapshot(phase, { threadId, runId }, { meta: undefined });
          }

          // submit output ログ
          const out: string = "{}";
          console.info("[ai.meta] submit output =", out);

          outputs.push({
            toolCallId: c.id,
            output: out,
          });

        } else {
          outputs.push({
            toolCallId: c.id,
            output: "{}"
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
    // run 呼び出しログ
    console.info("[ai.meta] runWithToolCapture attempt =", attempt);

    const r = await runWithToolCapture<Meta | undefined>({
      threadId: ctx.threadId,
      agentId,
      operation: "meta",
      // toolChoice: { type: "function", function: { name: EMIT_META_FN } },
      requiresActionHandler
    });
    // run delta ログ
    console.info("[ai.meta] run delta =", JSON.stringify(r, null, 2));

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
