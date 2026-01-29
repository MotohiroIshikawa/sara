import { getThreadUserTexts } from "@/utils/search/getThreadUserTexts";
import { DEBUG } from "@/utils/env";

// 検索クエリ生成用の入力
export type BuildSearchQueryArgs = {
  rewrittenQuery?: string | null; // decision Agent が返した正規化済み検索クエリ, 正常に入っているなら最優先で使用する
  question: string;              // 今回のユーザー入力（生テキスト）
  threadId: string;              // threadId（thread 履歴から user 発言を取得するため）
};

// DEBUG フラグ（他ファイルと同じルールに合わせる）
const debugAi: boolean =
  (DEBUG.AI || process.env["DEBUG.AI"] === "true" || process.env.DEBUG_AI === "true") === true;

/**
 * 検索に使うクエリ文字列を生成する。
 * 優先順位:
 * 1. rewrittenQuery が生きていればそれをそのまま返す
 * 2. thread の user 発言列 + 今回の question を材料に再構成する
 * 3. それでも作れなければ null（検索不能）
 */
export async function buildSearchQuery(
  args: BuildSearchQueryArgs
): Promise<string | null> {
  const rewritten: string | null =
    typeof args.rewrittenQuery === "string" && args.rewrittenQuery.trim().length > 0
      ? args.rewrittenQuery.trim()
      : null;

  // decision が正常ならそれを最優先
  if (rewritten) {
    if (debugAi) {
      console.info("[search.query] use rewrittenQuery", {
        threadId: args.threadId,
        query: rewritten,
      });
    }
    return rewritten;
  }

  if (debugAi) {
    console.info("[search.query] rewrittenQuery is empty, fallback to thread context", {
      threadId: args.threadId,
      question: args.question,
    });
  }

  // thread の user 発言列を取得
  const threadTexts: readonly string[] = await getThreadUserTexts(args.threadId);

  if (debugAi) {
    console.info("[search.query] thread user texts fetched", {
      threadId: args.threadId,
      count: threadTexts.length,
      texts: threadTexts,
    });
  }

  // 今回の質問も最後に足す（重複は後で除外）
  const allTexts: string[] = [
    ...threadTexts,
    args.question.trim(),
  ].filter((t) => t.length > 0);

  if (allTexts.length === 0) {
    if (debugAi) {
      console.info("[search.query] no candidate texts, search disabled", {
        threadId: args.threadId,
      });
    }
    return null;
  }

  // 単純結合ではなく「検索語として意味がありそうな語」を残す
  // ここでは最低限：
  // - 重複を除外
  // - 空白正規化
  const seen: Set<string> = new Set<string>();
  const normalized: string[] = [];

  for (const t of allTexts) {
    const norm: string = normalizeForSearch(t);
    if (!norm) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    normalized.push(norm);
  }

  if (normalized.length === 0) {
    if (debugAi) {
      console.info("[search.query] normalized texts are empty, search disabled", {
        threadId: args.threadId,
        allTexts,
      });
    }
    return null;
  }

  // スペース区切りで連結して検索クエリ化
  const query: string = normalized.join(" ");

  // フォールバック経路で最終的に生成された検索クエリ
  if (debugAi) {
    console.info("[search.query] fallback query built from thread", {
      threadId: args.threadId,
      query,
      normalized,
    });
  }

  return query;
}

/**
 * 検索用に最低限正規化する
 * - 前後空白除去
 * - 改行を空白に
 * - 連続空白を1つに
 */
function normalizeForSearch(input: string): string {
  const s: string = input
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return s.length > 0 ? s : "";
}
