export type SearchItem = {
  title: string;
  url: string;
  snippet: string;
  crawledAt?: string | null;
};

// 検索結果を「可視コンテキスト」文字列に整形します。
// - 内部ブロックではなく、ユーザー投稿扱いでモデルに見せる前提
// - 先頭に役割を明示
export function formatSearchContext(
  items: readonly SearchItem[],
  maxItems: number = 5,
  maxCharsPerItem: number = 240
): string {
  const lines: string[] = [];
  const take: number = Math.max(0, Math.min(maxItems, items.length));
  for (let i = 0; i < take; i++) {
    const r = items[i];
    const title: string = (r.title ?? "").trim();
    const url: string = (r.url ?? "").trim();
    const snippetRaw: string = (r.snippet ?? "").trim();
    const snippet: string = snippetRaw.length > maxCharsPerItem ? `${snippetRaw.slice(0, maxCharsPerItem)}…` : snippetRaw;
    const line: string = `- ${title || "(no title)"}\n  URL: ${url}\n  要約: ${snippet}`;
    lines.push(line);
  }
  if (lines.length === 0) return "";
  return [
    "【Web検索コンテキスト】",
    ...lines,
    "（上記はユーザー質問に関連が高い順のおおまかな要約です。引用時は必ず本文で再検証してください）",
  ].join("\n");
}
