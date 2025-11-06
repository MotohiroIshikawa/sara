import { ToolUtility, type MessageContentUnion } from "@azure/ai-agents";
import type { AiContext, AiReplyOptions, AiReplyResult } from "@/types/gpts";
import { agentsClient, getOrCreateAgentIdWithTools, preflightAuth } from "@/utils/agents";
import { getInstruction } from "@/utils/agentPrompts";
import { withTimeout } from "@/utils/async";
import { LINE, DEBUG, AZURE, MAIN_TIMERS } from "@/utils/env";
import { stripInternalBlocksFromContent } from "@/utils/fence";
import { toLineTextsFromMessage } from "@/utils/lineMessage";
import { withLock } from "@/utils/redis";

type RunState = {
  status?: "queued" | "in_progress" | "requires_action" | "completed" | "failed" | "cancelled" | "expired";
};

const debugAi: boolean =
  (DEBUG.AI || process.env["DEBUG.AI"] === "true" || process.env.DEBUG_AI === "true") === true;

// Grounding/Search ツールを生成（Bing 設定があれば利用）
function createSearchTool(): readonly unknown[] {
  if (!AZURE.BING_CONNECTION_ID) return [];
  const bingTool = ToolUtility.createBingGroundingTool([
    {
      connectionId: AZURE.BING_CONNECTION_ID,
      market: "ja-JP",
      setLang: "ja",
      count: 5,
      freshness: "week",
    },
  ]);
  return [bingTool];
}

// 既定値を埋めた reply オプション
function normalizeOptions(opts?: AiReplyOptions): Required<AiReplyOptions> {
  return {
    question: opts?.question ?? "",
    imageUrls: opts?.imageUrls ?? [],
    temperature: typeof opts?.temperature === "number" ? opts.temperature : 0.2,
    topP: typeof opts?.topP === "number" ? opts.topP : 1,
  };
}

// assistant メッセージを runId 優先で取得（なければ最新の assistant を返す）
async function getAssistantMessageForRun(
  threadId: string,
  runId: string
): Promise<{ runId?: string; content: MessageContentUnion[] } | undefined> {
  let fallback: { runId?: string; content: MessageContentUnion[] } | undefined = undefined;
  // メッセージを新しい順で走査
  for await (const m of agentsClient.messages.list(threadId, { order: "desc" })) {
    // roleがassistantのみ抽出
    if (m.role !== "assistant") continue;
    // SDKの型は広めなので、最小限の情報に正規化して扱う
    const normalized = {
      runId: m.runId ?? undefined, 
      content: m.content as MessageContentUnion[]     // content は配列（テキスト/画像/リンク等の混在）
    };
    // 最初に見つかった最新assistantをフォールバックとして保持
    if (!fallback) fallback = normalized;
    // 対象runのメッセージを優先。見つかり次第、処理を打ち切って返す
    if (m.runId && m.runId === runId) return normalized;
  }
  return fallback;
}

// 返信取得
export async function getReply(
  ctx: AiContext,
  opts?: AiReplyOptions
): Promise<AiReplyResult> {
  const options = normalizeOptions(opts);
  const hasImage: boolean = options.imageUrls.length > 0;
  const hasQuestion: boolean = options.question.trim().length > 0;

  if (!hasQuestion && !hasImage) {
    return { texts: ["⚠️メッセージが空です。"], agentId: "", threadId: ctx.threadId, runId: "" };
  }

  if (!ctx.threadId || ctx.threadId.trim().length === 0) {
    return { texts: ["⚠️threadId が未設定です。"], agentId: "", threadId: "", runId: "" };
  }

  // 認証チェック
  await preflightAuth();

  // 指示文（reply 用）を取得
  const { instruction, origin } = await getInstruction(ctx.sourceType, ctx.ownerId, "reply");

  if (debugAi) {
    console.info("[ai.reply] origin=%s src=%s owner=%s", origin, ctx.sourceType, ctx.ownerId);
  }

  // ロックキーは type + ownerId を採用
  const lockKey = `owner:${ctx.sourceType}:${ctx.ownerId}`;

  return await withLock(lockKey, 90_000, async () => {
    const threadId: string = ctx.threadId;

    // 入力（テキスト/画像）を投入
    if (hasQuestion) {
      await agentsClient.messages.create(threadId, "user", options.question.trim());
    }
    if (hasImage) {
      const imageBlocks = options.imageUrls.map((u) => ({
        type: "image_url" as const,
        imageUrl: { url: u, detail: "high" as const },
      })) satisfies readonly MessageContentUnion[];
      await agentsClient.messages.create(threadId, "user", imageBlocks);
    }

    // reply 実行
    const tools: readonly unknown[] = createSearchTool();
    const replyAgentId = await getOrCreateAgentIdWithTools(instruction, tools, "reply");

    const run = await withTimeout(
      agentsClient.runs.create(threadId, replyAgentId, {
        temperature: options.temperature,
        topP: options.topP,
        parallelToolCalls: true,
      }),
      MAIN_TIMERS.CREATE_TIMEOUT,
      "reply:create"
    );

    // 完了待ち（ポーリング）
    {
      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
      const safeSleep = Math.max(1, MAIN_TIMERS.POLL_SLEEP);
      const pollMaxTicks = Math.max(1, Math.ceil(MAIN_TIMERS.POLL_TIMEOUT / safeSleep)) + 10;
      const startedAt = Date.now();
      let ticks = 0;

      while (true) {
        if (Date.now() - startedAt > MAIN_TIMERS.POLL_TIMEOUT || ++ticks > pollMaxTicks) break;
        const st = (await withTimeout(
          agentsClient.runs.get(threadId, run.id),
          MAIN_TIMERS.GET_TIMEOUT,
          "reply:get"
        )) as RunState;
        if (["completed", "failed", "cancelled", "expired"].includes(st.status ?? "")) break;
        await sleep(safeSleep);
      }
    }

    // 応答メッセージ取得
    const replyMsg = await getAssistantMessageForRun(threadId, run.id);
    if (!replyMsg) {
      return {
        texts: ["⚠️エラーが発生しました（返信メッセージが見つかりません）"],
        agentId: replyAgentId,
        threadId,
        runId: run.id,
      };
    }

    // 内部ブロック除去 → LINE用配列へ
    const { cleaned } = stripInternalBlocksFromContent(replyMsg.content);
    let texts = toLineTextsFromMessage(cleaned, { maxUrls: LINE.MAX_URLS_PER_BLOCK, showTitles: false });
    if (!texts.length) texts = ["（結果が見つかりませんでした）"];

    if (debugAi) {
      console.info(
        "[ai.reply] done: runId=%s agentId=%s threadId=%s texts=%d",
        run.id,
        replyAgentId,
        threadId,
        texts.length
      );
    }

    const result: AiReplyResult = {
      texts,
      agentId: replyAgentId,
      threadId,
      runId: run.id,
    };
    return result;
  });
}
