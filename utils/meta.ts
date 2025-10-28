import type { FollowupAsk, Meta, MetaComputeResult, MetaFollowup } from "@/types/gpts";
import { envInt, NEWS } from "@/utils/env";

// 判定の可視化用トレース型
type DecisionTrace = {
  intent: Meta["intent"] | null;
  hasTopic?: boolean;
  hasImageTask?: boolean;
  prefersImageTask?: boolean;
  replyLen?: number;
};

//const followupMaxLen: number = envInt("FOLLOWUP_MAX_LEN", 80, { min: 20, max: 200 });
const replyMinLen: number = envInt("REPLY_MIN_LEN", 40, { min: 0, max: 2000 });

function trimLite(s: string): string {
  return s.replace(/\s+/g, "").trim();
}

export function computeMeta(rawMeta?: Meta, replyText?: string): MetaComputeResult {
  // meta の補完
  const m: Meta = {
    intent: rawMeta?.intent ?? undefined,
    modality: rawMeta?.modality ?? "text",  // 既定は "text"
    domain: rawMeta?.domain ?? undefined,
    slots: { ...(rawMeta?.slots ?? {}) },
    complete: !!rawMeta?.complete,
    followups: rawMeta?.followups ?? [],
  };

  const s = m.slots ?? {};
  const reasons: string[] = [];

  const trace: DecisionTrace = { intent: m.intent ?? null,};

  // domain による補正
  if (m.domain === "event" && !s.date_range) {
    // event: 期間未指定は "ongoing"
    s.date_range = "ongoing";
  }
  if (m.domain === "news" && !s.date_range) {
    // news: 期間未指定は既定日数（env）→ last_${DAYS}d
    const days: number = Number.isFinite(NEWS.DEFAULT_DAYS) ? Number(NEWS.DEFAULT_DAYS) : 7;
    s.date_range = `last_${days}d`;
  }

  // intent 別 complete_norm 判定、不足スロット検出
  let complete_norm: boolean = false;
  let genFollowup: MetaFollowup | null = null;

  switch (m.intent) {
    case "lookup": {
      // 情報検索系。「教えて」「探して」など。topic があれば十分とみなす。
      const hasTopic: boolean = typeof s.topic === "string" && s.topic.trim().length > 0;
      trace.hasTopic = hasTopic;
      if (hasTopic) {
        reasons.push("lookup:topic_present");
      } else {
        reasons.push("lookup:topic_missing");
      }

      complete_norm = hasTopic;
      if (!hasTopic){
        genFollowup = { ask: "topic", text: "対象（固有名詞やキーワード）を教えてください。" };
      }
      break;
    }
    case "qa": {
      // 知識・説明要求。「これは何？」「なぜ？」など。topic または image_task のどちらかがあれば true。
      const hasTopic: boolean = typeof s.topic === "string" && s.topic.trim().length > 0;
      const hasImageTask: boolean = typeof s.image_task === "string" && !!s.image_task?.trim();
      const prefersImageTask: boolean = (m.modality === "image" || m.modality === "image+text");
      trace.hasTopic = hasTopic;
      trace.hasImageTask = hasImageTask;
      trace.prefersImageTask = prefersImageTask;
      if (hasTopic) reasons.push("qa:topic_present");
      if (hasImageTask) reasons.push("qa:image_task_present");
      if (!hasTopic && !hasImageTask) reasons.push("qa:topic_or_image_task_missing");

      complete_norm = hasTopic || hasImageTask;
      if (!complete_norm){
        genFollowup = prefersImageTask
          ? { ask: "image_task", text: "画像で何をしますか？（識別・文字読み取り・説明・要約・顔検出）" }
          : { ask: "topic", text: "対象（固有名詞やキーワード）を1つ教えてください。" };
      }
      break;
    }
    case "summarize": {
      // 要約・整理。「まとめて」「要点」など。topic または image_task のどちらかがあれば true。
      const hasTopic: boolean = typeof s.topic === "string" && s.topic.trim().length > 0;
      const hasImageTask: boolean = typeof s.image_task === "string" && !!s.image_task?.trim();
      const prefersImageTask: boolean = (m.modality === "image" || m.modality === "image+text");
      trace.hasTopic = hasTopic;
      trace.hasImageTask = hasImageTask;
      trace.prefersImageTask = prefersImageTask;
      if (hasTopic) reasons.push("summarize:topic_present");
      if (hasImageTask) reasons.push("summarize:image_task_present");
      if (!hasTopic && !hasImageTask) reasons.push("summarize:topic_or_image_task_missing");

      complete_norm = hasTopic || hasImageTask;
      if (!complete_norm){
        genFollowup = prefersImageTask
          ? { ask: "image_task", text: "画像の要約対象や目的を指定してください。（例：説明・文字起こし）" }
          : { ask: "topic", text: "要約したい対象（資料名や話題）を教えてください。" };
      }
      break;
    }
    case "classify": {
      // 分類・判定。「どの種類」「カテゴリ分け」など。topic または image_task のどちらかがあれば true。
      const hasTopic: boolean = typeof s.topic === "string" && s.topic.trim().length > 0;
      const hasImageTask: boolean = typeof s.image_task === "string" && !!s.image_task?.trim();
      const prefersImageTask: boolean = (m.modality === "image" || m.modality === "image+text");
      trace.hasTopic = hasTopic;
      trace.hasImageTask = hasImageTask;
      trace.prefersImageTask = prefersImageTask;
      if (hasTopic) reasons.push("classify:topic_present");
      if (hasImageTask) reasons.push("classify:image_task_present");
      if (!hasTopic && !hasImageTask) reasons.push("classify:topic_or_image_task_missing");

      complete_norm = hasTopic || hasImageTask;
      if (!complete_norm){
        genFollowup = prefersImageTask
          ? { ask: "image_task", text: "画像の分類目的を指定してください。（例：品目分類・品質判定）" }
          : { ask: "topic", text: "分類したい対象（品目名や文書名など）を教えてください。" };
      }
      break;
    }
    case "react": {
      // 感想・反応。「どう？」「コメントして」など。topic または image_task のどちらかがあれば true。
      const hasTopic: boolean = typeof s.topic === "string" && s.topic.trim().length > 0;
      const hasImageTask: boolean = typeof s.image_task === "string" && !!s.image_task?.trim();
      const prefersImageTask: boolean = (m.modality === "image" || m.modality === "image+text");
      trace.hasTopic = hasTopic;
      trace.hasImageTask = hasImageTask;
      trace.prefersImageTask = prefersImageTask;
      if (hasTopic) reasons.push("react:topic_present");
      if (hasImageTask) reasons.push("react:image_task_present");
      if (!hasTopic && !hasImageTask) reasons.push("react:topic_or_image_task_missing");

      complete_norm = hasTopic || hasImageTask;
      if (!complete_norm){
        genFollowup = prefersImageTask
          ? { ask: "image_task", text: "画像のどんな点にコメントすれば良いですか？" }
          : { ask: "topic", text: "反応・コメントする対象（話題や作品名）を教えてください。" };
      }
      break;
    }
    default: {
      // 未知 intent は不完全
      complete_norm = false;
      reasons.push("intent_unknown");
      break;
    }
  }

  // 返信本文の品質チェック
  const replyLen: number = (replyText?.trim().length ?? 0);
  trace.replyLen = replyLen;
  const reply_ok: boolean = replyMinLen > 0 ? (replyLen >= replyMinLen) : true;
  if (!reply_ok) reasons.push("reply_text_too_short");

  // 保存可否
  const saveable: boolean = complete_norm && reply_ok;

  // followups の最終決定
  const existingNormalized: MetaFollowup[] =
    (m.followups ?? []).map((f) =>
      typeof f === "string"
        ? { ask: "topic" as FollowupAsk, text: f }
        : { ask: (f?.ask ?? "topic") as FollowupAsk, text: (f?.text ?? "") }
    );

  const existingFirst: MetaFollowup | null =
    existingNormalized.find((f) => {
      const t: string = (f.text ?? "").trim();
      return t.length > 0;
    }) ?? null;

  // 既存がなければ、intent 判定時に用意した生成候補を使う
  const finalFollowup: MetaFollowup | null =
    existingFirst ?? (genFollowup ? { ask: genFollowup.ask, text: genFollowup.text } : null);

  m.followups = finalFollowup ? [finalFollowup] as MetaFollowup[] : [];

  // meta.complete を complete_norm で上書き
  m.complete = complete_norm;

  console.info("[meta] computeMeta", {
    intent: m.intent ?? null,
    modality: m.modality,
    domain: m.domain ?? null,
    complete_norm,              // 決定
    reply_ok,
    saveable,
    followups_len: m.followups.length,
    followup_ask: m.followups[0]?.ask ?? null,
    reasons,  // 判定の根拠（present/missing を含む）
    trace,    // hasTopic / hasImageTask / prefersImageTask / replyLen 等の生値
  });

  return { metaNorm: m, complete_norm, reply_ok, saveable, reasons };
}

// looksLikeFollowup: 構造化 followups へ対応（必要に応じてUI側の“重複判定”に利用）
export function looksLikeFollowup(line?: string, meta?: Meta): boolean {
  if (!line) return false;
  const s: string = line.trim();
  if (!s) return false;

  // 末尾「?」「？」の疑問形、または meta.followups に一致する文なら true
  const endsWithQ: boolean = /[?？]\s*$/.test(s);
  const equalsMeta: boolean =
    (meta?.followups ?? []).some((f) => {
      const t: string = typeof f === "string" ? f : (f?.text ?? "");
      return trimLite(t) === trimLite(s);
    }) ?? false;

  // 過去の「不足:」形式も一応サポート（将来削除可）
  const hasLegacyLead: boolean = /^不足[:：]/.test(s);

  return endsWithQ || equalsMeta || hasLegacyLead;
}
