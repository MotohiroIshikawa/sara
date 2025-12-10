import "server-only";
import { createHash } from "crypto";
import { AgentsClient, ToolUtility } from "@azure/ai-agents";
import { DefaultAzureCredential } from "@azure/identity";
import { emitInstpackTool } from "@/services/tools/emitInstpack.tool";
import { emitMetaTool } from "@/services/tools/emitMeta.tool";
import { getInstructionsWithInstpack } from "@/utils/prompts/getInstruction";
import { AZURE, DEBUG, envInt, MAIN_TIMERS } from "@/utils/env";
import { redis } from "@/utils/redis";
import { toDefinition, type ToolLike } from "@/utils/types";
import { withTimeout } from "@/utils/async";
import type { AgentsRequiresActionHandler, AgentsRunResult, AgentsRunState, AgentsRunStatus, AgentsToolOutput } from "@/types/agents";

// Azure設定
const endpoint = AZURE.AI_PRJ_ENDPOINT;
const agentNamePrefix = AZURE.AGENT_NAME_PREFIX;

// モデル種別
const modelDeployment = AZURE.AI_MODEL_DEPLOYMENT;
const MODEL = {
  reply: process.env.AZURE_AI_MODEL_DEPLOYMENT_REPLY ?? modelDeployment,
  meta: process.env.AZURE_AI_MODEL_DEPLOYMENT_META ?? modelDeployment,
  instpack: process.env.AZURE_AI_MODEL_DEPLOYMENT_INSTPACK ?? modelDeployment,
} as const;

// Azureクライアント
const credential = new DefaultAzureCredential();
export const agentsClient = new AgentsClient(endpoint, credential);

// 認証の正常性確認：tokenを取得する
export async function preflightAuth(): Promise<void> {
  const scope = "https://ml.azure.com/.default";
  const token = await credential.getToken(scope);
  if (!token) throw new Error(`Failed to acquire token for scope: ${scope}`);
  const sec = Math.round((token.expiresOnTimestamp - Date.now()) / 1000);
  console.log(`[Auth OK] got token for ${scope}, expires in ~${sec}s`);
}

// ツール署名の生成（Agentキャッシュ分離に使用）
function toolSignature(defs: ReadonlyArray<ToolLike | unknown>): string {
  const defsNorm = defs.map(toDefinition);
  return createHash("sha256")
    .update(JSON.stringify(defsNorm))
    .digest("base64url")
    .slice(0, 12);
}

// instructions+tools から 12桁の署名を決定的に算出
function computeAgentSig(
  instructions: string,
  tools: ReadonlyArray<ToolLike | unknown>,
  mdl: string
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({ 
        modelDeployment: mdl, 
        endpoint, 
        instructions, 
        toolSig: toolSignature(tools),
      })
    )
    .digest("base64url")
    .slice(0, 12);
}

// 署名からRedisキャッシュキーを生成
function agentCacheKeyFromSig(sig: string): string {
  const ns = Buffer.from(endpoint).toString("base64url");
  return `agent:id:${ns}:${sig}`;
}

// 指示文＋ツール構成でAgentをキャッシュ・作成
export async function getOrCreateAgentIdWithTools(
  instructions: string,
  tools: ReadonlyArray<ToolLike | unknown>,
  purpose: "reply" | "meta" | "instpack"
): Promise<string> {
  const mdl: string = MODEL[purpose];
  const sig = computeAgentSig(instructions, tools, mdl);
  const key = agentCacheKeyFromSig(sig);

  const cached = await redis.get(key);
  if (cached) return cached;

  const agent = await agentsClient.createAgent(mdl, {
    name: `${agentNamePrefix}-${Date.now()}`,
    instructions,
    tools: tools.map(toDefinition),
  });

  const ttlDays = envInt("AGENT_CACHE_TTL_DAYS", 14, { min: 1, max: 365 });
  const ttlSec = ttlDays * 24 * 60 * 60;
  await redis.setex(key, ttlSec, agent.id);
  return agent.id;
}

// run を1つ作成して runId を返す
export async function createRun(params: {
  threadId: string;
  agentId: string;
  toolChoice?: { type: "function"; function: { name: string } };
  createTimeoutMs?: number;
}): Promise<string> {

  const { threadId, agentId, toolChoice } = params;
  const createTimeout = params.createTimeoutMs ?? MAIN_TIMERS.CREATE_TIMEOUT;

  // 1回だけ run を作成
  const run = await withTimeout(
    agentsClient.runs.create(threadId, agentId, {
      parallelToolCalls: false,
      toolChoice,
    }),
    createTimeout,
    "run:create"
  ) as { id: string };

  if (DEBUG.AI) {
    console.info(
      "[agents] createRun: threadId=%s agentId=%s runId=%s",
      threadId,
      agentId,
      run.id
    );
  }

   return run.id;
}

