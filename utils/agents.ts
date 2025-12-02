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

const endpoint = AZURE.AI_PRJ_ENDPOINT;
const agentNamePrefix = AZURE.AGENT_NAME_PREFIX;

const modelDeployment = AZURE.AI_MODEL_DEPLOYMENT;
const MODEL = {
  reply: process.env.AZURE_AI_MODEL_DEPLOYMENT_REPLY ?? modelDeployment,
  meta: process.env.AZURE_AI_MODEL_DEPLOYMENT_META ?? modelDeployment,
  instpack: process.env.AZURE_AI_MODEL_DEPLOYMENT_INSTPACK ?? modelDeployment,
} as const;

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
    .update(JSON.stringify({ modelDeployment: mdl, endpoint, instructions, toolSig: toolSignature(tools) }))
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

type AgentsRunStatus =
  | "queued"
  | "in_progress"
  | "requires_action"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

type AgentsSubmitToolOutputsAction = {
  type: "submit_tool_outputs";
  submitToolOutputs?: { toolCalls?: unknown };
};

type AgentsRunState = {
  status?: AgentsRunStatus;
  requiredAction?: AgentsSubmitToolOutputsAction;
};

type AgentsToolOutput = {
  toolCallId: string;
  output: string;
};

type AgentsRequiresActionResult<TCaptured> = {
  outputs: AgentsToolOutput[];  // submitToolOutputs に渡す配列
  captured?: TCaptured;         // ツールから抜き出した「欲しい値」（Meta / instpack など）
};

type AgentsRequiresActionHandler<TCaptured> = (args: {
  state: AgentsRunState;  // runs.get() で取得した run 状態
  threadId: string;
  runId: string;
}) => Promise<AgentsRequiresActionResult<TCaptured> | undefined>;

// createAndPollRun の戻り値
export type AgentsRunResult<TCaptured> = {
  runId: string;                // 作成された run の ID
  captured?: TCaptured;         // ツール処理で集めた値（なければ undefined）
  finalState?: AgentsRunState;  // 最後に観測した run 状態
  timedOut: boolean;            // pollTimeout 超過でタイムアウトしたかどうか
  cancelled: boolean;           // タイムアウト後に cancel() が成功したかどうか
};

const debugAgentsRun: boolean =
  (DEBUG.AI || process.env["DEBUG.AI"] === "true" || process.env.DEBUG_AI === "true") === true;

// run の「終端状態」（completed / failed / cancelled / expired）を判定
function isTerminalStatus(status: AgentsRunStatus | undefined): boolean {
  if (status === undefined) return false;
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "expired"
  );
}

