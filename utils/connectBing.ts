import {
  AgentsClient,
  ToolUtility,
  isOutputOfType,
  type MessageContentUnion,
  type MessageTextContent,
  type MessageTextUrlCitationAnnotation,
} from "@azure/ai-agents";
import { DefaultAzureCredential } from "@azure/identity";
import { createHash } from "crypto";
import { normalizeMarkdownForLine } from "@/utils/normalizeMarkdownForLine";
import {
  buildReplyInstructions,
  buildMetaInstructions,
  buildInstpackInstructions,
} from "@/utils/agentPrompts";
import { emitMetaTool, EMIT_META_FN } from "@/services/tools/emitMeta.tool";
import { emitInstpackTool, EMIT_INSTPACK_FN } from "@/services/tools/emitInstpack.tool";
import { redis, withLock } from "@/utils/redis";
import { envInt, LINE, NEWS, DEBUG, AZURE, THREAD, MAIN_TIMERS } from "@/utils/env";
import {
  toDefinition,
  toToolCalls,
  type ToolLike,
  type FunctionToolCall,
  type ToolCall,
} from "@/utils/types";

// thenableを安全にPromiseに包むヘルパ
function asPromise<T>(p: PromiseLike<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => p.then(resolve, reject));
}

// ネットワーク強制タイムアウトのヘルパー
async function withTimeout<T>(
  work: PromiseLike<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  return await Promise.race<T>([
    asPromise(work),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout:${label}`)), timeoutMs)
    ),
  ]);
}

// 環境変数
//// Bing接続用
const endpoint = AZURE.AI_PRJ_ENDPOINT;
const bingConnectionId = AZURE.BING_CONNECTION_ID;
const modelDeployment = AZURE.AI_MODEL_DEPLOYMENT;
const agentNamePrefix = AZURE.AGENT_NAME_PREFIX;
//// Redis に保存するスレッドの有効期限（時間）
const threadTTL = THREAD.TTL_HOURS;
//// LINE送信の文字数やURL付与などの制約
const lineTextLimit = LINE.TEXT_LIMIT;
const maxUrlsPerBlock = LINE.MAX_URLS_PER_BLOCK;
const minSectionLength = LINE.MIN_SECTION_LENGTH;
//// ニュース期間の既定（日）
const metaDays = NEWS.DEFAULT_DAYS;
//// Bingのレスポンスを見たいときは.envにDEBUG_BING="1"を設定する
const debugBing = DEBUG.BING;

// 型宣言
//// 段落分割結果（原文中の位置範囲つき）
type Section = {
  context: string;     // マーカー除去後の本文
  startIndex: number;  // 元テキスト内の開始位置
  endIndex: number;    // 元テキスト内の終了位置（end-exclusive）
};
//// emit_meta用 返す内容・スロット構造
type Intent = "event" | "news" | "buy" | "generic";
type Slots = { topic?: string; place?: string | null; date_range?: string; official_only?: boolean };
type Meta = { intent?: Intent; slots?: Slots; complete?: boolean; followups?: string[] };
//// meta/instpack 抽出用
const fenceRe = (name: string) => new RegExp("```" + name + "\\s*\\r?\\n([\\s\\S]*?)\\r?\\n?```", "g");
// mainの戻り値
export type ConnectBingResult = {
  texts: string[];         // ユーザーへ返す本文（instpack/meta を除去済み）
  meta?: Meta;             // 末尾の meta JSON
  instpack?: string;       // 末尾の instpack（コンパイル済み指示）
  agentId: string;
  threadId: string;
  runId?: string;
};

//// run状態の簡易型（SDKの抜粋）
type RunState = {
  status?: "queued" | "in_progress" | "requires_action" | "completed" | "failed" | "cancelled" | "expired";
  requiredAction?: SubmitToolOutputsAction;
};
type SubmitToolOutputsAction = {
  type: "submit_tool_outputs"; 
  submitToolOutputs?: { toolCalls?: ToolCall[] };
};
//// ツール引数の受け用
type EmitMetaPayload = { meta?: Meta; instpack?: string };

// 認証
const credential = new DefaultAzureCredential();

// 認証の正常性確認：tokenを取得する
async function preflightAuth(): Promise<void> {
  const scope = "https://ml.azure.com/.default";
  const token = await credential.getToken(scope);
  if (!token) throw new Error(`Failed to acquire token for scope: ${scope}`);
  const sec = Math.round((token.expiresOnTimestamp - Date.now()) / 1000);
  console.log(`[Auth OK] got token for ${scope}, expires in ~${sec}s`);
}

// Azure AI Agentsクライアント作成
const client = new AgentsClient(endpoint, credential);

// Grounding with Bing Searchツールの定義
const bingTool = ToolUtility.createBingGroundingTool([
  { 
    connectionId: bingConnectionId,
    market: "ja-JP",
    setLang: "ja",
    count: 5,
    freshness: "week",
   }
]);

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

/**
 * getOrCreateAgentIdWithTools: 指示文＋ツール構成でAgentをキャッシュ・作成
 * 
 * @param instructions 
 * @param tools 
 * @returns 
 */
async function getOrCreateAgentIdWithTools(
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

  const agent = await client.createAgent(modelDeployment, {
    name: `${agentNamePrefix}-${Date.now()}`,
    instructions,
    tools: tools.map(toDefinition),
  });
  await redis.set(key, agent.id);
  return agent.id;
}

/**
 * threadKey: ThreadのKey作成用
 * 
 * @param userId 
 * @returns 
 */
function threadKey(userId: string) {
  // ENDPOINT毎
  const ns = Buffer.from(endpoint).toString("base64url");
  return `thread:${ns}:${userId}`;
}

/**
 * getOrCreateThreadId: ユーザー単位の会話スレッドの永続化/TTL延長/削除
 * 
 * @param userId 
 * @param ttlHours 
 * @returns 
 */
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
  await redis.setex(k, ttlHours * 3600, th.id);
  return th.id;
}

/**
 * resetThread: Threadの削除用
 * 
 * @param userId 
 */
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

// 整形用定数
//// 注釈マーカー削除：返却されたテキストに【\d+:\d+†source】（注釈マーカー）があれば削除する用途
const stripMarkers = (s: string) => s.replace(/【\d+:\d+†source】/g, "");
//// 段落区切り：返却されたテキストを空行(改行2連続)で区切る用途
const delimiter = /\r?\n\r?\n/g;
const isAscii = (s: string) => /^[\x00-\x7F]+$/.test(s);
//// 英数字短文のフィラー判定：空行で区切ったときにminSectionLengthより短い文字列があったらゴミとする用途
const isFiller = (s: string) => {
  const t = s.trim();
  if (!t) return true; // 空はフィラー
  return isAscii(t) && t.length <= minSectionLength;
};

/**
 * splitByHrWithRanges: テキストを段落に分割して原文中の文字数の範囲も保持。Section型を利用
 * 
 * @param text 
 * @returns 
 */
function splitByHrWithRanges(text: string): Section[] {
  const out: Section[] = [];
  let last = 0;
  // 段落区切り
  for (const m of text.matchAll(delimiter)) {
    const idx = m.index ?? -1;
    if (idx < 0) continue;
    const chunk = text.slice(last, idx);
    const trimmed = chunk.trim();
    if (!trimmed || isFiller(trimmed)) {
      // フィラー段落はスキップ
      last = idx + m[0].length;
      continue;
    }
    out.push({ context: stripMarkers(trimmed), startIndex: last, endIndex: idx });
    last = idx + m[0].length;
  }
  // 末尾の処理
  const tail = text.slice(last);
  const tailTrimmed = tail.trim();
  if (tailTrimmed && !isFiller(tailTrimmed)) {
    out.push({ context: stripMarkers(tailTrimmed), startIndex: last, endIndex: text.length });
  }
  return out;
}

/**
 * chunkForLine: LINEの文字数制限に合わせて段落をさらに分割
 * 
 * @param text 
 * @param limit 
 * @returns 
 */
function chunkForLine(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    // 直近の改行（できれば段落区切り）を探す->改行が無ければ機械的に分割
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < 0) cut = rest.lastIndexOf("\n", limit);
    if (cut < 0) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * toLineTextsFromTextPart: 返却されたテキストをLINEにあったテキスト(配列)に分割する
 * @param part 
 * @param opts 
 * @returns 
 */
function toLineTextsFromTextPart(
  part: MessageTextContent,
  opts: { maxUrls?: number; showTitles?: boolean } = {}
): string[] {
  const { maxUrls = maxUrlsPerBlock, showTitles = false } = opts;
  const block = part.text.value;
  const sections = splitByHrWithRanges(block);

  // 段落ごとのURL重複回避セット/追記バッファ
  const seenPerSection: Array<Set<string>> = sections.map(() => new Set<string>());
  // 注釈をセクションの末尾へ追記するための行バッファ
  const urlLinesPerSection: string[][] = sections.map(() => []);

  // 注釈を位置順にソートして各段落に割当て
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
    let idx = sections.findIndex(sec => s >= sec.startIndex && s < sec.endIndex);
    if (idx === -1 && sections.length > 0) {
      // どの範囲にも入らない場合は最後のセクションに付与
      idx = sections.length - 1;
    }
    if (idx === -1) continue;

    // 重複URLはスキップ、最大数より多い場合はスキップ
    const seen = seenPerSection[idx];
    if (seen.has(url)) continue;
    if (urlLinesPerSection[idx].length >= maxUrls) continue;
    seen.add(url);

    urlLinesPerSection[idx].push(
      showTitles && title ? `${title}\n${url}` : `${url}`
    );
  }

  // 段落本文+URLを結合し、各段落をLINEのテキストサイズ以内に再分割
  const out: string[] = [];
  sections.forEach((sec, i) => {
    // マークダウン形式の整形
    const body = normalizeMarkdownForLine(sec.context.trim());
    const refs = urlLinesPerSection[i];
    // URLを末尾に追加
    const text = refs.length ? `${body}\n${refs.join("\n")}` : body;
    out.push(text);
  });
  const sized: string[] = [];
  for (const t of out) sized.push(...chunkForLine(t, lineTextLimit));
  return sized;
}

/**
 * toLineTextsFromMessage: メッセージ中のtext部分をすべてLINE向けに整形
 * @param contents 
 * @param opts 
 * @returns 
 */
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

/**
 * stripInternalBlocksFromContent: assistantメッセージからmeta/instpackを除去、meta/instpackの中身を抽出
 * @param contents 
 * @returns 
 */
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

    // instpackを抽出・除去
    const instRe = fenceRe("instpack");
    let mInst: RegExpExecArray | null;
    let lastInst: string | undefined;
    while ((mInst = instRe.exec(c.text.value))) lastInst = mInst[1];
    if (lastInst && lastInst.trim()) inst = lastInst.trim();
    instRe.lastIndex = 0;
    c.text.value = c.text.value.replace(instRe, "").trim();

    // metaを抽出・除去（最後のフェンス優先）
    const metaRe = fenceRe("meta");
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

/**
 * buildFollowup: スロット不足時の追質問テキスト生成->不足スロットを1つだけ尋ねる簡潔な質問を用意
 * @param meta 
 * @returns 
 */
function buildFollowup(meta?: Meta): string {
  const slots = meta?.slots ?? {};
  const intent = meta?.intent;

  if (intent === "generic") {
    if (!slots.topic) return "対象（作品名など）を教えてください。";
    return meta?.followups?.[0]
      ?? "どんな会話にする（入門ガイド / 考察相棒 / ニュース速報 / クイズ作成 / グッズ案内）？";
  }

  const missing: string[] = [];
  if (!slots.topic) missing.push("対象（作品名など）");
  if (intent === "news" && !slots.date_range) missing.push("期間");
  if (missing.length === 0 && slots.topic && !slots.place) missing.push("場所（任意）");

  const lead = missing.length ? `不足: ${missing.join(" / ")}。` : "";
  if (intent === "event") return `${lead}ひとつだけ教えてください。`;
  return meta?.followups?.[0] ?? `${lead}ひとつだけ教えてください。`;
}

// このrunのassistantメッセージだけ拾う用途
type AssistantMsg = {
  role: "assistant";
  runId?: string;
  content: MessageContentUnion[];
};

/**
 * getAssistantMessageForRun: 指定したrunIdのassistantメッセージを優先取得
 * 
 * @param threadId 
 * @param runId 
 * @returns 
 */
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
    
    if (!fallback) fallback = normalized; // 最新のassistantをフォールバック候補として保持
    if (m.runId && m.runId === runId) { // 同じrunのメッセージを最優先で返す
      return normalized;
    }
  }
  // 同じrunが見つからなければ最新のassistantを返す
  return fallback;
}

const followupMaxLen = envInt("FOLLOWUP_MAX_LEN", 80, { min: 20, max: 200 });

function trimLite(s: string) {
  return s.replace(/\s+/g, "").trim();
}

/**
 * looksLikeFollowup: 追質問の形状判定ヘルパー
 * @param line 
 * @param meta 
 * @returns 
 */
function looksLikeFollowup(line?: string, meta?: Meta): boolean {
  if (!line) return false;
  const s = line.trim();
  if (!s) return false;
  if (s.length > followupMaxLen) return false;
  const endsWithQ = /[?？]\s*$/.test(s);
  const hasLead = /^不足[:：]/.test(s);
  const equalsMeta = meta?.followups?.some(f => trimLite(f) === trimLite(s)) ?? false;
  return endsWithQ || hasLead || equalsMeta;
}

// instpack用バリデーション
function looksLikeInstpack(s?: string): boolean {
  if (!s) return false;
  const t = s.trim();
  if (t.length < 50) return false;            // 短すぎ
//  if (/[?？]$/.test(t)) return false;         // 質問文っぽい
//  const signals = [/^-\s*role:/m, /\bintent\s*:/i, /\bslots\s*:/i, /参照|出力|ポリシー|Bing/i];
//  return signals.filter(r => r.test(t)).length >= 2;
  return true;
}

/**
 * normalizeMeta: Metaの正規化（newsのdate_rangeを既定補正、completeフラグの正規化）
 * @param meta 
 * @returns 
 */
function normalizeMeta(meta?: Meta): Meta | undefined {
  if (!meta) return meta;
  const out: Meta = { ...meta, slots: { ...(meta.slots ?? {}) } };
  
  if (out.intent === "event") {
    const r = out.slots?.date_range?.trim().toLowerCase();
    out.complete = !!out.slots?.topic && out.slots!.topic.trim().length > 0;
    if (!r) out.slots!.date_range = "ongoing"; // 仕様: 未指定は ongoing
  }
  
  if (out.intent === "news") {
    const r = out.slots?.date_range?.trim().toLowerCase();
    if (!r || r === "ongoing" || r === "upcoming_30d") {
      out.slots!.date_range = `last_${metaDays}d`;
      // topic が特定できていれば news は complete
      out.complete = !!out.slots?.topic && out.slots.topic.trim().length > 0;
    }
  }
 
  if (out.intent === "buy") {
    // topic があれば complete 扱いにする
    out.complete = !!out.slots?.topic && out.slots.topic.trim().length > 0;
  }

  // generic&topicなし: 追質問。generic&topicあり: 追質問なし->保存しますか？ダイアログ
  const isNonEmpty = (v: unknown): v is string =>
    typeof v === "string" && v.trim().length > 0;
  if (out.intent === "generic"){
    out.complete = isNonEmpty(out.slots?.topic);
  }
  return out;
}

// isFunctionToolCall: ツールコールの判定ヘルパー
function isFunctionToolCall(tc: ToolCall): tc is FunctionToolCall {
  return tc.type === "function";
}

// instpackログ出力
type PhaseTag = "main" | "repair-async" | "repair" | "fence" | "instpack" | "meta";
const sha12 = (s: string) => createHash("sha256").update(s).digest("base64url").slice(0, 12);
const preview = (s: string, n = 1200) => (s.length > n ? `${s.slice(0, n)}…` : s);
function logInstpack(
  tag: PhaseTag,
  ctx: { threadId: string; runId?: string },
  s?: string
) {
  if (!debugBing || !s) return;
  console.info(
    `[instpack:${tag}] tid=${ctx.threadId} run=${ctx.runId ?? "-"} len=${s.length} sha=${sha12(s)}\n${preview(s)}`
  );
}

// emit_metaのログ出力
function logEmitMetaSnapshot(
  phase: PhaseTag, 
  ctx: {
    threadId: string;
    runId?: string;
  }, 
  payload: { meta?: Meta; instpack?: string }
) {
  const { meta, instpack } = payload;
  console.info("[emit_meta] captured", {
    phase,
    threadId: ctx.threadId,
    runId: ctx.runId,
    intent: meta?.intent,
    complete: meta?.complete,
    slots: {
      topic: meta?.slots?.topic,
      place: meta?.slots?.place,
      date_range: meta?.slots?.date_range,
      official_only: meta?.slots?.official_only,
    },
    followups_len: meta?.followups?.length ?? 0,
    instpack_len: typeof instpack === "string" ? instpack.length : 0,
  });
}

// emit_metaのパース
function parseEmitMeta(raw: unknown): EmitMetaPayload | undefined {
  try {
    if (typeof raw === "string") return JSON.parse(raw) as EmitMetaPayload;
    if (raw && typeof raw === "object") return raw as EmitMetaPayload;
  } catch { /* ignore parse errors */ }
  return undefined;
}

// emit_metaの引数(JSON/obj)の取り出し用関数
function applyAndLogEmitMeta(
  payload: EmitMetaPayload | undefined,
  phase: PhaseTag,
  ctx: { threadId: string; runId?: string },
  sinks: { setMeta: (m?: Meta) => void; setInstpack: (s?: string) => void }
) {
  if (!payload) return;
  if (payload.meta) sinks.setMeta(payload.meta);
  if (typeof payload.instpack === "string") sinks.setInstpack(payload.instpack);

  logEmitMetaSnapshot(phase, ctx, {
    meta: payload.meta,
    instpack: payload.instpack,
  });
  logInstpack(phase, ctx, payload.instpack);
}

function isTrackable(meta?: Meta): boolean {
  if (!meta) return false;
  if (meta.intent && meta.intent !== "generic") return true;
  const s = meta.slots ?? {};
  const hasTopic = !!(s.topic && s.topic.trim());
  const hasPlace = typeof s.place === "string" && s.place.trim().length > 0;
  const hasDate  = !!(s.date_range && String(s.date_range).trim().length > 0);
  return (hasTopic && hasPlace) || (hasTopic && hasDate);
}
// 「保存する」判定（instpack取得を実施するかどうか）
function shouldSave(meta?: Meta, replyText?: string): boolean {
  if (!meta) return false;
  const replyOk = (replyText?.length ?? 0) >= 80;
  return meta.complete === true && isTrackable(meta) && replyOk;
}

/**
 * connectBing: メイン関数
 *  1. Agent/Threadの確保
 *  2. 質問を投入しrun実行
 *  3. requires_actionでツール出力をsubmit（emit_metaのpayloadを回収）
 *  4. 応答本文から内部ブロック除去、必要ならrepair runで meta/instpack回収
 *  5. LINE用に本文整形して返却
 * 
 * @param userId 
 * @param question 
 * @param opts 
 * @returns 
 */
export async function connectBing(
  userId: string, 
  question: string,
  opts?: {
    instructionsOverride?: string;
    // 修復runの回収結果を保存するためのコールバック
    onRepair?: (p: { userId: string; threadId: string; meta?: Meta; instpack?: string; }) => Promise<void>;
    // metaの再試行回数
    maxMetaRetry?: number;
  }
): Promise<ConnectBingResult> {
  const q = question.trim();
  console.log("[question] " + q);
  if (!q) return { texts: ["⚠️メッセージが空です。"], agentId: "", threadId: "" };

  // 認証・認証チェック
  await preflightAuth();

  // 段階別instructionsを生成
  const replyInstructions = (opts?.instructionsOverride?.trim()?.length
    ? opts!.instructionsOverride!
    : buildReplyInstructions()
  ).trim();
  const metaInstructions = buildMetaInstructions().trim();
  const instInstructions = buildInstpackInstructions().trim();

  return await withLock(`user:${userId}`, 90_000, async () => {
    // Thread の確保
    const threadId = await getOrCreateThreadId(userId);

    // ユーザーの質問をスレッドへ投入
    await client.messages.create(threadId, "user", [{ type: "text", text: q }]);

    // run1. 返信用
    const replyTools = [bingTool];
    const replyAgentId = await getOrCreateAgentIdWithTools(replyInstructions, replyTools);
    const replyRun = await withTimeout(
      client.runs.create(threadId, replyAgentId, {
        temperature: 0.2,
        topP: 1,
        parallelToolCalls: true,
      }),
      MAIN_TIMERS.CREATE_TIMEOUT,
      "reply:create"
    );

    // 返信の完了待ち
    {
      const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
      const safeSleep = Math.max(1, MAIN_TIMERS.POLL_SLEEP);
      const pollMaxTicks = Math.max(1, Math.ceil(MAIN_TIMERS.POLL_TIMEOUT / safeSleep)) + 10;
      const startedAt = Date.now();
      let ticks = 0;
      while (true) {
        if (Date.now() - startedAt > MAIN_TIMERS.POLL_TIMEOUT || ++ticks > pollMaxTicks) break;
        const st = await withTimeout(
          client.runs.get(threadId, replyRun.id),
          MAIN_TIMERS.GET_TIMEOUT,
          "reply:get"
        ) as RunState;
        if (["completed","failed","cancelled","expired"].includes(st.status ?? "")) break;
        await sleep(safeSleep);
      }
    }

    // 返信メッセージを取得
    const replyMsg = await getAssistantMessageForRun(threadId, replyRun.id);
    if (!replyMsg) {
      return {
        texts: ["⚠️エラーが発生しました（返信メッセージが見つかりません）"],
        agentId: replyAgentId,
        threadId,
        runId: replyRun.id
      };
    }
    // 本文から内部ブロック除去
    const { cleaned: replyContent } = stripInternalBlocksFromContent(replyMsg.content);
    let texts = toLineTextsFromMessage(replyContent, { maxUrls: maxUrlsPerBlock, showTitles: false });
    const replyTextJoined = texts.join("\n\n");

    // run2. meta（テキスト禁止・emit_meta 一発）用
    const metaTools = [emitMetaTool];
    const metaAgentId = await getOrCreateAgentIdWithTools(metaInstructions, metaTools);
    const getMetaOnce = async (): Promise<Meta | undefined> => {
      const metaRun = await withTimeout(
        client.runs.create(threadId, metaAgentId, {
          temperature: 0.0,
          parallelToolCalls: false,
          toolChoice: { type: "function", function: { name: EMIT_META_FN } },
        }),
        MAIN_TIMERS.CREATE_TIMEOUT,
        "meta:create"
      );

      let captured: Meta | undefined;
      while (true) {
        const cur = await withTimeout(
          client.runs.get(threadId, metaRun.id),
          MAIN_TIMERS.GET_TIMEOUT,
          "meta:get"
        ) as RunState;

        if (cur.status === "requires_action" && cur.requiredAction?.type === "submit_tool_outputs") {
          const calls = toToolCalls(cur.requiredAction?.submitToolOutputs?.toolCalls);
          const outs = calls.map((c): { toolCallId: string; output: string } => {
            if (isFunctionToolCall(c) && c.function?.name === EMIT_META_FN) {
              const payload = parseEmitMeta(c.function?.arguments);
              if (payload?.meta) captured = payload.meta;
              // ログ
              applyAndLogEmitMeta(payload, "meta", { threadId, runId: metaRun.id }, {
                setMeta: () => {}, setInstpack: () => {}
              });
              return { toolCallId: c.id, output: "ok" };
            }
            return { toolCallId: c.id, output: "" };
          });
          await client.runs.submitToolOutputs(threadId, metaRun.id, outs);
        } else if (["completed","failed","cancelled","expired"].includes(cur.status ?? "")) {
          break;
        } else {
          await new Promise(r => setTimeout(r, MAIN_TIMERS.POLL_SLEEP));
        }
      }
      return normalizeMeta(captured);
    };

    let mergedMeta: Meta | undefined = await getMetaOnce();
    for (let i = 1; !mergedMeta && i <= (opts?.maxMetaRetry ?? 2); i++) {
      mergedMeta = await getMetaOnce();
    }

    // meta 不足なら最後に1行の確認を付与
    if (mergedMeta?.complete === false) {
      const ask = buildFollowup(mergedMeta);
      const last = texts[texts.length - 1] ?? "";
      const already =
        last.replace(/\s+/g,"").trim() === ask.replace(/\s+/g,"").trim() ||
        looksLikeFollowup(last, mergedMeta);
      if (!already) texts = [...texts, ask];
    }
    if (!texts.length) texts = ["（結果が見つかりませんでした）"];

    // run3. instpack（保存条件を満たす場合のみ）用
    let mergedInst: string | undefined = undefined;
    if (shouldSave(mergedMeta, replyTextJoined)) {
      const instTools = [emitInstpackTool];
      const instAgentId = await getOrCreateAgentIdWithTools(instInstructions, instTools);
      const instpackRun = await withTimeout(
        client.runs.create(threadId, instAgentId, {
          temperature: 0.0,
          parallelToolCalls: false,
          toolChoice: { type: "function", function: { name: EMIT_INSTPACK_FN } },
        }),
        MAIN_TIMERS.CREATE_TIMEOUT,
        "inst:create"
      );

      while (true) {
        const cur = await withTimeout(
          client.runs.get(threadId, instpackRun.id),
          MAIN_TIMERS.GET_TIMEOUT,
          "inst:get"
        ) as RunState;

        if (cur.status === "requires_action" && cur.requiredAction?.type === "submit_tool_outputs") {
          const calls = toToolCalls(cur.requiredAction?.submitToolOutputs?.toolCalls);
          const outs = calls.map((c): { toolCallId: string; output: string } => {
            if (isFunctionToolCall(c) && c.function?.name === EMIT_INSTPACK_FN) {
              const payload = parseEmitMeta(c.function?.arguments);
              if (typeof payload?.instpack === "string") mergedInst = payload.instpack;
              applyAndLogEmitMeta(payload, "instpack", { threadId, runId: instpackRun.id }, {
                setMeta: () => {}, setInstpack: () => {}
              });
              return { toolCallId: c.id, output: "ok" };
            }
            return { toolCallId: c.id, output: "" };
          });
          await client.runs.submitToolOutputs(threadId, instpackRun.id, outs);
        } else if (["completed","failed","cancelled","expired"].includes(cur.status ?? "")) {
          break;
        } else {
          await new Promise(r => setTimeout(r, MAIN_TIMERS.POLL_SLEEP));
        }
      }

      if (mergedInst && !looksLikeInstpack(mergedInst)) {
        logInstpack("fence", { threadId, runId: instpackRun.id }, mergedInst);
//        mergedInst = undefined;
      }

      // ログ＆保存
      logInstpack("instpack", { threadId, runId: instpackRun.id }, mergedInst);
      if (mergedMeta || mergedInst) {
        await opts?.onRepair?.({ userId, threadId, meta: mergedMeta, instpack: mergedInst });
      }
    }

    // デバグ用途コンソール出力
    if (debugBing) {
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

    return {
      texts,
      meta: mergedMeta,
      instpack: mergedInst,
      agentId: replyAgentId,  // 返信用runのagentId
      threadId,
      runId: replyRun.id
    };
  });
}

/**
 * dumpRunAndMessages: Bing Searchの生jsonを見るためのデバグ用途
 * 
 * @param client 
 * @param threadId 
 * @param run 
 * @param opts 
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function dumpRunAndMessages(
  client: AgentsClient,
  threadId: string,
  run: unknown,           // SDKの型に縛らずrawをそのまま出す
  opts: { maxMsgs?: number } = {}
) {
  const { maxMsgs = 10 } = opts;
  console.log("\n===== [DEBUG] run (raw) =====");
  console.dir(run as object, { depth: null, colors: true });
  const runId = (run as { id?: string })?.id;
  console.log("[DEBUG] runId =", runId);
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
  console.log("\n===== [DEBUG] messages (raw, newest first) =====");
  let cnt = 0;
  for await (const m of client.messages.list(threadId, { order: "desc" })) {
    console.dir(m, { depth: null, colors: true });
    cnt++;
    if (cnt >= maxMsgs) break;
  }
}
