import { type MessageContentUnion } from "@azure/ai-agents";
import { agentsClient, getOrCreateAgentIdWithTools, preflightAuth } from "@/utils/agents";
import { withTimeout } from "@/utils/async";
import { MAIN_TIMERS, DEBUG } from "@/utils/env";
import type { AiContext } from "@/types/gpts";

// 判定結果（検索要否とクエリだけを主目的とする）
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
    // JSON が壊れていたら「検索する側」に倒す
    return { needSearch: true, reason: "non-json-output" };
  }

  const needSearch: boolean = typeof raw.needSearch === "boolean" ? raw.needSearch : true; // ★ デフォルト true
  const rewrittenQuery: string | undefined =
    typeof raw.rewrittenQuery === "string" && raw.rewrittenQuery.trim().length > 0
      ? raw.rewrittenQuery.trim()
      : undefined;

  const missing: string[] | undefined = isStringArray(raw.missing) && raw.missing.length > 0 ? raw.missing : undefined;

  const followup: string | undefined =
    typeof raw.followup === "string" && raw.followup.trim().length > 0 ? raw.followup.trim() : undefined;

  const reason: string | undefined =
    typeof raw.reason === "string" && raw.reason.trim().length > 0 ? raw.reason.trim() : undefined;

  // needSearch=true なのに rewrittenQuery が無くても検索を止めない
  // その場合は上位で question をそのまま使って検索すればよい
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
// JSON が壊れても検索を止めない（needSearch=true に倒す）
export async function runSearchDecision(
  instruction: string,
  ctx: AiContext,
  question: string
): Promise<SearchDecision> {
  const q: string = (question ?? "").trim();
  if (!q) {
    // ユーザ入力が空なら検索は不要（検索不能）
    return { needSearch: false, reason: "empty-question" };
  }
  if (!ctx.threadId || !ctx.threadId.trim()) {
    // threadId 不正でも検索側に倒す
    return { needSearch: true, reason: "empty-threadId" };
  }

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
  if (!msg) {
    // 取得できなくても検索側へ
    return { needSearch: true, reason: "no-assistant-message" };
  }

  // content から text を抽出
  const texts: string[] = (msg.content as MessageContentUnion[])
    .filter((b) => b.type === "output_text")
    .map((b) => {
      const t = b as { type: "output_text"; text?: string };
      return (t.text ?? "").trim();
    })
    .filter((s) => s.length > 0);

  const body: string = texts.join("\n").trim();

  if (debugAi) {
    console.info("[decision] raw assistant output >>>");
    console.info(body);
    console.info("[decision] <<< end raw output");
  }

  let  decision: SearchDecision = parseSearchDecision(body);

  if (decision.needSearch && !decision.rewrittenQuery) {
    decision = {
      ...decision,
      reason: decision.reason ?? "missing-rewrittenQuery",
    };
  }

  if (debugAi) {
    console.info(
      "[decision] runId=%s needSearch=%s rewritten=%s reason=%s",
      run.id,
      String(decision.needSearch),
      decision.rewrittenQuery ?? "",
      decision.reason ?? ""
    );
  }
  return decision;
}
