// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck  // ★型チェック停止（リファクタ作業中）
/**
import { createHash } from "crypto";
import { ToolUtility, type MessageContentUnion } from "@azure/ai-agents";
import type { AgentsClient as AzureAgentsClient } from "@azure/ai-agents";
import { getOrCreateThreadId } from "@/services/threadState";
import { emitInstpackTool, EMIT_INSTPACK_FN } from "@/services/tools/emitInstpack.tool";
import { emitMetaTool, EMIT_META_FN } from "@/services/tools/emitMeta.tool";
import type { Meta, ConnectBingResult, SourceType, MetaComputeResult, EmitMetaPayload } from "@/types/gpts";
import { agentsClient as client, getOrCreateAgentIdWithTools, preflightAuth } from "@/utils/agents";
import { getInstructions, type ReplyInsOrigin } from "@/utils/agentPrompts";
import { withTimeout } from "@/utils/async";
import { LINE, DEBUG, AZURE, MAIN_TIMERS } from "@/utils/env";
import { stripInternalBlocksFromContent } from "@/utils/fence";
import { toScopedOwnerIdFromPlainId } from "@/utils/lineSource";
import { toLineTextsFromMessage } from "@/utils/lineMessage";
import { computeMeta, logEmitMetaSnapshot, looksLikeFollowup, type MetaLogPhase } from "@/utils/meta";
import { withLock } from "@/utils/redis";
import { toToolCalls, type ToolCall, isFunctionToolCall } from "@/utils/types";

//// Bingのレスポンスを見たいときは.envにDEBUG_BING="1"を設定する
const debugBing = DEBUG.AI;

//// run状態
type RunState = {
  status?: "queued" | "in_progress" | "requires_action" | "completed" | "failed" | "cancelled" | "expired";
  requiredAction?: SubmitToolOutputsAction;
};
type SubmitToolOutputsAction = {
  type: "submit_tool_outputs"; 
  submitToolOutputs?: { toolCalls?: ToolCall[] };
};

// Grounding with Bing Searchツールの定義
const bingTool = ToolUtility.createBingGroundingTool([
  { 
    connectionId: AZURE.BING_CONNECTION_ID,
    market: "ja-JP",
    setLang: "ja",
    count: 5,
    freshness: "week",
   }
]);

// このrunのassistantメッセージだけ拾う用途
type AssistantMsg = {
  role: "assistant";
  runId?: string;
  content: MessageContentUnion[];
};

// getAssistantMessageForRun: 指定したrunIdのassistantメッセージを優先取得
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

// ログ用
const sha12 = (s: string) => createHash("sha256").update(s).digest("base64url").slice(0, 12);
const preview = (s: string, n = 1200) => (s.length > n ? `${s.slice(0, n)}…` : s);
function logInstpack(
  tag: MetaLogPhase,
  ctx: { threadId: string; runId?: string },
  s?: string
) {
  if (!debugBing || !s) return;
  console.info(
    `[instpack:${tag}] tid=${ctx.threadId} run=${ctx.runId ?? "-"} len=${s.length} sha=${sha12(s)}\n${preview(s)}`
  );
}

// emit_metaのパース
function parseEmitMeta(raw: unknown): EmitMetaPayload | undefined {
  try {
    if (typeof raw === "string") return JSON.parse(raw) as EmitMetaPayload;
    if (raw && typeof raw === "object") return raw as EmitMetaPayload;
  } catch {  }
  return undefined;
}

// emit_metaの引数(JSON/obj)の取り出し用関数
function applyAndLogEmitMeta(
  payload: EmitMetaPayload | undefined,
  phase: MetaLogPhase,
  ctx: { threadId: string; runId?: string },
  sinks: { setMeta: (m?: Meta) => void; setInstpack: (s?: string) => void }
) {
  if (!payload) return;
  if (payload.meta) sinks.setMeta(payload.meta);
  if (typeof payload.instpack === "string") sinks.setInstpack(payload.instpack);

  logEmitMetaSnapshot(phase, ctx, { meta: payload.meta, instpack: payload.instpack });
  logInstpack(phase, { threadId: ctx.threadId, runId: ctx.runId }, payload.instpack);
}

// 入力ID（plain or scoped）を正規化
function normalizeOwnerIds(inputId: string, type: SourceType): { scopedOwnerId: string; plainId: string } {
  const m = /^(user|group|room):(.+)$/.exec(inputId);
  if (m) {
    return { scopedOwnerId: inputId, plainId: m[2] };
  }
  return { scopedOwnerId: toScopedOwnerIdFromPlainId(type, inputId), plainId: inputId };
}

// 末尾にフォローアップを重複なく1行追加するヘルパー
function appendFollowupIfNeeded(texts: string[], ask: string | undefined, meta: Meta): string[] {
  if (typeof ask !== "string") return texts;
  const t: string = ask.trim();
  if (t.length === 0) return texts;

  const last: string = texts[texts.length - 1] ?? "";
  const eqLite = (a: string, b: string): boolean =>
    a.replace(/\s+/g, "").trim() === b.replace(/\s+/g, "").trim();

  const already: boolean = eqLite(last, t) || looksLikeFollowup(last, meta);
  return already ? texts : [...texts, t];
}

// * connectBing: メイン関数
// *  1. Agent/Threadの確保
// *  2. 質問を投入しrun実行
// *  3. requires_actionでツール出力をsubmit（emit_metaのpayloadを回収） = userのみ
// *  4. 応答本文から内部ブロック除去、必要ならrepair runで meta/instpack回収 = userのみ
// *  5. LINE用に本文整形して返却
export async function connectBing(
  userId: string, 
  question: string,
  opts?: {
    // 修復runの回収結果を保存するためのコールバック
    onRepair?: (p: { userId: string; threadId: string; meta?: Meta; instpack?: string; }) => Promise<void>;
    maxMetaRetry?: number;          // metaの再試行回数
    sourceType?: SourceType;        // 発話元の種別（デフォルト "user"）
    imageUrls?: readonly string[];  // 画像URL（署名付きなど外部から取得可能なURL）
  }
): Promise<ConnectBingResult> {
  const q = question.trim();
  const hasImage: boolean = Array.isArray(opts?.imageUrls) && (opts?.imageUrls?.length ?? 0) > 0;

  if (q) {
    console.log("[question] " + q);
  } else if (hasImage) {
    console.log("[question] (image-only)");
  } else {
    return { texts: ["⚠️メッセージが空です。"], agentId: "", threadId: "" };
  }

  // 認証・認証チェック
  await preflightAuth();

  // ソース種別と scopedOwnerId を決定
  const sourceType: SourceType = opts?.sourceType ?? "user";
  const { scopedOwnerId, plainId } = normalizeOwnerIds(userId, sourceType);
  if (debugBing) console.info(`[scope] type=${sourceType} plain=${plainId} scoped=${scopedOwnerId}`);

  const ins = await getInstructions({ type: sourceType, targetId: plainId});
  if (debugBing) {
    const origin: ReplyInsOrigin = ins.origin;
    const sha = sha12(ins.reply);
    console.info(
      `[reply:ins] origin=${origin} scope=${sourceType} owner=${scopedOwnerId} len=${ins.reply.length} sha=${sha}`
    );
    console.info(preview(ins.reply, 1600));
  }
  
  // scopedOwnerId を使う（現状は plain のまま）
  return await withLock(`owner:${scopedOwnerId}`, 90_000, async () => {
    // Thread の確保（Azure Thread は1つ／スコープ、Redisキーもスコープで管理）
    const threadId = await getOrCreateThreadId(scopedOwnerId);

    // ユーザーの質問をスレッドへ投入
    if (q) {
      await client.messages.create(threadId, "user", q);
    }
    if (hasImage) {
      const imageBlocks = opts!.imageUrls!.map((u) => ({
        type: "image_url" as const,
        imageUrl: { url: u, detail: "high" as const },
      })) satisfies readonly MessageContentUnion[];;
      await client.messages.create(threadId, "user", imageBlocks);
    }

    // run1. 返信用
    const replyTools = [bingTool];
    const replyAgentId = await getOrCreateAgentIdWithTools(ins.reply, replyTools);
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
    let texts = toLineTextsFromMessage(replyContent, { maxUrls: LINE.MAX_URLS_PER_BLOCK, showTitles: false });
    const replyTextJoined = texts.join("\n\n");

    // meta,instpack生成はuserのときだけ実行。group/room はスキップ
    const isUserSource = (sourceType === "user");

    // run2. meta（テキスト禁止・emit_meta 一発）用 = userのみ
    let mergedMeta: Meta | undefined = undefined;
    if (isUserSource) {
      const metaTools = [emitMetaTool];
      const metaAgentId = await getOrCreateAgentIdWithTools(ins.meta, metaTools);
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
        return captured;
      };

      mergedMeta = await getMetaOnce();
      for (let i = 1; !mergedMeta && i <= (opts?.maxMetaRetry ?? 2); i++) {
        mergedMeta = await getMetaOnce();
      }
      if (mergedMeta && hasImage) {
        const prevSlots: Meta["slots"] = mergedMeta.slots ?? {};
        const newSlots: Meta["slots"] = { ...prevSlots, has_image: true };
        mergedMeta = { ...mergedMeta, modality: "image", slots: newSlots };
      }
    }

    let metaEval: MetaComputeResult | undefined = undefined;
    if (isUserSource && mergedMeta) {
      metaEval = computeMeta(mergedMeta, replyTextJoined);
      mergedMeta = metaEval.metaNorm;
    }
    
    // meta 不足（complete_norm=false）のときだけ、確認用フォローアップを1行だけ追記する
    if (isUserSource && metaEval && metaEval.complete_norm === false) {
      const ask: string | undefined = metaEval.metaNorm.followups?.[0]?.text;
      texts = appendFollowupIfNeeded(texts, ask, metaEval.metaNorm);
    }
    if (!texts.length) texts = ["（結果が見つかりませんでした）"];

    // run3. instpack（保存条件を満たす場合のみ）用 = userのみ
    let mergedInst: string | undefined = undefined;
    if (isUserSource && (metaEval?.saveable === true)) {
      const instTools = [emitInstpackTool];
      const instAgentId = await getOrCreateAgentIdWithTools(ins.instpack, instTools);
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
        // 保存系でスコープキーを使う想定なら scopedOwnerId を渡す
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

// dumpRunAndMessages: Bing Searchの生jsonを見るためのデバグ用途
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function dumpRunAndMessages(
  client: AzureAgentsClient,
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

**/