import { isOutputOfType, type MessageContentUnion, type MessageTextContent } from "@azure/ai-agents";
import type { Meta } from "@/types/gpts";

// meta/instpack 抽出用
const fenceRe = (name: string) => new RegExp("```" + name + "\\s*\\r?\\n([\\s\\S]*?)\\r?\\n?```", "g");

// assistantメッセージからmeta/instpackを除去、meta/instpackの中身を抽出
export function stripInternalBlocksFromContent(contents: MessageContentUnion[]): {
  cleaned: MessageContentUnion[];
  meta?: Meta;
  instpack?: string;
} {
  const cloned = JSON.parse(JSON.stringify(contents)) as MessageContentUnion[];
  let meta: Meta | undefined;
  let inst: string | undefined;

  for (const c of cloned) {
    if (!isOutputOfType<MessageTextContent>(c, "text")) continue;

    // instpackを抽出・除去
    const instRe = fenceRe("instpack");
    let mInst: RegExpExecArray | null;
    let lastInst: string | undefined;
    while ((mInst = instRe.exec(c.text.value))) lastInst = mInst[1];
    if (lastInst && lastInst.trim()) inst = lastInst.trim();
    instRe.lastIndex = 0;
    c.text.value = c.text.value.replace(instRe, "").trim();

    // metaを抽出・除去（最後のフェンス優先）
    const metaRe = fenceRe("meta");
    let mMeta: RegExpExecArray | null;
    let lastMeta: string | undefined;
    while ((mMeta = metaRe.exec(c.text.value))) lastMeta = mMeta[1];
    if (lastMeta) {
      try {
        meta = JSON.parse(lastMeta.trim()) as Meta;
      } catch {
        /* 解析失敗は無視 */
      }
    }
    metaRe.lastIndex = 0;
    c.text.value = c.text.value.replace(metaRe, "").trim();
  }
  return { cleaned: cloned, meta, instpack: inst };
}
