import "server-only";
import { createHash } from "crypto";
import { AgentsClient } from "@azure/ai-agents";
import { DefaultAzureCredential } from "@azure/identity";
import { AZURE } from "@/utils/env";
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
  type FnTool = { function?: { name?: unknown } };
  type TypeTool = { type?: unknown };

  const tokens = defsNorm.map((d) => {
    const f = (d as FnTool).function;
    if (f && typeof f.name === "string") return f.name;
    const t = (d as TypeTool).type;
    if (typeof t === "string") return t;
    return "unknown";
  });
  return JSON.stringify(tokens);
}

// 指示文＋ツール構成でAgentをキャッシュ・作成
export async function getOrCreateAgentIdWithTools(
  instructions: string,
  tools: ReadonlyArray<ToolLike | unknown>
): Promise<string> {
  const ns = Buffer.from(endpoint).toString("base64url");
  const sig = createHash("sha256")
    .update(JSON.stringify({
      modelDeployment,
      endpoint,
      instructions,
      toolSig: toolSignature(tools),
    }))
    .digest("base64url")
    .slice(0, 12);
  const key = `agent:id:${ns}:${sig}`;

  const cached = await redis.get(key);
  if (cached) return cached;

  const agent = await agentsClient.createAgent(modelDeployment, {
    name: `${agentNamePrefix}-${Date.now()}`,
    instructions,
    tools: tools.map(toDefinition),
  });
  await redis.set(key, agent.id);
  return agent.id;
}

