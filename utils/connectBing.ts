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
import { normalizeMarkdownForLine } from "@/utils/normalizeMarkdownForLine";
import { agentInstructions } from '@/utils/agentInstructions';

function envInt(name: string, def: number, min = 0, max = 10) {
  const raw = process.env[name];
  const n = raw === undefined ? def : Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

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

const lineTextLimit = envInt("LINE_TEXT_LIMIT", 1000, 200, 4800);
const maxUrlsPerBlock = envInt("LINE_MAX_URLS_PER_BLOCK", 3, 0, 10);
const minSectionLength = envInt("MIN_SECTION_LENGTH", 8, 0, 10);

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
      instructions: agentInstructions 
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
    instructions: agentInstructions,
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
 * toSectionedJsonFromMessageで返されるオブジェクト->下記Section型のオブジェクト配列->LINE用text配列へ
 * 
 */
type Section = {
  context: string;     // マーカー除去後の本文
  startIndex: number;  // 元テキスト内の開始位置
  endIndex: number;    // 元テキスト内の終了位置（end-exclusive）
};

const stripMarkers = (s: string) => s.replace(/【\d+:\d+†source】/g, "");
const delimiter = /\r?\n\r?\n/g;
const isAscii = (s: string) => /^[\x00-\x7F]+$/.test(s);
const isFiller = (s: string) => {
  const t = s.trim();
  if (!t) return true; // 空はフィラー
  return isAscii(t) && t.length <= minSectionLength;
};

function splitByHrWithRanges(text: string): Section[] {
  const out: Section[] = [];
  let last = 0;
  for (const m of text.matchAll(delimiter)) {
    const idx = m.index ?? -1;
    if (idx < 0) continue;
    const chunk = text.slice(last, idx);
    const trimmed = chunk.trim();
    if (!trimmed || isFiller(trimmed)) {
      last = idx + m[0].length;
      continue;
    }
    out.push({ context: stripMarkers(trimmed), startIndex: last, endIndex: idx });
    last = idx + m[0].length;
  }
  const tail = text.slice(last);
  const tailTrimmed = tail.trim();
  if (tailTrimmed && !isFiller(tailTrimmed)) {
    out.push({ context: stripMarkers(tailTrimmed), startIndex: last, endIndex: text.length });
  }
  return out;
}

// LINE向けの文字数制限によるtext分割格納
function chunkForLine(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    // 直近の改行（できれば段落区切り）を探す
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < 0) cut = rest.lastIndexOf("\n", limit);
    if (cut < 0) cut = limit; // 改行が無ければ機械的に分割
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) out.push(rest);
  return out;
}

function toLineTextsFromTextPart(
  part: MessageTextContent,
  opts: { maxUrls?: number; showTitles?: boolean } = {}
): string[] {
  const { maxUrls = maxUrlsPerBlock, showTitles = false } = opts;
  const text = part.text.value;
  const sections = splitByHrWithRanges(text);

  // セクションごとのURL重複を避けるための集合
  const seenPerSection: Array<Set<string>> = sections.map(() => new Set<string>());

  // 注釈をセクションの末尾へ追記するための行バッファ
  const urlLinesPerSection: string[][] = sections.map(() => []);
  const anns = (part.text.annotations ?? [])
    .filter((a): a is MessageTextUrlCitationAnnotation => a.type === "url_citation")
    .sort((a, b) => (a.startIndex ?? 0) - (b.startIndex ?? 0));
  for (const a of anns) {
    const s = a.startIndex ?? -1;
    if (s < 0) continue;
    const url = a.urlCitation?.url;
    const title = a.urlCitation?.title;
    if (!url) continue;

    // 所属セクションを見つける
    const idx = sections.findIndex(sec => s >= sec.startIndex && s < sec.endIndex);
    if (idx === -1) continue;

    // 重複URLはスキップ
    const seen = seenPerSection[idx];
    if (seen.has(url)) continue;

    if (urlLinesPerSection[idx].length >= maxUrls) continue;
    seen.add(url);
    urlLinesPerSection[idx].push(
      showTitles && title ? `・${title}\n${url}` : `・${url}`
    );
  }

  // 各セクションを LINE 向けテキストに整形
  const out: string[] = [];
  sections.forEach((sec, i) => {
    // Markdownの整形
    const body = normalizeMarkdownForLine(sec.context.trim());
    const refs = urlLinesPerSection[i];
    // URLを末尾に追加
    const text = refs.length ? `${body}\n${refs.join("\n")}` : body;
    out.push(text);
  });

  // LINE向けの文字数制限によるtext分割格納
  const sized: string[] = [];
  for (const t of out) sized.push(...chunkForLine(t, lineTextLimit));
  return sized;
}

function toLineTextsFromMessage(
  contents: MessageContentUnion[],
  opts?: { maxUrls?: number; showTitles?: boolean }
): string[] {
  const textParts = contents.filter(
    (c): c is MessageTextContent => isOutputOfType<MessageTextContent>(c, "text")
  );
  const all: string[] = [];
  for (const p of textParts) {
    all.push(...toLineTextsFromTextPart(p, opts));
  }
  return all;
}

// main
export async function connectBing(userId: string, question: string): Promise<string[]> {
  const q = question.trim();
  console.log("question:" + q);
  if (!q) return ["⚠️メッセージが空です。"];
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
      temperature: 0.2,
      topP: 1,
    });

    // For Debug
    if (DEBUG_BING) {
      await dumpRunAndMessages(client, threadId, run, { maxMsgs: 5 });
    }

    if (run.status !== "completed") {
      const code = run.lastError?.code ?? "";
      const msg  = run.lastError?.message ?? "";
      console.warn(`⚠️Run ended: ${run.status}${code ? ` code=${code}` : ""}${msg ? ` message=${msg}` : ""}`);
      return ["⚠️エラーが発生しました。(run createAndPoll)"];
    }

    // すべてのメッセージを取得する->assistant, textのみ抽出
    for await (const m of client.messages.list(threadId, { order: "desc" })) {
      if (m.role !== "assistant") continue;
      const texts = toLineTextsFromMessage(m.content, { maxUrls: maxUrlsPerBlock, showTitles: true });
      if (DEBUG_BING) {
        console.log("\n===== [DEBUG] line texts =====");
        texts.forEach((t, i) => {
          console.log(`[${i}] len=${t.length}`);
          console.log(t);
          console.log("---");
        });
      }
      if (texts.length) return texts;
      break; // 最新のassistantのみ
    }
    return ["⚠️エラーが発生しました（Bing応答にtextが見つかりません）"];
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
    cnt++;
    if (cnt >= maxMsgs) break;
  }
}
