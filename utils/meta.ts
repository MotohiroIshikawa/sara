import type { Meta } from "@/types/gpts";
import { envInt, NEWS } from "@/utils/env";

export type EmitMetaPayload = { meta?: Meta; instpack?: string };

export function isTrackable(meta?: Meta): boolean {
  if (!meta) return false;
  if (meta.intent && meta.intent !== "generic") return true;
  const s = meta.slots ?? {};
  const hasTopic = !!(s.topic && s.topic.trim());
  const hasPlace = typeof s.place === "string" && s.place.trim().length > 0;
  const hasDate  = !!(s.date_range && String(s.date_range).trim().length > 0);
  return hasTopic && (hasPlace || hasDate);
}

// normalizeMeta: Metaの正規化（newsのdate_rangeを既定補正、completeフラグの正規化）
export function normalizeMeta(meta?: Meta): Meta | undefined {
  if (!meta) return meta;
  const out: Meta = { ...meta, slots: { ...(meta.slots ?? {}) } };
  
  if (out.intent === "event") {
    const r = out.slots?.date_range?.trim().toLowerCase();
    out.complete = !!out.slots?.topic && out.slots!.topic.trim().length > 0;
    if (!r) out.slots!.date_range = "ongoing"; // 仕様: 未指定は ongoing
  }
  
  if (out.intent === "news") {
    const r = out.slots?.date_range?.trim().toLowerCase();
    if (!r || r === "ongoing" || r === "upcoming_30d") {
      out.slots!.date_range = `last_${NEWS.DEFAULT_DAYS}d`;
      // topic が特定できていれば news は complete
      out.complete = !!out.slots?.topic && out.slots.topic.trim().length > 0;
    }
  }
 
  if (out.intent === "buy") {
    // topic があれば complete 扱いにする
    out.complete = !!out.slots?.topic && out.slots.topic.trim().length > 0;
  }

  // generic&topicなし: 追質問。generic&topicあり: 追質問なし->保存しますか？ダイアログ
  const isNonEmpty = (v: unknown): v is string =>
    typeof v === "string" && v.trim().length > 0;
  if (out.intent === "generic"){
    out.complete = isNonEmpty(out.slots?.topic);
  }
  return out;
}

// 「保存する」判定（instpack取得を実施するかどうか）
export function shouldSave(meta?: Meta, replyText?: string): boolean {
  if (!meta) return false;
  const replyOk = (replyText?.length ?? 0) >= 80;
  return meta.complete === true && isTrackable(meta) && replyOk;
}

// スロット不足時の追質問テキスト生成->不足スロットを1つだけ尋ねる簡潔な質問を用意
export function buildFollowup(meta?: Meta): string {
  const slots = meta?.slots ?? {};
  const intent = meta?.intent;

  if (intent === "generic") {
    if (!slots.topic) return "対象（作品名など）を教えてください。";
    return meta?.followups?.[0]
      ?? "どんな会話にする（入門ガイド / 考察相棒 / ニュース速報 / クイズ作成 / グッズ案内）？";
  }

  const missing: string[] = [];
  if (!slots.topic) missing.push("対象（作品名など）");
  if (intent === "news" && !slots.date_range) missing.push("期間");
  if (missing.length === 0 && slots.topic && !slots.place) missing.push("場所（任意）");

  const lead = missing.length ? `不足: ${missing.join(" / ")}。` : "";
  if (intent === "event") return `${lead}ひとつだけ教えてください。`;
  return meta?.followups?.[0] ?? `${lead}ひとつだけ教えてください。`;
}

const followupMaxLen = envInt("FOLLOWUP_MAX_LEN", 80, { min: 20, max: 200 });
function trimLite(s: string) {
  return s.replace(/\s+/g, "").trim();
}

// looksLikeFollowup: 追質問の形状判定ヘルパー
export function looksLikeFollowup(line?: string, meta?: Meta): boolean {
  if (!line) return false;
  const s = line.trim();
  if (!s) return false;
  if (s.length > followupMaxLen) return false;
  const endsWithQ = /[?？]\s*$/.test(s);
  const hasLead = /^不足[:：]/.test(s);
  const equalsMeta = meta?.followups?.some(f => trimLite(f) === trimLite(s)) ?? false;
  return endsWithQ || hasLead || equalsMeta;
}