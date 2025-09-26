/**
 * Bingからのレスポンス処理について
 * 
 * content:[{type:'text',text:{
 *  value:'(接頭の説明文)\n'+'\n'+'---\n'+'\n'+'###最初の段落'....
 *      // 段落ごとに参照URLがある場合は段落末尾に【\d+:\d+†source】の形で「注釈」が入る
 * ,annotations:[{
 *    type:'url_citation',
 *    urlCitation:{
 *      url:URL,
 *      title:'TITLE'
 *    },
 *    startIndex: SSS,  // 本文全体での「注釈」の開始位置
 *    endIndex: EEE     // 本文全体での「注釈」の終了位置
 *  }, ...]
 * }}]
 * 
 * toSectionedJsonFromMessageで返されるオブジェクト->Section型のオブジェクト配列->LINE用text配列へ
 * 
 */

import { isOutputOfType, type MessageContentUnion, type MessageTextContent, type MessageTextUrlCitationAnnotation } from "@azure/ai-agents";
import { LINE } from "@/utils/env";
import { normalizeMarkdownForLine } from "@/utils/normalizeMarkdownForLine";

// 注釈マーカー削除：返却されたテキストに【\d+:\d+†source】（注釈マーカー）があれば削除する用途
const stripMarkers = (s: string) => s.replace(/【\d+:\d+†source】/g, "");

// 段落区切り：返却されたテキストを空行(改行2連続)で区切る用途
const delimiter = /\r?\n\r?\n/g;
const isAscii = (s: string) => /^[\x00-\x7F]+$/.test(s);

// 英数字短文のフィラー判定：空行で区切ったときにminSectionLengthより短い文字列があったらゴミとする用途
const isFiller = (s: string) => {
  const t = s.trim();
  if (!t) return true; // 空はフィラー
  return isAscii(t) && t.length <= LINE.MIN_SECTION_LENGTH;
};

// 段落分割結果（原文中の位置範囲つき）
type Section = {
  context: string;     // マーカー除去後の本文
  startIndex: number;  // 元テキスト内の開始位置
  endIndex: number;    // 元テキスト内の終了位置（end-exclusive）
};

// splitByHrWithRanges: テキストを段落に分割して原文中の文字数の範囲も保持。Section型を利用
function splitByHrWithRanges(text: string): Section[] {
  const out: Section[] = [];
  let last = 0;
  // 段落区切り
  for (const m of text.matchAll(delimiter)) {
    const idx = m.index ?? -1;
    if (idx < 0) continue;
    const chunk = text.slice(last, idx);
    const trimmed = chunk.trim();
    if (!trimmed || isFiller(trimmed)) {
      // フィラー段落はスキップ
      last = idx + m[0].length;
      continue;
    }
    out.push({ context: stripMarkers(trimmed), startIndex: last, endIndex: idx });
    last = idx + m[0].length;
  }
  // 末尾の処理
  const tail = text.slice(last);
  const tailTrimmed = tail.trim();
  if (tailTrimmed && !isFiller(tailTrimmed)) {
    out.push({ context: stripMarkers(tailTrimmed), startIndex: last, endIndex: text.length });
  }
  return out;
}

// LINEの文字数制限に合わせて段落をさらに分割
function chunkForLine(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    // 直近の改行（できれば段落区切り）を探す->改行が無ければ機械的に分割
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < 0) cut = rest.lastIndexOf("\n", limit);
    if (cut < 0) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) out.push(rest);
  return out;
}

// 返却されたテキストをLINEにあったテキスト(配列)に分割する
function toLineTextsFromTextPart(
  part: MessageTextContent,
  opts: { maxUrls?: number; showTitles?: boolean } = {}
): string[] {
  const { maxUrls = LINE.MAX_URLS_PER_BLOCK, showTitles = false } = opts;
  const block = part.text.value;
  const sections = splitByHrWithRanges(block);

  // 段落ごとのURL重複回避セット/追記バッファ
  const seenPerSection: Array<Set<string>> = sections.map(() => new Set<string>());
  // 注釈をセクションの末尾へ追記するための行バッファ
  const urlLinesPerSection: string[][] = sections.map(() => []);

  // 注釈を位置順にソートして各段落に割当て
  const anns = (part.text.annotations ?? [])
    .filter((a): a is MessageTextUrlCitationAnnotation => a.type === "url_citation")
    .sort((a, b) => (a.startIndex ?? 0) - (b.startIndex ?? 0));

  for (const a of anns) {
    const s = a.startIndex ?? -1;
    if (s < 0) continue;
    const url = a.urlCitation?.url;
    const title = a.urlCitation?.title;
    if (!url) continue;

    // 所属セクションを見つける
    let idx = sections.findIndex(sec => s >= sec.startIndex && s < sec.endIndex);
    if (idx === -1 && sections.length > 0) {
      // どの範囲にも入らない場合は最後のセクションに付与
      idx = sections.length - 1;
    }
    if (idx === -1) continue;

    // 重複URLはスキップ、最大数より多い場合はスキップ
    const seen = seenPerSection[idx];
    if (seen.has(url)) continue;
    if (urlLinesPerSection[idx].length >= maxUrls) continue;
    seen.add(url);

    urlLinesPerSection[idx].push(
      showTitles && title ? `${title}\n${url}` : `${url}`
    );
  }

  // 段落本文+URLを結合し、各段落をLINEのテキストサイズ以内に再分割
  const out: string[] = [];
  sections.forEach((sec, i) => {
    // マークダウン形式の整形
    const body = normalizeMarkdownForLine(sec.context.trim());
    const refs = urlLinesPerSection[i];
    // URLを末尾に追加
    const text = refs.length ? `${body}\n${refs.join("\n")}` : body;
    out.push(text);
  });
  const sized: string[] = [];
  for (const t of out) sized.push(...chunkForLine(t, LINE.TEXT_LIMIT));
  return sized;
}

// メッセージ中のtext部分をすべてLINE向けに整形
export function toLineTextsFromMessage(
  contents: MessageContentUnion[],
  opts?: { maxUrls?: number; showTitles?: boolean }
): string[] {
  const textParts = contents.filter(
    (c): c is MessageTextContent => isOutputOfType<MessageTextContent>(c, "text")
  );
  const all: string[] = [];
  for (const p of textParts) {
    all.push(...toLineTextsFromTextPart(p, opts));
  }
  return all;
}