// run.get を繰り返して terminal 状態になるまで待つ
// requires_action や submit は扱わない純粋なポーリング
export async function pollRunUntilTerminal(params: {
  threadId: string;
  runId: string;
  getTimeoutMs?: number;
  pollTimeoutMs?: number;
  pollSleepMs?: number;
}): Promise<AgentsRunState> {

  const { threadId, runId } = params;
  const getTimeout = params.getTimeoutMs ?? MAIN_TIMERS.GET_TIMEOUT;
  const pollTimeout = params.pollTimeoutMs ?? MAIN_TIMERS.POLL_TIMEOUT;
  const pollSleep = params.pollSleepMs ?? MAIN_TIMERS.POLL_SLEEP;

  const startedAt = Date.now();
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));


  while (true) {
    const state = await withTimeout(
      agentsClient.runs.get(threadId, runId),
      getTimeout,
      "poll:get"
    ) as AgentsRunState;

    const status: AgentsRunStatus | undefined = state.status;

    if (DEBUG.AI) {
      console.info(
        "[agents] pollRunUntilTerminal: runId=%s status=%s",
        runId,
        status ?? "unknown"
      );
    }

    // terminal 状態なら返す
    if (
      status === "completed" ||
      status === "failed" ||
      status === "cancelled" ||
      status === "expired"
    ) {
      return state;
    }

    // timeout?
    if (Date.now() - startedAt > pollTimeout) {
      if (DEBUG.AI) {
        console.warn("[agents] poll timeout: runId=%s", runId);
      }
      return state;
    }

    await sleep(pollSleep);
  }
}

// requires_action を1回だけ処理する
export async function handleRequiresActionOnce<TCaptured>(params: {
  state: AgentsRunState;
  threadId: string;
  runId: string;
  handler: AgentsRequiresActionHandler<TCaptured>; // Meta / Instpack ごとの専用処理
}): Promise<{
  captured?: TCaptured;
  outputs: AgentsToolOutput[];
  submitted: boolean;
}> {

  const { state, threadId, runId, handler } = params;

  if (state.status !== "requires_action" || !state.requiredAction) {
    // requires_action でなければ何もしない
    return { captured: undefined, outputs: [], submitted: false };
  }

  // handler に処理を依頼する（tools の抽出 + output 組み立て）
  const result = await handler({
    state,
    threadId,
    runId,
  });

  if (!result || result.outputs.length === 0) {
    return { captured: result?.captured, outputs: [], submitted: false };
  }

  // submitToolOutputs 実行
  await agentsClient.runs.submitToolOutputs(threadId, runId, result.outputs);

  if (DEBUG.AI) {
    console.info(
      "[agents] handleRequiresActionOnce: submitted runId=%s outputs=%d",
      runId,
      result.outputs.length
    );
  }

  return {
    captured: result.captured,
    outputs: result.outputs,
    submitted: true,
  };
}

