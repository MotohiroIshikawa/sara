export type InstpackCheck = { ok: boolean; reason?: string };

const hasJa = (s: string) => /[一-龯ぁ-んァ-ン]/.test(s); // ★日本語必須
const has = (s: string, re: RegExp) => re.test(s);

export function isValidInstpack(s?: string): InstpackCheck {
  if (!s) return { ok: false, reason: "instpack:undefined" };
  const t = s.trim();
  if (!t) return { ok: false, reason: "instpack:empty" };
  if (t.length < 80) return { ok: false, reason: "instpack:too_short" };
  if (/```/.test(t)) return { ok: false, reason: "instpack:has_fence" };
  if (/[?？]\s*$/.test(t)) return { ok: false, reason: "instpack:looks_question" };
  if (!hasJa(t)) return { ok: false, reason: "instpack:not_japanese" };

  // ★日本語見出し（または後方互換の英語見出し）を確認
  const hasRole   = has(t, /(役割|role)\s*[:：]/);
  const hasOut    = has(t, /(出力規則|出力|output)\s*[:：]/);
  const hasRef    = has(t, /(参照方針|reference(_policy)?)/);
  const hasIntent = has(t, /(目的|intent)\s*[:：]/);
  const hasSlots  = has(t, /(スロット|slots)\s*[:：]/);

  if (!hasRole)   return { ok: false, reason: "instpack:missing_役割" };
  if (!hasOut)    return { ok: false, reason: "instpack:missing_出力規則" };
  if (!hasRef)    return { ok: false, reason: "instpack:missing_参照方針" };
  if (!hasIntent) return { ok: false, reason: "instpack:missing_目的" };
  if (!hasSlots)  return { ok: false, reason: "instpack:missing_スロット" };

  return { ok: true };
}
