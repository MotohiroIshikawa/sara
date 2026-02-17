import { ToolUtility, type MessageInputContentBlockUnion, type ThreadMessage } from "@azure/ai-agents";
import type { AiContext, AiReplyOptions, AiReplyResult, MissingReason } from "@/types/gpts";
import {
  agentsClient,
  getOrCreateAgentIdWithTools,
  preflightAuth,
  runWithToolCapture,
} from "@/utils/agents";
import { getInstruction } from "@/utils/prompts/getInstruction";
import { LINE, DEBUG, AZURE } from "@/utils/env";
import { stripInternalBlocksFromContent } from "@/utils/reply/fence";
import { toLineTextsFromMessage } from "@/utils/line/lineMessage";
import { withLock } from "@/utils/redis";
import {
  createOwnerLockKey,
  normalizeReplyOptions,
  validateReplyInputs,
  buildReplyRequiresActionHandler,
} from "./getReply_common";

const debugAi: boolean =
  (DEBUG.AI || process.env["DEBUG.AI"] === "true" || process.env.DEBUG_AI === "true") === true;

const debugGrounding: boolean =
  process.env.DEBUG_GROUNDING === "true";

// Grounding/Search ツールを生成
function createSearchTool(): readonly unknown[] {
  if (!AZURE.BING_CONNECTION_ID) {
    console.warn("[ai.reply.grounding] ⚠️ BING_CONNECTION_ID missing → grounding disabled"); // ★
    return [];
  }
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

export async function getReply_bingGrounding(
  ctx: AiContext,
  opts?: AiReplyOptions
): Promise<AiReplyResult> {
  const options = normalizeReplyOptions(opts);
  const validationError = validateReplyInputs(ctx, options);
  if (validationError) return validationError;

  const missingReasons: readonly MissingReason[] = options.missingReasons;
  const hasImage: boolean = options.imageUrls.length > 0;
  const hasQuestion: boolean = options.question.trim().length > 0;

  await preflightAuth();

  const { instruction, origin } = await getInstruction(
    ctx.sourceType,
    ctx.ownerId,
    "reply",
    "tool"
  );

  if (debugAi) {
    console.info("[ai.reply] origin=%s src=%s owner=%s", origin, ctx.sourceType, ctx.ownerId);
    console.info("[ai.reply] start", {
      sourceType: ctx.sourceType,
      ownerId: ctx.ownerId,
      threadId: ctx.threadId,
      hasQuestion,
      hasImage,
      missingReasons: missingReasons.length ? missingReasons : null,
    });
  }

  const lockKey: string = createOwnerLockKey(ctx.sourceType, ctx.ownerId);

  return await withLock(lockKey, 90_000, async () => {
    const threadId = ctx.threadId;

    // missingReasons 注入（履歴に残す）
    if (missingReasons.length > 0) {
      const payload = `[missingReasons] ${JSON.stringify(missingReasons)}`;
      if (debugGrounding) {
        console.info("[ai.reply.grounding] missingReasons injected", {
          threadId,
          count: missingReasons.length,
        });
      }
      await agentsClient.messages.create(threadId, "user", payload);
    }

    // user input
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

    const tools = createSearchTool();

    if (debugGrounding) {
      console.info("[ai.reply.grounding] tools", {
        hasGroundingTool: tools.length > 0,
        toolCount: tools.length,
      });
    }

    const agentId = await getOrCreateAgentIdWithTools(
      instruction,
      tools,
      "reply"
    );

    const r = await runWithToolCapture<void>({
      threadId,
      agentId,
      operation: "reply",
      requiresActionHandler: buildReplyRequiresActionHandler(),
    });

    if (debugAi) {
      console.info("[ai.reply] run done", {
        runId: r.runId,
        status: r.finalState?.status ?? null,
        timedOut: r.timedOut,
      });
    }

    if (debugGrounding) {
      console.info("[ai.reply.grounding] run summary", {
        runId: r.runId,
        status: r.finalState?.status ?? null,
        timedOut: r.timedOut,
        usedGrounding: tools.length > 0,
      });
    }

    // assistant メッセージ取得（最後の assistant）
    let msg: ThreadMessage | undefined;

    for await (const m of agentsClient.messages.list(threadId, { order: "desc" })) {
      if (m.role === "assistant" && m.runId === r.runId) {
        msg = m;
        break;
      }
    }

    if (!msg) {
      return {
        texts: ["⚠️エラーが発生しました（返信メッセージが見つかりません）"],
        agentId,
        threadId,
        runId: r.runId,
      };
    }

    const { cleaned } = stripInternalBlocksFromContent(msg.content);
    let texts = toLineTextsFromMessage(cleaned, {
      maxUrls: LINE.MAX_URLS_PER_BLOCK,
      showTitles: false,
    });

    if (!texts.length) texts = ["（結果が見つかりませんでした）"];

    return {
      texts,
      agentId,
      threadId,
      runId: r.runId,
    };
  });
}
