export type Intent = "event" | "news" | "buy" | "generic";
export type Slots = {
  topic?: string;
  place?: string;
  date_range?: string;
  official_only?: boolean;
};
export type Meta = {
  intent?: Intent;
  slots?: Slots;
  complete?: boolean;       // 不足があれば false
  followups?: string[];     // LLMが用意した追質問（あれば）
};

const META_BLOCK = /```meta\s*([\s\S]*?)```/i;

export function extractMetaAndStrip(blocks: string[]): { cleaned: string[]; meta?: Meta } {
  let meta: Meta | undefined;
  const cleaned = blocks
    .map((t) => {
      if (!t) return t;
      const m = t.match(META_BLOCK);
      if (!m) return t;
      try {
        meta = JSON.parse(m[1]) as Meta;
      } catch {
        // 解析失敗は無視して本文だけ使う
      }
      // コードフェンスを本文から除去
      return t.replace(META_BLOCK, "").trim();
    })
    .filter((s) => s && s.trim().length > 0);

  return { cleaned, meta };
}