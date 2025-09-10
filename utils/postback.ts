// LINE postback.data は 300 文字まで。人間可読 & 短い querystring 形式にする。
// 例: "pb?v=1&ns=gpts&fn=save&tid=thread_xxx"

const PB_PREFIX = "pb?";

export type PostbackEnvelope = {
  v?: number;                       // バージョン(将来の互換用)
  ns: string;                       // 名前空間 (例: "gpts")
  fn: string;                       // 関数名   (例: "save" / "continue")
  args?: Record<string, string>;    // 追加引数
};

export function encodePostback(ns: string, fn: string, args?: Record<string, string>, v = 1): string {
  const p = new URLSearchParams();
  p.set("v", String(v));
  p.set("ns", ns);
  p.set("fn", fn);
  for (const [k, val] of Object.entries(args ?? {})) {
    if (val != null) p.set(k, String(val));
  }
  return PB_PREFIX + p.toString();
}

export function decodePostback(data: string): PostbackEnvelope | null {
  try {
    const q = data.startsWith(PB_PREFIX) ? data.slice(PB_PREFIX.length) : data;
    const p = new URLSearchParams(q);
    const ns = p.get("ns") ?? undefined;
    const fn = p.get("fn") ?? undefined;
    if (!ns || !fn) return null;
    const v = Number(p.get("v") ?? "1") || 1;
    const args: Record<string, string> = {};
    p.forEach((val, key) => {
      if (key !== "v" && key !== "ns" && key !== "fn") args[key] = val;
    });
    return { v, ns, fn, args };
  } catch {
    return null;
  }
}
