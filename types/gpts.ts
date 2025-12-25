export type SourceType = "user" | "group" | "room";

// Meta用
type Intent =
  | "lookup"
  | "qa"
  | "summarize"
  | "classify"
  | "react";

type Modality = "text" | "image" | "image+text";

type Domain = "event" | "news" | "shopping" | "local" | "object" | null;

type ImageTask = "identify" | "ocr" | "caption" | "summarize" | "detect_faces" | null;

export type MetaProcedure = {
  kind: string;                      // 説明的ラベル（enumにしない）
  rule?: string | null;              // 処理ルール（自然文 or 簡易記述）
  interaction?: "single" | "step_by_step" | null; // 対話形式（任意）
};

export type MissingReason =
  | "focus"   // 何をするGPTSか未定
  | "scope"   // 対象範囲が未定
  | "format"  // 処理・出力形式が未定
  | "input";  // 実行に必要な入力が不足（保存可否とは独立）

type MetaSlots = {
  topic?: string;
  place?: string | null;
  date_range?: string | null;
  official_only?: boolean | null;
  title?: string | null;
  image_task?: ImageTask;
  tone?: string | null;
  output_style?: string | null;
  has_image?: boolean | null;
};

export type Meta = {
  intent?: Intent;
  modality?: Modality;
  domain?: Domain;
  slots?: MetaSlots;
  procedure?: MetaProcedure;
};

// 汎用AI実行ユーティリティ向けコンテキスト
export type AiContext = {
  ownerId: string;                   // plain の ownerId（userId/groupId/roomId の本体）
  sourceType: SourceType;            // 発話元
  threadId: string;                  // 既存または新規取得済みのスレッドID
};

// 返信取得の結果
export type AiReplyResult = {
  texts: readonly string[];          // 内部ブロック除去後のLINE表示用テキスト
  agentId: string;                   // 実行に使用したエージェントID
  threadId: string;
  runId: string;
};

// meta取得の結果
export type AiMetaResult = {
  meta?: Meta;                       // emit_meta の生結果
  agentId: string;
  threadId: string;
  runId: string;
};

// instpack取得の結果
export type AiInstpackResult = {
  instpack?: string;                 // emit_instpack の生結果
  agentId: string;
  threadId: string;
  runId: string;
};

// getReply用オプション
export type AiReplyOptions = {
  question?: string;                 // テキスト質問（省略可）
  imageUrls?: readonly string[];     // 画像URL群（省略可）
};

// getMeta用オプション
export type AiMetaOptions = {
  maxRetry?: number;                 // 既定2（再試行）
  hasImageHint?: boolean;            // 画像同梱時に slots.has_image を補正するヒント
};

export type MetaComputeResult = {
  metaNorm: Meta;                    // 補完済みmeta
  saveable: boolean;                 // instpack生成・保存可能
  missing: readonly MissingReason[]; // 理由コード（enum）
};

// emit_* ツール返却は用途ごとに分離
export type EmitMetaArgs = { meta: Meta };           // emit_metaの返却
export type EmitInstpackArgs = { instpack: string }; // emit_instpackの返却

export type AiError = {
  name: string;
  message: string;
  retriable: boolean;
};