// 共通の run 実行ヘルパ
// 1. runs.create()
// 2. runs.get() によるポーリング
// 3. requires_action 時のツール処理（requiresActionHandler）
// 4. pollTimeout 超過時の runs.cancel()
export async function createAndPollRun<TCaptured>(params: {
  threadId: string;         // 対象スレッド ID
  agentId: string;          // 使用する Agent ID
  operation: string;        // ログ用のラベル（"meta" / "inst" など）
  toolChoice?: { type: "function"; function: { name: string } };    // 利用するツール（単一 function）
  requiresActionHandler?: AgentsRequiresActionHandler<TCaptured>;   // requires_action 時の処理コールバック
  createTimeoutMs?: number; // runs.create のタイムアウト（省略時 MAIN_TIMERS.CREATE_TIMEOUT）
  getTimeoutMs?: number;    // runs.get のタイムアウト（省略時 MAIN_TIMERS.GET_TIMEOUT）
  pollTimeoutMs?: number;   // ポーリング全体のタイムアウト
  pollSleepMs?: number;     // 各ポーリング間の sleep
}): Promise<AgentsRunResult<TCaptured>> {
  const threadId: string = params.threadId;
  const agentId: string = params.agentId;
  const op: string = params.operation;

  const createTimeout: number = params.createTimeoutMs ?? MAIN_TIMERS.CREATE_TIMEOUT;
  const getTimeout: number = params.getTimeoutMs ?? MAIN_TIMERS.GET_TIMEOUT;
  const pollTimeout: number = params.pollTimeoutMs ?? MAIN_TIMERS.POLL_TIMEOUT;
  const pollSleep: number = Math.max(1, params.pollSleepMs ?? MAIN_TIMERS.POLL_SLEEP);

  // run を 1 回だけ作成（以降は run.id に対して get / cancel を行う）
  const run = await withTimeout(
    agentsClient.runs.create(threadId, agentId, {
      parallelToolCalls: false,      // ツールは直列実行
      toolChoice: params.toolChoice,
    }),
    createTimeout,
    `${op}:create`
  ) as { id: string };

  if (debugAgentsRun) {
    console.info(
      "[agentsRun] create: op=%s runId=%s agentId=%s threadId=%s",
      op,
      run.id,
      agentId,
      threadId
    );
  }

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  // ポーリング制限（時間 + 回数）
  const pollMaxTicks: number = Math.max(1, Math.ceil(pollTimeout / pollSleep)) + 10;
  const startedAt: number = Date.now();
  let ticks: number = 0;

  let lastState: AgentsRunState | undefined;
  let captured: TCaptured | undefined;
  let timedOut: boolean = false;
  let cancelled: boolean = false;

  // run 状態のポーリングループ
  while (true) {
    const state = await withTimeout(
      agentsClient.runs.get(threadId, run.id),
      getTimeout,
      `${op}:get`
    ) as AgentsRunState;

    lastState = state;
    const status: AgentsRunStatus | undefined = state.status;

    if (debugAgentsRun) {
      console.info(
        "[agentsRun] tick: op=%s runId=%s threadId=%s status=%s",
        op,
        run.id,
        threadId,
        status ?? "unknown"
      );
    }

    // モデル側から「ツール呼んだので結果を submit して」と言われたケース
    if (status === "requires_action" && params.requiresActionHandler) {

      // requiredAction の生 JSON を見るためのログを追加
      if (debugAgentsRun) {
        console.info(
          "[agentsRun] requiredAction raw:",
          JSON.stringify(state.requiredAction, null, 2)
        );
      }

      const result = await params.requiresActionHandler({
        state,
        threadId,
        runId: run.id,
      });

      if (result && result.outputs.length > 0) {
        // captured に値が入っていれば保持（最後にまとめて返す）
        if (result.captured !== undefined) {
          captured = result.captured;
        }

        // submitToolOutputs に渡す outputs をログ出力
        if (debugAgentsRun) {
          console.info(
            "[agentsRun] submitToolOutputs outputs:",
            JSON.stringify(result.outputs, null, 2)
          );
        }

        // ツールの実行結果を submit（これで run が再び in_progress → completed へ進む）
        await agentsClient.runs.submitToolOutputs(threadId, run.id, result.outputs);

        // submit 直後の 1 tick 状態を確認
        if (debugAgentsRun) {
          const afterSubmit = await agentsClient.runs.get(threadId, run.id);
          console.info(
            "[agentsRun] after submitToolOutputs: op=%s runId=%s status=%s requiredAction=%s",
            op,
            run.id,
            afterSubmit.status ?? "unknown",
            afterSubmit.requiredAction ? "present" : "none"
          );
        }
      }
    } else if (isTerminalStatus(status)) {
      // completed / failed / cancelled / expired のいずれかになったので終了
      break;
    } else {
      // まだ実行中（queued / in_progress など）なので少し待ってから再度 get
      ticks += 1;
      const elapsed: number = Date.now() - startedAt;
      if (elapsed > pollTimeout || ticks > pollMaxTicks) {
        // pollTimeout / tick 上限を超えたのでタイムアウト扱いにして抜ける
        timedOut = true;
        break;
      }
      await sleep(pollSleep);
    }
  }

  // タイムアウトしたうえで、run が terminal 状態になっていない場合は cancel を試みる
  if (timedOut && !isTerminalStatus(lastState?.status)) {
    if (debugAgentsRun) {
      console.warn(
        "[agentsRun] timeout; cancelling runId=%s threadId=%s op=%s status=%s",
        run.id,
        threadId,
        op,
        lastState?.status ?? "unknown"
      );
    }
    try {

      if (debugAgentsRun) {
        console.warn(
          "[agentsRun] cancel issued: runId=%s threadId=%s op=%s",
          run.id,
          threadId,
          op
        );
      }

      await withTimeout(
        agentsClient.runs.cancel(threadId, run.id),
        getTimeout,
        `${op}:cancel`
      );
      cancelled = true;

      const postCancelMaxTicks: number = 10;
      let postCancelTicks: number = 0;
      for (let i: number = 0; i < postCancelMaxTicks; i++) {
        postCancelTicks += 1;
        const st: AgentsRunState = await withTimeout(
          agentsClient.runs.get(threadId, run.id),
          getTimeout,
          `${op}:post-cancel-get`
        ) as AgentsRunState;

        lastState = st;

        if (debugAgentsRun) {
          console.info(
            "[agentsRun] post-cancel tick: op=%s runId=%s threadId=%s tick=%d status=%s",
            op,
            run.id,
            threadId,
            postCancelTicks,
            st.status ?? "unknown"
          );
        }

        if (isTerminalStatus(st.status)) {
          break;
        }

        await sleep(pollSleep);
      }

      // cancelしたことをログに出す
      if (debugAgentsRun) {
        console.warn(
          "[agentsRun] post-cancel done: op=%s runId=%s threadId=%s lastStatus=%s ticks=%d",
          op,
          run.id,
          threadId,
          lastState?.status ?? "unknown",
          postCancelTicks
        );
      }

    } catch (err) {
      if (debugAgentsRun) {
        console.warn(
          "[agentsRun] cancel failed: runId=%s threadId=%s op=%s err=%o",
          run.id,
          threadId,
          op,
          err
        );
      }
    }
  }

  if (debugAgentsRun) {
    console.info(
      "[agentsRun] done: op=%s runId=%s agentId=%s threadId=%s timedOut=%s cancelled=%s hasResult=%s",
      op,
      run.id,
      agentId,
      threadId,
      timedOut,
      cancelled,
      captured !== undefined
    );
  }

  const result: AgentsRunResult<TCaptured> = {
    runId: run.id,
    captured,
    finalState: lastState,
    timedOut,
    cancelled,
  };
  return result;
}
