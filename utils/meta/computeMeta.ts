import type { Meta, MetaComputeResult, MissingReason } from "@/types/gpts";
import { NEWS } from "@/utils/env";

// 判定の可視化用トレース型
type DecisionTrace = {
  intent: Meta["intent"] | null;
  domain: Meta["domain"] | null;
  hasTopic?: boolean;
  hasProcedure?: boolean;
  hasPlace: boolean;
  procedureNeedsInput: boolean;  
};

export function computeMeta(
  rawMeta?: Meta
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
  const hasPlace: boolean =
    typeof s.place === "string" && s.place.trim().length > 0;
  const hasProcedure: boolean =
    typeof m.procedure === "object" && m.procedure !== null;

  const procedureNeedsInput: boolean = hasProcedure && !(
    hasTopic ||
    hasPlace ||
    typeof s.date_range === "string"
  );

  const trace: DecisionTrace = {
    intent: m.intent ?? null,
    domain: m.domain ?? null,
    hasTopic,
    hasProcedure,
    hasPlace,
    procedureNeedsInput,
  };
  
  // domain によるルール成立条件 -> domain があれば「何を調べるか」が一意に定まる
  const domainSaveable: boolean =
    m.domain === "event" ||
    m.domain === "news" ||
    m.domain === "shopping" ||
    (m.domain === "local" && hasPlace);

  // procedure によるルール成立条件 -> procedure があれば domain 不要
  // 割り勘計算・変換・診断など
  const procedureSaveable: boolean = hasProcedure && !procedureNeedsInput;

  // チャットルールとして成立するか？ = instpack を生成しに行ってよいか？
  const saveable: boolean = !!m.intent && (domainSaveable || procedureSaveable);

  // missing 判定（核心優先・複数OK）
  if (!saveable) {
    if (hasProcedure && procedureNeedsInput) {
      // procedure はあるが、実行入力が足りない
      missing.push("input");
    } else if (m.domain === "local" && !hasPlace) {
      // local だが place が無い
      missing.push("scope");
    } else if ( (m.intent === "summarize" || m.intent === "classify") && !hasProcedure) {
      // 処理系 intent だが procedure が無く、形式が未確定
      missing.push("format");
    } else {
      // domain も procedure も無い（用途不明）
      missing.push("focus");
    }
  }

  console.info("[meta] computeMeta", {
    intent: m.intent ?? null,
    domain: m.domain ?? null,
    saveable,
    missing,
    trace,
  });

  return {
    metaNorm: m, 
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