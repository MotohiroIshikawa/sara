import "server-only";
import { createHash } from "crypto";
import { AgentsClient, ToolUtility } from "@azure/ai-agents";
import { DefaultAzureCredential } from "@azure/identity";
import { emitInstpackTool } from "@/services/tools/emitInstpack.tool";
import { emitMetaTool } from "@/services/tools/emitMeta.tool";
import { getInstructionsWithInstpack } from "@/utils/prompts/getInstruction";
import { AZURE, envInt } from "@/utils/env";
import { redis } from "@/utils/redis";
import { toDefinition, type ToolLike } from "@/utils/types";

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