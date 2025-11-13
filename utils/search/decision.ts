import { type MessageContentUnion } from "@azure/ai-agents";
import { agentsClient, getOrCreateAgentIdWithTools, preflightAuth } from "@/utils/agents";
import { withTimeout } from "@/utils/async";
import { MAIN_TIMERS, DEBUG } from "@/utils/env";
import type { AiContext } from "@/types/gpts";

// 判定結果（最小共通インターフェース）
export type SearchDecision = {
  needSearch: boolean;
  rewrittenQuery?: string;
  missing?: string[];
  followup?: string;
  reason?: string;
};

type RawDecision = {
  needSearch?: unknown;
  rewrittenQuery?: unknown;
  missing?: unknown;
  followup?: unknown;
  reason?: unknown;
};

type RunState = {
  status?: "queued" | "in_progress" | "requires_action" | "completed" | "failed" | "cancelled" | "expired";
};

const debugAi: boolean =
  (DEBUG.AI || process.env["DEBUG.AI"] === "true" || process.env.DEBUG_AI === "true") === true;

// 文字列配列かを判定
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

// 生JSON(文字列)→ SearchDecision への安全パース
export function parseSearchDecision(jsonText: string): SearchDecision {
  let raw: RawDecision;
  try {
    raw = JSON.parse(jsonText) as RawDecision;
  } catch {
    return { needSearch: false, reason: "non-json-output" };
  }

  const needSearch: boolean = typeof raw.needSearch === "boolean" ? raw.needSearch : false;
  const rewrittenQuery: string | undefined =
    typeof raw.rewrittenQuery === "string" && raw.rewrittenQuery.trim().length > 0
      ? raw.rewrittenQuery.trim()
      : undefined;

  const missing: string[] | undefined = isStringArray(raw.missing) && raw.missing.length > 0 ? raw.missing : undefined;

  const followup: string | undefined =
    typeof raw.followup === "string" && raw.followup.trim().length > 0 ? raw.followup.trim() : undefined;

  const reason: string | undefined =
    typeof raw.reason === "string" && raw.reason.trim().length > 0 ? raw.reason.trim() : undefined;

  if (needSearch && !rewrittenQuery) {
    // needSearch=true だが rewrittenQuery が無いときは検索しない
    return {
      needSearch: false,
      reason: "needSearch-true-but-missing-rewrittenQuery",
      followup,
      missing,
    };
  }
  return { needSearch, rewrittenQuery, missing, followup, reason };
}

// 指定 runId の assistant メッセージ（なければ最新）を取得
async function getAssistantMessageForRun(
  threadId: string,
  runId: string
): Promise<{ runId?: string; content: MessageContentUnion[] } | undefined> {
  let fallback: { runId?: string; content: MessageContentUnion[] } | undefined;
  for await (const m of agentsClient.messages.list(threadId, { order: "desc" })) {
    if (m.role !== "assistant") continue;
    const normalized = {
      runId: m.runId ?? undefined,
      content: m.content as MessageContentUnion[],
    };
    if (!fallback) fallback = normalized;
    if (m.runId && m.runId === runId) return normalized;
  }
  return fallback;
}

// 検索要否の判定を行う run。
// - instruction: utils/prompts/decision.md の中身（次ステップで getInstruction("decision") を用意して渡す）
// - ctx.threadId に対して、question を user メッセージとして投入し、ツール無し・軽量モデル(meta)で実行
// - 最終的に SearchDecision を返す（失敗時は安全側: needSearch=false）
export async function runSearchDecision(
  instruction: string,
  ctx: AiContext,
  question: string
): Promise<SearchDecision> {
  const q: string = (question ?? "").trim();
  if (!q) return { needSearch: false, reason: "empty-question" };
  if (!ctx.threadId || !ctx.threadId.trim()) return { needSearch: false, reason: "empty-threadId" };

  await preflightAuth();

  // tools: なし、purpose: "meta"（軽量モデル想定）
  const agentId: string = await getOrCreateAgentIdWithTools(instruction, [], "meta");

  // user 質問を投入
  await agentsClient.messages.create(ctx.threadId, "user", q);

  const run = await withTimeout(
    agentsClient.runs.create(ctx.threadId, agentId, {
      parallelToolCalls: false,
    }),
    MAIN_TIMERS.CREATE_TIMEOUT,
    "decision:create"
  );

  // ポーリング
  {
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const safeSleep: number = Math.max(1, MAIN_TIMERS.POLL_SLEEP);
    const pollMaxTicks: number = Math.max(1, Math.ceil(MAIN_TIMERS.POLL_TIMEOUT / safeSleep)) + 10;
    const startedAt: number = Date.now();
    let ticks = 0;

    while (true) {
      if (Date.now() - startedAt > MAIN_TIMERS.POLL_TIMEOUT || ++ticks > pollMaxTicks) break;
      const st = (await withTimeout(
        agentsClient.runs.get(ctx.threadId, run.id),
        MAIN_TIMERS.GET_TIMEOUT,
        "decision:get"
      )) as RunState;
      if (["completed", "failed", "cancelled", "expired"].includes(st.status ?? "")) break;
      await sleep(safeSleep);
    }
  }

  // アシスタント出力（JSON想定）を取得
  const msg = await getAssistantMessageForRun(ctx.threadId, run.id);
  if (!msg) return { needSearch: false, reason: "no-assistant-message" };

  // content から text を抽出して連結（モデルには“JSONのみ”を指示している想定）
  const texts: string[] = (msg.content as MessageContentUnion[])
    .filter((b) => b.type === "output_text")
    .map((b) => {
      const t = b as { type: "output_text"; text?: string };
      return (t.text ?? "").trim();
    })
    .filter((s) => s.length > 0);

  const body: string = texts.join("\n").trim();

  const decision: SearchDecision = parseSearchDecision(body);
  if (debugAi) {
    console.info("[decision] runId=%s needSearch=%s rewritten=%s missing=%s followup=%s reason=%s",
      run.id,
      String(decision.needSearch),
      decision.rewrittenQuery ?? "",
      (decision.missing ?? []).join(","),
      decision.followup ?? "",
      decision.reason ?? ""
    );
  }
  return decision;
}
