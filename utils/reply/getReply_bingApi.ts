import { type MessageInputContentBlockUnion } from "@azure/ai-agents";
import type { AiContext, AiReplyOptions, AiReplyResult, MissingReason } from "@/types/gpts";
import { agentsClient, getOrCreateAgentIdWithTools, preflightAuth } from "@/utils/agents";
import { getInstruction } from "@/utils/prompts/getInstruction";
import { withTimeout } from "@/utils/async";
import { LINE, DEBUG, MAIN_TIMERS } from "@/utils/env";
import { stripInternalBlocksFromContent } from "@/utils/reply/fence";
import { toLineTextsFromMessage } from "@/utils/line/lineMessage";
import { withLock } from "@/utils/redis";
import { bingWebSearch, type BingWebPage } from "@/utils/search/providers/bing";
import { formatSearchContext, type SearchItem } from "@/utils/search/format";
import { runSearchDecision, type SearchDecision } from "@/utils/search/decision";
import {
  normalizeReplyOptions,
  type NormalizedReplyOptions,
  createOwnerLockKey,
  getAssistantMessageForRun,
  waitForRunCompletion,
  validateReplyInputs,
} from "@/utils/reply/getReply_common";

const debugAi: boolean =
  (DEBUG.AI || process.env["DEBUG.AI"] === "true" || process.env.DEBUG_AI === "true") === true;

const MISSING_REASONS_PREFIX = "[missingReasons]";