// createRun → get → requires_action → submit → 再 get
// terminal になるまで1つの run を完結させるAPI
export async function runWithToolCapture<TCaptured>(params: {
  threadId: string;
  agentId: string;
  operation: string; // "meta" | "instpack" などログ用
  toolChoice?: { type: "function"; function: { name: string } };
  requiresActionHandler: AgentsRequiresActionHandler<TCaptured>;
  createTimeoutMs?: number;
  getTimeoutMs?: number;
  pollTimeoutMs?: number;
  pollSleepMs?: number;
}): Promise<AgentsRunResult<TCaptured>> {

  const {
    threadId,
    agentId,
    operation,
    toolChoice,
    requiresActionHandler,
  } = params;

  const createTimeout = params.createTimeoutMs ?? MAIN_TIMERS.CREATE_TIMEOUT;
  const getTimeout = params.getTimeoutMs ?? MAIN_TIMERS.GET_TIMEOUT;
  const pollTimeout = params.pollTimeoutMs ?? MAIN_TIMERS.POLL_TIMEOUT;
  const pollSleep = params.pollSleepMs ?? MAIN_TIMERS.POLL_SLEEP;

  // 1. run を作成
  const runId = await createRun({
    threadId,
    agentId,
    toolChoice,
    createTimeoutMs: createTimeout,
  });

  if (DEBUG.AI) {
    console.info(
      "[agents] runWithToolCapture start: op=%s runId=%s",
      operation,
      runId
    );
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const startedAt = Date.now();

  let captured: TCaptured | undefined = undefined;
  let finalState: AgentsRunState | undefined;
  let timedOut = false;
  let cancelled = false;

  // 2. ポーリングループ
  while (true) {
    const state = await withTimeout(
      agentsClient.runs.get(threadId, runId),
      getTimeout,
      `${operation}:get`
    ) as AgentsRunState;

    finalState = state;
    const status = state.status;

    if (DEBUG.AI) {
      console.info(
        "[agents] run tick: op=%s runId=%s status=%s",
        operation,
        runId,
        status ?? "unknown"
      );
    }

    // -- requires_action 処理 --
    if (status === "requires_action") {
      const { captured: cap, submitted } = await handleRequiresActionOnce({
        state,
        threadId,
        runId,
        handler: requiresActionHandler,
      });

      if (cap !== undefined) captured = cap;

      if (!submitted) {
        // ツール出力なし → この run は先に進めない
        break;
      }

      // submit 後1 tick 状態確認のためループ継続
      continue;
    }

    // -- terminal --
    if (
      status === "completed" ||
      status === "failed" ||
      status === "cancelled" ||
      status === "expired"
    ) break;

    // -- timeout? --
    if (Date.now() - startedAt > pollTimeout) {
      timedOut = true;
      break;
    }

    await sleep(pollSleep);
  }

  // 3. timeout したのに terminal ではない → cancel
  if (timedOut && finalState && finalState.status !== "completed") {
    try {
      await withTimeout(
        agentsClient.runs.cancel(threadId, runId),
        getTimeout,
        `${operation}:cancel`
      );
      cancelled = true;
    } catch {
      // cancel 失敗は無視
    }
  }

  if (DEBUG.AI) {
    console.info(
      "[agents] runWithToolCapture done: op=%s runId=%s timedOut=%s cancelled=%s",
      operation,
      runId,
      timedOut,
      cancelled
    );
  }

  return {
    runId,
    captured,
    finalState,
    timedOut,
    cancelled,
  };
}

// instpack に紐づく reply/meta/inst 用 Agent を「キャッシュにある分だけ」削除
export async function delete3AgentsForInstpack(instpack: string): Promise<{
  deletedReply?: string | null;
  deletedMeta?: string | null;
  deletedInst?: string | null;
}> {
  // 作成時と同一設定の Bing Grounding ツール（署名が一致する必要がある）
  const bingTool = ToolUtility.createBingGroundingTool([
    { connectionId: AZURE.BING_CONNECTION_ID, market: "ja-JP", setLang: "ja", count: 5, freshness: "week" },
  ]);

  const { reply, meta, inst } = getInstructionsWithInstpack(instpack);

  const pairs: Array<{ 
    label: "reply" | "meta" | "inst"; 
    ins: string; 
    tools: ReadonlyArray<ToolLike | unknown>;
    mdl: string;
  }> = [
    { label: "reply", ins: reply, tools: [bingTool], mdl: MODEL.reply },
    { label: "meta",  ins: meta,  tools: [emitMetaTool], mdl: MODEL.meta  },
    { label: "inst",  ins: inst,  tools: [emitInstpackTool], mdl: MODEL.instpack },
  ];

  const result: { deletedReply?: string | null; deletedMeta?: string | null; deletedInst?: string | null } = {};

  for (const p of pairs) {
    const sig = computeAgentSig(p.ins, p.tools, p.mdl);
    const key = agentCacheKeyFromSig(sig);
    const agentId = await redis.get(key);
    if (!agentId) {
      if (p.label === "reply") result.deletedReply = null;
      if (p.label === "meta")  result.deletedMeta  = null;
      if (p.label === "inst")  result.deletedInst  = null;
      continue;
    }
    try {
      await agentsClient.deleteAgent(agentId);
    } catch {
      // 404 等は無視
    }
    await redis.del(key);

    if (p.label === "reply") result.deletedReply = agentId;
    if (p.label === "meta")  result.deletedMeta  = agentId;
    if (p.label === "inst")  result.deletedInst  = agentId;
  }

  return result;
}
