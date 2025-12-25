import type { Meta, MetaComputeResult, MissingReason } from "@/types/gpts";
import { envInt, NEWS } from "@/utils/env";

// 判定の可視化用トレース型
type DecisionTrace = {
  intent: Meta["intent"] | null;
  hasTopic?: boolean;
  hasImageTask?: boolean;
  hasProcedure?: boolean; 
  isImageModality?: boolean;
  replyLen?: number;
};

//const followupMaxLen: number = envInt("FOLLOWUP_MAX_LEN", 80, { min: 20, max: 200 });
const replyMinLen: number = envInt("REPLY_MIN_LEN", 40, { min: 0, max: 2000 });

export function computeMeta(
  rawMeta?: Meta, 
  replyText?: string
): MetaComputeResult {

  // meta の正規化
  const m: Meta = {
    intent: rawMeta?.intent ?? undefined,
    modality: rawMeta?.modality ?? "text",  // 既定は "text"
    domain: rawMeta?.domain ?? undefined,
    slots: { ...(rawMeta?.slots ?? {}) },
    procedure: rawMeta?.procedure ?? undefined,
  };

  const s = m.slots ?? {};
  const missing: MissingReason[] = [];
  const trace: DecisionTrace = { intent: m.intent ?? null,};

  // domain による補正
  if (m.domain === "event" && !s.date_range) {
    // event: 期間未指定は "ongoing"
    s.date_range = "ongoing";
  }
  if (m.domain === "news" && !s.date_range) {
    // news: 期間未指定は既定日数（env）→ last_${DAYS}d
    const days: number = Number.isFinite(NEWS.DEFAULT_DAYS) 
      ? Number(NEWS.DEFAULT_DAYS) 
      : 7;
    s.date_range = `last_${days}d`;
  }

  const hasTopic: boolean =
    typeof s.topic === "string" && s.topic.trim().length > 0;

  const hasImageTask: boolean =
    typeof s.image_task === "string" && !!s.image_task?.trim();

  const isImageModality: boolean =
    m.modality === "image" || m.modality === "image+text";

  const hasProcedure: boolean =
    typeof m.procedure === "object" && m.procedure !== null;

  trace.hasTopic = hasTopic;
  trace.hasImageTask = hasImageTask;
  trace.hasProcedure = hasProcedure;
  trace.isImageModality = isImageModality;

  // intent 別 complete_norm 判定、不足スロット検出
  let complete_norm: boolean = false;

  switch (m.intent) {
    case "lookup": {
      // lookup は「対象が分かれば成立」
      // topic もしくは image_task のどちらかがあれば十分
      complete_norm = hasTopic || hasImageTask;
      if (!complete_norm) missing.push("focus");
      break;
    }
    case "qa": {
      // qa は「説明・回答」が主目的
      // topic があるか、procedure（固定手順）がある場合に成立
      // 「割り勘計算BOT」「大阪弁変換」などを許可
      complete_norm = hasTopic || hasProcedure;
      if (!complete_norm) missing.push("focus");
      break;
    }
    case "summarize": {
      // summarize は「入力対象」が必須
      // 画像系は image_task が必要、テキスト系は topic が必要
      complete_norm = isImageModality ? hasImageTask : hasTopic;
      if (!complete_norm) missing.push("format");
      break;
    }
    case "classify": {
      // classify は「分類対象」が必須
      // topic か procedure（分類ルール固定）があれば成立
      complete_norm = hasTopic || hasProcedure;
      if (!complete_norm) missing.push("format");
      break;
    }
    case "react": {
      // react は保存価値が低いが、complete_norm は成立しうる
      // topic がある場合のみ成立（procedure は通常不要）
      complete_norm = hasTopic;
      if (!complete_norm) missing.push("format");
      break;
    }
    default: {
      // 未知 intent は不完全
      complete_norm = false;
      missing.push("focus");
      break;
    }
  }

  // domain 固有の成立条件
  // local は scope（place）がないと GPTS として成立しない
  if (
    m.domain === "local" &&
    !(typeof s.place === "string" && s.place.trim().length > 0)
  ) {
    missing.push("scope");
  }

  // 返信本文の品質チェック
  const replyLen: number = replyText?.trim().length ?? 0;
  trace.replyLen = replyLen;
  const reply_ok: boolean = isImageModality ? true    // 画像なら常にOK
    : replyMinLen > 0 ? replyLen >= replyMinLen : true;

  // 保存可否
  // saveable は「domain が成立」OR「procedure がある」
  // complete_norm は instpack 生成可否の前提条件として使う
  const domainSaveable: boolean =
    m.domain === "event" ||
    m.domain === "news" ||
    m.domain === "shopping" ||
    (m.domain === "local" && typeof s.place === "string" && s.place.trim().length > 0);
  const procedureSaveable: boolean = hasProcedure;
  const saveable: boolean =
    complete_norm &&
    reply_ok &&
    (domainSaveable || procedureSaveable);

  console.info("[meta] computeMeta", {
    intent: m.intent ?? null,
    modality: m.modality,
    domain: m.domain ?? null,
    complete_norm,              // 決定
    reply_ok,
    saveable,
    missing,
    trace,    // hasTopic / hasImageTask / prefersImageTask / replyLen 等の生値
  });

  return {
    metaNorm: m, 
    complete_norm, 
    reply_ok, 
    saveable, 
    missing,
  };
}

export type MetaLogPhase = "main" | "repair" | "fence" | "instpack" | "meta";

export function logEmitMetaSnapshot(
  phase: MetaLogPhase,
  ctx: { threadId: string; runId?: string },
  payload: { meta?: Meta; instpack?: string }
): void {
  const meta = payload?.meta;
  const instpack = payload?.instpack;

  console.info("[emit_meta] captured", {
    phase,
    threadId: ctx.threadId,
    runId: ctx.runId,
    intent: meta?.intent ?? null,
    slots: {
      topic: meta?.slots?.topic ?? null,
      place: meta?.slots?.place ?? null,
      date_range: meta?.slots?.date_range ?? null,
      official_only: meta?.slots?.official_only ?? null,
      image_task: meta?.slots?.image_task ?? null,
      has_image: meta?.slots?.has_image === true ? true : false,
    },
    instpack_len: typeof instpack === "string" ? instpack.length : 0,
  });
}