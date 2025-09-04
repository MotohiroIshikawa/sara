import {
  AgentsClient,
  ToolUtility,
  isOutputOfType,
  type MessageContentUnion,
  type MessageTextContent,
  type MessageTextUrlCitationAnnotation,
} from "@azure/ai-agents";
import { DefaultAzureCredential } from "@azure/identity";
import Redis from "ioredis";
import Redlock from "redlock";
import { createHash } from "crypto";

// 先頭あたりに追加
const DEBUG_BING = process.env.DEBUG_BING === "1";

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

// Agentのkey作成
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

// ユーザ毎のTheadのkey作成
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

function hostnameOf(u: string) {
  try { return new URL(u).hostname; } catch { return u; }
}

// text パートから URL を抽出（出現順・重複URLは除外）
function extractUrlsFromTextPart(part: MessageTextContent, max = 8 ): Array<{ url: string; title?: string }> {
  const anns = (part.text.annotations ?? [])
    .filter((a): a is MessageTextUrlCitationAnnotation => a.type === "url_citation")
    .sort((a, b) => (a.startIndex ?? 0) - (b.startIndex ?? 0));
  const seen = new Set<string>();
  const out: Array<{ url: string; title?: string }> = [];

  for (const a of anns) {
    const url = a.urlCitation?.url;
    // 重複除外
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: a.urlCitation?.title });
    if (out.length >= max) break;
  }
  return out;
}

// text の直後に、その text に付いている参考URLを並べる
function renderTextThenUrls(
  parts: MessageContentUnion[] | MessageTextContent[],
  opts?: { maxPerText?: number; showLabel?: boolean }
): string {
  const { maxPerText = 8, showLabel = true } = opts ?? {};
  const textParts = (parts as MessageContentUnion[]).filter(
    (c): c is MessageTextContent => isOutputOfType<MessageTextContent>(c, "text")
  );

  const blocks: string[] = [];
  for (const part of textParts) {
    // 【 】で囲まれている部分は削除
    const cleaned = part.text.value.replace(/【\d+:\d+†source】/g, "");
    blocks.push(cleaned);
    // url部分を取ってくる
    const urls = extractUrlsFromTextPart(part, maxPerText);
    if (urls.length) {
      const header = showLabel ? "\n参考URL:\n" : "\n";
      const lines = urls
        .map((u, i) => `  ${i + 1}. ${(u.title ?? hostnameOf(u.url))} - ${u.url}`)
        .join("\n");
      blocks.push(header + lines);
    }
  }
  return blocks.join("\n\n");
}

// main
export async function connectBing(userId: string, question: string): Promise<string> {
  const q = question.trim();
  console.log("question:" + q);
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

    // For Debug
    if (DEBUG_BING) {
      await dumpRunAndMessages(client, threadId, run, { maxMsgs: 5 });
    }

    if (run.status !== "completed") {
      const code = run.lastError?.code ?? "";
      const msg  = run.lastError?.message ?? "";
      console.warn(`⚠️ Run ended: ${run.status}${code ? ` code=${code}` : ""}${msg ? ` message=${msg}` : ""}`);
      return "エラーが発生しました。(run createAndPoll)";
    }

    // すべてのメッセージを取得する->assistant, textのみ抽出
    let lastAssistantText = "";
    for await (const m of client.messages.list(threadId, { order: "desc" })) {
      if (m.role !== "assistant") continue;
      // URL抜き出し
      const textParts = m.content.filter(
        (c): c is MessageTextContent => isOutputOfType<MessageTextContent>(c, "text")
      );

      if (textParts.length) {
        lastAssistantText = renderTextThenUrls(textParts, { maxPerText: 8, showLabel: true });
      }
      break; // 最新のassistantのみ
    }
    if (!lastAssistantText) return "⚠️ Bing応答にtextが見つかりませんでした。";
    return lastAssistantText;
  });
}


// ↓ファイル下部のどこかに追加（ユーティリティ）
async function dumpRunAndMessages(
  client: AgentsClient,
  threadId: string,
  run: unknown,           // SDKの型に縛らず raw をそのまま出す
  opts: { maxMsgs?: number } = {}
) {
  const { maxMsgs = 10 } = opts;

  // run 全体（unknown は object にキャストして表示）
  console.log("\n===== [DEBUG] run (raw) =====");
  console.dir(run as object, { depth: null, colors: true });

  // run.id を安全に取り出す
  const runId = (run as { id?: string })?.id;
  console.log("[DEBUG] runId =", runId);

  // steps（runId が取れたときだけ）
  console.log("\n===== [DEBUG] steps (raw) =====");
  try {
    if (runId) {
      const steps = client.runSteps.list(threadId, runId, { order: "desc", limit: 20 });
      for await (const step of steps) {
        console.dir(step, { depth: null, colors: true });
      }
    } else {
      console.warn("[DEBUG] run.id not found; skip steps");
    }
  } catch (e) {
    console.warn("[DEBUG] steps unavailable or error:", e);
  }

  // messages はそのまま
  console.log("\n===== [DEBUG] messages (raw, newest first) =====");
  let cnt = 0;
  for await (const m of client.messages.list(threadId, { order: "desc" })) {
    console.dir(m, { depth: null, colors: true });
    // …（略：あなたのサマリ出力部分はそのままでOK）
    cnt++;
    if (cnt >= maxMsgs) break;
  }
}
