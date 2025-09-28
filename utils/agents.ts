import "server-only";
import { createHash } from "crypto";
import { AgentsClient, ToolUtility } from "@azure/ai-agents";
import { DefaultAzureCredential } from "@azure/identity";
import { emitInstpackTool } from "@/services/tools/emitInstpack.tool";
import { emitMetaTool } from "@/services/tools/emitMeta.tool";
import { buildInstpackInstructions, buildMetaInstructions, buildReplyInstructions, buildReplyWithUserInstpack } from "@/utils/agentPrompts";
import { AZURE, envInt } from "@/utils/env";
import { redis } from "@/utils/redis";
import { toDefinition, type ToolLike } from "@/utils/types";

const endpoint = AZURE.AI_PRJ_ENDPOINT;
const modelDeployment = AZURE.AI_MODEL_DEPLOYMENT;
const agentNamePrefix = AZURE.AGENT_NAME_PREFIX;

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
  tools: ReadonlyArray<ToolLike | unknown>
): string {
  return createHash("sha256")
    .update(JSON.stringify({ modelDeployment, endpoint, instructions, toolSig: toolSignature(tools) }))
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
  tools: ReadonlyArray<ToolLike | unknown>
): Promise<string> {
  const sig = computeAgentSig(instructions, tools);
  const key = agentCacheKeyFromSig(sig);

  const cached = await redis.get(key);
  if (cached) return cached;

  const agent = await agentsClient.createAgent(modelDeployment, {
    name: `${agentNamePrefix}-${Date.now()}`,
    instructions,
    tools: tools.map(toDefinition),
  });

  const ttlDays = envInt("AGENT_CACHE_TTL_DAYS", 14, { min: 1, max: 365 });
  const ttlSec = ttlDays * 24 * 60 * 60;
  await redis.setex(key, ttlSec, agent.id);
  return agent.id;
}

// BASE+REPLY（instpack未注入）の reply Agent を「キャッシュにある分だけ」削除
export async function deleteBaseReplyAgent(): Promise<string | null> {
  const bingTool = ToolUtility.createBingGroundingTool([
    { connectionId: AZURE.BING_CONNECTION_ID, market: "ja-JP", setLang: "ja", count: 5, freshness: "week" },
  ]);
  const baseReplyIns = buildReplyInstructions().trim();
  const sig = (function computeAgentSigLocal() {
    return createHash("sha256")
      .update(JSON.stringify({ modelDeployment, endpoint, instructions: baseReplyIns, toolSig: (function toolSigLocal() {
        const defsNorm = [toDefinition(bingTool)];
        return createHash("sha256").update(JSON.stringify(defsNorm)).digest("base64url").slice(0, 12);
      })() }))
      .digest("base64url")
      .slice(0, 12);
  })();

  const ns = Buffer.from(endpoint).toString("base64url");
  const key = `agent:id:${ns}:${sig}`;

  const agentId = await redis.get(key);
  if (!agentId) return null;

  try {
    await agentsClient.deleteAgent(agentId);
  } catch {
    // 404等は無視
  }
  await redis.del(key);
  return agentId;
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

  const replyIns = buildReplyWithUserInstpack(instpack).trim();
  const metaIns  = buildMetaInstructions().trim();
  const instIns  = buildInstpackInstructions().trim();

  const pairs: Array<{ label: "reply" | "meta" | "inst"; ins: string; tools: ReadonlyArray<ToolLike | unknown> }> = [
    { label: "reply", ins: replyIns, tools: [bingTool] },
    { label: "meta",  ins: metaIns,  tools: [emitMetaTool] },
    { label: "inst",  ins: instIns,  tools: [emitInstpackTool] },
  ];

  const result: { deletedReply?: string | null; deletedMeta?: string | null; deletedInst?: string | null } = {};

  for (const p of pairs) {
    const sig = computeAgentSig(p.ins, p.tools);
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