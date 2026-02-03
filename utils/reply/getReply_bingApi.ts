import { type MessageInputContentBlockUnion } from "@azure/ai-agents";
import type { AiContext, AiReplyOptions, AiReplyResult, MissingReason } from "@/types/gpts";
import { agentsClient, getOrCreateAgentIdWithTools, preflightAuth } from "@/utils/agents";
import { getInstruction } from "@/utils/prompts/getInstruction";
import { withTimeout } from "@/utils/async";
import { LINE, DEBUG, MAIN_TIMERS } from "@/utils/env";
import { stripInternalBlocksFromContent } from "@/utils/reply/fence";
import { toLineTextsFromMessage } from "@/utils/line/lineMessage";
import { withLock } from "@/utils/redis";
import { buildSearchQuery } from "@/utils/search/buildSearchQuery";
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

function logRawBlock(label: string, text: string): void {
  console.info("%s len=%d", label, text.length);
  console.info("%s\n%s", label, text);
}

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

  // reply 用 instruction
  const { instruction, origin } = await getInstruction(ctx.sourceType, ctx.ownerId, "reply", "api");
  if (debugAi) {
    console.info("[ai.reply/api] origin=%s src=%s owner=%s", origin, ctx.sourceType, ctx.ownerId);
    logRawBlock("[ai.reply/api] instruction(raw)", instruction);
  }

  const lockKey: string = createOwnerLockKey(ctx.sourceType, ctx.ownerId);

  return await withLock(lockKey, 90_000, async () => {
    const threadId: string = ctx.threadId;

    // decision（検索要否判定）は専用 thread で実行する
    let searchContext: string = "";

    if (hasQuestion) {
      let decisionThreadId: string | null = null;
      try {
        const { instruction: decisionIns } =
          await getInstruction(ctx.sourceType, ctx.ownerId, "decision");

        // decision 用 thread を新規作成
        const decisionThread = await agentsClient.threads.create();
        decisionThreadId = decisionThread.id;

        // decision に渡す入力は Node.js 側で再構築した 1 本の文字列
        const decisionInput: string | null = await buildSearchQuery({
          rewrittenQuery: null,
          question: options.question,
          threadId: ctx.threadId, // メイン thread から user 発言を拾う
        });

        const finalDecisionInput: string =
          decisionInput && decisionInput.length > 0
            ? decisionInput
            : options.question.trim();

        if (debugAi) {
          logRawBlock("[decision.input]", finalDecisionInput);
          logRawBlock("[decision.instruction]", decisionIns);
        }

        // decision thread に user メッセージを 1 回だけ投入
        await agentsClient.messages.create(
          decisionThreadId,
          "user",
          finalDecisionInput
        );

        // ctx を直接使わず、decision 用 threadId で判定
        const decisionCtx: AiContext = {
          ...ctx,
          threadId: decisionThreadId,
        };

        const decision: SearchDecision =
          await runSearchDecision(decisionIns, decisionCtx, finalDecisionInput);

        if (debugAi) {
          console.info("[ai.reply/api] decision", {
            sourceType: ctx.sourceType,
            ownerId: ctx.ownerId,
            needSearch: decision.needSearch,
            rewrittenQuery: decision.rewrittenQuery ?? null,
            reason: decision.reason ?? null,
          });
        }

        // 検索が必要なら Web 検索
        if (decision.needSearch) {
          const q: string | null =
            decision.rewrittenQuery && decision.rewrittenQuery.trim().length > 0
              ? decision.rewrittenQuery.trim()
              : finalDecisionInput;

          if (q && q.length > 0) {
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
              if (searchContext) {
                logRawBlock("[ai.reply/api] searchContext(raw)", searchContext);
              }
            }
          }
        }
      } catch (e) {
        if (debugAi) {
          console.warn("[ai.reply/api] decision/search failed:", e);
        }
      } finally {
        // decision thread は必ず破棄
        if (decisionThreadId) {
          try {
            await agentsClient.threads.delete(decisionThreadId);
          } catch {
            // no-op
          }
        }
      }
    }

    // reply 本体
    if (missingReasons.length > 0) {
      const payload: string = `${MISSING_REASONS_PREFIX} ${JSON.stringify(missingReasons)}`;
      if (debugAi) {
        logRawBlock("[ai.reply/api] injectedUserMessage(missingReasons)", payload);
      }
      await agentsClient.messages.create(threadId, "user", payload);
    }

    if (searchContext) {
      if (debugAi) {
        logRawBlock("[ai.reply/api] injectedUserMessage(searchContext)", searchContext);
      }
      await agentsClient.messages.create(threadId, "user", searchContext);
    }

    if (hasQuestion) {
      const qText: string = options.question.trim();
      if (debugAi) {
        logRawBlock("[ai.reply/api] injectedUserMessage(question)", qText);
      }
      await agentsClient.messages.create(threadId, "user", qText);
    }

    if (hasImage) {
      const imageBlocks: MessageInputContentBlockUnion[] =
        options.imageUrls.map((u) => ({
          type: "image_url",
          imageUrl: { url: u, detail: "high" },
        }));

      if (debugAi) {
        logRawBlock(
          "[ai.reply/api] injectedUserMessage(imageUrls)",
          JSON.stringify(options.imageUrls)
        );
        logRawBlock(
          "[ai.reply/api] injectedUserMessage(imageBlocks)",
          JSON.stringify(imageBlocks)
        );
      }

      await agentsClient.messages.create(threadId, "user", imageBlocks);
    }

    const replyAgentId: string =
      await getOrCreateAgentIdWithTools(instruction, [], "reply");

    const run = await withTimeout(
      agentsClient.runs.create(threadId, replyAgentId, {
        parallelToolCalls: false,
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
      console.info("[ai.reply/api] run prompt snapshot", {
        runId: run.id,
        origin,
        instructionLen: instruction.length,
        hasQuestion,
        hasImage,
        missingReasons: missingReasons.length > 0 ? missingReasons : null,
        hasSearchContext: searchContext.length > 0,
      });
    }

    await waitForRunCompletion(threadId, run.id, "reply");

    const replyMsg = await getAssistantMessageForRun(threadId, run.id);
    if (!replyMsg) {
      return {
        texts: ["⚠️エラーが発生しました（返信メッセージが見つかりません）"],
        agentId: replyAgentId,
        threadId,
        runId: run.id,
      };
    }

    const { cleaned } = stripInternalBlocksFromContent(replyMsg.content);
    let texts: string[] = toLineTextsFromMessage(cleaned, {
      maxUrls: LINE.MAX_URLS_PER_BLOCK,
      showTitles: false,
    });
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

    return {
      texts,
      agentId: replyAgentId,
      threadId,
      runId: run.id,
    };
  });
}
