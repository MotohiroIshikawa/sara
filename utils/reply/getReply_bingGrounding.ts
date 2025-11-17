import { ToolUtility, type MessageInputContentBlockUnion } from "@azure/ai-agents";
import type { AiContext, AiReplyOptions, AiReplyResult } from "@/types/gpts";
import { agentsClient, getOrCreateAgentIdWithTools, preflightAuth } from "@/utils/agents";
import { getInstruction } from "@/utils/prompts/getInstruction";
import { withTimeout } from "@/utils/async";
import { LINE, DEBUG, AZURE, MAIN_TIMERS } from "@/utils/env";
import { stripInternalBlocksFromContent } from "@/utils/reply/fence";
import { toLineTextsFromMessage } from "@/utils/line/lineMessage";
import { withLock } from "@/utils/redis";
import { createOwnerLockKey, getAssistantMessageForRun, normalizeReplyOptions, validateReplyInputs, waitForRunCompletion, type NormalizedReplyOptions } from "./getReply_common";

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

// 返信取得
export async function getReply_bingGrounding(
  ctx: AiContext,
  opts?: AiReplyOptions
): Promise<AiReplyResult> {
  const options: NormalizedReplyOptions = normalizeReplyOptions(opts);
  const validationError: AiReplyResult | null = validateReplyInputs(ctx, options);
  if (validationError) return validationError;

  const hasImage: boolean = options.imageUrls.length > 0;
  const hasQuestion: boolean = options.question.trim().length > 0;

  // 認証チェック
  await preflightAuth();

  // 指示文（reply用）を取得 -> tool
  const { instruction, origin } = await getInstruction(ctx.sourceType, ctx.ownerId, "reply", "tool");
  if (debugAi) console.info("[ai.reply] origin=%s src=%s owner=%s", origin, ctx.sourceType, ctx.ownerId);

  // ロックキーは type + ownerId を採用
  const lockKey: string = createOwnerLockKey(ctx.sourceType, ctx.ownerId);

  return await withLock(lockKey, 90_000, async () => {
    const threadId: string = ctx.threadId;

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

    // reply 実行
    const tools: readonly unknown[] = createSearchTool();
    const replyAgentId = await getOrCreateAgentIdWithTools(instruction, tools, "reply");

    const run = await withTimeout(
      agentsClient.runs.create(threadId, replyAgentId, {
        parallelToolCalls: true,
      }),
      MAIN_TIMERS.CREATE_TIMEOUT,
      "reply:create"
    );

    // 完了待ち（ポーリング）
    await waitForRunCompletion(threadId, run.id, "reply");

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