// 返信(REST Bing検索)
export async function getReply_bingApi(
  ctx: AiContext,
  opts?: AiReplyOptions
): Promise<AiReplyResult> {
  const missingReasons: readonly MissingReason[] = opts?.missingReasons ?? [];

  const options: NormalizedReplyOptions = normalizeReplyOptions(opts);

  const validationError: AiReplyResult | null = validateReplyInputs(ctx, options);
  if (validationError) return validationError;

  const hasImage: boolean = options.imageUrls.length > 0;
  const hasQuestion: boolean = options.question.trim().length > 0;
  if (debugAi) {
    console.info("[ai.reply/api] start", {
      sourceType: ctx.sourceType,
      ownerId: ctx.ownerId,
      threadId: ctx.threadId,
      hasQuestion,
      hasImage,
      missingReasons: missingReasons.length > 0 ? missingReasons : null,
    });
  }

  // 認証チェック
  await preflightAuth();

  // 指示文（reply用）を取得 -> api
  const { instruction, origin } = await getInstruction(ctx.sourceType, ctx.ownerId, "reply", "api");
  if (debugAi) {
    console.info("[ai.reply/api] origin=%s src=%s owner=%s", origin, ctx.sourceType, ctx.ownerId);
  }

  // ロックキーは type + ownerId を採用
  const lockKey: string = createOwnerLockKey(ctx.sourceType, ctx.ownerId);

  return await withLock(lockKey, 90_000, async () => {
    const threadId: string = ctx.threadId;

    // 事前判定（decision.md）→ 必要時のみ Web 検索
    let searchContext: string = "";
    if (hasQuestion) {
      try {
        const { instruction: decisionIns } = await getInstruction(ctx.sourceType, ctx.ownerId, "decision");
        const decision: SearchDecision = await runSearchDecision(decisionIns, ctx, options.question);
        if (debugAi) {
          console.info("[ai.reply/api] decision", {
            sourceType: ctx.sourceType,
            ownerId: ctx.ownerId,
            needSearch: decision.needSearch,
            hasFollowup: !!decision.followup && decision.followup.trim().length > 0,
          });
        }

        // フォローアップのみで十分な場合：検索・返信runは行わず即返
        if (!decision.needSearch && decision.followup && decision.followup.trim().length > 0) {
          return { texts: [decision.followup.trim()], agentId: "", threadId, runId: "" };
        }

        // 検索が必要と判断された場合のみ Web 検索を実施
        if (decision.needSearch) {
          const q: string = (decision.rewrittenQuery ?? options.question).trim();
          if (q.length > 0) {
            const pages: readonly BingWebPage[] = await bingWebSearch(q);
            const items: SearchItem[] = pages.map((p) => ({
              title: p.name,
              url: p.url,
              snippet: p.snippet,
              crawledAt: p.dateLastCrawled ?? null,
            }));
            searchContext = formatSearchContext(items, 5, 240);

            if (debugAi) {
              console.info("[ai.reply/api] search done", {
                sourceType: ctx.sourceType,
                ownerId: ctx.ownerId,
                threadId,
                query: q,
                items: items.length,
              });
            }
          }
        }
      } catch (e) {
        if (debugAi) console.warn("[ai.reply/api] decision/search failed:", e);
      }
    }

    // missingReasons をモデルに渡す（prompt側の特別ルールを有効化する）
    // 注意：ここは user メッセージとして投入されるため履歴に残る。
    // prefix を固定しておくと、将来の除去/解析がしやすい。
    if (missingReasons.length > 0) {
      const payload: string = `${MISSING_REASONS_PREFIX} ${JSON.stringify(missingReasons)}`;
      await agentsClient.messages.create(threadId, "user", payload);
    }

    // 検索コンテキスト → ユーザー投入直前に掲示
    if (searchContext) {
      await agentsClient.messages.create(threadId, "user", searchContext);
    }

    // 入力（テキスト/画像）を投入
    if (hasQuestion) {
      await agentsClient.messages.create(threadId, "user", options.question.trim());
    }
    if (hasImage) {
      const imageBlocks: MessageInputContentBlockUnion[] = options.imageUrls.map((u) => ({
        type: "image_url",
        imageUrl: { url: u, detail: "high" },
      }));
      await agentsClient.messages.create(threadId, "user", imageBlocks);
    }

    const replyAgentId: string = await getOrCreateAgentIdWithTools(instruction, [], "reply");

    const run = await withTimeout(
      agentsClient.runs.create(threadId, replyAgentId, {
        parallelToolCalls: false, // ツール無し
      }),
      MAIN_TIMERS.CREATE_TIMEOUT,
      "reply:create"
    );

    if (debugAi) {
      console.info("[ai.reply/api] run created", {
        sourceType: ctx.sourceType,
        ownerId: ctx.ownerId,
        threadId,
        runId: run.id,
      });
    }

    // 完了待ち（ポーリング）
    await waitForRunCompletion(threadId, run.id, "reply");

    if (debugAi) {
      const runInfo: { status?: string; lastError?: unknown } =
        await agentsClient.runs.get(threadId, run.id);
      console.info("[ai.reply/api] run completed", {
        sourceType: ctx.sourceType,
        ownerId: ctx.ownerId,
        threadId,
        runId: run.id,
        status: runInfo.status ?? null,
        lastError: runInfo.lastError ?? null,
      });
    }

    // 応答メッセージ取得
    const replyMsg = await getAssistantMessageForRun(threadId, run.id);
    if (!replyMsg) {
      const runInfo: { status?: string; lastError?: unknown } =
        await agentsClient.runs.get(threadId, run.id);
      console.error("[ai.reply/api] reply message not found", {
        sourceType: ctx.sourceType,
        ownerId: ctx.ownerId,
        threadId,
        runId: run.id,
        status: runInfo.status,
        lastError: runInfo.lastError,
      });

      return {
        texts: ["⚠️エラーが発生しました（返信メッセージが見つかりません）"],
        agentId: replyAgentId,
        threadId,
        runId: run.id,
      };
    }

    // 内部ブロック除去 → LINE用配列へ
    const { cleaned } = stripInternalBlocksFromContent(replyMsg.content);
    let texts: string[] = toLineTextsFromMessage(cleaned, { maxUrls: LINE.MAX_URLS_PER_BLOCK, showTitles: false });
    if (!texts.length) texts = ["（結果が見つかりませんでした）"];

    if (debugAi) {
      console.info(
        "[ai.reply/api] done: runId=%s agentId=%s threadId=%s texts=%d",
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
