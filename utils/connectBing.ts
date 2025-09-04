import {
  AgentsClient,
  ToolUtility,
  isOutputOfType,
  type MessageTextContent,
  type MessageTextUrlCitationAnnotation,
} from "@azure/ai-agents";
import { DefaultAzureCredential } from "@azure/identity";
import Redis from "ioredis";
import Redlock from "redlock";
import { createHash } from "crypto";

const endpoint = process.env.AZURE_AI_PRJ_ENDPOINT!;
const bingConnectionId = process.env.AZURE_BING_CONNECTION_ID!;
const modelDeployment = process.env.AZURE_AI_MODEL_DEPLOYMENT!;
const agentNamePrefix = process.env.AZURE_AI_PRJ_AGENT_NAME ?? "lineai-bing-agent";
const threadTTL = Number(process.env.THREAD_TTL ?? 168);

const redisHost = process.env.REDIS_HOSTNAME!;
const redisPort = Number(process.env.REDIS_PORT ?? 6380);
const redisUser = process.env.REDIS_USERNAME ?? "default";
const redisKey = process.env.REDIS_KEY!;

// credential
const credential = new DefaultAzureCredential();
async function preflightAuth(): Promise<void> {
  const scope = "https://ml.azure.com/.default";
  const token = await credential.getToken(scope);
  if (!token) throw new Error(`Failed to acquire token for scope: ${scope}`);
  const sec = Math.round((token.expiresOnTimestamp - Date.now()) / 1000);
  console.log(`[auth] got token for ${scope}, expires in ~${sec}s`);
}

// client
const client = new AgentsClient(endpoint, credential);
// bingTool
const bingTool = ToolUtility.createBingGroundingTool([{ connectionId: bingConnectionId }]);

// redis
const redis = new Redis({
  host: redisHost,
  port: redisPort,
  username: redisUser,
  password: redisKey,
  tls: { servername: redisHost },
});
redis.on("error", (e) => console.error("[redis] error:", e));

// radlock
const redlock = new Redlock([redis], {
  retryCount: 6,
  retryDelay: 250,
  retryJitter: 150,
});

function agentIdKey() {
  const ns = Buffer.from(endpoint).toString("base64url");
  const h = createHash("sha256")
    .update(JSON.stringify({
      modelDeployment,
      bingConnectionId,
      instructions: "You are a helpful agent. Use Bing grounding when it helps and include sources if available." 
    }))
    .digest("base64url")
    .slice(0, 12);
  return `agent:id:${ns}:${h}`;
}

// AGETN ID 取得
async function getOrCreateAgentId(): Promise<string> {
  //  if (process.env.AZURE_AI_PRJ_AGENT_ID) return process.env.AZURE_AI_PRJ_AGENT_ID;
  const key = agentIdKey();
  const cached = await redis.get(key);
  if (cached) return cached;

  // redisのchacheがなければ AGENT作成
  const agent = await client.createAgent(modelDeployment, {
    name: `${agentNamePrefix}-${Date.now()}`,
    instructions:
      "You are a helpful agent. Use Bing grounding when it helps and include sources if available.",
    tools: [bingTool.definition],
  });
  await redis.set(key, agent.id);
  return agent.id;
}

// ユーザ毎のthead
function threadKey(userId: string) {
  // ENDPOINT毎
  const ns = Buffer.from(endpoint).toString("base64url");
  return `thread:${ns}:${userId}`;
}

// Thread ID 取得
async function getOrCreateThreadId(userId: string, ttlHours = threadTTL): Promise<string> {
  const k = threadKey(userId);
  const tid = await redis.get(k);
  if (tid){
    // 使われたらTTLを延長
    await redis.expire(k, ttlHours * 3600);
    return tid;
  }
  // なければcreate
  const th = await client.threads.create();
  await redis.set(k, th.id, "EX", ttlHours * 3600);
  return th.id;
}

// Threadのdelete
export async function resetThread(userId: string) {
  const k = threadKey(userId);
  const tid = await redis.get(k);
  if (tid) {
    try {
      await client.threads.delete(tid);
    } catch {
      // 既に無ければ無視
    }
    await redis.del(k);
  }
}

// 引用URLを収集する
function collectCitations(contents: MessageTextContent[]) {
  const urlMap = new Map<string, string | undefined>(); // url->titleのMapになってる
  for (const c of contents) {
    if (!isOutputOfType<MessageTextContent>(c, "text")) continue;
    for (const annotation of c.text.annotations ?? []) {
      if (annotation.type === "url_citation") {
        const a = annotation as MessageTextUrlCitationAnnotation;
        const url = a.urlCitation?.url;
        if (url) urlMap.set(url, a.urlCitation?.title);
      }
      // 将来 Azure AI Search 等のファイル引用も出したい時:
      // else if (ann.type === "file_citation") { ... }
    }
  }
  return [...urlMap.entries()].map(([url, title]) => ({ url, title }));
}

// main
export async function connectBing(userId: string, question: string): Promise<string> {
  const q = question.trim();
  if (!q) return "メッセージが空です。";
  // 認証チェック
  await preflightAuth();

  return await redlock.using([`lock:user:${userId}`], 90_000, async () => {
    // Agent/Thread作成
    const [agentId, threadId] = await Promise.all([
      getOrCreateAgentId(),
      getOrCreateThreadId(userId),
    ]);

    // ユーザクエリ投入
    await client.messages.create(threadId, "user", [{ type: "text", text: q }]);

    // 実行
    const run = await client.runs.createAndPoll(threadId, agentId, {
      pollingOptions: { intervalInMs: 1500 },
    });
    if (run.status !== "completed") {
      const code = run.lastError?.code ?? "";
      const msg  = run.lastError?.message ?? "";
      console.warn(`⚠️ Run ended: ${run.status}${code ? ` code=${code}` : ""}${msg ? ` message=${msg}` : ""}`);
      return "エラーが発生しました。(run createAndPoll)";
    }

    // すべてのメッセージを取得する->assistant, textのみ抽出
    let lastAssistantText = "";
    let lastAssistantCitations: Array<{ url: string; title?: string }> = [];
    for await (const m of client.messages.list(threadId, { order: "desc" })) {
      if (m.role !== "assistant") continue;
      // 本文
      for (const c of m.content) {
        if (isOutputOfType<MessageTextContent>(c, "text") && !lastAssistantText) {
          lastAssistantText = c.text.value;
        }
      }
      // URL抜き出し
      const textParts = m.content.filter(
        (c): c is MessageTextContent => isOutputOfType<MessageTextContent>(c, "text")
      );
      lastAssistantCitations = collectCitations(textParts);
      break; // 最新のassistantのみ
    }
    if (!lastAssistantText) return "⚠️ Bing応答にtextが見つかりませんでした。";
    const sources = lastAssistantCitations.length
      ? "\n\n参考URL:\n" +
        lastAssistantCitations
          .map((s, i) => `${i + 1}. ${s.title ? `${s.title} - ` : ""}${s.url}`)
          .join("\n")
      : "";
    return lastAssistantText + sources;
  });
}