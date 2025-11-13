import type { AiContext, AiReplyOptions, AiReplyResult } from "@/types/gpts";
import { getReply_bingGrounding } from "@/utils/reply/getReply_bingGrounding";
import { getReply_bingApi } from "@/utils/reply/getReply_bingApi";

// 利用する検索モード
export type ReplyMode = "tool" | "api";

// env値からモードを解決（未設定や不正値は "tool" にフォールバック）
function resolveReplyMode(explicit?: ReplyMode): ReplyMode {
  if (explicit) return explicit;
  const raw: string = String(process.env["REPLY_SEARCH_MODE"] ?? "").trim().toLowerCase();
  return raw === "api" ? "api" : "tool";
}

// reply の統一
// - mode を省略すると REPLY_SEARCH_MODE（"tool"|"api"）で切替。未設定は "tool"
// - "api": REST検索方式（判定→必要時検索→コンテキスト投下→返信run）
// - "tool": Groundingツール方式（従来）
export async function runReply(
  ctx: AiContext,
  opts?: AiReplyOptions,
  mode?: ReplyMode
): Promise<AiReplyResult> {
  const m: ReplyMode = resolveReplyMode(mode);
  if (m === "api") {
    return await getReply_bingApi(ctx, opts);
  }
  return await getReply_bingGrounding(ctx, opts);
}
