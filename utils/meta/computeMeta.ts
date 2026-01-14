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

// 次回用に保持する「最小の状態」抽出関数
//    - Agent には渡さない（Node.js が保存して次回に使う）
//    - 保存対象は topic/domain/place/date_range/intent のみ
export function extractMetaCarry(metaNorm?: Meta): Meta {
  const topic: string | undefined = metaNorm?.slots?.topic;
  const place: string | null | undefined = metaNorm?.slots?.place ?? undefined;
  const date_range: string | null | undefined = metaNorm?.slots?.date_range ?? undefined;

  const slots: Meta["slots"] = {};

  if (typeof topic === "string" && topic.trim().length > 0) {
    slots.topic = topic.trim();
  }
  if (typeof place === "string" && place.trim().length > 0) {
    slots.place = place.trim();
  }
  if (typeof date_range === "string" && date_range.trim().length > 0) {
    slots.date_range = date_range.trim();
  }

  // intent/domain はそのまま（undefined可）
  // ここでは modality/procedure/title/tone/output_style 等は「次回用に残さない」
  const carry: Meta = {
    intent: metaNorm?.intent ?? undefined,
    domain: metaNorm?.domain ?? undefined,
    slots,
  };

  return carry;
}

// 前回 metaNorm（carry）と今回 rawMeta を合成して、このターンの rawMeta として扱う。
//    ※補完ルールの詳細はここで深追いしない（最小の上書き優先だけ）
function mergeMeta(prev?: Meta, curr?: Meta): Meta | undefined {
  if (!prev && !curr) return undefined;
  if (!prev) return curr;
  if (!curr) return prev;

  const mergedSlots: Meta["slots"] = {
    ...(prev.slots ?? {}),
    ...(curr.slots ?? {}),
  };

  const merged: Meta = {
    intent: curr.intent ?? prev.intent,
    modality: curr.modality ?? prev.modality,
    domain: curr.domain ?? prev.domain,
    slots: mergedSlots,
    procedure: curr.procedure ?? prev.procedure,
  };

  return merged;
}

export function computeMeta(
  rawMeta?: Meta,
  prevMeta?: Meta // 前回の metaNorm（保存しておいた carry を想定）
): MetaComputeResult {
  // 前回情報を合成してから正規化する（Agentには渡さない。Node.js内部だけで使う）
  const mergedRaw: Meta | undefined = mergeMeta(prevMeta, rawMeta);

  // meta の正規化
  const m: Meta = {
    intent: mergedRaw?.intent ?? undefined,
    modality: mergedRaw?.modality ?? "text", // 既定は "text"
    domain: mergedRaw?.domain ?? undefined,
    slots: { ...(mergedRaw?.slots ?? {}) },
    procedure: mergedRaw?.procedure ?? undefined,
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

  const hasTopic: boolean = typeof s.topic === "string" && s.topic.trim().length > 0;
  const hasPlace: boolean = typeof s.place === "string" && s.place.trim().length > 0;
  const hasProcedure: boolean = typeof m.procedure === "object" && m.procedure !== null;

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
    hasPrevMeta: typeof prevMeta === "object" && prevMeta !== null, // prevMeta が来ているかの確認ログ（デバッグ用）
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