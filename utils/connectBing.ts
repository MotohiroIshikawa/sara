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
import { emitMetaTool } from "@/services/tools/emitMeta.tool";

// Int型環境変数
function envInt(name: string, def: number, min = 0, max = 10) {
  const raw = process.env[name];
  const n = raw === undefined ? def : Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

// 環境変数
//// Bing接続用
const endpoint = process.env.AZURE_AI_PRJ_ENDPOINT!;
const bingConnectionId = process.env.AZURE_BING_CONNECTION_ID!;
const modelDeployment = process.env.AZURE_AI_MODEL_DEPLOYMENT!;
const agentNamePrefix = process.env.AZURE_AI_PRJ_AGENT_NAME ?? "lineai-bing-agent";
const threadTTL = Number(process.env.THREAD_TTL ?? 168);
//// Redis接続用
const redisHost = process.env.REDIS_HOSTNAME!;
const redisPort = Number(process.env.REDIS_PORT ?? 6380);
const redisUser = process.env.REDIS_USERNAME ?? "default";
const redisKey = process.env.REDIS_KEY!;
//// LINE出力
const lineTextLimit = envInt("LINE_TEXT_LIMIT", 1000, 200, 4800);
const maxUrlsPerBlock = envInt("LINE_MAX_URLS_PER_BLOCK", 3, 0, 10);
const minSectionLength = envInt("MIN_SECTION_LENGTH", 8, 0, 10);
//// Bingのレスポンスを見たいときは.envにDEBUG_BING="1"を設定する
const DEBUG_BING = process.env.DEBUG_BING === "1";
//// METAの期間厳密化
const metaDays = envInt("NEWS_DEFAULT_DAYS", 7, 1, 30);

// 型宣言
type Section = {
  context: string;     // マーカー除去後の本文
  startIndex: number;  // 元テキスト内の開始位置
  endIndex: number;    // 元テキスト内の終了位置（end-exclusive）
};
type Intent = "event" | "news" | "buy" | "generic";
type Slots = { topic?: string; place?: string | null; date_range?: string; official_only?: boolean };
type Meta = { intent?: Intent; slots?: Slots; complete?: boolean; followups?: string[] };
// meta/instpack 抽出用
const FENCE_RE = (name: string) => new RegExp("```" + name + "\\s*\\r?\\n([\\s\\S]*?)\\r?\\n?```", "g");
// 戻り値
export type ConnectBingResult = {
  texts: string[];         // ユーザーへ返す本文（instpack/meta を除去済み）
  meta?: Meta;             // 末尾の meta JSON
  instpack?: string;       // 末尾の instpack（コンパイル済み指示）
  agentId: string;
  threadId: string;
  runId?: string;
};
type ToolCallBase = { id: string; type?: string };
type FunctionToolCall = ToolCallBase & { type: "function"; function: { name: string; arguments?: string } };
type ToolCall = FunctionToolCall | ToolCallBase;
type SubmitToolOutputsAction = { type: "submit_tool_outputs"; toolCalls: ToolCall[] };
type RunState = {
  status?: "queued" | "in_progress" | "requires_action" | "completed" | "failed" | "cancelled" | "expired";
  requiredAction?: SubmitToolOutputsAction;
};
type EmitMetaPayload = { meta?: Meta; instpack?: string };

// credential
const credential = new DefaultAzureCredential();
async function preflightAuth(): Promise<void> {
  const scope = "https://ml.azure.com/.default";
  const token = await credential.getToken(scope);
  if (!token) throw new Error(`Failed to acquire token for scope: ${scope}`);
  const sec = Math.round((token.expiresOnTimestamp - Date.now()) / 1000);
  console.log(`[Auth OK] got token for ${scope}, expires in ~${sec}s`);
}

// client
const client = new AgentsClient(endpoint, credential);
// bingTool
const bingTool = ToolUtility.createBingGroundingTool([
  { 
    connectionId: bingConnectionId,
    market: "ja-JP",
    setLang: "ja",
    count: 5,
    freshness: "week",
   }]);

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

type FunctionToolDefLite = { function?: { name?: string } };
const emitToolName: string = (() => {
  const def = emitMetaTool.definition as FunctionToolDefLite;
  const name = def?.function?.name;
  return typeof name === "string" && name.length > 0 ? name : "emit_meta";
})();

// Agentのkey作成
function agentIdKey(instructions: string) {
  const ns = Buffer.from(endpoint).toString("base64url");
  // ツール構成が変わったら必ず新規Agentを作るためのシグネチャ
  const toolSig = JSON.stringify([
    "bing_grounding",
    // 念のためツール名が変わっても追随
    emitToolName,
  ]);
  const h = createHash("sha256")
    .update(JSON.stringify({
      modelDeployment,
      bingConnectionId,
      instructions,
      toolSig 
    }))
    .digest("base64url")
    .slice(0, 12);
  return `agent:id:${ns}:${h}`;
}

// AGETN ID 取得
async function getOrCreateAgentId(instructions: string): Promise<string> {
  //  if (process.env.AZURE_AI_PRJ_AGENT_ID) return process.env.AZURE_AI_PRJ_AGENT_ID;
  const key = agentIdKey(instructions);
  const cached = await redis.get(key);
  if (cached) return cached;

  // redisのchacheがなければ AGENT作成
  const agent = await client.createAgent(modelDeployment, {
    name: `${agentNamePrefix}-${Date.now()}`,
    instructions,
    tools: [
      bingTool.definition,
      emitMetaTool.definition,
    ],
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
 * toSectionedJsonFromMessageで返されるオブジェクト->Section型のオブジェクト配列->LINE用text配列へ
 * 
 */

// 整形用
const stripMarkers = (s: string) => s.replace(/【\d+:\d+†source】/g, "");
const delimiter = /\r?\n\r?\n/g;
const isAscii = (s: string) => /^[\x00-\x7F]+$/.test(s);
const isFiller = (s: string) => {
  const t = s.trim();
  if (!t) return true; // 空はフィラー
  return isAscii(t) && t.length <= minSectionLength;
};

// textをdelimiterで分割、全text中での開始/終了文字数を取得する
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

// LINEの文字数制限によるtext分割格納
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

// annotationの各urlがどのtextに属するかの判断、urlをtextの末尾に付ける
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
      showTitles && title ? `${title}\n${url}` : `${url}`
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

// LINE向けにtextを作成
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

// assistantメッセージからmeta/instpackを除去
function stripInternalBlocksFromContent(contents: MessageContentUnion[]): {
  cleaned: MessageContentUnion[];
  meta?: Meta;
  instpack?: string;
} {
  const cloned = JSON.parse(JSON.stringify(contents)) as MessageContentUnion[];
  let meta: Meta | undefined;
  let inst: string | undefined;

  for (const c of cloned) {
    if (!isOutputOfType<MessageTextContent>(c, "text")) continue;

    // instpack
    const instRe = FENCE_RE("instpack");
    let mInst: RegExpExecArray | null;
    let lastInst: string | undefined;
    while ((mInst = instRe.exec(c.text.value))) lastInst = mInst[1];
    if (lastInst && lastInst.trim()) inst = lastInst.trim();
    instRe.lastIndex = 0;
    c.text.value = c.text.value.replace(instRe, "").trim();

    // meta（最後のフェンスを採用->1行JSONを想定）
    const metaRe = FENCE_RE("meta");
    let mMeta: RegExpExecArray | null;
    let lastMeta: string | undefined;
    while ((mMeta = metaRe.exec(c.text.value))) lastMeta = mMeta[1];
    if (lastMeta) {
      try {
        meta = JSON.parse(lastMeta.trim()) as Meta;
      } catch {
        /* 解析失敗は無視 */
      }
    }
    metaRe.lastIndex = 0;
    c.text.value = c.text.value.replace(metaRe, "").trim();
  }
  return { cleaned: cloned, meta, instpack: inst };
}

// スロットが不足している場合に問い合わせる
function buildFollowup(meta?: Meta): string {
  const slots = meta?.slots ?? {};
  const intent = meta?.intent;
  const missing: string[] = [];

  // topic が無ければ必ず聞く
  if (!slots.topic) missing.push("対象（作品名など）");
  // event では期間は質問しない（ongoing を採用する前提）
  if (intent !== "event" && !slots.date_range) missing.push("期間");
  // 場所は任意。必要に応じて軽く聞く
  if (slots.topic && !slots.place) missing.push("場所（任意）");

  const lead = missing.length ? `不足: ${missing.join(" / ")}。` : "";
  // モデルが followups を返してきても、event の場合は自前文面を優先
  if (intent === "event") {
    return `${lead}ひとつだけ教えてください。`;
  }
  return meta?.followups?.[0] ?? `${lead}ひとつだけ教えてください。`;
}

// この run の assistant メッセージだけ拾う
type AssistantMsg = {
  role: "assistant";
  runId?: string;
  content: MessageContentUnion[];
};

async function getAssistantMessageForRun(
  threadId: string, 
  runId: string
): Promise<AssistantMsg | undefined> {
  let fallback: AssistantMsg | undefined = undefined;

  for await (const m of client.messages.list(threadId, { order: "desc" })) {
    if (m.role !== "assistant") continue;
    const normalized: AssistantMsg = {
      role: "assistant",
      runId: m.runId ?? undefined,
      content: m.content as MessageContentUnion[],
    };
    // 最新のassistantをフォールバック候補として保持
    if (!fallback) fallback = normalized;
    // 同じrunのメッセージを最優先で返す
    if (m.runId && m.runId === runId) {
      return normalized;
    }
  }
  // 同じrunが見つからなければ最新のassistantを返す
  return fallback;
}

// フォローアップ検知
const FOLLOWUP_MAX_LEN = envInt("FOLLOWUP_MAX_LEN", 80, 20, 200);
function trimLite(s: string) {
  return s.replace(/\s+/g, "").trim();
}
function looksLikeFollowup(line?: string, meta?: Meta): boolean {
  if (!line) return false;
  const s = line.trim();
  if (!s) return false;
  if (s.length > FOLLOWUP_MAX_LEN) return false;
  const endsWithQ = /[?？]\s*$/.test(s);
  const hasLead = /^不足[:：]/.test(s);
  const equalsMeta = meta?.followups?.some(f => trimLite(f) === trimLite(s)) ?? false;
  return endsWithQ || hasLead || equalsMeta;
}

// META正規化
function normalizeMeta(meta?: Meta): Meta | undefined {
  if (!meta) return meta;
  const out: Meta = { ...meta, slots: { ...(meta.slots ?? {}) } };
  if (out.intent === "news") {
    const r = out.slots?.date_range?.trim().toLowerCase();
    if (!r || r === "ongoing" || r === "upcoming_30d") {
      out.slots!.date_range = `last_${metaDays}d`;
      // topic が特定できていれば news は complete
      out.complete = !!out.slots?.topic && out.slots.topic.trim().length > 0;
    }
  }
  return out;
}

// main
export async function connectBing(
  userId: string, 
  question: string,
  opts?: { instructionsOverride?: string }
): Promise<ConnectBingResult> {
  const q = question.trim();
  console.log("question:" + q);
  if (!q) return { texts: ["⚠️メッセージが空です。"], agentId: "", threadId: "" };
  // 認証チェック
  await preflightAuth();

  const instructions = opts?.instructionsOverride?.trim()?.length
    ? opts!.instructionsOverride!
    : agentInstructions;
  
  return await redlock.using([`lock:user:${userId}`], 90_000, async () => {
    // Agent/Thread作成
    const [agentId, threadId] = await Promise.all([
      getOrCreateAgentId(instructions),
      getOrCreateThreadId(userId),
    ]);

    // ユーザクエリ投入
    await client.messages.create(threadId, "user", [{ type: "text", text: q }]);

    // 実行
    //// createAndPoll廃止->runs.create
    const run = await client.runs.create(threadId, agentId, {
      temperature: 0.2,
      topP: 1,
    });

    let metaCaptured: Meta | undefined;
    let instpackCaptured: string | undefined;
    // セーフティ: 無限ループ防止
    const POLL_SLEEP_MS = 500;
    const POLL_TIMEOUT_MS = 60_000;
    const POLL_MAX_TICKS = Math.ceil(POLL_TIMEOUT_MS / POLL_SLEEP_MS) + 10; // 余裕を少し追加
    const startedAt = Date.now();
    let ticks = 0;

    while (true) {
      if (Date.now() - startedAt > POLL_TIMEOUT_MS || ++ticks > POLL_MAX_TICKS) {
        console.warn("⚠️ run polling timeout");
        break;
      }
      const cur = (await client.runs.get(threadId, run.id)) as RunState;
      if (cur.status === "requires_action" && cur.requiredAction?.type === "submit_tool_outputs") {
        const calls = cur.requiredAction.toolCalls ?? [];
        const outputs = calls.map((c): { toolCallId: string; output: string } => {
          const fn = c as FunctionToolCall; // 可能性のある構造だけを参照
          console.debug("[tools] call:", fn.function?.name, (fn.function?.arguments ?? "").slice(0, 120));
          if (fn.type === "function" && fn.function?.name === emitToolName) {
            try {
              const payload: EmitMetaPayload = JSON.parse(fn.function.arguments ?? "{}");
              if (payload?.meta) metaCaptured = payload.meta;    // 値を保持
              if (typeof payload?.instpack === "string") instpackCaptured = payload.instpack;
            } catch {
              /* parse error → ack して続行 */
            }
            return { toolCallId: c.id, output: "ok" };
          }
          // 他ツールがあれば通常処理
          return { toolCallId: c.id, output: "" };
        });
        await client.runs.submitToolOutputs(threadId, run.id, outputs);
      } else {
        const terminal: RunState["status"][] = ["completed", "failed", "cancelled", "expired"];
        if (cur.status && terminal.includes(cur.status)) {
          break;
        }
        await new Promise((r) => setTimeout(r, POLL_SLEEP_MS));
      }
    }

    // For Debug
    if (DEBUG_BING) {
      await dumpRunAndMessages(client, threadId, run, { maxMsgs: 5 });
    }

    // ループ終了後の最終状態を取得して判定
    const final = (await client.runs.get(threadId, run.id)) as RunState;
    if (final.status !== "completed") {
      type RunError = { code?: string; message?: string };
      const lastError: RunError | undefined = (final as unknown as { lastError?: RunError }).lastError;
      const code = lastError?.code ?? "";
      const msg  = lastError?.message ?? "";
      console.warn(`⚠️Run ended: ${final.status}${code ? ` code=${code}` : ""}${msg ? ` message=${msg}` : ""}`);
      return { texts: ["⚠️エラーが発生しました。(run polling)"], agentId, threadId, runId: run.id };
    }

    const picked = await getAssistantMessageForRun(threadId, run.id!);
    if (!picked) return {
      texts: ["⚠️エラーが発生しました（Bing応答にtextが見つかりません）"],
      agentId, threadId, runId: (run as { id?: string })?.id
    };

    const { cleaned: contentNoInternal, meta: rawMeta, instpack } = stripInternalBlocksFromContent(picked.content);

    const mergedMeta = normalizeMeta(metaCaptured ?? rawMeta);   // ← 使用（no-unused-vars解消）
    const mergedInst = instpackCaptured ?? instpack;             // ← 使用（no-unused-vars解消）

    // ユーザー向け本文をLINE整形
    const texts = toLineTextsFromMessage(contentNoInternal, {
      maxUrls: maxUrlsPerBlock,
      showTitles: false
    });

    if (DEBUG_BING) {
      console.log("\n===== [DEBUG] line texts =====");
      texts.forEach((t, i) => {
        console.log(`[${i}] len=${t.length}`);
        console.log(t);
        console.log("---");
      });
      console.log("===== [DEBUG] meta =====");
      console.dir(mergedMeta, { depth: null });
      console.log("===== [DEBUG] instpack =====");
      console.log(mergedInst ?? "(none)");
    }

    // 暫定回答は出す。その上で不足があれば最後に1行だけ確認を付与
    const out = texts.length ? [...texts] : ["（結果が見つかりませんでした）"];
    if (mergedMeta?.complete === false) {
      const ask = buildFollowup(mergedMeta);
      const last = out[out.length - 1];
      // すでに本文に同等の確認行が含まれていれば重複追加しない
      const alreadyHas =
        out.some(t => t.replace(/\s+/g,"").trim() === ask.replace(/\s+/g,"").trim()) ||
        looksLikeFollowup(last, mergedMeta);
      if (!alreadyHas) out.push(ask);
    }
    return { texts: out, meta: mergedMeta, instpack: mergedInst, agentId, threadId, runId: (run as { id?: string })?.id };
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
