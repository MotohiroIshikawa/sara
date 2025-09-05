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
import { formatSectionsForLine } from "@/utils/normalizeMarkdownForLine";

// Bingのレスポンスを見たいときは.envにDEBUG_BING="1"を設定する
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


/**
 * Bingからのレスポンス処理
 * 
 * content:[{type:'text',text:{
 *  value:'(接頭の説明文)\n'+'\n'+'---\n'+'\n'+'###最初の段落'....
 *      // 段落ごとに参照URLがある場合は段落末尾に【\d+:\d+†source】の形で「注釈」が入る
 * ,annotations:[{
 *    type:'url_citation',
 *    urlCitation:{
 *      url:URL,
 *      title:'TITLE'
 *    },
 *    startIndex: SSS,  // 本文全体での「注釈」の開始位置
 *    endIndex: EEE     // 本文全体での「注釈」の終了位置
 *  }, ...]
 * }}]
 * 
 * toSectionedJsonFromMessageで返されるオブジェクト->下記Section型のオブジェクト配列
 * 
 */
type UrlRef = { url: string; title?: string };
type Section = {
  context: string;             // マーカー除去後の本文
  startIndex: number;          // 元テキスト内の開始位置
  endIndex: number;            // 元テキスト内の終了位置（end-exclusive）
  annotations?: UrlRef[];      // そのブロックに属するURL（出現順・重複除外）
};
const stripMarkers = (s: string) => s.replace(/【\d+:\d+†source】/g, "");
const delimiter = /\n\s*---\s*\n/g;

function splitByHrWithRanges(text: string): Section[] {
  const out: Section[] = [];
  let last = 0;
  for (const m of text.matchAll(delimiter)) {
    const idx = m.index ?? -1;
    if (idx < 0) continue;
    const chunk = text.slice(last, idx);
    if (chunk.trim()){
      out.push({ context: stripMarkers(chunk), startIndex: last, endIndex: idx });
    }
    last = idx + m[0].length;
  }
  const tail = text.slice(last);
  if (tail.trim()){
    out.push({ context: stripMarkers(tail), startIndex: last, endIndex: text.length });
  }
  return out;
}
// 1つの text パートを JSON 化：各ブロック直下にそのブロックの URL を付ける
function toSectionedJsonFromTextPart(part: MessageTextContent): Section[] {
  const text = part.text.value;
  const sections = splitByHrWithRanges(text);
  const annotation = (part.text.annotations ?? [])
    .filter((a): a is MessageTextUrlCitationAnnotation => a.type === "url_citation")
    .sort((a, b) => (a.startIndex ?? 0) - (b.startIndex ?? 0));
  
  for (const a of annotation) {
    const start = a.startIndex ?? -1;
    if (start < 0) continue;

    const url = a.urlCitation?.url;
    if (!url) continue;
    const title = a.urlCitation?.title;

    // 所属ブロックを探索（startIndex ∈ [section.startIndex, section.endIndex)）
    const section = sections.find(s => start >= s.startIndex && start < s.endIndex);
    if (!section) continue;
    // ブロック内で重複URLは除外しつつ、出現順で追加
    if (!section.annotations) section.annotations = [];
    if (!section.annotations.some(r => r.url === url)) {
      section.annotations.push({ url, title });
    }
  }
  return sections;
}
// メッセージ（複数 text パートの可能性あり）→ セクション配列を連結
function toSectionedJsonFromMessage(contents: MessageContentUnion[]): Section[] {
  const textParts = contents.filter(
    (c): c is MessageTextContent => isOutputOfType<MessageTextContent>(c, "text")
  );
  const all: Section[] = [];
  for (const p of textParts) all.push(...toSectionedJsonFromTextPart(p));
  return all;
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
      const sections = toSectionedJsonFromMessage(m.content);
      const payload = formatSectionsForLine(sections);
      lastAssistantText = JSON.stringify(payload, null, 2);
      if (DEBUG_BING) console.log(lastAssistantText);
      break; // 最新のassistantのみ
    }
    if (!lastAssistantText) return "⚠️ Bing応答にtextが見つかりませんでした。";
    return lastAssistantText;
  });
}

// Bing Searchの生jsonを見るためのデバグ
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
