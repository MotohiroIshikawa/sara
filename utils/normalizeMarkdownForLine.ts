/**
 * Markdown を LINE の通常テキスト向けに読みやすく整形する。
 * - LINE は Markdown を解釈しないため、記号で代替表現に置換
 * - 強調: **text** → 【text】, *text* / _text_ → 〈text〉
 * - 見出し: #/##/###... → 削除
 * - 箇条書き: -, * → ・ / 数字. → n)
 * - 引用: > → ＞
 * - インラインコード: `code` → 「code」
 * - リンク: [label](url) → label - url
 * - 水平線や脚注マーカーを削除、改行整理
 */
export function normalizeMarkdownForLine(md: string): string {
  let s = md;

  // 余計な脚注マーカー除去（Bing groundingの残骸）
  s = s.replace(/【\d+:\d+†source】/g, "");

  // コードブロックはインデント化
  s = s.replace(/```([\s\S]*?)```/g, (_m: string, code: string) =>
    code.split("\n").map((l: string) => (l ? `    ${l}` : l)).join("\n")
  );

  // 見出し → 記号
  s = s
    .replace(/^\s*######\s*(.+)$/gm, "$1")
    .replace(/^\s*#####\s*(.+)$/gm, "$1")
    .replace(/^\s*####\s*(.+)$/gm, "$1")
    .replace(/^\s*###\s*(.+)$/gm, "$1")
    .replace(/^\s*##\s*(.+)$/gm, "$1")
    .replace(/^\s*#\s*(.+)$/gm, "$1");

  // 引用
  s = s.replace(/^\s*>\s?/gm, "> ");

  // 箇条書き
  s = s.replace(/^\s*[-*]\s+/gm, "・");
  s = s.replace(/^\s*(\d+)\.\s+/gm, "$1) ");

  // 強調
//  s = s.replace(/\*\*(.+?)\*\*/g, "【$1】");                            // 太字
  s = s.replace(/\*\*(.+?)\*\*/g, "$1");                            // 太字
  s = s.replace(/(^|[^*])\*(?!\*)([^*]+)\*(?!\*)(?=[^*]|$)/g, "$1〈$2〉"); // 斜体 *
  s = s.replace(/_([^_]+)_/g, "〈$1〉");                                  // 斜体 _

  // インラインコード/リンク
  s = s.replace(/`([^`]+)`/g, "「$1」");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, "$1 - $2");

  // 水平線は削除
  s = s.replace(/^\s*---\s*$/gm, "");

  // 連続改行を詰める & 末尾整理
  s = s.replace(/\n{3,}/g, "\n\n").trim();

  return s;
}